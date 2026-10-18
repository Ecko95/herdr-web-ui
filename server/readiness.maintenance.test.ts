import { test, expect } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { maintenanceStart, maintenanceLaunchPath, maintenanceReadyPath, writeMaintenanceLaunch, readMaintenanceLaunch, writeMaintenanceReady, readMaintenanceReady,
  writeOwnerLauncher, readReadiness, readinessPath, MAINTENANCE_WINDOW_NS, monotonicNs } from "./readiness.ts";
import { updateStateDir } from "./update-state.ts";

const linux = process.platform === "linux";
const request = (env: Record<string, string> = {}, now = monotonicNs()) => ({ HERDR_WEB_MAINTENANCE_NONCE: randomUUID(), HERDR_WEB_MAINTENANCE_DEADLINE_NS: String(now + 4_000_000_000n), ...env });

test("maintenance start is off without both process fields and refuses every invalid request", () => {
  const now = 10_000_000_000n;
  expect(maintenanceStart({}, now, "linux")).toBeNull();
  const ok = request({}, now);
  expect(maintenanceStart(ok, now, "linux")).toEqual({ nonce: ok.HERDR_WEB_MAINTENANCE_NONCE, deadlineNs: now + 4_000_000_000n });
  expect(maintenanceStart({ ...ok, HERDR_WEB_MAINTENANCE_DEADLINE_NS: String(now + MAINTENANCE_WINDOW_NS) }, now, "linux")).not.toBeNull();
  for (const [env, reason] of [
    [{ HERDR_WEB_MAINTENANCE_NONCE: ok.HERDR_WEB_MAINTENANCE_NONCE }, "both"],
    [{ HERDR_WEB_MAINTENANCE_DEADLINE_NS: ok.HERDR_WEB_MAINTENANCE_DEADLINE_NS }, "both"],
    [{ ...ok, HERDR_WEB_MAINTENANCE_NONCE: "not-a-uuid" }, "nonce"],
    [{ ...ok, HERDR_WEB_MAINTENANCE_DEADLINE_NS: "12.5" }, "deadline"],
    [{ ...ok, HERDR_WEB_MAINTENANCE_DEADLINE_NS: "-1" }, "deadline"],
    [{ ...ok, HERDR_WEB_MAINTENANCE_DEADLINE_NS: String(now) }, "expired"],
    [{ ...ok, HERDR_WEB_MAINTENANCE_DEADLINE_NS: String(now + MAINTENANCE_WINDOW_NS + 1n) }, "five seconds"],
    [{ ...ok, HERDR_WEB_OWNER_ORIGIN: "http://localhost" }, "owner"],
    [{ ...ok, HERDR_WEB_OWNER_RP_ID: "localhost" }, "owner"],
    [{ ...ok, HERDR_WEB_AUTO_UPDATE: "1" }, "automatic"],
  ] as const) expect(() => maintenanceStart(env as Record<string, string>, now, "linux")).toThrow(reason);
  expect(() => maintenanceStart(ok, now, "darwin")).toThrow("Linux");
  // the default clock is the absolute one: a deadline 4 s ahead of it is accepted, one taken from process-relative hrtime is expired
  expect(maintenanceStart(request())).not.toBeNull();
  expect(() => maintenanceStart(request({}, process.hrtime.bigint()))).toThrow("expired");
});

