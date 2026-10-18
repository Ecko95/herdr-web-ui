import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { controlledEnvironment, runControlled, syntheticNetworkCalls, syntheticServerOptions } from "../scripts/motoko-env.ts";
import { defaultStateDir } from "./update-state.ts";
import { createServer } from "./index.ts";

const roots: string[] = [];
const temporary = () => { const root = mkdtempSync(join(tmpdir(), "owner-unit-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("controlled child roots exclude inherited accounts, selectors, and live sockets", () => {
  const root = temporary(), env = controlledEnvironment(root);
  for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "TMPDIR", "HERDR_WEB_STATE_DIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "HERMES_HOME", "GROK_HOME", "OPENCODE_DB", "HERDR_SOCKET"]) expect(env[name]?.startsWith(join(root, sep))).toBe(true);
  for (const name of ["HERDR_TEST_LIVE", "HERDR_WEB_TOKEN", "SSH_AUTH_SOCK", "PORT", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "HERDR_WEB_TAILSCALE_OWNER"]) expect(env[name]).toBeUndefined();
  const controlledRoot = dirname(homedir());
  expect(basename(controlledRoot).startsWith("motoko-proof-")).toBe(true);
  expect(homedir()).toBe(join(controlledRoot, "home"));
  expect(tmpdir()).toBe(join(controlledRoot, "tmp"));
  expect(process.env["HERDR_WEB_STATE_DIR"]).toBe(join(controlledRoot, "herdr-state"));
  expect(defaultStateDir()).toBe(process.env["HERDR_WEB_STATE_DIR"]!);
  expect(process.env["HERDR_SOCKET"]).toBe(join(controlledRoot, "config/herdr/sessions/herdr-web-ui-test/herdr.sock"));
});

test("controlled runner refuses live-test override without a child", async () => {
  const previous = process.env["HERDR_TEST_LIVE"];
  process.env["HERDR_TEST_LIVE"] = "1";
  try { expect(await runControlled(["no-such-child-command"])).toBe(2); }
  finally { if (previous === undefined) delete process.env["HERDR_TEST_LIVE"]; else process.env["HERDR_TEST_LIVE"] = previous; }
});

test("synthetic services handle usage and voice status without provider requests", async () => {
  const server = createServer(syntheticServerOptions(temporary()));
  try {
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(base + "/api/usage")).status).toBe(200);
    expect((await fetch(base + "/api/voice")).status).toBe(200);
    expect(syntheticNetworkCalls).toBe(0);
  } finally { server.stop(); }
});


import { ownerConfiguration, OwnerStore, writeEnrollmentToken } from "./motoko-owner.ts";
import { SoftwareAuthenticator } from "./motoko-owner.fixture.ts";

