import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { maintenanceLaunchPath, maintenanceReadyPath, monotonicNs, processIdentity, readinessPath, type ProcessIdentity } from "../server/readiness.ts";
import { canBind } from "./plugin-port.ts";
import { endFixtureTree, sameBirth } from "./fixture-pidfd.ts";
import { updateStateDir } from "../server/update-state.ts";

/**
 * The legacy maintenance start through the real plugin, launcher and supervisor, in a disposable
 * replica: a synthetic legacy bridge answers the exact-boot health check, nothing reaches herdr. Every request goes
 * to a listener this file owns or to the fixture's own proven bridge; cleanup goes through pinned pidfds only.
 */
const repo = join(import.meta.dir, "..");
const linux = process.platform === "linux";
const BRIDGES = {
  ready: `Bun.serve({hostname:"127.0.0.1",port:Number(process.env.PORT),fetch:()=>Response.json({ok:true,herdr:{version:"0.9.3",protocol:1},auth:{required:false,authenticated:true},web_ui:{boot_id:process.env.HERDR_WEB_BOOT_ID,revision:null}})});`,
  silent: `Bun.serve({hostname:"127.0.0.1",port:Number(process.env.PORT),fetch:()=>new Promise(()=>{})});`,
};
function fixture(port: number, bridge: keyof typeof BRIDGES = "ready") {
  const root = mkdtempSync(join(tmpdir(), "maintenance-plugin-"));
  for (const name of ["server", "pid", "config", "app"]) mkdirSync(join(root, name), { mode: 0o700 });
  writeFileSync(join(root, "server/managed.ts"), `import {runManaged} from ${JSON.stringify(join(repo, "server/managed.ts"))}; await runManaged(${JSON.stringify(root)});`);
  writeFileSync(join(root, "server/index.ts"), BRIDGES[bridge]);
  const env: Record<string, string | undefined> = { ...process.env, HERDR_PLUGIN_ROOT: root, HERDR_PLUGIN_STATE_DIR: join(root, "pid"), HERDR_PLUGIN_CONFIG_DIR: join(root, "config"),
    HERDR_WEB_STATE_DIR: join(root, "app"), HERDR_WEB_AUTO_UPDATE: "0", HOST: "127.0.0.1", PORT: String(port) };
  for (const key of ["HERDR_WEB_OWNER_RP_ID", "HERDR_WEB_OWNER_ORIGIN"]) delete env[key];
  const nonce = randomUUID(), births: ProcessIdentity[] = [];
  const state = updateStateDir(root, port, join(root, "app"));
  const launchPath = maintenanceLaunchPath(root, port, join(root, "app")), readyPath = maintenanceReadyPath(root, port, join(root, "app"));
  const run = async (extra: Record<string, string | undefined> = {}, ahead = 4_500_000_000n, preload?: string) => {
    const fields = { HERDR_WEB_MAINTENANCE_NONCE: nonce, HERDR_WEB_MAINTENANCE_DEADLINE_NS: String(monotonicNs() + ahead), ...extra };
    const child = Bun.spawn([process.execPath, ...(preload ? ["--preload", preload] : []), join(repo, "scripts/plugin.ts"), "start"], { env: { ...env, ...fields }, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    // the early birth is kept before anything below can throw, so cleanup always knows the launcher
    for (const line of out.trim().split("\n")) { try { const value = JSON.parse(line); if (value?.event === "spawned" && value.launcher_birth) births.push(value.launcher_birth); } catch { /* not JSON */ } }
    const deadline = BigInt(fields.HERDR_WEB_MAINTENANCE_DEADLINE_NS ?? "0");
    return { code, out, err, deadline, ended: monotonicNs(), result: JSON.parse(out.trim().split("\n").at(-1) ?? "null"), starter: child.pid };
  };
  /** Ends every tree this fixture started: from each early birth and from both records, through pinned pidfds. */
  const end = async () => {
    const roots: ProcessIdentity[] = [...births];
    for (const path of [launchPath, readyPath]) {
      try { const value = JSON.parse(readFileSync(path, "utf8")); roots.push(...[value.launcher, value.supervisor, value.bridge].filter(Boolean)); } catch { /* absent */ }
    }
    const { survivors } = await endFixtureTree(roots, root);
    if (survivors.length) throw new Error(`fixture survivors remain: ${JSON.stringify(survivors)}`);
  };
  return { root, env, nonce, run, end, births, state, pid: join(root, "pid/server.pid"), app: join(root, "app"), launch: launchPath, ready: readyPath };
}
const freePort = () => { const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }), port = reservation.port!; reservation.stop(true); return port; };
const parentOf = (pid: number) => { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]); };
/** The port is free again: proven by a bind, never by a request to whatever might hold it now. */
const portClosed = (port: number) => canBind("127.0.0.1", port);

