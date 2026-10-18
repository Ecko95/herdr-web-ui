/**
 * Managed startup, upgrade and rollback in owner mode, against disposable process trees: run it
 * only through the controlled runner, which gives it a temporary home, config and herdr session
 * (scripts/motoko-env.ts):
 *
 *   HERDR_TEST_MODE=integration bun scripts/motoko-env.ts bun scripts/motoko-upgrade-qa.ts --out=<dir>
 *
 * Each scenario copies this checkout into a temporary Git repository on `main` (the updater only
 * resumes a saved release from a clean checkout) and drives the real scripts/plugin.ts,
 * server/managed.ts, server/supervisor.ts and server/index.ts. Owner and legacy stores are
 * synthetic. A release that lacks owner mode is the baseline commit (BASELINE), unpacked from Git.
 * Nothing reads a real account, real state or the user's herdr. Results go to --out/results.json.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { useTestHerdr } from "./test-herdr.ts";
import { processStartedAt } from "../server/process-start.ts";
import { updateStateDir } from "../server/update-state.ts";
import { createCoordination, envelope } from "../server/motoko-coordination.ts";

const BASELINE = "95507e2ea66c53eefaed58dd923ec21111118a2e";
const ROOT = resolve(import.meta.dir, "..");
const out = process.argv.find((value) => value.startsWith("--out="))?.slice(6) ?? null;
const only = process.argv.find((value) => value.startsWith("--only="))?.slice(7).split(",") ?? null;
if (!out) throw new Error("Usage: motoko-upgrade-qa.ts --out=<dir> [--only=name,...]");
if (!process.env["HOME"]?.startsWith(tmpdir()) && !process.env["HOME"]?.includes("motoko-proof-")) throw new Error("Run this through scripts/motoko-env.ts: HOME is not a temporary one");
if (process.platform !== "linux") throw new Error("Owner private readiness is Linux only");
mkdirSync(out, { recursive: true });
const herdrSocket = await useTestHerdr();
const work = mkdtempSync(join(tmpdir(), "motoko-upgrade-"));

// ---- disposable checkouts ----

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "qa", GIT_AUTHOR_EMAIL: "qa@invalid", GIT_COMMITTER_NAME: "qa", GIT_COMMITTER_EMAIL: "qa@invalid" } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/** A clean `main` repository with `files` copied from `from`, sharing this checkout's dependencies. */
function repository(target: string, copy: (target: string) => void): string {
  mkdirSync(target, { recursive: true });
  copy(target);
  symlinkSync(join(ROOT, "node_modules"), join(target, "node_modules"));
  git(target, "init", "-q", "-b", "main");
  // the symlink is not the directory .gitignore names
  writeFileSync(join(target, ".git", "info", "exclude"), "node_modules\n");
  git(target, "add", "-A");
  git(target, "commit", "-q", "-m", "disposable");
  return git(target, "rev-parse", "HEAD");
}

/** This checkout, as committed source: the candidate the owner would run. */
function sourceCheckout(target: string): string {
  return repository(target, (dir) => {
    for (const file of git(ROOT, "ls-files", "-co", "--exclude-standard").split("\n").filter(Boolean)) {
      // a checkout that links its dependencies has node_modules as a file .gitignore's "node_modules/" does not name
      if (!existsSync(join(ROOT, file)) || file === "node_modules") continue;
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      cpSync(join(ROOT, file), join(dir, file));
    }
    if (existsSync(join(ROOT, "dist"))) cpSync(join(ROOT, "dist"), join(dir, "dist"), { recursive: true });
  });
}

/** The baseline commit, which has no owner mode: the release an owner-to-legacy fallback would run. */
function legacyTree(target: string): string {
  return repository(target, (dir) => {
    const archive = spawnSync("sh", ["-c", `git -C '${ROOT}' archive ${BASELINE} | tar -x -C '${dir}'`]);
    if (archive.status !== 0) throw new Error(`git archive: ${archive.stderr}`);
  });
}

// ---- one disposable installation ----

interface Install { name: string; dir: string; src: string; head: string; pluginState: string; config: string; appState: string; port: number; updates: string }

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = server.port!;
  await server.stop(true);
  return port;
}