const config = { rpId: "localhost", origin: "http://localhost" };
const request = (path: string, body: unknown = {}, cookie?: string) => new Request(config.origin + path, { method: "POST", headers: { origin: config.origin, "x-herdr-machine": "1", "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
async function call(store: OwnerStore, path: string, body: unknown = {}, cookie?: string) {
  const req = request(path, body, cookie);
  return store.handle(req, new URL(req.url), { ip: "127.0.0.1", userAgent: "fiction-browser" });
}
async function enroll(store: OwnerStore, root: string, authenticator = new SoftwareAuthenticator()) {
  const token = writeEnrollmentToken(root);
  const options = await (await call(store, "/api/owner/bootstrap/options", { enrollmentToken: token }))!.json();
  const pending = await (await call(store, "/api/owner/register", { ceremonyId: options.ceremonyId, label: "Fiction key", response: authenticator.registration(options.options.challenge) }))!.json();
  const response = await call(store, "/api/owner/prove", { ceremonyId: pending.ceremonyId, response: authenticator.assertion(pending.options.challenge) });
  expect(response?.status).toBe(201);
  return { authenticator, cookie: response!.headers.get("set-cookie")!.split(";")[0]!, pending };
}

test("owner configuration stays legacy only when all owner inputs are absent", () => {
  expect(ownerConfiguration(undefined, {})).toBeNull();
  expect(() => ownerConfiguration(undefined, { HERDR_WEB_OWNER_RP_ID: "localhost" })).toThrow();
  expect(() => ownerConfiguration({ rpId: "localhost", origin: "http://localhost/path" }, {})).toThrow();
  expect(() => ownerConfiguration({ rpId: "127.0.0.1", origin: "http://127.0.0.1" }, {})).toThrow();
  expect(ownerConfiguration(config, {})).toEqual(config);
});

test("registration stays pending until possession proof; later sign-in uses the same credential", async () => {
  const root = temporary(), store = new OwnerStore(config, root);
  try {
    const { authenticator, cookie } = await enroll(store, root);
    expect(store.match(request("/api/usage", {}, cookie))?.credential_id).toBe(authenticator.id);
    expect((await call(store, "/api/owner/sign-out", {}, cookie))?.status).toBe(204);
    expect(store.match(request("/api/usage", {}, cookie))).toBeNull();
    const options = await (await call(store, "/api/owner/sign-in/options"))!.json();
    expect(options.options.allowCredentials).toEqual([]);
    const login = await call(store, "/api/owner/sign-in", { ceremonyId: options.ceremonyId, response: authenticator.assertion(options.options.challenge) });
    expect(login?.status).toBe(204);
    expect((await call(store, "/api/owner/sign-in", { ceremonyId: options.ceremonyId, response: authenticator.assertion(options.options.challenge) }))?.status).toBe(400);
  } finally { store.close(); }
});


async function addPending(store: OwnerStore, cookie: string, existing: SoftwareAuthenticator, next = new SoftwareAuthenticator()) {
  const auth = await (await call(store, "/api/owner/credentials/add/options", {}, cookie))!.json();
  const grant = await (await call(store, "/api/owner/credentials/add/authorize", { ceremonyId: auth.ceremonyId, response: existing.assertion(auth.options.challenge) }, cookie))!.json();
  const response = await call(store, "/api/owner/register", { ceremonyId: grant.ceremonyId, label: "Fiction second key", response: next.registration(grant.options.challenge) }, cookie);
  expect(response?.status).toBe(200);
  return { next, pending: await response!.json() };
}
async function signIn(store: OwnerStore, authenticator: SoftwareAuthenticator) {
  const options = await (await call(store, "/api/owner/sign-in/options"))!.json();
  const response = await call(store, "/api/owner/sign-in", { ceremonyId: options.ceremonyId, response: authenticator.assertion(options.options.challenge) });
  expect(response?.status).toBe(204); return response!.headers.get("set-cookie")!.split(";")[0]!;
}

test("an add credential requires the original session through activation", async () => {
  const root = temporary(), store = new OwnerStore(config, root);
  try {
    const first = await enroll(store, root), other = await signIn(store, first.authenticator);
    const { next, pending } = await addPending(store, first.cookie, first.authenticator);
    const proof = { ceremonyId: pending.ceremonyId, response: next.assertion(pending.options.challenge) };
    const wrong = await call(store, "/api/owner/prove", proof, other);
    expect(wrong?.status).toBe(400);
    expect((await wrong!.json()).error.code).toBe("invalid_challenge");
    const second = await addPending(store, first.cookie, first.authenticator);
    const activated = await call(store, "/api/owner/prove", { ceremonyId: second.pending.ceremonyId, response: second.next.assertion(second.pending.options.challenge) }, first.cookie);
    expect(activated?.status).toBe(201); expect(activated?.headers.get("set-cookie")).toBeNull();
    const session = store.match(request("/api/owner/sessions", {}, first.cookie))!;
    expect((await call(store, "/api/owner/sign-out", {}, first.cookie))?.status).toBe(204);
    expect(store.current(session.id)).toBeNull();
  } finally { store.close(); }
});

test("revocation during asynchronous proof prevents activation", async () => {
  const root = temporary(); let hold = false, entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
  const { verifyAuthenticationResponse } = await import("@simplewebauthn/server");
  const store = new OwnerStore(config, root, { authenticate: async options => { if (hold) { entered(); await gate; } return verifyAuthenticationResponse(options); } });
  try {
    const first = await enroll(store, root), { next, pending } = await addPending(store, first.cookie, first.authenticator);
    const session = store.match(request("/api/owner/sessions", {}, first.cookie))!;
    hold = true;
    const result = call(store, "/api/owner/prove", { ceremonyId: pending.ceremonyId, response: next.assertion(pending.options.challenge) }, first.cookie);
    await started; store.revokeSession(session.id); release();
    const response = await result; expect(response?.status).toBe(401);
    const saved = JSON.parse(readFileSync(join(root, "owner.json"), "utf8"));
    expect(saved.credentials.find((c: { id: string }) => c.id === next.id).status).toBe("pending");
  } finally { release(); store.close(); }
});

test("expiry prevents add proof and cancels the owner signal", async () => {
  let now = Date.now(); const root = temporary(), store = new OwnerStore(config, root, { now: () => now });
  try {
    const first = await enroll(store, root), { next, pending } = await addPending(store, first.cookie, first.authenticator);
    const session = store.match(request("/api/owner/sessions", {}, first.cookie))!;
    const signal = store.signal(session.id); now += 31 * 60_000;
    expect(store.current(session.id)).toBeNull(); expect(signal.aborted).toBe(true);
    expect((await call(store, "/api/owner/prove", { ceremonyId: pending.ceremonyId, response: next.assertion(pending.options.challenge) }, first.cookie))?.status).toBe(400);
  } finally { store.close(); }
});

test("a failed revocation write retains denial across restart until trusted recovery", async () => {
  const root = temporary(); let fail = false;
  const store = new OwnerStore(config, root, { write: (path, state) => { if (fail) throw new Error("synthetic write failure"); writeFileSync(path, JSON.stringify(state), { mode: 0o600 }); } });
  const first = await enroll(store, root), second = await addPending(store, first.cookie, first.authenticator);
  expect((await call(store, "/api/owner/prove", { ceremonyId: second.pending.ceremonyId, response: second.next.assertion(second.pending.options.challenge) }, first.cookie))?.status).toBe(201);
  const session = store.match(request("/api/owner/sessions", {}, first.cookie))!, signal = store.signal(session.id);
  const before = readFileSync(join(root, "owner.json"), "utf8");
  fail = true;
  const deletion = new Request(config.origin + "/api/owner/credentials/" + first.authenticator.id, { method: "DELETE", headers: { origin: config.origin, "x-herdr-machine": "1", cookie: first.cookie } });
  expect((await store.handle(deletion, new URL(deletion.url), { ip: "127.0.0.1", userAgent: "fiction" }))?.status).toBe(503);
  expect(signal.aborted).toBe(true); expect(readFileSync(join(root, "owner.json"), "utf8")).toBe(before); store.close();
  const blocked = new OwnerStore(config, root);
  expect(blocked.fault).toBe(true); expect(blocked.match(request("/api/usage", {}, first.cookie))).toBeNull();
  expect((await call(blocked, "/api/owner/sign-in/options"))?.status).toBe(503); blocked.close();
  const recovered = JSON.parse(before); recovered.credentials = recovered.credentials.filter((c: { id: string }) => c.id !== first.authenticator.id); recovered.sessions = recovered.sessions.filter((s: { credential_id: string }) => s.credential_id !== first.authenticator.id);
  writeFileSync(join(root, "owner.json"), JSON.stringify(recovered), { mode: 0o600 }); unlinkSync(join(root, "owner.dirty"));
  const reopened = new OwnerStore(config, root);
  try { expect(reopened.match(request("/api/usage", {}, first.cookie))).toBeNull(); await signIn(reopened, second.next); }
  finally { reopened.close(); }
});

test("unknown credentials, UV absence, wrong origin, replay, and pending sign-in fail", async () => {
  const root = temporary(), store = new OwnerStore(config, root);
  try {
    const token = writeEnrollmentToken(root), key = new SoftwareAuthenticator();
    const opt = await (await call(store, "/api/owner/bootstrap/options", { enrollmentToken: token }))!.json();
    expect(opt.options.authenticatorSelection.residentKey).toBe("required");
    expect((await call(store, "/api/owner/bootstrap/options", { enrollmentToken: token }))?.status).toBe(401);
    const pending = await (await call(store, "/api/owner/register", { ceremonyId: opt.ceremonyId, label: "Fiction", response: key.registration(opt.options.challenge) }))!.json();
    const sign = await (await call(store, "/api/owner/sign-in/options"))!.json();
    expect((await call(store, "/api/owner/sign-in", { ceremonyId: sign.ceremonyId, response: key.assertion(sign.options.challenge) }))?.status).toBe(401);
    expect((await call(store, "/api/owner/prove", { ceremonyId: pending.ceremonyId, response: key.assertion(pending.options.challenge, "https://wrong.example") }))?.status).toBe(400);
    expect((await call(store, "/api/owner/prove", { ceremonyId: pending.ceremonyId, response: key.assertion(pending.options.challenge) }))?.status).toBe(400);
    const requestWithoutOrigin = new Request(config.origin + "/api/owner/sign-in/options", { method: "POST", body: "{}" });
    expect((await store.handle(requestWithoutOrigin, new URL(requestWithoutOrigin.url), { ip: "127.0.0.1", userAgent: "fiction" }))?.status).toBe(403);
  } finally { store.close(); }
});


test("the placeholder origin cannot come from environment and cannot admit before resolution", async () => {
  expect(() => ownerConfiguration(undefined, { HERDR_WEB_OWNER_RP_ID: "localhost", HERDR_WEB_OWNER_ORIGIN: "http://localhost:0" })).toThrow();
  const root = temporary(), store = new OwnerStore({ rpId: "localhost", origin: "http://localhost:0" }, root);
  try {
    expect((await call(store, "/api/owner/sign-in/options"))?.status).toBe(503);
    store.resolveTestOrigin(12345);
    expect(store.config.origin).toBe("http://localhost:12345");
    expect(() => store.resolveTestOrigin(12346)).toThrow();
  } finally { store.close(); }
});

test("UV absence and counter regression reject active credential assertions", async () => {
  const root = temporary(), store = new OwnerStore(config, root);
  try {
    const { authenticator } = await enroll(store, root);
    for (const variation of ["uv", "rp", "counter", "unknown"] as const) {
      const options = await (await call(store, "/api/owner/sign-in/options"))!.json();
      const response = variation === "unknown" ? new SoftwareAuthenticator().assertion(options.options.challenge) : authenticator.assertion(options.options.challenge, config.origin, variation === "rp" ? "wrong.example" : "localhost", variation !== "uv");
      if (variation === "counter") { authenticator.counter = 0; Object.assign(response, authenticator.assertion(options.options.challenge)); }
      const result = await call(store, "/api/owner/sign-in", { ceremonyId: options.ceremonyId, response }); expect(result?.status).not.toBe(204);
    }
  } finally { store.close(); }
});


test("voice configuration rechecks the revocation signal after its asynchronous body read", async () => {
  const { VoiceService, handleVoiceRequest } = await import("./voice.ts");
  const root = temporary(), controller = new AbortController();
  const service = new VoiceService({ stateDir: root, env: {}, fetch: async () => { throw new Error("No provider request"); } });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
  const req = new Request("http://localhost/api/voice/config", { method: "PUT", body: "{}" });
  req.json = async () => { entered(); await gate; return { api_key: "fiction-voice-key" }; };
  const response = handleVoiceRequest(req, "/api/voice/config", service, controller.signal);
  await started; controller.abort(); release();
  expect((await response).status).not.toBe(200); expect(service.status().configured).toBe(false);
});

test("owner revocation cancels an active synthetic voice stream", async () => {
  const { VoiceService } = await import("./voice.ts");
  const root = temporary(), store = new OwnerStore(config, root);
  try {
    const { cookie } = await enroll(store, root), session = store.match(request("/api/voice", {}, cookie))!;
    let upstream: AbortSignal | null = null;
    const service = new VoiceService({ stateDir: temporary(), env: {}, fetch: async (_url, init) => {
      upstream = init.signal!;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { init.signal!.addEventListener("abort", () => controller.close(), { once: true }); } }), { headers: { "content-type": "text/event-stream" } });
    } });
    service.update({ api_key: "fiction-voice-key" });
    const stream = await service.transcribe({ audio: new Blob(["fiction audio"], { type: "audio/webm" }), filename: "audio.webm", mode: "chat", polish: false, keywords: [], languages: [] }, store.signal(session.id));
    store.revokeSession(session.id);
    expect(upstream!.aborted).toBe(true);
    const reader = stream.getReader();
    for (let i = 0; i < 4; i++) { const result = await reader.read(); if (result.done) break; expect(i).toBeLessThan(3); }
  } finally { store.close(); }
});