test.skipIf(!linux)("unchanged legacy config starts the exact new tree with fresh private records inside the deadline", async () => {
  const port = freePort(), f = fixture(port);
  // records of an earlier launch (another nonce) are present and must not establish anything
  mkdirSync(f.state, { recursive: true, mode: 0o700 });
  const stale = { version: 1, mode: "legacy-maintenance", root: f.root, port, nonce: randomUUID(), launcher: processIdentity(process.pid) };
  writeFileSync(f.launch, JSON.stringify(stale), { mode: 0o600 });
  try {
    const started = await f.run();
    expect(started.code, started.err + started.out).toBe(0);
    expect(started.ended < started.deadline).toBe(true);
    const r = started.result;
    expect(Object.keys(r).sort()).toEqual(["error", "launch", "launcher_birth", "launcher_exit", "launcher_pid", "mode", "ready", "starter", "status", "version"]);
    const early = JSON.parse(started.out.trim().split("\n")[0]!);
    expect(early).toEqual({ version: 1, mode: "legacy-maintenance", event: "spawned", starter: started.starter, launcher_birth: r.launch });
    expect(r.launcher_birth).toEqual(r.launch);
    expect(r).toMatchObject({ version: 1, mode: "legacy-maintenance", status: "ready", starter: started.starter, launcher_exit: null, error: null });
    expect(started.out).not.toContain(f.nonce);
    const launch = JSON.parse(readFileSync(f.launch, "utf8")), ready = JSON.parse(readFileSync(f.ready, "utf8"));
    expect(launch).toEqual({ version: 1, mode: "legacy-maintenance", root: f.root, port, nonce: f.nonce, launcher: ready.launcher });
    expect(ready).toMatchObject({ version: 1, mode: "legacy-maintenance", owner: false, root: f.root, port, nonce: f.nonce });
    expect(r.launcher_pid).toBe(ready.launcher.pid); expect(r.launch).toEqual(ready.launcher);
    expect(r.ready).toEqual({ boot_id: ready.boot_id, launcher: ready.launcher, supervisor: ready.supervisor, bridge: ready.bridge });
    // the legacy numeric PID file is unchanged in format and names the new launcher
    expect(readFileSync(f.pid, "utf8")).toBe(`${ready.launcher.pid}\n`);
    expect(readFileSync(join(f.state, "supervisor.lock", "pid"), "utf8")).toBe(String(ready.supervisor.pid));
    expect(parentOf(ready.supervisor.pid)).toBe(ready.launcher.pid);
    expect(parentOf(ready.bridge.pid)).toBe(ready.supervisor.pid);
    expect(parentOf(ready.launcher.pid)).not.toBe(started.starter);
    for (const identity of [ready.launcher, ready.supervisor, ready.bridge]) expect(processIdentity(identity.pid)).toEqual(identity);
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    expect(health.web_ui.boot_id).toBe(ready.boot_id);
    for (const path of [f.launch, f.ready]) expect(readFileSync(path).length).toBeLessThan(4096);
    // the owner record and launcher format were never written
    expect(existsSync(readinessPath(f.root, port, f.app))).toBe(false);
    // the private fields stop at the supervisor: the bridge does not inherit them
    const bridgeEnv = readFileSync(`/proc/${ready.bridge.pid}/environ`, "utf8");
    expect(bridgeEnv).not.toContain("HERDR_WEB_MAINTENANCE_");
  } finally { await f.end(); rmSync(f.root, { recursive: true, force: true }); }
}, 20_000);

test.skipIf(!linux)("an occupied fixed port is refused before any launch and the listener is left alone", async () => {
  const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) }), f = fixture(holder.port!);
  try {
    const started = await f.run();
    expect(started.code).toBe(1);
    expect(started.result).toMatchObject({ status: "refused", launcher_pid: null, launch: null, ready: null });
    expect(started.result.error).toContain("occupied");
    expect(existsSync(f.pid)).toBe(false); expect(existsSync(f.launch)).toBe(false);
    expect((await fetch(`http://127.0.0.1:${holder.port}/`)).status).toBe(200);
  } finally { holder.stop(true); await f.end(); rmSync(f.root, { recursive: true, force: true }); }
});

