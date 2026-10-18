import { SOURCE, ORCHESTRATOR, RIG_ID } from "./fixtures/motoko-target.ts";
import { afterEach, expect, setSystemTime, test, spyOn } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { writeEnrollmentToken } from "./motoko-owner.ts";
import { syntheticServerOptions } from "../scripts/motoko-env.ts";
import { SshConnection } from "./ssh.ts";
import { SoftwareAuthenticator } from "./motoko-owner.fixture.ts";
import { createCoordination, type CoordinationQueue, type QueueCreate } from "./motoko-coordination.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const origin = "http://localhost";
function setup(owner = true) {
  const root = mkdtempSync(join(tmpdir(), "motoko-contract-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const options = syntheticServerOptions(root);
  const server = createServer({ ...options, ...(owner ? { owner: { rpId: "localhost", origin } } : {}) });
  cleanup.push(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;
  const send = (path: string, body: unknown = {}, cookie?: string, method = "POST") => fetch(base + path, { method, headers: { host: "localhost", origin, "x-herdr-machine": "1", "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(["GET", "HEAD"].includes(method) ? {} : { body: JSON.stringify(body) }) });
  return { root, stateDir: options.stateDir!, server, base, send };
}
async function enroll(send: ReturnType<typeof setup>["send"], stateDir: string) {
  const key = new SoftwareAuthenticator(), token = writeEnrollmentToken(stateDir);
  const bootstrap = await (await send("/api/owner/bootstrap/options", { enrollmentToken: token })).json();
  const registeredResponse = await send("/api/owner/register", { ceremonyId: bootstrap.ceremonyId, label: "Fiction browser", response: key.registration(bootstrap.options.challenge) });
  expect(registeredResponse.status).toBe(200); expect(registeredResponse.headers.get("set-cookie")).toBeNull();
  const registered = await registeredResponse.json();
  const proof = await send("/api/owner/prove", { ceremonyId: registered.ceremonyId, response: key.assertion(registered.options.challenge) });
  expect(proof.status).toBe(201);
  const cookie = proof.headers.get("set-cookie")!.split(";")[0]!;
  expect(proof.headers.get("set-cookie")).toContain("HttpOnly"); expect(proof.headers.get("set-cookie")).toContain("SameSite=Strict");
  return { key, cookie };
}

test("owner public health is redacted; every protected path rejects legacy admission", async () => {
  const { base } = setup();
  for (const path of ["/api/health", "/api/health?scope=bridge"]) {
    const response = await fetch(base + path); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, auth: { required: true, authenticated: false, reason: "owner_required", owner: { enrolled: false } } });
  }
  for (const path of ["/api/session", "/api/agents", "/api/fs/file?path=/fiction", "/api/usage", "/api/update", "/api/devices", "/api/machines", "/api/machines/events"]) {
    expect((await fetch(base + path, { headers: { authorization: "Bearer fictional-legacy-token", "tailscale-user-login": "fiction-owner", "x-forwarded-for": "127.0.0.1" } })).status).toBe(401);
  }
  for (const path of ["/api/portal", "/api/portal/status", "/api/bridge", "/api/machines/remote/session", "/api/machines/settings", "/api/machines/setup"]) expect((await fetch(base + path)).status).toBe(403);
});

test("owner session admits local routes, denies remote routes, and legacy DELETE signs out", async () => {
  const { stateDir, base, send } = setup(), { cookie } = await enroll(send, stateDir);
  expect((await send("/api/usage", {}, cookie, "GET")).status).toBe(200);
  expect((await send("/api/voice", {}, cookie, "GET")).status).toBe(200);
  expect((await send("/api/owner/sessions", {}, cookie, "GET")).status).toBe(200);
  const roster = await (await send("/api/machines", {}, cookie, "GET")).json();
  expect(roster.machines.map((m: { id: string }) => m.id)).toEqual(["local"]);
  for (const path of ["/api/auth", "/api/devices/pair", "/api/devices/pair/start", "/api/portal", "/api/machines/setup", "/api/machines/remote/update-bridge"]) expect((await send(path, {}, cookie)).status).toBe(403);
  expect((await fetch(base + "/api/owner/sign-in/options", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" })).status).toBe(403);
  expect((await fetch(base + "/api/owner/sign-in/options", { method: "POST", headers: { origin, cookie, "sec-fetch-site": "cross-site", "x-herdr-machine": "1" }, body: "{}" })).status).toBe(403);
  const stream = await send("/api/machines/events", {}, cookie, "GET"); expect(stream.status).toBe(200);
  const reader = stream.body!.getReader(); expect((await reader.read()).done).toBe(false);
  expect((await send("/api/auth", {}, cookie, "DELETE")).status).toBe(204);
  for (let i = 0; i < 10; i++) { const result = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE did not close")), 2000))]); if (result.done) break; expect(i).toBeLessThan(9); }
  expect((await send("/api/usage", {}, cookie, "GET")).status).toBe(401);
});

test("legacy mode remains available and partial owner config rejects before listener creation", async () => {
  const legacy = setup(false);
  expect((await fetch(legacy.base + "/api/usage")).status).toBe(200);
  expect((await fetch(legacy.base + "/api/owner/sessions")).status).toBe(404);
  const previous = process.env["HERDR_WEB_OWNER_RP_ID"]; process.env["HERDR_WEB_OWNER_RP_ID"] = "localhost";
  try { expect(() => createServer(syntheticServerOptions(legacy.root))).toThrow("Invalid owner configuration"); }
  finally { if (previous === undefined) delete process.env["HERDR_WEB_OWNER_RP_ID"]; else process.env["HERDR_WEB_OWNER_RP_ID"] = previous; }
});

test("owner construction ignores enabled remote registrations and remote profile discovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "motoko-remote-negative-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const options = syntheticServerOptions(root); mkdirSync(options.stateDir!, { recursive: true });
  const seeded = JSON.stringify([{ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Fiction remote", enabled: true, target: { destination: "fiction.invalid" } }]);
  writeFileSync(join(options.stateDir!, "machines.json"), seeded);
  let profileCalls = 0;
  const ssh = spyOn(SshConnection.prototype, "start").mockImplementation(async () => { throw new Error("Remote SSH is forbidden"); });
  cleanup.push(() => ssh.mockRestore());
  const server = createServer({ ...options, owner: { rpId: "localhost", origin }, herdrProfiles: async () => { profileCalls++; throw new Error("Remote discovery is forbidden"); } }); cleanup.push(() => server.stop());
  expect(profileCalls).toBe(0);
  expect(readFileSync(join(options.stateDir!, "machines.json"), "utf8")).toBe(seeded);
  const health = await fetch(`http://127.0.0.1:${server.port}/api/health`); expect(health.status).toBe(200);
  expect(profileCalls).toBe(0); expect(ssh).not.toHaveBeenCalled();
});


test("programmatic loopback origin resolves once from the trusted ephemeral port", async () => {
  const root = mkdtempSync(join(tmpdir(), "motoko-origin-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const options = syntheticServerOptions(root);
  for (const change of [{ hostname: "0.0.0.0" }, { hostname: "localhost" }, { port: 7317 }, { owner: { rpId: "example.test", origin: "http://localhost:0" } }]) {
    expect(() => createServer({ ...options, owner: { rpId: "localhost", origin: "http://localhost:0" }, ...change })).toThrow();
  }
  const server = createServer({ ...options, owner: { rpId: "localhost", origin: "http://localhost:0" } }); cleanup.push(() => server.stop());
  const actual = `http://localhost:${server.port}`;
  const accepted = await fetch(actual + "/api/owner/sign-in/options", { method: "POST", headers: { origin: actual, "x-herdr-machine": "1", "content-type": "application/json" }, body: "{}" });
  expect(accepted.status).toBe(200);
  for (const claimed of ["http://localhost:0", "http://localhost", "https://example.test"]) expect((await fetch(actual + "/api/owner/sign-in/options", { method: "POST", headers: { origin: claimed, "x-herdr-machine": "1", "x-forwarded-host": "localhost", "x-forwarded-proto": "http" }, body: "{}" })).status).toBe(403);
});

test("owner sign-out closes an active socket immediately", async () => {
  const { base, stateDir, send } = setup(), { cookie } = await enroll(send, stateDir);
  const Socket = WebSocket as unknown as { new(url: string, options: { headers: Record<string, string> }): WebSocket };
  const socket = new Socket(base.replace("http:", "ws:") + "/ws", { headers: { origin, host: "localhost", cookie } });
  cleanup.push(() => socket.close());
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("Owner socket failed")); });
  const closed = new Promise<number>(resolve => socket.onclose = event => resolve(event.code));
  expect((await send("/api/owner/sign-out", {}, cookie)).status).toBe(204);
  expect(await Promise.race([closed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Socket did not close")), 2000))])).toBe(1008);
});

test.skipIf(process.env["HERDR_TEST_MODE"] !== "integration")("owner local roster includes the isolated test pane and local alias", async () => {
  const { stateDir, send, server } = setup(), { cookie } = await enroll(send, stateDir);
  await server.statusReady;
  const session = await send("/api/machines/local/session", {}, cookie, "GET"); expect(session.status).toBe(200);
  const body = await session.json(); expect(body.snapshot.panes.length).toBeGreaterThan(0);
  const roster = await (await send("/api/machines", {}, cookie, "GET")).json();
  expect(roster.machines.length).toBe(1); expect(roster.machines[0].id).toBe("local");
});

const REQUEST_ID = "2d9f4a5c-1d2e-4f60-8a9b-0c1d2e3f4a5b";
/** The smallest disposable queue for the route: it records every create and answers like OpenRig. */
function routeQueue(onCreate: () => Promise<void> = async () => {}) {
  const creates: QueueCreate[] = [], items = new Map<string, Record<string, unknown>>();
  const reply = (status: number, value: unknown) => ({ status, bytes: new TextEncoder().encode(JSON.stringify(value)) });
  const queue: CoordinationQueue = {
    async create(input) {
      creates.push(input); await onCreate();
      const item = { qitemId: input.qitemId, sourceSession: input.sourceSession, destinationSession: input.destinationSession, body: input.body, state: "pending", blockedOn: null, handedOffTo: null, closureReason: null, lastNudgeResult: null, deliveryOutcome: null, tsUpdated: "2026-10-18T00:00:00.000Z" };
      items.set(input.qitemId, item); return reply(201, item);
    },
    async item(id) { const item = items.get(id); return item ? reply(200, item) : reply(404, { error: "qitem_not_found" }); },
    async transitions(id) { return items.has(id) ? reply(200, []) : reply(404, { error: "qitem_not_found" }); },
  };
  return { queue, creates };
}
function coordinationSetup(onCreate?: () => Promise<void>, binding: { rigId: string; sourceSession: string; destinationSession: string } | null = { rigId: RIG_ID, sourceSession: SOURCE, destinationSession: ORCHESTRATOR }) {
  const root = mkdtempSync(join(tmpdir(), "motoko-coord-route-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const options = syntheticServerOptions(root);
  const { queue, creates } = routeQueue(onCreate ? () => onCreate() : undefined);
  const coordination = createCoordination({ stateDir: options.stateDir!, binding, queue, now: Date.now });
  const server = createServer({ ...options, owner: { rpId: "localhost", origin }, coordination });
  cleanup.push(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;
  const send = (path: string, body: unknown = {}, cookie?: string, method = "POST", headers: Record<string, string> = {}) => fetch(base + path, { method, headers: { host: "localhost", origin, "x-herdr-machine": "1", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers }, ...(["GET", "HEAD"].includes(method) ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  return { stateDir: options.stateDir!, base, send, creates };
}
const receiptFile = (stateDir: string) => join(stateDir, "coordination.json");

test("owner requests: no session, a revoked session or a foreign origin never reaches the queue", async () => {
  const { stateDir, base, send, creates } = coordinationSetup();
  const body = { requestId: REQUEST_ID, text: "Plan the trip" };
  expect((await send("/api/motoko/requests", body)).status).toBe(401);
  expect((await send("/api/motoko/requests", {}, undefined, "GET")).status).toBe(401);
  const { cookie } = await enroll(send, stateDir);
  expect((await send("/api/motoko/requests", body, cookie, "POST", { origin: "https://evil.example" })).status).toBe(403);
  expect((await fetch(base + "/api/motoko/requests", { method: "POST", headers: { host: "localhost", origin, cookie, "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(403);
  expect((await send("/api/motoko/requests", body, cookie, "POST", { "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await send("/api/owner/sign-out", {}, cookie)).status).toBe(204);
  expect((await send("/api/motoko/requests", body, cookie)).status).toBe(401);
  expect(creates).toEqual([]);
  expect(existsSync(receiptFile(stateDir))).toBe(false);
});

test("owner requests: body actor, destination or transport fields are refused; GET never creates", async () => {
  const { stateDir, send, creates } = coordinationSetup(), { cookie } = await enroll(send, stateDir);
  for (const extra of [{ sourceSession: "team-orchestrator@fiction-lab" }, { destinationSession: "team-worker-a@fiction-lab" }, { actorSession: SOURCE }, { origin: "motoko-owner" }]) {
    const response = await send("/api/motoko/requests", { requestId: REQUEST_ID, text: "Plan the trip", ...extra }, cookie);
    expect(response.status).toBe(400); expect((await response.json()).error.code).toBe("invalid_request");
  }
  const spoof = await send("/api/motoko/requests", { requestId: REQUEST_ID, text: "Plan the trip" }, cookie, "POST", { "x-openrig-session": "team-orchestrator@fiction-lab", "x-openrig-actor": "x" });
  expect(spoof.status).toBe(200);
  expect(creates.map(c => [c.sourceSession, c.destinationSession])).toEqual([[SOURCE, ORCHESTRATOR]]);
  const history = await send("/api/motoko/requests", {}, cookie, "GET");
  expect(history.status).toBe(200); expect(history.headers.get("cache-control")).toBe("no-store");
  const view = await history.json();
  expect(view.requests.map((r: { requestId: string; text: string }) => [r.requestId, r.text])).toEqual([[REQUEST_ID, "Plan the trip"]]);
  expect(JSON.stringify(view)).not.toContain(stateDir); expect(JSON.stringify(view)).not.toContain(cookie.split("=")[1]!);
  expect(creates.length).toBe(1);
});

test("owner requests: a session ended during dispatch withholds the answer; an unbound source refuses", async () => {
  let signOut: () => Promise<unknown> = async () => {};
  const live = coordinationSetup(() => signOut().then(() => {})), { cookie } = await enroll(live.send, live.stateDir);
  signOut = () => live.send("/api/owner/sign-out", {}, cookie);
  const ended = await live.send("/api/motoko/requests", { requestId: REQUEST_ID, text: "Plan the trip" }, cookie);
  expect(ended.status).toBe(401); expect((await ended.json()).error.code).toBe("owner_required");
  expect(JSON.parse(readFileSync(receiptFile(live.stateDir), "utf8")).receipts.length).toBe(1);
  const unbound = coordinationSetup(undefined, null), second = await enroll(unbound.send, unbound.stateDir);
  const refused = await unbound.send("/api/motoko/requests", { requestId: REQUEST_ID, text: "Plan the trip" }, second.cookie);
  expect(refused.status).toBe(409); expect((await refused.json()).error.code).toBe("coordination_origin_unbound");
  expect((await (await unbound.send("/api/motoko/requests", {}, second.cookie, "GET")).json()).enabled).toBe(false);
  expect(unbound.creates).toEqual([]);
});

test("owner requests: an idle-expired session never reaches the queue", async () => {
  const { stateDir, send, creates } = coordinationSetup(), { cookie } = await enroll(send, stateDir);
  setSystemTime(new Date(Date.now() + 31 * 60_000));
  try {
    expect((await send("/api/motoko/requests", { requestId: REQUEST_ID, text: "Plan the trip" }, cookie)).status).toBe(401);
    expect((await send("/api/motoko/requests", {}, cookie, "GET")).status).toBe(401);
  } finally { setSystemTime(); }
  expect(creates).toEqual([]);
  expect(existsSync(receiptFile(stateDir))).toBe(false);
});