async function install(name: string, owner: boolean): Promise<Install> {
  const dir = join(work, name);
  const src = join(dir, "src");
  const head = sourceCheckout(src);
  const port = await freePort();
  const config = join(dir, "plugin-config"), pluginState = join(dir, "plugin-state"), appState = join(dir, "app-state");
  for (const path of [config, pluginState, appState]) mkdirSync(path, { recursive: true, mode: 0o700 });
  // owner settings reach the plugin the way a user sets them: in its settings file
  writeFileSync(join(config, ".env"), [`PORT=${port}`, "HOST=127.0.0.1", ...(owner ? ["HERDR_WEB_OWNER_RP_ID=localhost", `HERDR_WEB_OWNER_ORIGIN=http://localhost:${port}`] : [])].join("\n") + "\n");
  return { name, dir, src, head, pluginState, config, appState, port, updates: updateStateDir(src, port, appState) };
}

function pluginEnv(at: Install): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^(PORT|HOST|HERDR_WEB_|HERDR_PLUGIN_)/.test(key)) env[key] = value;
  return { ...env, HERDR_PLUGIN_ROOT: at.src, HERDR_PLUGIN_STATE_DIR: at.pluginState, HERDR_PLUGIN_CONFIG_DIR: at.config, HERDR_WEB_STATE_DIR: at.appState, ...(herdrSocket ? { HERDR_SOCKET_PATH: herdrSocket } : {}) };
}

