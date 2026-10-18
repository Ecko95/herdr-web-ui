import { test, expect, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * H1: a maintenance supervisor must publish no readiness once its shutdown has started. Runs in its own `bun test`
 * process (it replaces the updater module and Bun.spawn, fetch and process.exit for the supervisor under test).
 * MAINTENANCE_SERVER_DIR selects the supervisor under test (default: this checkout); the frozen input payload's
 * server directory reproduces the failure. The bridge is an owned child, ended only through its handle; the
 * SIGTERM is a local process.emit, no OS signal; health answers come from a fake fetch, the port is an owned listener.
 */
const server = process.env["MAINTENANCE_SERVER_DIR"] ?? import.meta.dir;
let updaterStarts = 0;
class FakeUpdater {
  status = { phase: "idle", auto_update: false }; notes = {}; installed = {};
  initialize() { return Promise.resolve(null); } stop() {} start() { updaterStarts++; } request() {}
}
mock.module(join(server, "updater.ts"), () => ({ Updater: FakeUpdater }));
const { runSupervisor } = await import(join(server, "supervisor.ts"));
const { writeMaintenanceLaunch, readMaintenanceReady, maintenanceReadyPath, monotonicNs } = await import(join(server, "readiness.ts"));

async function scenario(termDuringHealth: boolean) {
  expect(process.env["HOME"]).toContain("motoko-proof-");
  expect(process.pid).not.toBe(1012); expect(process.ppid).not.toBe(1012);
  const names = ["PORT", "HOST", "HERDR_WEB_STATE_DIR", "HERDR_WEB_MAINTENANCE_NONCE", "HERDR_WEB_MAINTENANCE_DEADLINE_NS", "HERDR_WEB_LAUNCHER_PID", "HERDR_WEB_OWNER_RP_ID", "HERDR_WEB_OWNER_ORIGIN", "HERDR_WEB_AUTO_UPDATE"];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const originalSpawn = Bun.spawn, originalFetch = globalThis.fetch, originalExit = process.exit;
  const beforeTerm = process.listeners("SIGTERM"), beforeInt = process.listeners("SIGINT");
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) });
  const root = mkdtempSync(join(tmpdir(), "maintenance-shutdown-")), app = join(root, "app"), port = listener.port!, nonce = crypto.randomUUID();
  const exits: number[] = [], seen: { afterTerm: unknown[] } = { afterTerm: [] };
  let bridge: ReturnType<typeof Bun.spawn> | null = null, onExit: ((child: unknown, code: number | null) => void) | undefined, boot = "";
  updaterStarts = 0;
  try {
    mkdirSync(app, { mode: 0o700 });
    // case one ignores TERM, so shutdown waits on it while the health answer is already in flight
    bridge = originalSpawn([process.execPath, "-e", `${termDuringHealth ? "process.on('SIGTERM',()=>{});" : ""} console.log('fixture-ready'); setInterval(()=>{},1000)`],
      { stdout: "pipe", stderr: "ignore", cwd: root, onExit(child, code) { onExit?.(child, code); } });
    expect(bridge.pid).not.toBe(1012);
    const first = await (bridge.stdout as ReadableStream<Uint8Array>).getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain("fixture-ready");
    Object.assign(process.env, { PORT: String(port), HOST: "127.0.0.1", HERDR_WEB_STATE_DIR: app, HERDR_WEB_MAINTENANCE_NONCE: nonce,
      HERDR_WEB_MAINTENANCE_DEADLINE_NS: String(monotonicNs() + 4_500_000_000n), HERDR_WEB_LAUNCHER_PID: String(process.ppid), HERDR_WEB_AUTO_UPDATE: "0" });
    delete process.env["HERDR_WEB_OWNER_RP_ID"]; delete process.env["HERDR_WEB_OWNER_ORIGIN"];
    writeMaintenanceLaunch(root, port, app, nonce, process.ppid);
    const owned = bridge;
    Bun.spawn = ((_argv: unknown, options: { env: Record<string, string>; onExit: typeof onExit }) => { boot = options.env["HERDR_WEB_BOOT_ID"]!; onExit = options.onExit; return owned; }) as unknown as typeof Bun.spawn;
    process.exit = ((code: number) => { exits.push(code); }) as typeof process.exit;
    const path = maintenanceReadyPath(root, port, app);
    globalThis.fetch = (async () => {
      if (termDuringHealth) { process.emit("SIGTERM"); seen.afterTerm.push(existsSync(path)); }
      return Response.json({ web_ui: { boot_id: boot } });
    }) as unknown as typeof fetch;
    await runSupervisor(root);
    if (termDuringHealth) {
      // shutdown is waiting on the bridge: nothing may be published, and startup must not commit
      expect(bridge.exitCode).toBeNull(); expect(exits).toEqual([]);
      expect(existsSync(path)).toBe(false); expect(readMaintenanceReady(root, port, app, nonce)).toBeNull();
      expect(updaterStarts).toBe(0);
      bridge.kill("SIGKILL"); await bridge.exited;
    } else {
      // control: ready first, then shutdown removes it before the bridge stops
      expect(readMaintenanceReady(root, port, app, nonce)?.bridge.pid).toBe(bridge.pid);
      expect(updaterStarts).toBe(1);
      process.emit("SIGTERM");
      await bridge.exited;
    }
    const deadline = Date.now() + 2000;
    while (exits.length === 0) { if (Date.now() > deadline) throw new Error("fake shutdown exit missing"); await Bun.sleep(1); }
    expect(exits).toEqual([0]);
    // after the bridge exit no readiness record exists, republished or left over
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(path, "..", "supervisor.lock"))).toBe(false);
    return { bridge: bridge.pid, exits, afterTerm: seen.afterTerm };
  } finally {
    if (bridge && bridge.exitCode === null) { bridge.kill("SIGKILL"); await bridge.exited; }
    const cleanup = Date.now() + 2000;
    while (bridge && exits.length === 0 && Date.now() < cleanup) await Bun.sleep(1); // the supervisor's shutdown finishes on the fake exit
    Bun.spawn = originalSpawn; globalThis.fetch = originalFetch; process.exit = originalExit;
    for (const fn of process.listeners("SIGTERM")) if (!beforeTerm.includes(fn)) process.removeListener("SIGTERM", fn);
    for (const fn of process.listeners("SIGINT")) if (!beforeInt.includes(fn)) process.removeListener("SIGINT", fn);
    for (const [name, value] of Object.entries(before)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    listener.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

test.skipIf(process.platform !== "linux")("a shutdown that starts during the health check publishes no maintenance readiness, before or after the bridge exits", async () => {
  await scenario(true);
}, 15_000);

test.skipIf(process.platform !== "linux")("control: readiness published before shutdown is removed when shutdown stops the bridge", async () => {
  await scenario(false);
}, 15_000);