test.skipIf(!linux)("invalid, expired, distant, file-sourced, owner and automatic-update requests are refused before any launch", async () => {
  const f = fixture(freePort());
  try {
    const cases: [Record<string, string | undefined>, bigint, string][] = [
      [{}, -1n, "expired"],
      [{}, 5_500_000_000n, "five seconds"],
      [{ HERDR_WEB_MAINTENANCE_NONCE: "fiction" }, 4_000_000_000n, "nonce"],
      [{ HERDR_WEB_MAINTENANCE_DEADLINE_NS: undefined }, 4_000_000_000n, "both"],
      [{ HERDR_WEB_OWNER_ORIGIN: "http://localhost", HERDR_WEB_OWNER_RP_ID: "localhost" }, 4_000_000_000n, "owner"],
      [{ HERDR_WEB_AUTO_UPDATE: "1" }, 4_000_000_000n, "automatic"],
      [{ PORT: undefined }, 4_000_000_000n, "fixed PORT"],
      [{ HERDR_PLUGIN_ROOT: `${f.root}/.` }, 4_000_000_000n, "exact root"],
    ];
    for (const [extra, ahead, reason] of cases) {
      const started = await f.run(extra, ahead);
      expect(started.code).toBe(1);
      expect(started.result?.status, started.out + started.err).toBe("refused");
      expect(started.result.error).toContain(reason);
    }
    writeFileSync(join(f.root, "config/.env"), `HERDR_WEB_MAINTENANCE_NONCE=${randomUUID()}\n`);
    const fromFile = await f.run();
    expect(fromFile.result).toMatchObject({ status: "refused" }); expect(fromFile.result.error).toContain("process environment");
    expect(existsSync(f.pid)).toBe(false); expect(existsSync(f.launch)).toBe(false);
  } finally { await f.end(); rmSync(f.root, { recursive: true, force: true }); }
}, 20_000);

test.skipIf(!linux)("a bridge that never passes its exact-boot check ends without ready inside the deadline and the tree tears itself down", async () => {
  const port = freePort(), f = fixture(port, "silent");
  try {
    const started = await f.run({}, 2_000_000_000n);
    expect(started.code).toBe(1);
    expect(["expired", "failed"]).toContain(started.result.status);
    expect(started.result.ready).toBeNull();
    const launcher: ProcessIdentity = started.result.launcher_birth;
    expect(started.result.launch).toEqual(launcher);
    // the starter returns no later than shortly after the deadline; it never waits past it for readiness
    expect(Number(started.ended - started.deadline) / 1e6).toBeLessThan(500);
    expect(existsSync(f.ready)).toBe(false);
    // no restart and no fallback: the launcher exits by itself and no second supervisor appears
    const deadline = Date.now() + 10_000;
    while (sameBirth(launcher)) { if (Date.now() > deadline) throw new Error("launcher kept running"); await Bun.sleep(25); }
    expect(existsSync(join(f.state, "supervisor.lock"))).toBe(false);
    expect(existsSync(f.ready)).toBe(false);
    expect(await portClosed(port)).toBe(true);
  } finally { await f.end(); rmSync(f.root, { recursive: true, force: true }); }
}, 20_000);

test.skipIf(!linux)("a launch-record write failure after spawn keeps custody: the launcher exits before any supervisor and the starter reports it", async () => {
  const port = freePort(), f = fixture(port);
  mkdirSync(f.state, { recursive: true, mode: 0o700 }); chmodSync(f.state, 0o500);
  try {
    const started = await f.run();
    expect(started.code).toBe(1);
    expect(started.result).toMatchObject({ status: "failed", launch: null, ready: null });
    expect(Number.isInteger(started.result.launcher_pid)).toBe(true);
    expect(started.result.launcher_exit).not.toBe(0); expect(started.result.launcher_exit).not.toBeNull();
    expect(sameBirth(started.result.launcher_birth)).toBe(false);
    expect(readFileSync(f.pid, "utf8")).toBe(`${started.result.launcher_pid}\n`);
    expect(existsSync(join(f.state, "supervisor.lock"))).toBe(false);
    expect(readFileSync(join(f.root, "pid/server.log"), "utf8")).toContain("maintenance launcher");
  } finally { chmodSync(f.state, 0o700); await f.end(); rmSync(f.root, { recursive: true, force: true }); }
}, 20_000);

