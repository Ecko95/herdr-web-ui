import { ownerStartupRequired, requirePrivateReadiness, requireOwnerRelease, writeReadiness, clearReadiness, MAINTENANCE_FIELDS, maintenanceStart, maintenanceLeft,
  maintenanceQueryable, readMaintenanceLaunch, writeMaintenanceReady, clearMaintenanceReady } from "./readiness.ts";
/**
 * The supervisor owns builds and bridge restarts; herdr continues to own every PTY.
 * server/managed.ts launches it from the active release, so an update replaces this code too:
 * after an install passes its health check the supervisor exits with HANDOVER_EXIT and the
 * launcher starts the new release's supervisor. `root` is always the source checkout.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { defaultStateDir, HANDOVER_EXIT, updateStateDir } from "./update-state.ts";
import { herdrSocketPath } from "./herdr/client.ts";
import { Updater, type Release } from "./updater.ts";
import { windowsProcessTable } from "./windows-processes.ts";

export async function runSupervisor(root = resolve(import.meta.dir, ".."), options: { startupTimeoutMs?: number } = {}) {
  root = resolve(root);
  const ownerMode = ownerStartupRequired();
  if (ownerMode) requirePrivateReadiness();
  const launchNonce = process.env["HERDR_WEB_LAUNCH_NONCE"] ?? "";
  const launcherPid = Number(process.env["HERDR_WEB_LAUNCHER_PID"]);
  if (ownerMode && (launcherPid !== process.ppid || !launchNonce)) throw new Error("Owner mode requires the managed launcher");
  const port = Number(process.env["PORT"] ?? DEFAULT_PORT);
  // a legacy maintenance start: this supervisor's first bridge only, before the absolute deadline; the bridge never sees the fields
  const maintenance = maintenanceStart();
  for (const name of MAINTENANCE_FIELDS) delete process.env[name];
  if (maintenance && (!maintenanceQueryable(launcherPid) || launcherPid !== process.ppid || readMaintenanceLaunch(root, port, undefined, maintenance.nonce)?.launcher.pid !== launcherPid)) {
    throw new Error("Maintenance start requires its exact managed launcher");
  }
  let pendingMaintenance = maintenance;
  const host = process.env["HOST"] ?? "127.0.0.1";
  const probeHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : host.includes(":") ? `[${host}]` : host;
  const origin = `http://${probeHost}:${port}`;
  const appStateDir = resolve(defaultStateDir());
  const socketPath = resolve(herdrSocketPath());
  const stateDir = updateStateDir(root, port);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lock = join(stateDir, "supervisor.lock");
  try { mkdirSync(lock); }
  catch {
    const pid = Number(readFileSync(join(lock, "pid"), "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0 || (maintenance && !maintenanceQueryable(pid))) throw new Error(`Invalid update lock: ${lock}`);
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
    if (alive && process.platform === "win32") {
      // Forced Windows shutdown skips lock cleanup; the old PID may now belong to someone else.
      const recordedAt = statSync(join(lock, "pid")).mtimeMs;
      const owner = (await windowsProcessTable()).find(row => row.pid === pid);
      if (owner?.started !== undefined && owner.started > recordedAt) {
        if (Number(readFileSync(join(lock, "pid"), "utf8")) !== pid || statSync(join(lock, "pid")).mtimeMs !== recordedAt) {
          throw new Error("Another server is starting. Try again.");
        }
        alive = false;
      }
    }
    if (alive) throw new Error("A managed server is already running for this checkout and port.");
    rmSync(lock, { recursive: true }); mkdirSync(lock);
  }
  writeFileSync(join(lock, "pid"), String(process.pid), { mode: 0o600 });
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let active: Release | null = null;
  let switching = true, stopping = false;
  // The bridge answers before its first health check has passed here. An install taken in that
  // gap stopped the bridge under the check, and the start failed: commands wait for the start.
  const started = Promise.withResolvers<void>();
  const publish = () => {
    if (updater.status.phase === "error") console.error(`Update failed: ${updater.status.error}`);
    try { child?.send({ type: "update-status", status: updater.status, notes: updater.notes, installed: updater.installed }); } catch { /* bridge restarting */ }
  };
  const invalidateReady = () => {
    if (ownerMode) clearReadiness(root, port, appStateDir, launchNonce);
    if (maintenance) clearMaintenanceReady(root, port, appStateDir, maintenance.nonce);
  };
  async function stopChild() {
    invalidateReady();
    const prior = child;
    child = null;
    if (!prior || prior.exitCode !== null) return;
    prior.kill("SIGTERM");
    const timer = setTimeout(() => prior.kill("SIGKILL"), 6000);
    await prior.exited;
    clearTimeout(timer);
  }
  async function launch(release: Release | null) {
    if (stopping) throw new Error("Server is stopping");
    if (ownerMode) requireOwnerRelease(release?.directory ?? root);
    const once = pendingMaintenance;
    pendingMaintenance = null;
    if (once && ((release && release.directory !== root) || maintenanceLeft(once) <= 0)) throw new Error("Maintenance start runs this checkout before its deadline only");
    const bootId = crypto.randomUUID();
    const privateStatus: { value: "pending" | "ready" | "failed" } = { value: "pending" };
    const candidate = Bun.spawn([process.execPath, "server/index.ts"], {
      cwd: release?.directory ?? root, windowsHide: true, stdin: "ignore", stdout: "inherit", stderr: "inherit",
      env: { ...process.env, HERDR_WEB_MANAGED: "1", HERDR_WEB_BOOT_ID: bootId,
        HERDR_WEB_STATE_DIR: appStateDir, HERDR_SOCKET: socketPath,
        HERDR_WEB_REVISION: release?.revision ?? "" },
      ipc(message) {
        if (ownerMode && message?.type === "bridge-ready" && message.boot_id === bootId && message.protocol === 1 && message.owner === true) {
          if (message.status === "ready" && message.port === port) privateStatus.value = "ready";
          else if (message.status === "failed") { privateStatus.value = "failed"; invalidateReady(); }
        }
        if (message?.type === "update-status-request") publish();
        if (message?.type === "update-command" && (message.command === "check" || message.command === "install")) {
          const command = message.command;
          void started.promise.then(() => updater.request(command));
        }
      },
      onExit(proc, code) {
        if (child === proc) invalidateReady();
        if (child === proc && !switching && !stopping) {
          console.error(`Bridge exited unexpectedly (${code}).`);
          void shutdown(1);
        }
      },
    });
    child = candidate;
    const deadline = Date.now() + (options.startupTimeoutMs ?? 20_000);
    const untilDeadline = () => once ? maintenanceLeft(once) : deadline - Date.now();
    while (untilDeadline() > 0 && !stopping && candidate.exitCode === null) {
      if (ownerMode) {
        if (privateStatus.value === "failed") break;
        if (privateStatus.value === "ready") { writeReadiness(root, port, appStateDir, launchNonce, bootId, launcherPid, candidate.pid); publish(); return; }
        await Bun.sleep(25);
        continue;
      }
      let booted = false;
      try {
        const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(Math.max(1, Math.min(1000, Math.ceil(untilDeadline())))) });
        const body = await response.json() as { web_ui?: { boot_id?: string } };
        booted = response.ok && body.web_ui?.boot_id === bootId;
      } catch { /* wait for this exact bridge, never mistake another port owner for it */ }
      if (booted) {
        if (!once) { publish(); return; }
        // a shutdown may have started while the health answer was awaited: it owns this bridge now, so publish nothing
        if (stopping || child !== candidate || candidate.exitCode !== null) break;
        // ready only before the deadline, checked on both sides of the write; a late record is removed below
        if (untilDeadline() > 0) { writeMaintenanceReady(root, port, appStateDir, once.nonce, bootId, launcherPid, candidate.pid); if (untilDeadline() > 0) { publish(); return; } }
        break;
      }
      await Bun.sleep(Math.max(0, Math.min(100, untilDeadline())));
    }
    await stopChild();
    throw new Error(ownerMode ? "Owner bridge readiness failed" : once ? "The maintenance bridge was not ready before its deadline." : "The new bridge failed its startup health check.");
  }
  const pluginRoot = process.env["HERDR_PLUGIN_ROOT"];
  // only a launcher-started supervisor can hand over: run directly, it keeps serving the update itself
  const launched = typeof process.send === "function";
  const updater = new Updater({ root, stateDir, autoUpdate: process.env["HERDR_WEB_AUTO_UPDATE"] === "1", publish,
    pluginCheckout: pluginRoot !== undefined && resolve(pluginRoot) === root,
    notice: process.env["HERDR_WEB_SUPERVISOR_FALLBACK"]
      ? "The updated supervisor failed to start, so the previous one is running this version. The next update tries again."
      : undefined,
    async afterInstall() {
      // a fallback supervisor hands over too: afterInstall only follows a newer release, never the one that failed
      if (!launched || stopping) return;
      console.log("Update installed; handing over to the new supervisor.");
      await shutdown(HANDOVER_EXIT);
    },
    async activate(next, commit) {
      if (ownerMode) requireOwnerRelease(next.directory);
      switching = true;
      try {
        await stopChild();
        try { await launch(next); commit(); }
        catch (error) {
          await stopChild();
          await launch(active);
          throw new Error(`${error instanceof Error ? error.message : error} Previous version restored.`);
        }
        active = next;
      } finally { switching = false; }
    },
  });
  async function shutdown(code: number) {
    if (stopping) return;
    stopping = true; updater.stop();
    await stopChild();
    rmSync(lock, { recursive: true, force: true });
    process.exit(code);
  }
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  try {
    active = await updater.initialize();
    try { await launch(active); }
    catch (error) {
      if (ownerMode || maintenance || !active || active.directory === root) throw error;
      console.error("Saved release failed; starting the source checkout.", error);
      rmSync(join(stateDir, "current.json"), { force: true });
      active = await updater.initialize();
      await launch(active);
    }
    switching = false;
    started.resolve();
    updater.start();
    process.send?.({ type: "supervisor-ready" });
    console.log(`Managed updates: ${updater.status.auto_update ? "automatic install" : "automatic checks, install from Settings"}`);
  } catch (error) {
    console.error(error);
    await shutdown(1);
  }
}

if (import.meta.main) await runSupervisor(process.env["HERDR_WEB_SOURCE_ROOT"] || resolve(import.meta.dir, ".."));