test("the last active credential cannot be removed and read access cannot extend idle time", async () => {
  let now = Date.now(); const root = temporary(), store = new OwnerStore(config, root, { now: () => now });
  try {
    const first = await enroll(store, root), session = store.match(request("/api/usage", {}, first.cookie))!;
    const deletion = new Request(config.origin + "/api/owner/credentials/" + first.authenticator.id, { method: "DELETE", headers: { origin: config.origin, "x-herdr-machine": "1", cookie: first.cookie } });
    expect((await store.handle(deletion, new URL(deletion.url), { ip: "127.0.0.1", userAgent: "fiction" }))?.status).toBe(409);
    now += 60_001;
    expect(store.current(session.id)!.idle_expires_at).toBe(session.idle_expires_at);
    const touched = store.current(session.id, true)!;
    expect(touched.idle_expires_at).toBe(now + 30 * 60_000);
    expect(touched.absolute_expires_at).toBe(session.absolute_expires_at);
    now = session.absolute_expires_at;
    expect(store.current(session.id, true)).toBeNull();
  } finally { store.close(); }
});


function completedVerifiers() {
  let held = false, ready!: () => void;
  const entered = new Promise<void>(resolve => ready = resolve), completions = new Map<unknown, () => void>();
  return {
    authenticate: async (options: Parameters<typeof import("@simplewebauthn/server").verifyAuthenticationResponse>[0]) => {
      const { verifyAuthenticationResponse } = await import("@simplewebauthn/server");
      const result = await verifyAuthenticationResponse(options);
      if (held) await new Promise<void>(resolve => { completions.set(options.expectedChallenge, resolve); if (completions.size === 2) ready(); });
      return result;
    },
    hold: () => { held = true; },
    release: async (challenges: string[]) => { await entered; held = false; for (const challenge of challenges) completions.get(challenge)!(); },
    close: () => { held = false; for (const resolve of completions.values()) resolve(); },
  };
}