interface Run { out: string; err: string; code: number; ms: number }
async function plugin(at: Install, command: string): Promise<Run> {
  const started = Date.now();
  const child = Bun.spawn([process.execPath, join(at.src, "scripts", "plugin.ts"), command], { cwd: at.src, env: pluginEnv(at), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out: stdout, err: stderr, code, ms: Date.now() - started };
}

const serverLog = (at: Install): string => { try { return readFileSync(join(at.pluginState, "server.log"), "utf8"); } catch { return ""; } };

/** The pid the plugin recorded: numeric text for legacy, owner JSON for owner mode. */
function recorded(at: Install): { pid: number; startedAt?: number; nonce?: string } | null {
  try {
    const text = readFileSync(join(at.pluginState, "server.pid"), "utf8").trim();
    if (/^\d+$/.test(text)) return { pid: Number(text) };
    return JSON.parse(text) as { pid: number; startedAt: number; nonce: string };
  } catch { return null; }
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const groupAlive = (pgid: number): boolean => { try { process.kill(-pgid, 0); return true; } catch { return false; } };

/** Whatever this installation left running, killed: a failed scenario must not leak a server. */
function reap(at: Install, extra: number[] = []): void {
  const pid = recorded(at)?.pid;
  for (const group of [pid, ...extra]) if (group && groupAlive(group)) { try { process.kill(-group, "SIGKILL"); } catch {} }
  for (const member of livePids(at.src)) { try { process.kill(member, "SIGKILL"); } catch {} }
}

/** Live processes whose argv names a file under `root` (the launcher, supervisors and bridges of one install). */
function livePids(root: string): number[] {
  const pids: number[] = [];
  for (const entry of new Bun.Glob("[0-9]*").scanSync({ cwd: "/proc", onlyFiles: false })) {
    try {
      const argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      const cwd = readlinkSync(`/proc/${entry}/cwd`);
      const state = readFileSync(`/proc/${entry}/stat`, "utf8").split(") ")[1]!.split(" ")[0];
      if (state === "Z") continue;
      if (argv.some((arg) => arg.startsWith(root)) || (cwd.startsWith(root) && argv.some((arg) => arg.endsWith(".ts")))) pids.push(Number(entry));
    } catch { /* gone meanwhile */ }
  }
  return pids;
}

async function get(at: Install, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<{ status: number; body: unknown }> {
  try {
    const response = await fetch(`http://127.0.0.1:${at.port}${path}`, { method, headers, signal: AbortSignal.timeout(3000) });
    const text = await response.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch {}
    return { status: response.status, body };
  } catch (error) { return { status: 0, body: String(error) }; }
}

const listening = async (at: Install): Promise<boolean> => (await get(at, "/api/health")).status !== 0;

// ---- synthetic stores ----

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const fileHash = (path: string): string | null => existsSync(path) ? sha(readFileSync(path, "utf8")) : null;

/** An owner store with one active passkey and the given sessions; tokens are the cookies that match them. */
function ownerStore(at: Install, tokens: string[]): Record<string, string> {
  const now = Date.now();
  const ids: Record<string, string> = {};
  const sessions = tokens.map((token, index) => {
    ids[token] = `session-${index}`;
    return { id: `session-${index}`, token_hash: sha(token), credential_id: "credential-1", created_at: now, last_active_at: now, idle_expires_at: now + 30 * 60_000, absolute_expires_at: now + 12 * 3_600_000, observed_ip: "127.0.0.1", user_agent: "upgrade-qa" };
  });
  writeFileSync(join(at.appState, "owner.json"), JSON.stringify({ version: 1, credentials: [{ id: "credential-1", label: "Synthetic", public_key: "c3ludGhldGlj", alg: -7, counter: 0, status: "active", created_at: now, last_used_at: now, grant_id: null }], sessions }), { mode: 0o600 });
  return ids;
}

/** The legacy files an installed release keeps, with synthetic content. */
const LEGACY_FILES = {
  "devices.json": JSON.stringify({ devices: [{ id: "device-synthetic", name: "Synthetic phone", created_at: 1, last_seen_at: 1, token_hash: "0".repeat(64) }], gate_closed_at: null }),
  "preferences.json": JSON.stringify({ revision: 3, settings: { theme: "dark" } }),
  "voice.json": JSON.stringify({ provider: null }),
  "plugin-port": "",
  // the owner's request receipts (server/motoko-coordination.ts), valid for its reader: kept byte for byte and still usable
  "coordination.json": JSON.stringify({ version: 1, receipts: [{ requestId: "5c9f4a5c-1d2e-4f60-8a9b-0c1d2e3f4a5b", qitemId: "qitem-motoko-5c9f4a5c-1d2e-4f60-8a9b-0c1d2e3f4a5b", createdAt: "2026-10-18T00:00:00.000Z", text: "Synthetic request", textSha256: createHash("sha256").update("Synthetic request").digest("hex"), rigId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", sourceSession: "fiction-owner@external", destinationSession: "team-orchestrator@fiction-lab", origin: { kind: "motoko-owner", sessionId: "session-synthetic", ownerOrigin: "http://localhost", checkedAt: "2026-10-18T00:00:00.000Z" } }] }),
};
function legacyState(at: Install): Record<string, string | null> {
  for (const [name, content] of Object.entries(LEGACY_FILES)) if (name !== "plugin-port") writeFileSync(join(at.appState, name), content, { mode: 0o600 });
  return stateHashes(at);
}
function stateHashes(at: Install): Record<string, string | null> {
  return Object.fromEntries(["devices.json", "preferences.json", "voice.json", "coordination.json", "owner.json", "owner.dirty"].map((name) => [name, fileHash(join(at.appState, name))]));
}

/** A saved release under the update namespace, as the updater writes it (server/updater.ts). */
function saveRelease(at: Install, name: string, make: (target: string) => string): string {
  mkdirSync(at.updates, { recursive: true, mode: 0o700 });
  const directory = join(at.updates, `release-${name}`);
  const revision = make(directory);
  writeFileSync(join(at.updates, "current.json"), JSON.stringify({ directory, revision, source_revision: at.head }));
  return directory;
}

/**
 * Usable receipt recovery, apart from byte preservation: a new coordination module over the kept state reads the
 * same request and queue IDs, and an explicit retry after that restart selects the one existing fake queue item.
 */
async function receiptRecovered(at: Install, check: (label: string, ok: boolean, detail?: unknown) => void): Promise<void> {
  const path = join(at.appState, "coordination.json"), before = fileHash(path);
  const receipt = JSON.parse(readFileSync(path, "utf8")).receipts[0];
  const items = new Map([[receipt.qitemId, { qitemId: receipt.qitemId, sourceSession: receipt.sourceSession, destinationSession: receipt.destinationSession, body: envelope(receipt), state: "pending", tsUpdated: receipt.createdAt }]]);
  const reply = (value: unknown) => ({ status: 200, bytes: new TextEncoder().encode(JSON.stringify(value)) });
  const queue = {
    async create(input: { qitemId: string }) { if (!items.has(input.qitemId)) throw new Error("unexpected new queue item"); return reply(items.get(input.qitemId)); },
    async item(id: string) { return reply(items.get(id)); },
    async transitions() { return reply([]); },
  };
  const owner = { sessionId: "later-synthetic-sign-in", origin: receipt.origin.ownerOrigin, recheck() {} };
  const restart = () => createCoordination({ stateDir: at.appState, binding: { rigId: receipt.rigId, sourceSession: receipt.sourceSession, destinationSession: receipt.destinationSession }, queue, now: Date.now });
  const history = await restart().history(owner, new AbortController().signal);
  const first = history.requests[0];
  check("a restarted module recovers the same request and queue IDs", history.requests.length === 1 && first?.requestId === receipt.requestId && first?.qitemId === receipt.qitemId && first?.queue.status === "known", first ?? null);
  await restart().submit(owner, { requestId: receipt.requestId, text: receipt.text });
  check("an explicit retry after restart selects one queue item and keeps the receipt bytes", items.size === 1 && fileHash(path) === before, { items: items.size, unchanged: fileHash(path) === before });
}

// ---- checks ----

const REDACTED = (enrolled: boolean, reason = "owner_required") => ({ ok: true, auth: { required: true, authenticated: false, reason, owner: { enrolled } } });
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

interface Check { name: string; ok: boolean; detail: unknown }
interface Result { scenario: string; requirement: string; ok: boolean; checks: Check[]; ms: number; error?: string }
const results: Result[] = [];

async function scenario(name: string, requirement: string, run: (check: (label: string, ok: boolean, detail?: unknown) => void) => Promise<void>): Promise<void> {
  if (only && !only.includes(name)) return;
  const checks: Check[] = [];
  const started = Date.now();
  let error: string | undefined;
  try { await run((label, ok, detail) => { checks.push({ name: label, ok, detail: detail ?? null }); }); }
  catch (caught) { error = caught instanceof Error ? caught.stack ?? caught.message : String(caught); }
  const ok = error === undefined && checks.length > 0 && checks.every((c) => c.ok);
  results.push({ scenario: name, requirement, ok, checks, ms: Date.now() - started, ...(error ? { error } : {}) });
  console.log(`${ok ? "ok" : "FAIL"} - ${name} (${Date.now() - started} ms)`);
  for (const c of checks.filter((c) => !c.ok)) console.log(`    not ok: ${c.name} ${JSON.stringify(c.detail).slice(0, 600)}`);
  if (error) console.log(`    error: ${error.split("\n")[0]}`);
}

/** The private descriptor build-sol's contract defines: updateStateDir(ROOT, port, APP_STATE_DIR)/ready.json. */
const readyPath = (at: Install) => join(at.updates, "ready.json");
function readyDescriptor(at: Install): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(readyPath(at), "utf8")) as Record<string, unknown>; } catch { return null; }
}

// 1, 2: a cold start with no browser session, the redacted health it serves, an idempotent second start
await scenario("owner-cold-start", "1, 2, 3", async (check) => {
  const at = await install("owner-cold", true);
  try {
    const first = await plugin(at, "start");
    check("start exits 0", first.code === 0, { code: first.code, err: first.err.slice(-800), log: serverLog(at).slice(-1200) });
    check("start says it listens", first.out.includes("listening at"), first.out);
    const pid = recorded(at);
    check("pid record is owner JSON bound to its start identity", pid !== null && typeof pid.nonce === "string" && pid.startedAt === processStartedAt(pid.pid), pid);
    const ready = readyDescriptor(at);
    check("ready.json binds launcher, supervisor and bridge", ready !== null && ready["owner"] === true && ready["port"] === at.port && ready["root"] === at.src
      && ["launcher", "supervisor", "bridge"].every((role) => { const p = ready[role] as { pid?: number; startedAt?: number } | undefined; return p?.pid !== undefined && alive(p.pid) && p.startedAt === processStartedAt(p.pid); })
      && (ready["launcher"] as { pid: number }).pid === pid?.pid && ready["nonce"] === pid?.nonce, ready);
    const health = await get(at, "/api/health"), bridge = await get(at, "/api/health?scope=bridge");
    check("public health is exactly the redacted owner shape", health.status === 200 && same(health.body, REDACTED(false)), health);
    check("bridge-scope health is exactly the redacted owner shape", bridge.status === 200 && same(bridge.body, REDACTED(false)), bridge);
    const before = livePids(at.src).sort();
    const second = await plugin(at, "start");
    check("second start is idempotent", second.code === 0 && second.out.includes("already running"), second);
    check("second start opens no second instance", same(livePids(at.src).sort(), before) && same(recorded(at), pid), { before, after: livePids(at.src) });
    const stopped = await plugin(at, "stop");
    check("stop exits 0", stopped.code === 0, stopped);
    check("stop leaves nothing running", livePids(at.src).length === 0 && !(await listening(at)), livePids(at.src));
    check("stop removes ready.json", !existsSync(readyPath(at)), readyDescriptor(at));
  } finally { reap(at); }
});

// 1: a restart after the owner enrolled, with no browser cookie
await scenario("owner-enrolled-restart", "1, 2", async (check) => {
  const at = await install("owner-enrolled", true);
  try {
    ownerStore(at, []);
    for (const round of [1, 2]) {
      const started = await plugin(at, "start");
      check(`start ${round} exits 0 with an enrolled owner`, started.code === 0, { err: started.err.slice(-800), log: serverLog(at).slice(-1200) });
      const health = await get(at, "/api/health?scope=bridge");
      check(`start ${round} health says enrolled, redacted`, same(health.body, REDACTED(true)), health);
      const stopped = await plugin(at, "stop");
      check(`stop ${round} exits 0`, stopped.code === 0, stopped);
      check(`stop ${round} leaves the owner store clean`, !existsSync(join(at.appState, "owner.dirty")), stateHashes(at));
    }
  } finally { reap(at); }
});

// 3: a stranger on the port forges every field any health check reads
await scenario("owner-stranger-listener", "3", async (check) => {
  const at = await install("owner-stranger", true);
  const forged = { ok: true, herdr: { version: "0.9.3", protocol: 1 }, bridge_protocol: 1, web_ui: { boot_id: "forged" }, auth: { required: false, authenticated: true } };
  for (const answer of [forged, REDACTED(true)]) {
    const stranger = Bun.serve({ hostname: "127.0.0.1", port: at.port, fetch: () => Response.json(answer) });
    try {
      const started = await plugin(at, "start");
      const label = answer === forged ? "forged legacy health" : "the redacted owner shape";
      check(`start refuses ${label}`, started.code !== 0 && !started.out.includes("already running"), started);
      check(`start with ${label} spawns no server`, livePids(at.src).length === 0, livePids(at.src));
      check(`start with ${label} moves to no other port`, !existsSync(join(at.appState, "plugin-port")) || readFileSync(join(at.appState, "plugin-port"), "utf8").trim() === "", null);
    } finally { await stranger.stop(true); reap(at); }
  }
});

// 4: stale, reused and mismatched process records never satisfy readiness, and stop never signals them
await scenario("owner-stale-identity", "4", async (check) => {
  const at = await install("owner-stale", true);
  // a live process that is not ours, in its own group, standing where a recorded launcher was
  const foreign = spawn("sleep", ["120"], { detached: true, stdio: "ignore" });
  const pid = foreign.pid!;
  const startedAt = processStartedAt(pid)!;
  const stranger = Bun.serve({ hostname: "127.0.0.1", port: at.port, fetch: () => Response.json(REDACTED(false)) });
  try {
    const cases: [string, unknown, unknown][] = [
      ["a reused pid (start identity differs)", { version: 1, pid, startedAt: startedAt - 60_000, nonce: "n1" }, { pid, startedAt: startedAt - 60_000 }],
      ["a live pid whose descriptor nonce differs", { version: 1, pid, startedAt, nonce: "n1" }, { pid, startedAt }],
      ["a malformed descriptor", { version: 1, pid, startedAt, nonce: "n1" }, null],
    ];
    for (const [label, record, identity] of cases) {
      writeFileSync(join(at.pluginState, "server.pid"), JSON.stringify(record), { mode: 0o600 });
      mkdirSync(at.updates, { recursive: true, mode: 0o700 });
      writeFileSync(readyPath(at), identity === null ? "{not json" : JSON.stringify({ version: 1, owner: true, root: at.src, port: at.port, nonce: label.includes("nonce") ? "n2" : "n1", boot_id: "b", launcher: identity, supervisor: identity, bridge: identity }), { mode: 0o600 });
      const started = await plugin(at, "start");
      check(`start does not take ${label} for a running server`, started.code !== 0 && !started.out.includes("already running"), started);
      // stop trusts a pid record whose start identity matches: only a reused pid is stale to it
      if (!label.startsWith("a reused pid")) continue;
      const stopped = await plugin(at, "stop");
      check(`stop fails closed on ${label}`, stopped.code === 1, stopped);
      check(`stop leaves the foreign process for ${label} alive`, alive(pid), null);
      check(`stop keeps the pid record for ${label}`, existsSync(join(at.pluginState, "server.pid")), null);
    }
  } finally { await stranger.stop(true); foreign.kill("SIGKILL"); reap(at); }
});

/** A bridge stand-in: it serves health with the boot id the supervisor gave it, and behaves as `mode` says over IPC. */
function standIn(mode: "silent" | "wrong-nonce" | "stubborn"): string {
  return `
const port = Number(process.env.PORT), boot = process.env.HERDR_WEB_BOOT_ID;
${mode === "stubborn" ? 'process.on("SIGTERM", () => {});' : ""}
Bun.serve({ hostname: "127.0.0.1", port, fetch: () => Response.json({ ok: true, herdr: { version: "0.9.3", protocol: 1 }, bridge_protocol: 1, web_ui: { boot_id: boot }, auth: { required: false, authenticated: true } }) });
${mode === "wrong-nonce" ? 'process.send?.({ type: "bridge-ready", boot_id: crypto.randomUUID(), protocol: 1, owner: true, status: "ready" });' : ""}
setInterval(() => {}, 1000);
`;
}

// 5: the supervisor's deadline holds against a bridge that never cooperates (started by the real launcher)
await scenario("owner-uncooperative-child", "5", async (check) => {
  for (const mode of ["silent", "wrong-nonce", "stubborn"] as const) {
    const at = await install(`owner-child-${mode}`, true);
    // the source checkout whose bridge is the stand-in; readiness and owner modules stay, so the release check passes
    writeFileSync(join(at.src, "server", "index.ts"), standIn(mode));
    git(at.src, "commit", "-qam", "stand-in");
    const started = Date.now();
    // its own group and a log file: a bridge that outlives a killed supervisor must hold no pipe of ours
    const logFile = join(at.dir, "supervisor.log");
    const log = openSync(logFile, "a");
    const supervisor = spawn(process.execPath, [join(at.src, "server", "managed.ts")], {
      cwd: at.src, detached: true, stdio: ["ignore", log, log],
      env: { ...pluginEnv(at), HERDR_WEB_SOURCE_ROOT: at.src, PORT: String(at.port), HOST: "127.0.0.1", HERDR_WEB_OWNER_RP_ID: "localhost", HERDR_WEB_OWNER_ORIGIN: `http://localhost:${at.port}` },
    });
    closeSync(log);
    const group = supervisor.pid!;
    try {
      const code = await new Promise<number | null>((resolve) => {
        const watchdog = setTimeout(() => { try { process.kill(-group, "SIGKILL"); } catch {} }, 60_000);
        supervisor.once("exit", (exit) => { clearTimeout(watchdog); resolve(exit); });
      });
      const ms = Date.now() - started;
      check(`${mode}: supervisor fails`, code !== 0, { code, log: readFileSync(logFile, "utf8").slice(-600) });
      check(`${mode}: supervisor stops at its own deadline (20 s, plus 6 s to kill)`, ms >= 19_000 && ms < 35_000, { ms });
      check(`${mode}: no bridge survives`, livePids(at.src).length === 0 && !(await listening(at)), livePids(at.src));
      check(`${mode}: no ready descriptor`, !existsSync(readyPath(at)), readyDescriptor(at));
    } finally { reap(at, [group]); }
  }
});

// 6: legacy startup and stop keep their existing contract
await scenario("legacy-start-stop", "6", async (check) => {
  const at = await install("legacy", false);
  try {
    check("a test herdr answers", herdrSocket !== null, herdrSocket);
    const started = await plugin(at, "start");
    check("legacy start exits 0", started.code === 0 && started.out.includes("listening at"), { err: started.err.slice(-800), log: serverLog(at).slice(-1200) });
    check("legacy pid record stays numeric text", /^\d+\n$/.test(readFileSync(join(at.pluginState, "server.pid"), "utf8")), readFileSync(join(at.pluginState, "server.pid"), "utf8"));
    const health = await get(at, "/api/health"), bridge = await get(at, "/api/health?scope=bridge");
    const body = health.body as { ok?: unknown; herdr?: unknown; web_ui?: { boot_id?: unknown } };
    check("legacy full health keeps herdr and web_ui", health.status === 200 && body.ok === true && typeof body.herdr === "object" && typeof body.web_ui?.boot_id === "string", health);
    check("legacy bridge health keeps bridge_protocol", bridge.status === 200 && Number.isInteger((bridge.body as { bridge_protocol?: unknown }).bridge_protocol), bridge);
    check("legacy writes no owner descriptor", !existsSync(readyPath(at)), readyDescriptor(at));
    const second = await plugin(at, "start");
    check("legacy second start is idempotent", second.code === 0 && second.out.includes("already running"), second);
    const stopped = await plugin(at, "stop");
    check("legacy stop exits 0 and leaves nothing", stopped.code === 0 && livePids(at.src).length === 0, stopped);
  } finally { reap(at); }
});

// 7: downgrade refusal: an owner start never runs a release without owner mode, and keeps the fixture state
await scenario("owner-to-legacy-fallback", "7", async (check) => {
  const at = await install("owner-legacy-release", true);
  try {
    const before = legacyState(at);
    ownerStore(at, []);
    const ownerBefore = stateHashes(at);
    saveRelease(at, "legacy", legacyTree);
    let legacyAnswered = false;
    const watch = setInterval(async () => {
      const health = await get(at, "/api/health?scope=bridge");
      if (health.status === 200 && (health.body as { bridge_protocol?: unknown }).bridge_protocol !== undefined) legacyAnswered = true;
    }, 200);
    const started = await plugin(at, "start");
    clearInterval(watch);
    check("start refuses a legacy release in owner mode", started.code !== 0, { out: started.out, err: started.err.slice(-600) });
    check("the refusal names private readiness support", serverLog(at).includes("Owner mode requires a release with private readiness support"), serverLog(at).slice(-1200));
    check("no legacy admission answered meanwhile", !legacyAnswered, null);
    check("nothing is left running", livePids(at.src).length === 0 && livePids(at.updates).length === 0 && !(await listening(at)), [...livePids(at.src), ...livePids(at.updates)]);
    check("legacy fixture state is unchanged", same({ ...stateHashes(at), "owner.json": before["owner.json"] }, { ...before, "owner.json": before["owner.json"] }) || same(stateHashes(at), ownerBefore), { before: ownerBefore, after: stateHashes(at) });
    check("owner store is unchanged", stateHashes(at)["owner.json"] === ownerBefore["owner.json"], stateHashes(at));
    await receiptRecovered(at, check);
  } finally { reap(at); }
});

// 7, 8: an owner release that fails activation keeps state and does not fall back to the source checkout
await scenario("owner-failed-activation", "7, 8", async (check) => {
  const at = await install("owner-failed-release", true);
  try {
    legacyState(at);
    ownerStore(at, []);
    const before = stateHashes(at);
    saveRelease(at, "broken", (target) => repository(target, (dir) => {
      cpSync(at.src, dir, { recursive: true, filter: (path) => !path.includes("/.git") && !path.endsWith("/node_modules") });
      writeFileSync(join(dir, "server", "index.ts"), 'console.error("synthetic activation failure"); process.exit(1);\n');
    }));
    const started = await plugin(at, "start");
    check("start fails with the broken release", started.code !== 0, { out: started.out, err: started.err.slice(-600) });
    check("no fallback to the source checkout", !serverLog(at).includes("starting the source checkout"), serverLog(at).slice(-1500));
    check("nothing is left running", livePids(at.src).length === 0 && livePids(at.updates).length === 0 && !(await listening(at)), null);
    const after = stateHashes(at);
    check("legacy, coordination and owner files are unchanged", ["devices.json", "preferences.json", "voice.json", "coordination.json", "owner.json"].every((name) => after[name] === before[name]), { before, after });
    check("no ready descriptor", !existsSync(readyPath(at)), readyDescriptor(at));
    await receiptRecovered(at, check);
  } finally { reap(at); }
});

// upgrade: a good owner release, started over legacy state, keeps that state and adds only owner files
await scenario("owner-release-upgrade", "1, 6, 7", async (check) => {
  const at = await install("owner-good-release", true);
  try {
    const before = legacyState(at);
    const directory = saveRelease(at, "candidate", (target) => repository(target, (dir) => {
      cpSync(at.src, dir, { recursive: true, filter: (path) => !path.includes("/.git") && !path.endsWith("/node_modules") });
    }));
    const started = await plugin(at, "start");
    check("start through the saved release exits 0", started.code === 0, { err: started.err.slice(-800), log: serverLog(at).slice(-1500) });
    const ready = readyDescriptor(at);
    const bridgePid = (ready?.["bridge"] as { pid?: number } | undefined)?.pid;
    const bridgeCwd = bridgePid ? Bun.spawnSync(["readlink", `/proc/${bridgePid}/cwd`]).stdout.toString().trim() : null;
    check("the bridge runs from the saved release", bridgeCwd === directory, { bridgeCwd, directory });
    check("health stays redacted", same((await get(at, "/api/health")).body, REDACTED(false)), null);
    const stopped = await plugin(at, "stop");
    check("stop exits 0", stopped.code === 0, stopped);
    const after = stateHashes(at);
    check("legacy and coordination files are unchanged", ["devices.json", "preferences.json", "voice.json", "coordination.json"].every((name) => after[name] === before[name] && before[name] !== null), { before, after });
    check("clean shutdown leaves no dirty marker", after["owner.dirty"] === null, after);
    await receiptRecovered(at, check);
  } finally { reap(at); }
});

// 8: a dirty owner store refuses startup and keeps its marker for trusted recovery
await scenario("owner-dirty-store", "8", async (check) => {
  const at = await install("owner-dirty", true);
  try {
    ownerStore(at, ["dirty-token"]);
    writeFileSync(join(at.appState, "owner.dirty"), "Owner state requires clean shutdown or trusted recovery.\n", { mode: 0o600 });
    const before = stateHashes(at);
    const started = await plugin(at, "start");
    check("start fails on a dirty owner store", started.code !== 0, { out: started.out, err: started.err.slice(-600) });
    check("nothing is left listening", livePids(at.src).length === 0 && !(await listening(at)), livePids(at.src));
    check("marker and store are unchanged", same(stateHashes(at), before), { before, after: stateHashes(at) });
    check("no ready descriptor", !existsSync(readyPath(at)), readyDescriptor(at));
  } finally { reap(at); }
});

// 8: a revocation survives a managed restart; stale clients get no admission
await scenario("owner-revocation-and-stale-clients", "8", async (check) => {
  const at = await install("owner-revoke", true);
  try {
    const [keep, revoke] = ["keep-token-synthetic", "revoke-token-synthetic"];
    const ids = ownerStore(at, [keep, revoke]);
    const cookie = (token: string) => ({ cookie: `motoko_owner=${token}` });
    const mutate = { origin: `http://localhost:${at.port}`, "x-herdr-machine": "1" };
    const first = await plugin(at, "start");
    check("start exits 0", first.code === 0, { err: first.err.slice(-800), log: serverLog(at).slice(-1200) });
    check("both sessions are admitted", (await get(at, "/api/owner/sessions", cookie(keep))).status === 200 && (await get(at, "/api/owner/sessions", cookie(revoke))).status === 200, null);
    const revoked = await get(at, `/api/owner/sessions/${ids[revoke]}`, { ...cookie(keep), ...mutate }, "DELETE");
    check("revocation answers 204", revoked.status === 204, revoked);
    check("revoked session is refused at once", (await get(at, "/api/owner/sessions", cookie(revoke))).status === 401, null);
    check("plugin stop exits 0", (await plugin(at, "stop")).code === 0, null);
    const stored = JSON.parse(readFileSync(join(at.appState, "owner.json"), "utf8")) as { sessions: { id: string }[] };
    check("revocation is in the store after stop", !stored.sessions.some((s) => s.id === ids[revoke]) && stored.sessions.some((s) => s.id === ids[keep]), stored.sessions.map((s) => s.id));
    const second = await plugin(at, "start");
    check("restart exits 0", second.code === 0, { err: second.err.slice(-800) });
    check("revoked cookie stays refused after restart", (await get(at, "/api/owner/sessions", cookie(revoke))).status === 401, null);
    check("kept cookie is admitted after restart", (await get(at, "/api/owner/sessions", cookie(keep))).status === 200, null);
    // stale clients: what an older client or an un-upgraded page still sends
    const stale: [string, Record<string, string>][] = [
      ["revoked owner cookie", cookie(revoke)],
      ["legacy bearer token", { authorization: "Bearer legacy-token-synthetic" }],
      ["legacy token cookie", { cookie: "herdr_token=legacy-token-synthetic" }],
      ["legacy device cookie", { cookie: "herdr_device=device-synthetic" }],
      ["no credential", {}],
    ];
    for (const [label, headers] of stale) {
      const session = await get(at, "/api/session", headers);
      check(`${label}: /api/session refused`, session.status === 401 || session.status === 403, session);
      const health = await get(at, "/api/health", headers);
      check(`${label}: health stays redacted`, same(health.body, REDACTED(true)), health);
    }
    const socket = await get(at, "/ws", { ...cookie(revoke), origin: `http://localhost:${at.port}`, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": btoa("the sample nonce") });
    check("revoked cookie cannot open the socket", socket.status !== 101 && socket.status !== 0 && socket.status >= 400, socket);
  } finally { reap(at); }
});

writeFileSync(join(out, "results.json"), JSON.stringify({ baseline: BASELINE, root: ROOT, herdr: herdrSocket !== null, results }, null, 2));
rmSync(work, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} scenarios pass`);
process.exitCode = failed === 0 ? 0 : 1;