test.skipIf(!linux)("maintenance records bind the exact launch, refuse owner readiness and reject stale or unsafe records", async () => {
  const root = mkdtempSync(join(tmpdir(), "maintenance-ready-unit-")), port = 12345, app = join(root, "app"), nonce = randomUUID(), boot = randomUUID();
  // this test process stands in for the supervisor, its parent for the launcher and a child for the bridge
  const bridge = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { stdout: "ignore", stderr: "ignore" });
  try {
    expect(() => writeMaintenanceLaunch(root, port, app, nonce, 1012)).toThrow("launcher");
    const launch = writeMaintenanceLaunch(root, port, app, nonce, process.ppid);
    expect(launch).toEqual({ version: 1, mode: "legacy-maintenance", root, port, nonce, launcher: launch.launcher });
    expect(launch.launcher.pid).toBe(process.ppid);
    expect(readMaintenanceLaunch(root, port, app, nonce)).toEqual(launch);
    expect(readMaintenanceLaunch(root, port, app, randomUUID())).toBeNull();
    const lock = join(updateStateDir(root, port, app), "supervisor.lock");
    mkdirSync(lock); writeFileSync(join(lock, "pid"), String(process.pid), { mode: 0o600 });
    const ready = writeMaintenanceReady(root, port, app, nonce, boot, process.ppid, bridge.pid);
    expect(ready).toEqual({ version: 1, mode: "legacy-maintenance", owner: false, root, port, nonce, boot_id: boot, launcher: launch.launcher, supervisor: ready.supervisor, bridge: ready.bridge });
    expect(ready.supervisor.pid).toBe(process.pid); expect(ready.bridge.pid).toBe(bridge.pid);
    const path = maintenanceReadyPath(root, port, app), valid = readFileSync(path, "utf8");
    expect(statSync(path).mode & 0o777).toBe(0o600); expect(statSync(maintenanceLaunchPath(root, port, app)).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    expect(readMaintenanceReady(root, port, app, nonce)).toEqual(ready);
    expect(readMaintenanceReady(root, port, app, randomUUID())).toBeNull();

    // an owner:false record never passes the owner validator, even at the owner path with a valid owner launcher
    const ownerLauncher = writeOwnerLauncher(join(root, "server.pid"), process.ppid, nonce);
    mkdirSync(join(readinessPath(root, port, app), ".."), { recursive: true });
    writeFileSync(readinessPath(root, port, app), valid, { mode: 0o600 });
    expect(readReadiness(root, port, app, ownerLauncher)).toBeNull();
    writeFileSync(readinessPath(root, port, app), JSON.stringify({ ...JSON.parse(valid), owner: true, mode: undefined }), { mode: 0o600 });
    expect(readReadiness(root, port, app, ownerLauncher)).not.toBeNull(); // control: the same identities pass only as owner:true

    const cases: ((v: ReturnType<typeof JSON.parse>) => void)[] = [
      v => { v.version = 2; }, v => { v.mode = "owner"; }, v => { v.owner = true; }, v => { v.root += "/foreign"; }, v => { v.port++; },
      v => { v.nonce = randomUUID(); }, v => { v.boot_id = "fiction"; }, v => { v.launcher.startedAt++; }, v => { v.supervisor.startedAt++; },
      v => { v.bridge.startedAt++; }, v => { v.bridge = v.launcher; }, v => { v.supervisor = v.bridge; }, v => { v.bridge.pid = 1012; },
      v => { v.supervisor.pid = 1012; }, v => { v.launcher.pid = 0; }, v => { v.bridge.pid = 1.5; }, v => { v.extra = 1; },
    ];
    for (const change of cases) {
      const value = JSON.parse(valid); change(value); writeFileSync(path, JSON.stringify(value));
      expect(readMaintenanceReady(root, port, app, nonce)).toBeNull();
    }
    writeFileSync(path, valid); expect(readMaintenanceReady(root, port, app, nonce)).not.toBeNull();
    // the launch record must still name the same launcher
    const launchPath = maintenanceLaunchPath(root, port, app), launchText = readFileSync(launchPath, "utf8");
    writeFileSync(launchPath, JSON.stringify({ ...launch, launcher: { ...launch.launcher, startedAt: launch.launcher.startedAt + 1 } }));
    expect(readMaintenanceReady(root, port, app, nonce)).toBeNull(); writeFileSync(launchPath, launchText);
    // the lock must name this supervisor
    writeFileSync(join(lock, "pid"), String(bridge.pid)); expect(readMaintenanceReady(root, port, app, nonce)).toBeNull();
    writeFileSync(join(lock, "pid"), String(process.pid)); expect(readMaintenanceReady(root, port, app, nonce)).not.toBeNull();
    // unsafe files
    chmodSync(path, 0o644); expect(readMaintenanceReady(root, port, app, nonce)).toBeNull(); chmodSync(path, 0o600);
    const alias = join(root, "alias"); linkSync(path, alias); expect(readMaintenanceReady(root, port, app, nonce)).toBeNull(); rmSync(alias);
    rmSync(path); symlinkSync(join(root, "elsewhere"), path); writeFileSync(join(root, "elsewhere"), valid, { mode: 0o600 });
    expect(readMaintenanceReady(root, port, app, nonce)).toBeNull(); rmSync(path);
    writeFileSync(path, valid + " ".repeat(5000), { mode: 0o600 }); expect(readMaintenanceReady(root, port, app, nonce)).toBeNull();
    writeFileSync(path, "{malformed", { mode: 0o600 }); expect(readMaintenanceReady(root, port, app, nonce)).toBeNull();
    writeFileSync(path, valid, { mode: 0o600 }); chmodSync(join(path, ".."), 0o755); expect(readMaintenanceReady(root, port, app, nonce)).toBeNull(); chmodSync(join(path, ".."), 0o700);
    // a dead bridge (a reused PID cannot carry the same start time) never establishes readiness
    bridge.kill(); await bridge.exited; expect(readMaintenanceReady(root, port, app, nonce)).toBeNull();
    expect(existsSync(path)).toBe(true);
  } finally { if (bridge.exitCode === null) bridge.kill(); await bridge.exited; rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(!linux)("a ready record needs the matching launch record and the exact parent chain", () => {
  const root = mkdtempSync(join(tmpdir(), "maintenance-chain-unit-")), port = 12346, app = join(root, "app"), nonce = randomUUID();
  const bridge = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { stdout: "ignore", stderr: "ignore" });
  try {
    expect(() => writeMaintenanceReady(root, port, app, nonce, randomUUID(), process.ppid, bridge.pid)).toThrow("launch record");
    writeMaintenanceLaunch(root, port, app, nonce, process.ppid);
    expect(() => writeMaintenanceReady(root, port, app, randomUUID(), randomUUID(), process.ppid, bridge.pid)).toThrow("launch record");
    expect(() => writeMaintenanceReady(root, port, app, nonce, randomUUID(), process.pid, bridge.pid)).toThrow();
    expect(() => writeMaintenanceReady(root, port, app, nonce, randomUUID(), process.ppid, process.ppid)).toThrow();
    expect(() => writeMaintenanceReady(root, port, app, nonce, randomUUID(), process.ppid, 1012)).toThrow();
    expect(existsSync(maintenanceReadyPath(root, port, app))).toBe(false);
  } finally { bridge.kill(); rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(!linux || Bun.which("python3") === null)("the maintenance clock is the caller's Python time.monotonic_ns clock", () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = monotonicNs();
    const result = Bun.spawnSync(["python3", "-I", "-c", "import time; print(time.monotonic_ns())"], { stdout: "pipe", stderr: "pipe" });
    const after = monotonicNs();
    expect(result.exitCode).toBe(0);
    const python = BigInt(result.stdout.toString().trim());
    expect(python >= before && python <= after).toBe(true);
  }
});