for (const purpose of ["sign-in", "credentials/add/authorize"] as const) {
  for (const counters of [[2, 2], [3, 2]]) {
    test(`${purpose} admits one concurrent assertion for counters ${counters.join(",")}`, async () => {
      const root = temporary(), barrier = completedVerifiers(), store = new OwnerStore(config, root, { authenticate: barrier.authenticate });
      try {
        const first = await enroll(store, root), optionsPath = purpose === "sign-in" ? "/api/owner/sign-in/options" : "/api/owner/credentials/add/options";
        const a = await (await call(store, optionsPath, {}, first.cookie))!.json();
        const b = await (await call(store, optionsPath, {}, first.cookie))!.json();
        first.authenticator.counter = counters[0]! - 1; const signedA = first.authenticator.assertion(a.options.challenge);
        first.authenticator.counter = counters[1]! - 1; const signedB = first.authenticator.assertion(b.options.challenge);
        barrier.hold();
        const pendingA = call(store, "/api/owner/" + purpose, { ceremonyId: a.ceremonyId, response: signedA }, first.cookie);
        const pendingB = call(store, "/api/owner/" + purpose, { ceremonyId: b.ceremonyId, response: signedB }, first.cookie);
        await barrier.release([a.options.challenge, b.options.challenge]);
        const [accepted, refused] = await Promise.all([pendingA, pendingB]);
        expect(accepted?.status).toBe(purpose === "sign-in" ? 204 : 200);
        expect(refused?.status).toBe(400);
        expect((await refused!.json()).error.code).toBe("counter_regressed");
        const saved = JSON.parse(readFileSync(join(root, "owner.json"), "utf8"));
        expect(saved.credentials.find((c: { id: string }) => c.id === first.authenticator.id).counter).toBe(counters[0]);
        expect(saved.sessions.length).toBe(purpose === "sign-in" ? 2 : 1);
        expect((await call(store, "/api/owner/" + purpose, { ceremonyId: a.ceremonyId, response: signedA }, first.cookie))?.status).toBe(400);
        const fresh = await (await call(store, optionsPath, {}, first.cookie))!.json();
        first.authenticator.counter = counters[0]!;
        expect((await call(store, "/api/owner/" + purpose, { ceremonyId: fresh.ceremonyId, response: first.authenticator.assertion(fresh.options.challenge) }, first.cookie))?.status).toBe(purpose === "sign-in" ? 204 : 200);
      } finally { barrier.close(); store.close(); }
    });
  }
}

