import { randomUUID } from "node:crypto";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { processStartedAt } from "./process-start.ts";
import { updateStateDir } from "./update-state.ts";

export interface ProcessIdentity { pid: number; startedAt: number }
export interface OwnerLauncher extends ProcessIdentity { version: 1; nonce: string }
export interface PrivateReadiness {
  version: 1; owner: true; root: string; port: number; nonce: string; boot_id: string;
  launcher: ProcessIdentity; supervisor: ProcessIdentity; bridge: ProcessIdentity;
}
const nonce = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
export function ownerStartupRequired(env: Record<string, string | undefined> = process.env): boolean {
  return !!(env["HERDR_WEB_OWNER_RP_ID"] || env["HERDR_WEB_OWNER_ORIGIN"]);
}
export function requirePrivateReadiness(platform: string = process.platform): void {
  if (platform !== "linux") throw new Error("Owner-mode private readiness is unsupported on this platform");
}
export function requireOwnerRelease(directory: string): void {
  if (!existsSync(join(directory, "server", "readiness.ts")) || !existsSync(join(directory, "server", "motoko-owner.ts"))) throw new Error("Owner mode requires a release with private readiness support");
}
export function processIdentity(pid: number): ProcessIdentity | null {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    if (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] === "Z") return null;
    const startedAt = processStartedAt(pid);
    return startedAt === null ? null : { pid, startedAt };
  } catch { return null; }
}
const sameProcess = (value: unknown): value is ProcessIdentity => {
  if (!value || typeof value !== "object") return false;
  const record = value as ProcessIdentity, current = processIdentity(record.pid);
  return current !== null && current.startedAt === record.startedAt;
};
function parent(pid: number): number | null {
  try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]); } catch { return null; }
}
function readPrivate(path: string): unknown {
  const directory = lstatSync(dirname(path));
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 || directory.uid !== process.getuid!()) throw new Error("Invalid private readiness directory");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid!()) throw new Error("Invalid private readiness file");
  return JSON.parse(readFileSync(path, "utf8"));
}
export function preparePrivateDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const directory = lstatSync(dirname(path));
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 || directory.uid !== process.getuid!()) throw new Error("Private readiness directory must be owner-only");
}
function writePrivate(path: string, value: unknown): void {
  preparePrivateDirectory(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" }); renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch {} }
}
export function writeOwnerLauncher(path: string, pid: number, launchNonce: string): OwnerLauncher {
  requirePrivateReadiness(); const identity = processIdentity(pid);
  if (!identity || !nonce(launchNonce)) throw new Error("Cannot identify the owner launcher");
  const record: OwnerLauncher = { version: 1, ...identity, nonce: launchNonce }; writePrivate(path, record); return record;
}
export function readOwnerLauncher(path: string, verifyLive = true): OwnerLauncher | null {
  try {
    const value = readPrivate(path) as OwnerLauncher;
    return value.version === 1 && nonce(value.nonce) && Number.isSafeInteger(value.pid) && value.pid > 0 && Number.isFinite(value.startedAt) && value.startedAt > 0 && (!verifyLive || sameProcess(value)) ? value : null;
  } catch { return null; }
}
export const readinessPath = (root: string, port: number, appStateDir?: string): string => join(updateStateDir(root, port, appStateDir), "ready.json");
export function writeReadiness(root: string, port: number, appStateDir: string, launchNonce: string, bootId: string, launcherPid: number, bridgePid: number): void {
  requirePrivateReadiness();
  const launcher = processIdentity(launcherPid), supervisor = processIdentity(process.pid), bridge = processIdentity(bridgePid);
  if (!launcher || !supervisor || !bridge || parent(supervisor.pid) !== launcher.pid || parent(bridge.pid) !== supervisor.pid || !nonce(launchNonce) || !nonce(bootId)) throw new Error("Cannot identify owner readiness processes");
  writePrivate(readinessPath(root, port, appStateDir), { version: 1, owner: true, root: resolve(root), port, nonce: launchNonce, boot_id: bootId, launcher, supervisor, bridge } satisfies PrivateReadiness);
}
export function readReadiness(root: string, port: number, appStateDir: string, launcher: OwnerLauncher | null): PrivateReadiness | null {
  if (!launcher || !sameProcess(launcher)) return null;
  try {
    const value = readPrivate(readinessPath(root, port, appStateDir)) as PrivateReadiness;
    if (value.version !== 1 || value.owner !== true || value.root !== resolve(root) || value.port !== port || value.nonce !== launcher.nonce || !nonce(value.boot_id)
      || !sameProcess(value.launcher) || value.launcher.pid !== launcher.pid || value.launcher.startedAt !== launcher.startedAt
      || !sameProcess(value.supervisor) || !sameProcess(value.bridge) || parent(value.supervisor.pid) !== launcher.pid || parent(value.bridge.pid) !== value.supervisor.pid) return null;
    return value;
  } catch { return null; }
}
export function clearReadiness(root: string, port: number, appStateDir: string, launchNonce: string): void {
  const path = readinessPath(root, port, appStateDir);
  try { const value = readPrivate(path) as PrivateReadiness; if (value.nonce === launchNonce) unlinkSync(path); } catch { /* absent or another launch */ }
}

/**
 * Legacy maintenance start: one private, one-time start of the unchanged legacy mode, for a caller
 * that stopped the old tree and holds an absolute CLOCK_MONOTONIC deadline. Both fields come from the
 * process environment only; neither is a credential. Owner mode and its records never take part.
 */
export interface MaintenanceStart { nonce: string; deadlineNs: bigint }
export interface MaintenanceLaunch { version: 1; mode: "legacy-maintenance"; root: string; port: number; nonce: string; launcher: ProcessIdentity }
export interface MaintenanceReady {
  version: 1; mode: "legacy-maintenance"; owner: false; root: string; port: number; nonce: string; boot_id: string;
  launcher: ProcessIdentity; supervisor: ProcessIdentity; bridge: ProcessIdentity;
}
export const MAINTENANCE_FIELDS = ["HERDR_WEB_MAINTENANCE_NONCE", "HERDR_WEB_MAINTENANCE_DEADLINE_NS"] as const;
export const MAINTENANCE_WINDOW_NS = 5_000_000_000n;
/**
 * Absolute CLOCK_MONOTONIC in ns, the clock of the caller's deadline (Python time.monotonic_ns).
 * Bun's process.hrtime.bigint() counts from this process's start, so it cannot carry that deadline.
 * 64-bit glibc Linux only, where timespec is two 64-bit fields.
 */
let clock: { read: () => number; buffer: BigInt64Array } | null = null;
export function monotonicNs(): bigint {
  if (!clock) {
    const libc = dlopen("libc.so.6", { clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 } }), buffer = new BigInt64Array(2);
    clock = { buffer, read: () => libc.symbols.clock_gettime(1 /* CLOCK_MONOTONIC */, ptr(buffer)) };
  }
  if (clock.read() !== 0) throw new Error("CLOCK_MONOTONIC is unavailable");
  return clock.buffer[0]! * 1_000_000_000n + clock.buffer[1]!;
}
export function maintenanceStart(env: Record<string, string | undefined> = process.env, now?: bigint, platform: string = process.platform): MaintenanceStart | null {
  const [value, deadline] = MAINTENANCE_FIELDS.map(name => env[name]);
  if (value === undefined && deadline === undefined) return null;
  if (value === undefined || deadline === undefined) throw new Error("Maintenance start needs both process fields");
  if (platform !== "linux") throw new Error("Maintenance start is supported on Linux only");
  if (!nonce(value)) throw new Error("Invalid maintenance nonce");
  if (!/^[1-9]\d{0,19}$/.test(deadline)) throw new Error("Invalid maintenance deadline");
  const deadlineNs = BigInt(deadline), remaining = deadlineNs - (now ?? monotonicNs());
  if (remaining <= 0n) throw new Error("Maintenance deadline expired");
  if (remaining > MAINTENANCE_WINDOW_NS) throw new Error("Maintenance deadline is more than five seconds away");
  if (ownerStartupRequired(env)) throw new Error("Maintenance start refuses owner configuration");
  if (env["HERDR_WEB_AUTO_UPDATE"] === "1") throw new Error("Maintenance start refuses automatic update installs");
  return { nonce: value, deadlineNs };
}
/** Milliseconds left before the absolute deadline; zero or less once it has passed. */
export const maintenanceLeft = (start: MaintenanceStart): number => Number(start.deadlineNs - monotonicNs()) / 1e6;
/** PID 1012 and invalid PIDs are refused before any process query. */
export const maintenanceQueryable = (pid: unknown): pid is number => Number.isSafeInteger(pid) && (pid as number) > 1 && pid !== 1012;
const maintenanceIdentity = (pid: number): ProcessIdentity | null => maintenanceQueryable(pid) ? processIdentity(pid) : null;
const maintenanceParent = (pid: number): number | null => maintenanceQueryable(pid) ? parent(pid) : null;
const sameMaintenanceProcess = (value: unknown): value is ProcessIdentity => {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== "pid,startedAt") return false;
  const record = value as ProcessIdentity;
  return maintenanceQueryable(record.pid) && Number.isFinite(record.startedAt) && record.startedAt > 0 && sameProcess(record);
};
const sameIdentity = (a: ProcessIdentity, b: ProcessIdentity): boolean => a.pid === b.pid && a.startedAt === b.startedAt;
const exactKeys = (value: object, keys: string): boolean => Object.keys(value).sort().join() === keys;
/** Single-link private files only: a hard link or symlink to the record is refused. */
function readMaintenance(path: string): unknown {
  if (lstatSync(path).nlink !== 1) throw new Error("Invalid maintenance record links");
  return readPrivate(path);
}
export const maintenanceLaunchPath = (root: string, port: number, appStateDir?: string): string => join(updateStateDir(root, port, appStateDir), "maintenance-launch.json");
export const maintenanceReadyPath = (root: string, port: number, appStateDir?: string): string => join(updateStateDir(root, port, appStateDir), "maintenance-ready.json");
export function writeMaintenanceLaunch(root: string, port: number, appStateDir: string | undefined, launchNonce: string, launcherPid = process.pid): MaintenanceLaunch {
  requirePrivateReadiness(); const launcher = maintenanceIdentity(launcherPid);
  if (!launcher || !nonce(launchNonce)) throw new Error("Cannot identify the maintenance launcher");
  const record: MaintenanceLaunch = { version: 1, mode: "legacy-maintenance", root: resolve(root), port, nonce: launchNonce, launcher };
  writePrivate(maintenanceLaunchPath(root, port, appStateDir), record); return record;
}
export function readMaintenanceLaunch(root: string, port: number, appStateDir: string | undefined, launchNonce: string): MaintenanceLaunch | null {
  try {
    const value = readMaintenance(maintenanceLaunchPath(root, port, appStateDir)) as MaintenanceLaunch;
    return value && typeof value === "object" && exactKeys(value, "launcher,mode,nonce,port,root,version") && value.version === 1 && value.mode === "legacy-maintenance"
      && value.root === resolve(root) && value.port === port && nonce(launchNonce) && value.nonce === launchNonce && sameMaintenanceProcess(value.launcher) ? value : null;
  } catch { return null; }
}
const lockPid = (root: string, port: number, appStateDir: string | undefined): number | null => {
  try {
    const path = join(updateStateDir(root, port, appStateDir), "supervisor.lock", "pid"), stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 32) return null;
    const text = readFileSync(path, "utf8");
    return /^[1-9]\d*\n?$/.test(text) ? Number(text) : null;
  } catch { return null; }
};
/** Called by the supervisor (this process) after its exact-boot health check passed. */
export function writeMaintenanceReady(root: string, port: number, appStateDir: string | undefined, launchNonce: string, bootId: string, launcherPid: number, bridgePid: number): MaintenanceReady {
  requirePrivateReadiness();
  const launch = readMaintenanceLaunch(root, port, appStateDir, launchNonce);
  if (!launch || launch.launcher.pid !== launcherPid) throw new Error("No matching maintenance launch record");
  const launcher = maintenanceIdentity(launcherPid), supervisor = maintenanceIdentity(process.pid), bridge = maintenanceIdentity(bridgePid);
  if (!launcher || !supervisor || !bridge || !sameIdentity(launcher, launch.launcher) || maintenanceParent(supervisor.pid) !== launcher.pid
    || maintenanceParent(bridge.pid) !== supervisor.pid || !nonce(bootId)) throw new Error("Cannot identify maintenance readiness processes");
  const record: MaintenanceReady = { version: 1, mode: "legacy-maintenance", owner: false, root: resolve(root), port, nonce: launchNonce, boot_id: bootId, launcher, supervisor, bridge };
  writePrivate(maintenanceReadyPath(root, port, appStateDir), record); return record;
}
export function readMaintenanceReady(root: string, port: number, appStateDir: string | undefined, launchNonce: string): MaintenanceReady | null {
  const launch = readMaintenanceLaunch(root, port, appStateDir, launchNonce);
  if (!launch) return null;
  try {
    const value = readMaintenance(maintenanceReadyPath(root, port, appStateDir)) as MaintenanceReady;
    if (!value || typeof value !== "object" || !exactKeys(value, "boot_id,bridge,launcher,mode,nonce,owner,port,root,supervisor,version")
      || value.version !== 1 || value.mode !== "legacy-maintenance" || value.owner !== false || value.root !== resolve(root) || value.port !== port
      || value.nonce !== launchNonce || !nonce(value.boot_id)
      || !sameMaintenanceProcess(value.launcher) || !sameMaintenanceProcess(value.supervisor) || !sameMaintenanceProcess(value.bridge)
      || !sameIdentity(value.launcher, launch.launcher) || maintenanceParent(value.supervisor.pid) !== value.launcher.pid
      || maintenanceParent(value.bridge.pid) !== value.supervisor.pid || lockPid(root, port, appStateDir) !== value.supervisor.pid) return null;
    return value;
  } catch { return null; }
}
export function clearMaintenanceReady(root: string, port: number, appStateDir: string | undefined, launchNonce: string): void {
  const path = maintenanceReadyPath(root, port, appStateDir);
  try { const value = readMaintenance(path) as MaintenanceReady; if (value.nonce === launchNonce) unlinkSync(path); } catch { /* absent or another launch */ }
}
