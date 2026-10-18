/** Disposable same-path upgrade proof. Never accepts an installed root or real state. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import webpush from "web-push";
import { chromium } from "playwright-core";
import { chromePath } from "./chrome-path.ts";
import { useTestHerdr } from "./test-herdr.ts";
import { canBind } from "./plugin-port.ts";
import { endFixtureTree, sameBirth, signalPinned } from "./fixture-pidfd.ts";
import { updateStateDir } from "../server/update-state.ts";
import { processStartedAt } from "../server/process-start.ts";
import { writeEnrollmentToken } from "../server/motoko-owner.ts";
import { SoftwareAuthenticator } from "../server/motoko-owner.fixture.ts";
import { createCoordination, envelope, type CoordinationQueue } from "../server/motoko-coordination.ts";

const ROOT = resolve(import.meta.dir, "..");
const value = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const inputs = value("inputs"), out = value("out"), only = value("only");
if (!inputs || !out || !process.env.HOME?.includes("motoko-proof-")) throw new Error("Use motoko-env.ts with --inputs=<private-artifacts> --out=<evidence> [--candidate=<payload>] [--only=name]");
// the payload under test; the legacy and owner-baseline inputs stay the qualified ones
const candidate = resolve(value("candidate") ?? join(inputs, "candidate"));
mkdirSync(out, { recursive: true, mode: 0o700 });
const socket = await useTestHerdr();
assert(socket, "isolated Herdr is required");
const work = mkdtempSync(join(tmpdir(), "motoko-bundle-replica-"));
const tools = join(work, "tools"); mkdirSync(tools);
// The actual app sees synthetic tailnet metadata; no host account query occurs.
writeFileSync(join(tools, "tailscale"), '#!/bin/sh\nprintf \'%s\\n\' \'{"BackendState":"NoState","Self":null,"Peer":{},"User":{}}\'\n', { mode: 0o755 });
const gitLog = join(work, "git-calls");
// a real source check would reach the live gateway: any call is recorded and fails
const rigLog = join(work, "rig-calls");
writeFileSync(join(tools, "rig"), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "' + rigLog + '"\nexit 1\n', { mode: 0o755 });
writeFileSync(join(tools, "git"), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$MOTOKO_GIT_LOG"\n[ "$1" = fetch ] && exit 1\nexec /usr/bin/git "$@"\n', { mode: 0o755 });
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const optionalHash = (path: string) => existsSync(path) ? hash(path) : null;
const wait = async (condition: () => boolean | Promise<boolean>, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (!await condition()) { if (Date.now() >= deadline) throw new Error("Replica condition timed out"); await Bun.sleep(25); }
};
interface Replica { dir: string; root: string; app: string; config: string; pid: string; port: number; updates: string; known: Map<number, number>; groups: Set<number> }
const replicas: Replica[] = [];
const cp = (from: string, to: string) => cpSync(from, to, { recursive: true, dereference: false });
function config(at: Replica, owner: boolean) {
  writeFileSync(join(at.config, ".env"), `HOST=127.0.0.1\nPORT=${at.port}\nHERDR_WEB_AUTO_UPDATE=0\nMOTOKO_FIXTURE_LABEL=preserve\n${owner ? `HERDR_WEB_OWNER_RP_ID=localhost\nHERDR_WEB_OWNER_ORIGIN=http://localhost:${at.port}\n` : ""}`, { mode: 0o600 });
}
async function replica(name: string, legacy = false): Promise<Replica> {
  const dir = join(work, name); mkdirSync(dir, { mode: 0o700 });
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reserve.port!; await reserve.stop(true);
  const root = join(dir, "registered-plugin"), app = join(dir, "app"), configDir = join(dir, "config"), pid = join(dir, "pid");
  for (const path of [app, configDir, pid]) mkdirSync(path, { mode: 0o700 });
  cp(legacy ? join(inputs!, "installed-plugin") : candidate, root);
  const at: Replica = { dir, root, app, config: configDir, pid, port, updates: updateStateDir(root, port, app), known: new Map(), groups: new Set() };
  if (legacy) chmodSync(pid, 0o775);
  replicas.push(at); if (!legacy) config(at, true);
  return at;
}
function env(at: Replica): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [key, entry] of Object.entries(process.env)) if (entry !== undefined && !/^(HOST|PORT|HERDR_WEB_|HERDR_PLUGIN_)/.test(key)) inherited[key] = entry;
  return { ...inherited, HOST: "127.0.0.1", PORT: String(at.port), HERDR_WEB_AUTO_UPDATE: "0", PATH: tools + ":" + process.env.PATH, MOTOKO_GIT_LOG: gitLog, HERDR_PLUGIN_ROOT: at.root, HERDR_PLUGIN_STATE_DIR: at.pid, HERDR_PLUGIN_CONFIG_DIR: at.config, HERDR_WEB_STATE_DIR: at.app, HERDR_SOCKET_PATH: socket!, HERDR_SOCKET: socket!, HERDR_WEB_TELEMETRY: "0", DO_NOT_TRACK: "1" };
}
function remember(at: Replica, pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  const started = processStartedAt(pid); if (started === null) return;
  at.known.set(pid, started);
  try { for (const child of readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean)) remember(at, Number(child)); } catch { /* exit */ }
}
function record(at: Replica) {
  const text = readFileSync(join(at.pid, "server.pid"), "utf8").trim();
  const parsed = /^\d+$/.test(text) ? { pid: Number(text) } : JSON.parse(text) as { pid: number; startedAt?: number };
  remember(at, parsed.pid); at.groups.add(parsed.pid); return parsed;
}
async function plugin(at: Replica, command: string) {
  const child = Bun.spawn([process.execPath, join(at.root, "scripts/plugin.ts"), command], { cwd: at.root, env: env(at), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 35_000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  if (existsSync(join(at.pid, "server.pid"))) record(at);
  return { code, stdout, stderr };
}
const base = (at: Replica) => `http://localhost:${at.port}`;
async function request(at: Replica, path: string, cookie?: string, method = "GET", body?: unknown) {
  assert(!path.startsWith("/api/motoko/"), "the replica proof must not call the real reader");
  const response = await fetch(base(at) + path, { method, headers: { origin: base(at), "x-herdr-machine": "1", "x-herdr-update": "1", "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000) });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}
async function offline(at: Replica) { try { await fetch(base(at) + "/api/health", { signal: AbortSignal.timeout(200) }); return false; } catch { return true; } }
const ready = (at: Replica) => JSON.parse(readFileSync(join(at.updates, "ready.json"), "utf8")) as { bridge: { pid: number; startedAt: number }; supervisor: { pid: number }; launcher: { pid: number } };
const ownerState = (at: Replica) => JSON.parse(readFileSync(join(at.app, "owner.json"), "utf8")) as { credentials: { id: string; counter: number }[]; sessions: { id: string; token_hash: string }[] };
async function enroll(at: Replica) {
  const key = new SoftwareAuthenticator();
  const begin = await request(at, "/api/owner/bootstrap/options", undefined, "POST", { enrollmentToken: writeEnrollmentToken(at.app) }); assert.equal(begin.status, 200);
  const registered = await request(at, "/api/owner/register", undefined, "POST", { ceremonyId: begin.body.ceremonyId, label: "Disposable software key", response: key.registration(begin.body.options.challenge, base(at)) }); assert.equal(registered.status, 200);
  const proof = await request(at, "/api/owner/prove", undefined, "POST", { ceremonyId: registered.body.ceremonyId, response: key.assertion(registered.body.options.challenge, base(at)) }); assert.equal(proof.status, 201);
  return { key, cookie: proof.headers.get("set-cookie")!.split(";")[0]! };
}
async function signIn(at: Replica, key: SoftwareAuthenticator) {
  const begin = await request(at, "/api/owner/sign-in/options", undefined, "POST", {}); assert.equal(begin.status, 200);
  const result = await request(at, "/api/owner/sign-in", undefined, "POST", { ceremonyId: begin.body.ceremonyId, response: key.assertion(begin.body.options.challenge, base(at)) }); assert.equal(result.status, 204);
  return result.headers.get("set-cookie")!.split(";")[0]!;
}
function replace(at: Replica, artifact: string, backup: string) {
  assert(!lstatSync(at.root).isSymbolicLink());
  const stage = at.root + ".stage"; cp(artifact, stage);
  renameSync(at.root, join(at.dir, backup)); renameSync(stage, at.root);
  assert(!lstatSync(at.root).isSymbolicLink());
  const git = Bun.spawnSync(["/usr/bin/git", "rev-parse", "HEAD"], { cwd: at.root }); assert.notEqual(git.exitCode, 0, "replacement has no enclosing Git checkout");
}
function bridgeConsumer(at: Replica) {
  record(at);
  for (const [pid, startedAt] of at.known) {
    if (processStartedAt(pid) !== startedAt) continue;
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (!argv.some((part) => part === "server/index.ts" || part.endsWith("/server/index.ts"))) continue;
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      return { pid, startedAt, cwd, entrySha256: hash(join(cwd, "server/index.ts")), executable: readlinkSync(`/proc/${pid}/exe`) };
    } catch { /* exit */ }
  }
  throw new Error("No actual bridge consumer found");
}
async function stop(at: Replica) {
  if (existsSync(join(at.pid, "server.pid"))) record(at);
  const result = await plugin(at, "stop"); assert.equal(result.code, 0, JSON.stringify(result));
  await wait(() => offline(at));
}
function appHashes(at: Replica) {
  const values: Record<string, string> = {};
  function walk(path: string, prefix: string) { for (const name of readdirSync(path)) { if (!prefix && ["updates", "plugin-port", "owner.dirty", "owner-enroll.token"].includes(name)) continue; const file = join(path, name), key = prefix + name; if (lstatSync(file).isDirectory()) walk(file, key + "/"); else values[key] = hash(file); } }
  walk(at.app, ""); return values;
}
/** Final cleanup: every birth this proof observed, through pinned pidfds; never a group or numeric signal. Survivors are reported. */
async function clean(at: Replica) {
  for (const pid of at.known.keys()) remember(at, pid);
  const { survivors } = await endFixtureTree([...at.known].map(([pid, startedAt]) => ({ pid, startedAt })), at.dir);
  if (survivors.length) console.log("FIXTURE_SURVIVORS " + JSON.stringify(survivors));
}
const results: { name: string; ok: boolean; milliseconds: number; detail?: unknown; error?: string }[] = [];
async function scenario(name: string, run: () => Promise<unknown>) {
  if (only && only !== name) return;
  const started = Date.now();
  try { const detail = await run(); results.push({ name, ok: true, milliseconds: Date.now() - started, detail }); console.log("ok - " + name); }
  catch (error) {
    for (const at of replicas) {
      const log = join(at.pid, "server.log");
      if (existsSync(log)) writeFileSync(join(out!, name + "-" + at.dir.split("/").pop() + ".log"), readFileSync(log));
    }
    results.push({ name, ok: false, milliseconds: Date.now() - started, error: error instanceof Error ? error.stack : String(error) }); console.log("FAIL - " + name + ": " + String(error)); }
  writeFileSync(join(out!, "results.json"), JSON.stringify({ results, work, installedUiRequests: 0, replicaHttp: true, realReaderRequests: 0 }, null, 2));
}

try {
  await scenario("same-path-upgrade-and-both-rollbacks", async () => {
    const at = await replica("upgrade", true);
    mkdirSync(at.updates, { recursive: true, mode: 0o700 });
    const release = join(at.updates, "release-installed"); cp(join(inputs!, "installed-release"), release);
    const pointer = { directory: release, revision: "6de77101b2fafda044054e8f7195f3573b624b72", source_revision: "5a9fe391e8239c5f038c129e885b7cec15a68b99" };
    writeFileSync(join(at.updates, "current.json"), JSON.stringify(pointer), { mode: 0o600 });
    writeFileSync(join(at.app, "vapid.json"), JSON.stringify(webpush.generateVAPIDKeys()), { mode: 0o600 });
    for (const name of ["push-subscriptions.json", "push-retired.json"]) writeFileSync(join(at.app, name), "[]\n", { mode: 0o600 });
    writeFileSync(join(at.app, "preferences.json"), JSON.stringify({ revision: 3, settings: { theme: "dark" } }), { mode: 0o600 });
    mkdirSync(join(at.app, "ssh"), { mode: 0o700 }); writeFileSync(join(at.app, "ssh", "fixture.txt"), "fictional app SSH state\n", { mode: 0o600 });
    let started = await plugin(at, "start"); assert.equal(started.code, 0, JSON.stringify(started));
    const initial = await request(at, "/api/health"); assert.equal(initial.status, 200); assert(initial.body.web_ui?.boot_id);
    const legacyBridge = bridgeConsumer(at); assert.equal(legacyBridge.cwd, release);
    assert.equal((await request(at, "/api/updates")).body.current_revision, pointer.revision);
    const legacyPids = [...at.known.keys()];
    assert(legacyPids.some((pid) => { try { return readlinkSync(`/proc/${pid}/cwd`) === release; } catch { return false; } }), "actual legacy bridge uses the pinned installed release");
    await stop(at);
    const stateBefore = appHashes(at), configBefore = optionalHash(join(at.config, ".env")), pointerBefore = hash(join(at.updates, "current.json"));
    replace(at, candidate, "old-plugin");
    started = await plugin(at, "start"); assert.equal(started.code, 0, JSON.stringify(started));
    const candidateBridge = bridgeConsumer(at); assert.equal(candidateBridge.cwd, at.root); assert.equal(candidateBridge.entrySha256, hash(join(candidate, "server/index.ts")));
    const candidatePids = [...at.known.keys()].filter((pid) => processStartedAt(pid) === at.known.get(pid));
    assert(candidatePids.some((pid) => { try { return readlinkSync(`/proc/${pid}/cwd`) === at.root; } catch { return false; } }), "actual new bridge uses the same registered root");
    assert(!candidatePids.some((pid) => { try { return readlinkSync(`/proc/${pid}/cwd`) === release; } catch { return false; } }), "saved old release does not execute");
    const unmanaged = await request(at, "/api/updates"); assert.equal(unmanaged.body.managed, false); assert.equal(unmanaged.body.auto_update, false);
    const fetchesBefore = existsSync(gitLog) ? readFileSync(gitLog, "utf8").split("\n").filter((line) => line.startsWith("fetch ")).length : 0;
    for (const command of ["check", "install"]) { const denied = await request(at, "/api/updates/" + command, undefined, "POST", {}); assert.equal(denied.status, 409); assert.equal(denied.body.error.code, "updates_unmanaged"); }
    const afterUpdate = await request(at, "/api/updates"); assert.equal(afterUpdate.body.managed, false); assert.equal(afterUpdate.body.available, false);
    const fetchesAfter = existsSync(gitLog) ? readFileSync(gitLog, "utf8").split("\n").filter((line) => line.startsWith("fetch ")).length : 0;
    assert.equal(fetchesAfter, fetchesBefore, "unmanaged commands run no Git fetch");
    assert.equal(hash(join(at.updates, "current.json")), pointerBefore);
    await stop(at); assert.deepEqual(appHashes(at), stateBefore); assert.equal(optionalHash(join(at.config, ".env")), configBefore);
    // Before owner cutover, restore the actual prior Git tree and its unchanged selection.
    renameSync(at.root, join(at.dir, "new-plugin")); renameSync(join(at.dir, "old-plugin"), at.root);
    started = await plugin(at, "start"); assert.equal(started.code, 0, JSON.stringify(started));
    const restored = await request(at, "/api/health"); assert(restored.body.web_ui?.boot_id); assert.equal(restored.body.auth?.owner, undefined);
    assert([...at.known].some(([pid, stamp]) => { try { return processStartedAt(pid) === stamp && readlinkSync(`/proc/${pid}/cwd`) === release; } catch { return false; } }));
    await stop(at); assert.deepEqual(appHashes(at), stateBefore); assert.equal(optionalHash(join(at.config, ".env")), configBefore);
    replace(at, candidate, "old-plugin-after-rollback");
    config(at, true);
    const publicPidDirectory = await plugin(at, "start"); assert.notEqual(publicPidDirectory.code, 0); assert(await offline(at));
    assert(publicPidDirectory.stderr.toLowerCase().includes("private"), publicPidDirectory.stderr);
    chmodSync(at.pid, 0o700);
    started = await plugin(at, "start"); assert.equal(started.code, 0, JSON.stringify(started));
    const boot = ready(at); assert.equal(boot.launcher.pid, record(at).pid); assert.equal(readlinkSync(`/proc/${boot.bridge.pid}/cwd`), at.root);
    assert.equal((await request(at, "/api/session")).status, 401);
    const enrolled = await enroll(at), revokedCookie = enrolled.cookie;
    const keep = await signIn(at, enrolled.key);
    const sessions = await request(at, "/api/owner/sessions", keep); assert.equal(sessions.status, 200);
    const prior = sessions.body.sessions.find((item: { current: boolean }) => !item.current); assert(prior);
    assert.equal((await request(at, "/api/owner/sessions/" + prior.id, keep, "DELETE")).status, 204);
    assert.equal((await request(at, "/api/owner/sessions", revokedCookie)).status, 401);
    await stop(at);
    const ownerBefore = hash(join(at.app, "owner.json")), settingsBefore = optionalHash(join(at.config, ".env")), counterBefore = ownerState(at).credentials[0]!.counter;
    assert(counterBefore >= 2); assert(!existsSync(join(at.app, "owner.dirty")));
    // After owner cutover, rollback uses an earlier owner-capable artifact, never legacy code or state.
    replace(at, join(inputs!, "owner-baseline"), "new-owner-code");
    started = await plugin(at, "start"); assert.equal(started.code, 0, JSON.stringify(started));
    assert.equal(hash(join(at.app, "owner.json")), ownerBefore, "code rollback preserves the latest exact owner store");
    assert.equal(optionalHash(join(at.config, ".env")), settingsBefore);
    assert.equal((await request(at, "/api/owner/sessions", revokedCookie)).status, 401);
    assert.equal((await request(at, "/api/owner/sessions", keep)).status, 200);
    for (const headers of [{}, { authorization: "Bearer fictional-legacy" }, { cookie: "herdr_token=fictional-legacy" }]) {
      const response = await fetch(base(at) + "/api/session", { headers }); assert.equal(response.status, 401);
    }
    await signIn(at, enrolled.key); assert(ownerState(at).credentials[0]!.counter > counterBefore);
    const redacted = await request(at, "/api/health"); assert.deepEqual(redacted.body, { ok: true, auth: { required: true, authenticated: false, reason: "owner_required", owner: { enrolled: true } } });
    await stop(at);
    return { installedPluginRevision: pointer.source_revision, installedReleaseRevision: pointer.revision, sameRegisteredPath: true, symlinkReplacement: false, legacyConsumerPids: legacyPids, legacyBridge, candidateBridge, unmanaged: unmanaged.body, stateBefore, ownerCounterBeforeRollback: counterBefore, ownerCounterAfterRollback: ownerState(at).credentials[0]!.counter, oldPointerUnchanged: hash(join(at.updates, "current.json")) === pointerBefore };
  });

  await scenario("failed-owner-start-keeps-owner-selection", async () => {
    const at = await replica("failed-start");
    assert.equal((await plugin(at, "start")).code, 0); await enroll(at); await stop(at);
    const store = hash(join(at.app, "owner.json")), settings = readFileSync(join(at.config, ".env"), "utf8");
    writeFileSync(join(at.config, ".env"), settings.replace("HERDR_WEB_OWNER_RP_ID=localhost", "HERDR_WEB_OWNER_RP_ID=other.invalid"));
    const failed = await plugin(at, "start"); assert.notEqual(failed.code, 0); assert(await offline(at)); assert.equal(hash(join(at.app, "owner.json")), store);
    assert(!existsSync(join(at.updates, "ready.json")));
    writeFileSync(join(at.config, ".env"), settings);
    replace(at, join(inputs!, "owner-baseline"), "failed-start-code");
    assert.equal((await plugin(at, "start")).code, 0); assert.equal((await request(at, "/api/session")).status, 401);
    assert.equal(hash(join(at.app, "owner.json")), store); await stop(at);
    return { failedStartExit: failed.code, noLegacyAdmission: true, ownerStatePreserved: true };
  });

  await scenario("interrupted-stop-keeps-dirty-denial", async () => {
    const at = await replica("interrupted"); assert.equal((await plugin(at, "start")).code, 0); await enroll(at);
    const bridge = ready(at).bridge; assert.equal(processStartedAt(bridge.pid), bridge.startedAt);
    const store = hash(join(at.app, "owner.json")); process.kill(bridge.pid, "SIGSTOP");
    const stopping = plugin(at, "stop");
    await wait(() => !existsSync(join(at.updates, "ready.json")));
    assert.equal(processStartedAt(bridge.pid), bridge.startedAt); process.kill(bridge.pid, "SIGKILL");
    await stopping; await wait(() => offline(at));
    assert(existsSync(join(at.app, "owner.dirty"))); const marker = hash(join(at.app, "owner.dirty"));
    replace(at, join(inputs!, "owner-baseline"), "interrupted-code");
    const restarted = await plugin(at, "start"); assert.notEqual(restarted.code, 0); assert(await offline(at));
    assert.equal(hash(join(at.app, "owner.json")), store); assert.equal(hash(join(at.app, "owner.dirty")), marker);
    return { stoppedBridgeIdentity: bridge, restartExit: restarted.code, markerPreserved: true, noLegacyAdmission: true };
  });

  await scenario("failed-owner-write-keeps-dirty-denial", async () => {
    const at = await replica("write-fault"); assert.equal((await plugin(at, "start")).code, 0);
    const first = await enroll(at), keep = await signIn(at, first.key);
    const sessions = await request(at, "/api/owner/sessions", keep); const revoke = sessions.body.sessions.find((item: { current: boolean }) => !item.current); assert(revoke);
    const store = hash(join(at.app, "owner.json")); chmodSync(at.app, 0o500);
    let result;
    try { result = await request(at, "/api/owner/sessions/" + revoke.id, keep, "DELETE"); } finally { chmodSync(at.app, 0o700); }
    assert.equal(result.status, 503); assert.equal((await request(at, "/api/session", first.cookie)).status, 503);
    assert.equal(hash(join(at.app, "owner.json")), store); assert(existsSync(join(at.app, "owner.dirty")));
    await stop(at); const marker = hash(join(at.app, "owner.dirty"));
    replace(at, join(inputs!, "owner-baseline"), "write-fault-code");
    const restarted = await plugin(at, "start"); assert.notEqual(restarted.code, 0); assert(await offline(at));
    assert.equal(hash(join(at.app, "owner.json")), store); assert.equal(hash(join(at.app, "owner.dirty")), marker);
    return { failedWriteStatus: result.status, restartExit: restarted.code, markerPreserved: true, staleRevocationNeverAdmitted: true };
  });

  // Supported owner-capable code rollback with current coordination receipts: combined -> owner-baseline -> combined.
  // The owner-baseline payload predates coordination: it has no /api/motoko/requests route and never reads
  // coordination.json. Every store stays in place; nothing is restored, merged or replaced.
  await scenario("owner-capable-code-rollback-keeps-receipts", async () => {
    assert.equal(hash(join(candidate, "server/motoko-coordination.ts")), hash(join(ROOT, "server/motoko-coordination.ts")), "the seeding module is the payload's module");
    const at = await replica("coordination-rollback");
    assert.equal((await plugin(at, "start")).code, 0);
    const enrolled = await enroll(at), revoked = enrolled.cookie, keep = await signIn(at, enrolled.key);
    const prior = (await request(at, "/api/owner/sessions", keep)).body.sessions.find((item: { current: boolean }) => !item.current); assert(prior);
    assert.equal((await request(at, "/api/owner/sessions/" + prior.id, keep, "DELETE")).status, 204);
    // Without the source binding the combined route serves history with enabled:false. Read it only while no receipt
    // exists: with receipts, a history read would ask the production queue adapter at the fixed live daemon address.
    const requests = (cookie: string) => fetch(base(at) + "/api/motoko/requests", { headers: { cookie }, signal: AbortSignal.timeout(3000) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    assert(!existsSync(join(at.app, "coordination.json")));
    const combinedRoute = await requests(keep); assert.equal(combinedRoute.status, 200); assert.equal(combinedRoute.body?.enabled, false); assert.deepEqual(combinedRoute.body?.requests, []);
    await stop(at);
    // receipts written by the payload's own module over a disposable queue, with escaped text and two identities
    const items = new Map<string, Record<string, unknown>>();
    const reply = (status: number, body: unknown) => ({ status, bytes: new TextEncoder().encode(JSON.stringify(body)) });
    const queue: CoordinationQueue = {
      async create(input) {
        const item = items.get(input.qitemId) ?? { qitemId: input.qitemId, sourceSession: input.sourceSession, destinationSession: input.destinationSession, body: input.body, state: "pending", blockedOn: null, handedOffTo: null, closureReason: null, lastNudgeResult: null, deliveryOutcome: null, tsUpdated: new Date().toISOString() };
        items.set(input.qitemId, item); return reply(201, item);
      },
      async item(id) { return items.has(id) ? reply(200, items.get(id)) : reply(404, { error: "qitem_not_found" }); },
      async transitions(id) { return items.has(id) ? reply(200, []) : reply(404, { error: "qitem_not_found" }); },
    };
    const module = () => createCoordination({ stateDir: at.app, binding: { rigId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", sourceSession: "fiction-owner@external", destinationSession: "team-orchestrator@fiction-lab" }, queue, now: Date.now });
    const owner = { sessionId: "synthetic", origin: base(at), recheck() {} };
    const seeded = [{ requestId: "3f1c4a5c-1d2e-4f60-8a9b-0c1d2e3f4a5b", text: "Plan a fictional <b>day</b>\n\u0000tab\there" }, { requestId: "4a2c4a5c-1d2e-4f60-8a9b-0c1d2e3f4a5b", text: "Second fictional request" }];
    for (const input of seeded) await module().submit(owner, input);
    assert.equal(items.size, 2);
    const receipts = join(at.app, "coordination.json"), receiptBytes = hash(receipts), ownerBytes = hash(join(at.app, "owner.json"));
    const counter = ownerState(at).credentials[0]!.counter, sessionIds = ownerState(at).sessions.map((item) => item.id).sort();
    assert(!sessionIds.includes(prior.id), "the revoked session is gone from the current store");
    // code rollback to the qualified owner-capable baseline
    replace(at, join(inputs!, "owner-baseline"), "combined-code");
    assert.equal((await plugin(at, "start")).code, 0);
    assert.equal(hash(join(at.app, "owner.json")), ownerBytes, "rollback start keeps the current owner store bytes");
    assert.equal((await request(at, "/api/owner/sessions", revoked)).status, 401);
    assert.equal((await request(at, "/api/owner/sessions", keep)).status, 200);
    const baselineRoute = await requests(keep); assert.equal(baselineRoute.status, 404, "the baseline has no coordination route");
    await signIn(at, enrolled.key);
    const rolledCounter = ownerState(at).credentials[0]!.counter; assert(rolledCounter > counter, "the counter advances, never back");
    await stop(at);
    assert.equal(hash(receipts), receiptBytes, "the baseline leaves coordination.json byte for byte");
    assert(!existsSync(join(at.app, "owner.dirty")));
    // supported recovery path: the combined payload again over the same, newer state
    replace(at, candidate, "baseline-code");
    assert.equal((await plugin(at, "start")).code, 0);
    assert.equal((await request(at, "/api/owner/sessions", revoked)).status, 401);
    assert.equal((await request(at, "/api/owner/sessions", keep)).status, 200);
    assert(ownerState(at).credentials[0]!.counter >= rolledCounter);
    await stop(at);
    assert.equal(hash(receipts), receiptBytes);
    // usable recovery: a restarted module reads the same identities; explicit retries select the same two items
    const history = await module().history(owner, new AbortController().signal);
    assert.deepEqual(history.requests.map((item) => [item.requestId, item.qitemId, item.text, item.queue.status]).sort(), seeded.map((input) => [input.requestId, "qitem-motoko-" + input.requestId, input.text, "known"]).sort());
    for (const input of seeded) await module().submit(owner, input);
    assert.equal(items.size, 2, "explicit retries select the existing queue items");
    assert.equal(hash(receipts), receiptBytes, "retries keep the receipt bytes");
    for (const [id, item] of items) assert.equal(item["body"], envelope(JSON.parse(readFileSync(receipts, "utf8")).receipts.find((r: { qitemId: string }) => r.qitemId === id)));
    const rigCalls = existsSync(rigLog) ? readFileSync(rigLog, "utf8").trim().split("\n").filter(Boolean).length : 0;
    assert.equal(rigCalls, 0, "no source check ran");
    return { receiptSha256: receiptBytes, ownerCounterBefore: counter, ownerCounterAfterRollback: rolledCounter, revokedSessionDenied: true, combinedRoute: combinedRoute.status, baselineRoute: baselineRoute.status, recovered: history.requests.length, queueItems: items.size, rigCalls, restoredOrMerged: false };
  });

  await scenario("browser-service-worker-and-stale-client", async () => {
    const at = await replica("browser", true);
    mkdirSync(at.updates, { recursive: true, mode: 0o700 });
    const release = join(at.updates, "release-installed"); cp(join(inputs!, "installed-release"), release);
    writeFileSync(join(at.updates, "current.json"), JSON.stringify({ directory: release, revision: "6de77101b2fafda044054e8f7195f3573b624b72", source_revision: "5a9fe391e8239c5f038c129e885b7cec15a68b99" }), { mode: 0o600 });
    assert.equal((await plugin(at, "start")).code, 0);
    const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ serviceWorkers: "allow" });
      const external: string[] = [];
      context.on("request", (request) => { const url = new URL(request.url()); if (/^https?:$/.test(url.protocol) && url.origin !== base(at)) external.push(request.url()); });
      await context.addInitScript(() => {
        (window as unknown as { cspFailures: string[] }).cspFailures = [];
        document.addEventListener("securitypolicyviolation", (event) => (window as unknown as { cspFailures: string[] }).cspFailures.push(event.violatedDirective));
      });
      // Explicit browser fixture: no request reaches the production-default reader.
      let fixtureReads = 0;
      await context.route("**/api/motoko/status", (route) => { fixtureReads++; return route.fulfill({ json: { source: "fixture", sampledAt: new Date().toISOString(), staleAfterMs: 30_000, rigs: [], needsYou: [], errors: [] } }); });
      const page = await context.newPage();
      await page.goto(base(at));
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
      const oldEntry = await page.locator('script[type="module"]').first().getAttribute("src"); assert(oldEntry);
      const oldCaches = await page.evaluate(() => caches.keys());
      const stalePage = await context.newPage(); await stalePage.goto(base(at));
      assert.equal(await stalePage.locator('script[type="module"]').first().getAttribute("src"), oldEntry);
      await stop(at); replace(at, candidate, "old-browser-code"); assert.equal((await plugin(at, "start")).code, 0);
      assert.equal(await page.locator('script[type="module"]').first().getAttribute("src"), oldEntry, "open tab retains its actual prior client");
      assert.equal((await page.evaluate(async () => (await fetch("/api/updates")).json())).managed, false);
      const shell = await page.request.get(base(at)); assert.equal(shell.headers()["cache-control"], "no-cache");
      const worker = await page.request.get(base(at) + "/sw.js"); assert.equal(worker.headers()["cache-control"], "no-cache");
      assert.equal(createHash("sha256").update(await worker.body()).digest("hex"), hash(join(candidate, "dist/sw.js")));
      await page.evaluate(async () => {
        const previous = navigator.serviceWorker.controller;
        const registration = await navigator.serviceWorker.getRegistration();
        if (!registration) throw new Error("No service worker registration");
        await registration.update();
        if (navigator.serviceWorker.controller === previous) await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Worker replacement timed out")), 10_000);
          navigator.serviceWorker.addEventListener("controllerchange", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      });
      await page.reload();
      const newEntry = await page.locator('script[type="module"]').first().getAttribute("src"); assert(newEntry); assert.notEqual(newEntry, oldEntry);
      await page.waitForFunction(async (entry) => Boolean(await caches.match(entry!)), new URL(newEntry, base(at)).href);
      const cachePaths = await page.evaluate(async () => {
        const paths: string[] = [];
        for (const name of await caches.keys()) for (const item of await (await caches.open(name)).keys()) paths.push(new URL(item.url).pathname);
        return paths;
      });
      assert(!cachePaths.some((path) => path.startsWith("/api/") || path === "/ws"), "private API and sockets are absent from the cache");
      assert(!cachePaths.some((path) => /\/(smile|wine|glance|shrug|visor)[-.]/.test(path)), "pre-owner view does not precache poses");
      await context.setOffline(true); await page.reload({ waitUntil: "domcontentloaded" });
      assert.equal(await page.locator('script[type="module"]').first().getAttribute("src"), newEntry, "offline navigation retains the new shell");
      await context.setOffline(false);
      await stop(at); config(at, true); chmodSync(at.pid, 0o700); assert.equal((await plugin(at, "start")).code, 0);
      // The actual earlier client still has no owner credential. Its request cannot use legacy admission.
      assert.equal(await stalePage.locator('script[type="module"]').first().getAttribute("src"), oldEntry);
      assert.equal(await stalePage.evaluate(async () => (await fetch("/api/session")).status), 401);
      await page.goto(base(at) + "/?page=motoko"); await page.getByTestId("owner-gate").waitFor();
      assert.equal(await page.locator(".motoko-boot").count(), 0); assert.equal(fixtureReads, 0);
      await page.screenshot({ path: join(out!, "bundle-owner-gate.png") });
      assert.deepEqual(await page.evaluate(() => (window as unknown as { cspFailures: string[] }).cspFailures), []);
      assert.deepEqual(external, []);
      await stop(at);
      return { oldEntry, newEntry, oldCaches, cachePaths, offlineNewShell: true, staleClientDenied: true, readerFixtureReads: fixtureReads, externalRequests: external.length };
    } finally { await browser.close(); }
  });

  await scenario("legacy-maintenance-start", async () => {
    // The candidate under the unchanged legacy config, started the way the maintenance caller starts it:
    // a dead holder's lock, a saved pointer, and a deadline from Python's CLOCK_MONOTONIC five seconds ahead.
    const at = await replica("maintenance"); config(at, false);
    mkdirSync(at.updates, { recursive: true, mode: 0o700 });
    const pointer = join(at.updates, "current.json");
    writeFileSync(pointer, JSON.stringify({ directory: join(at.updates, "release-fiction"), revision: "0".repeat(40), source_revision: "0".repeat(40) }), { mode: 0o600 });
    const pointerBefore = hash(pointer);
    const holder = Bun.spawn(["/bin/true"]); await holder.exited;
    mkdirSync(join(at.updates, "supervisor.lock"), { mode: 0o700 }); writeFileSync(join(at.updates, "supervisor.lock", "pid"), String(holder.pid), { mode: 0o600 });
    const nonce = crypto.randomUUID();
    const clock = Bun.spawnSync(["python3", "-I", "-c", "import time; print(time.monotonic_ns() + 5_000_000_000)"], { stdout: "pipe" });
    assert.equal(clock.exitCode, 0); const deadline = BigInt(clock.stdout.toString().trim());
    const child = Bun.spawn([process.execPath, join(at.root, "scripts/plugin.ts"), "start"], { cwd: at.root, env: { ...env(at), HERDR_WEB_MAINTENANCE_NONCE: nonce, HERDR_WEB_MAINTENANCE_DEADLINE_NS: String(deadline) }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const after = BigInt(Bun.spawnSync(["python3", "-I", "-c", "import time; print(time.monotonic_ns())"], { stdout: "pipe" }).stdout.toString().trim());
    record(at);
    assert.equal(code, 0, stdout + stderr); assert(after < deadline, "ready before the deadline");
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    assert.equal(result.status, "ready"); assert(!stdout.includes(nonce), "the nonce stays out of public output");
    const launch = JSON.parse(readFileSync(join(at.updates, "maintenance-launch.json"), "utf8")), ready = JSON.parse(readFileSync(join(at.updates, "maintenance-ready.json"), "utf8"));
    assert.deepEqual(launch, { version: 1, mode: "legacy-maintenance", root: at.root, port: at.port, nonce, launcher: ready.launcher });
    assert.equal(ready.owner, false); assert.equal(ready.nonce, nonce);
    assert.deepEqual(result.ready, { boot_id: ready.boot_id, launcher: ready.launcher, supervisor: ready.supervisor, bridge: ready.bridge });
    assert.deepEqual(result.launcher_birth, ready.launcher, "the birth pinned at spawn is the recorded launcher");
    assert.deepEqual(JSON.parse(stdout.trim().split("\n")[0]!), { version: 1, mode: "legacy-maintenance", event: "spawned", starter: child.pid, launcher_birth: ready.launcher });
    const parentOf = (pid: number) => { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]); };
    assert.equal(readFileSync(join(at.pid, "server.pid"), "utf8"), `${ready.launcher.pid}\n`);
    assert.equal(readFileSync(join(at.updates, "supervisor.lock", "pid"), "utf8"), String(ready.supervisor.pid));
    assert.equal(parentOf(ready.supervisor.pid), ready.launcher.pid); assert.equal(parentOf(ready.bridge.pid), ready.supervisor.pid);
    for (const identity of [ready.launcher, ready.supervisor, ready.bridge]) assert.equal(processStartedAt(identity.pid), identity.startedAt);
    const consumer = bridgeConsumer(at); assert.equal(consumer.pid, ready.bridge.pid); assert.equal(consumer.cwd, at.root);
    const health = await request(at, "/api/health"); assert.equal(health.status, 200); assert.equal(health.body.web_ui.boot_id, ready.boot_id);
    assert.equal(hash(pointer), pointerBefore, "the saved pointer is unchanged");
    assert(!existsSync(join(at.updates, "ready.json")) && !existsSync(join(at.app, "owner.json")), "no owner record or owner state");
    // cleanup of this disposable replica: SIGTERM to its exact launcher through a pinned pidfd; the launcher passes it on
    assert.equal(signalPinned(ready.launcher, 15, at.root), "sent");
    await wait(() => [ready.launcher, ready.supervisor, ready.bridge].every((identity: { pid: number; startedAt: number }) => !sameBirth(identity)), 15_000);
    assert(await canBind("127.0.0.1", at.port), "the fixed port is free again (a bind probe, no request)");
    assert.equal(hash(pointer), pointerBefore, "the saved pointer is unchanged after the stop");
    return { result, pointerUnchanged: true, lockTakenFromDeadHolder: holder.pid, deadlineMarginMs: Number(deadline - after) / 1e6, bridgeCwd: consumer.cwd, entrySha256: consumer.entrySha256 };
  });
} finally {
  for (const at of replicas) await clean(at);
  rmSync(work, { recursive: true, force: true });
}
if (results.some((item) => !item.ok)) process.exitCode = 1;