test("zero counters retain the supported policy across fresh sign-in challenges", async () => {
  const root = temporary(), store = new OwnerStore(config, root), key = new SoftwareAuthenticator(); key.counter = -1;
  try {
    await enroll(store, root, key);
    for (let i = 0; i < 2; i++) { key.counter = -1; await signIn(store, key); }
    const saved = JSON.parse(readFileSync(join(root, "owner.json"), "utf8"));
    expect(saved.credentials[0].counter).toBe(0); expect(saved.sessions.length).toBe(3);
  } finally { store.close(); }
});

test("pending-key proof consumes its ceremony once during concurrent requests", async () => {
  const root = temporary(), store = new OwnerStore(config, root);
  try {
    const first = await enroll(store, root), { next, pending } = await addPending(store, first.cookie, first.authenticator);
    const body = { ceremonyId: pending.ceremonyId, response: next.assertion(pending.options.challenge) };
    const responses = await Promise.all([call(store, "/api/owner/prove", body, first.cookie), call(store, "/api/owner/prove", body, first.cookie)]);
    expect(responses.map(response => response?.status)).toEqual([201, 400]);
    expect((await responses[1]!.json()).error.code).toBe("invalid_challenge");
    const saved = JSON.parse(readFileSync(join(root, "owner.json"), "utf8"));
    expect(saved.credentials.find((c: { id: string }) => c.id === next.id).status).toBe("active");
    expect(saved.sessions.length).toBe(1);
  } finally { store.close(); }
});