test.skipIf(!linux)("a ready-record write failure after the exact-boot check publishes nothing and the new tree tears itself down", async () => {
  const port = freePort(), f = fixture(port);
  mkdirSync(f.ready, { recursive: true, mode: 0o700 }); // a directory where the record goes: its atomic rename fails
  try {
    const started = await f.run();
    expect(started.code).toBe(1);
    expect(started.result).toMatchObject({ status: "failed", ready: null });
    const launcher: ProcessIdentity = started.result.launcher_birth;
    expect(started.result.launch).toEqual(launcher);
    expect(started.result.launcher_exit).toBe(1);
    expect(sameBirth(launcher)).toBe(false);
    expect(existsSync(join(f.state, "supervisor.lock"))).toBe(false);
    expect(await portClosed(port)).toBe(true);
  } finally { await f.end(); rmSync(f.root, { recursive: true, force: true }); }
}, 20_000);

test.skipIf(!linux)("a server.pid write failure after spawn still pins the launcher birth, first in an early line and then in the result", async () => {
  const port = freePort(), f = fixture(port);
  mkdirSync(f.pid, { mode: 0o700 }); // a directory where the legacy PID file goes: the write fails after spawn
  try {
    const started = await f.run();
    expect(started.code).toBe(1);
    const lines = started.out.trim().split("\n").map(line => JSON.parse(line));
    expect(lines.length).toBe(2);
    const [early, result] = lines;
    expect(early).toEqual({ version: 1, mode: "legacy-maintenance", event: "spawned", starter: started.starter, launcher_birth: early.launcher_birth });
    expect(result).toMatchObject({ status: "failed", launcher_exit: null, launcher_birth: early.launcher_birth, launcher_pid: early.launcher_birth.pid });
    expect(started.out).not.toContain(f.nonce);
    // the launcher keeps running: its birth is the one pinned before the failure, and its own record later names the same birth
    const deadline = Date.now() + 10_000;
    while (!existsSync(f.ready)) { if (Date.now() > deadline) throw new Error("no ready record"); await Bun.sleep(25); }
    const launch = JSON.parse(readFileSync(f.launch, "utf8")), ready = JSON.parse(readFileSync(f.ready, "utf8"));
    expect(launch.launcher).toEqual(early.launcher_birth);
    expect(processIdentity(early.launcher_birth.pid)).toEqual(early.launcher_birth);
  } finally { await f.end(); rmSync(f.root, { recursive: true, force: true }); }
}, 20_000);

test.skipIf(!linux)("H2: launch null with a launcher exit does not prove that no supervisor ran or that its lock was removed", async () => {
  // the review's rapid-failure fixture: an invalid lock PID that the supervisor refuses before any process query or
  // bridge spawn, and a 300 ms pause in the starter right after its server.pid write (a private fs adapter; product unchanged)
  const port = freePort(), f = fixture(port);
  try {
    mkdirSync(join(f.state, "supervisor.lock"), { recursive: true, mode: 0o700 });
    writeFileSync(join(f.state, "supervisor.lock", "pid"), "0", { mode: 0o600 });
    const preload = join(f.root, "delay.ts");
    writeFileSync(preload, `import {mock} from "bun:test";import * as fs from "node:fs";const original=fs.writeFileSync;mock.module("node:fs",()=>({...fs,writeFileSync(path,...args){const result=original(path,...args);if(path===${JSON.stringify(f.pid)})Bun.sleepSync(300);return result;}}));`);
    const started = await f.run({}, 4_000_000_000n, preload);
    expect(started.code).toBe(1);
    expect(started.result).toMatchObject({ status: "failed", launcher_exit: 1, launch: null, ready: null });
    // yet the launcher wrote its record and a supervisor ran: null only says no live record was observed
    const launch = JSON.parse(readFileSync(f.launch, "utf8"));
    expect(launch.launcher).toEqual(started.result.launcher_birth);
    const log = readFileSync(join(f.root, "pid/server.log"), "utf8");
    expect(log).toContain("Invalid update lock"); expect(log).toContain("runSupervisor");
    // and exit 1 does not prove lock cleanup: the refused lock is still there
    expect(readFileSync(join(f.state, "supervisor.lock", "pid"), "utf8")).toBe("0");
  } finally { await f.end(); rmSync(f.root, { recursive: true, force: true }); }
}, 20_000);
