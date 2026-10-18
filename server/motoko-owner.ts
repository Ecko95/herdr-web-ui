import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isIP } from "node:net";
import { generateRegistrationOptions, generateAuthenticationOptions, verifyRegistrationResponse, verifyAuthenticationResponse, type RegistrationResponseJSON, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { parseCookies, noContent, TOKEN_COOKIE, DEVICE_COOKIE, enrollmentWait, recordEnrollmentFailure } from "./auth.ts";
import { jsonResponse, isJsonObject } from "./http.ts";

export interface OwnerConfig { rpId: string; origin: string }
export class OwnerConfigError extends Error { constructor() { super("Invalid owner configuration"); this.name = "OwnerConfigError"; } }
export function ownerConfiguration(option?: OwnerConfig, env: Record<string, string | undefined> = process.env): OwnerConfig | null {
  if (option === undefined && !env["HERDR_WEB_OWNER_RP_ID"] && !env["HERDR_WEB_OWNER_ORIGIN"]) return null;
  const rpId = option?.rpId ?? env["HERDR_WEB_OWNER_RP_ID"];
  const origin = option?.origin ?? env["HERDR_WEB_OWNER_ORIGIN"];
  if (origin === "http://localhost:0" && option === undefined) throw new OwnerConfigError();
  if (!rpId || !origin || isIP(rpId) || !/^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(rpId) || rpId.split(".").some(s => !s || s.startsWith("-") || s.endsWith("-") || s.length > 63)) throw new OwnerConfigError();
  let url: URL; try { url = new URL(origin); } catch { throw new OwnerConfigError(); }
  if (url.origin !== origin || url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost")) || !(url.hostname === rpId || url.hostname.endsWith("." + rpId))) throw new OwnerConfigError();
  return { rpId, origin };
}

const TTL = 120_000, IDLE = 30 * 60_000, ABSOLUTE = 12 * 60 * 60_000;
export const OWNER_COOKIE = "motoko_owner";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("base64url");
const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a), "hex"), Buffer.from(hash(b), "hex"));
const clearCookie = (name: string) => `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
export class OwnerError extends Error { constructor(readonly code: string, readonly status = 400) { super(code); } }
function requireOwner(condition: unknown, code: string, status = 400): asserts condition { if (!condition) throw new OwnerError(code, status); }

interface Credential { id: string; label: string; public_key: string; alg: -7; counter: number; status: "active" | "pending"; created_at: number; last_used_at: number; grant_id: string | null }
export interface OwnerSession { id: string; token_hash: string; credential_id: string; created_at: number; last_active_at: number; idle_expires_at: number; absolute_expires_at: number; observed_ip: string; user_agent: string }
interface State { version: 1; credentials: Credential[]; sessions: OwnerSession[] }
interface VerifiedAssertion { original: Credential; counter: number }
type Purpose = "sign-in" | "bootstrap-register" | "add-authorize" | "add-register" | "prove";
interface Ceremony { id: string; purpose: Purpose; challenge: string; expiresAt: number; sessionId?: string; credentialId?: string; grantId?: string; bootstrap?: boolean }
interface Grant { id: string; sessionId: string; expiresAt: number }
interface Meta { ip: string; userAgent: string; client?: string | null }
interface Dependencies { onFault?: () => void; now?: () => number; write?: (path: string, value: State) => void; authenticate?: typeof verifyAuthenticationResponse }

function privateJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path); } catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
}
function validState(value: unknown): value is State {
  if (!isJsonObject(value) || value["version"] !== 1 || !Array.isArray(value["credentials"]) || !Array.isArray(value["sessions"])) return false;
  const credentials = value["credentials"] as unknown[];
  if (!credentials.every(c => isJsonObject(c) && typeof c["id"] === "string" && /^[A-Za-z0-9_-]+$/.test(c["id"]) && typeof c["label"] === "string" && c["label"].length > 0 && c["label"].length <= 48 && typeof c["public_key"] === "string" && /^[A-Za-z0-9_-]+$/.test(c["public_key"]) && c["alg"] === -7 && Number.isSafeInteger(c["counter"]) && Number(c["counter"]) >= 0 && ["active", "pending"].includes(String(c["status"])) && typeof c["created_at"] === "number" && Number.isFinite(c["created_at"]) && typeof c["last_used_at"] === "number" && Number.isFinite(c["last_used_at"]) && (c["grant_id"] === null || typeof c["grant_id"] === "string"))) return false;
  const ids = new Set(credentials.map(c => (c as Credential).id));
  if (ids.size !== credentials.length) return false;
  const sessions = value["sessions"] as unknown[];
  if (!sessions.every(s => isJsonObject(s) && typeof s["id"] === "string" && typeof s["token_hash"] === "string" && /^[0-9a-f]{64}$/.test(s["token_hash"]) && typeof s["credential_id"] === "string" && ids.has(s["credential_id"]) && ["created_at", "last_active_at", "idle_expires_at", "absolute_expires_at"].every(k => typeof s[k] === "number" && Number.isFinite(s[k])) && typeof s["observed_ip"] === "string" && typeof s["user_agent"] === "string" && s["user_agent"].length <= 160)) return false;
  return new Set(sessions.map(s => (s as OwnerSession).id)).size === sessions.length;
}

/** SSH-only token creation; callers must not log the returned secret. */
export function writeEnrollmentToken(stateDir: string, now = Date.now()): string {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const token = random(); privateJson(join(stateDir, "owner-enroll.token"), { token, expiresAt: now + 600_000, failures: 0 }); return token;
}

export class OwnerStore {
  private state: State = { version: 1, credentials: [], sessions: [] };
  private faulted = false;
  private closed = false;
  private originResolved: boolean;
  private readonly ceremonies = new Map<string, Ceremony>();
  private readonly grants = new Map<string, Grant>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly now: () => number;
  private readonly path: string;
  private readonly marker: string;
  private readonly write: (path: string, value: State) => void;
  private readonly authenticate: typeof verifyAuthenticationResponse;
  private readonly onFault?: () => void;
  private ownsMarker = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(readonly config: OwnerConfig, readonly stateDir: string, dependencies: Dependencies = {}) {
    this.originResolved = config.origin !== "http://localhost:0"; this.onFault = dependencies.onFault;
    this.now = dependencies.now ?? Date.now; this.write = dependencies.write ?? privateJson; this.authenticate = dependencies.authenticate ?? verifyAuthenticationResponse;
    this.path = join(stateDir, "owner.json"); this.marker = join(stateDir, "owner.dirty");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    try { const value: unknown = JSON.parse(readFileSync(this.path, "utf8")); if (!validState(value)) throw new Error("Invalid store"); this.state = value; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) this.faulted = true; }
    try {
      const fd = openSync(this.marker, "wx", 0o600);
      try { writeSync(fd, "Owner state requires clean shutdown or trusted recovery.\n"); fsyncSync(fd); } finally { closeSync(fd); }
      this.ownsMarker = true;
    } catch { this.faulted = true; }
    this.schedule();
  }
  resolveTestOrigin(port: number): void {
    if (this.originResolved || this.config.origin !== "http://localhost:0" || !Number.isInteger(port) || port < 1 || port > 65535) throw new OwnerConfigError();
    this.config.origin = `http://localhost:${port}`; this.originResolved = true;
  }
  private schedule(): void {
    clearTimeout(this.timer); if (this.closed || this.faulted) return;
    const next = Math.min(this.now() + 30_000, ...this.state.sessions.flatMap(s => [s.idle_expires_at, s.absolute_expires_at]), ...this.state.credentials.filter(c => c.status === "pending").map(c => c.created_at + TTL));
    this.timer = setTimeout(() => {
      for (const session of [...this.state.sessions]) this.current(session.id);
      const credentials = this.state.credentials.filter(c => c.status !== "pending" || c.created_at + TTL > this.now());
      if (credentials.length !== this.state.credentials.length) { try { this.save({ ...this.state, credentials }); } catch {} }
      this.schedule();
    }, Math.max(1, next - this.now()));
    this.timer.unref();
  }
  get fault(): boolean { return this.faulted; }
  get enrolled(): boolean { return !this.faulted && this.state.credentials.some(c => c.status === "active"); }
  private available(): void { requireOwner(!this.faulted && !this.closed && this.originResolved, "owner_store_unavailable", 503); }
  private fail(): void { this.faulted = true; for (const controller of this.controllers.values()) controller.abort(); this.controllers.clear(); this.ceremonies.clear(); this.grants.clear(); try { this.onFault?.(); } catch { /* fault admission already closed */ } }
  private save(state: State, revocation = false): void {
    this.available();
    try { this.write(this.path, state); this.state = state; this.schedule(); }
    catch { if (revocation) this.state = state; this.fail(); throw new OwnerError("owner_store_unavailable", 503); }
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    clearTimeout(this.timer);
    for (const controller of this.controllers.values()) controller.abort(); this.controllers.clear();
    if (this.ownsMarker && !this.faulted) {
      try { this.write(this.path, this.state); unlinkSync(this.marker); this.ownsMarker = false; } catch { this.fail(); }
    }
  }
  current(id: string, touch = false): OwnerSession | null {
    if (this.faulted || this.closed || !this.originResolved) return null;
    const session = this.state.sessions.find(s => s.id === id);
    if (!session) return null;
    const now = this.now();
    if (session.idle_expires_at <= now || session.absolute_expires_at <= now || !this.state.credentials.some(c => c.id === session.credential_id && c.status === "active")) {
      try { this.revokeSession(id); } catch {} return null;
    }
    if (touch && now - session.last_active_at >= 60_000) {
      const updated = { ...session, last_active_at: now, idle_expires_at: Math.min(now + IDLE, session.absolute_expires_at) };
      const next = { ...this.state, sessions: this.state.sessions.map(s => s.id === id ? updated : s) };
      try { this.write(this.path, next); this.state = next; this.schedule(); return updated; } catch { return session; }
    }
    return session;
  }
  match(request: Request, touch = false): OwnerSession | null {
    const value = parseCookies(request.headers.get("cookie")).get(OWNER_COOKIE);
    if (!value || this.faulted) return null;
    const session = this.state.sessions.find(s => s.token_hash === hash(value));
    return session ? this.current(session.id, touch) : null;
  }
  assertCurrent(id: string): OwnerSession { this.available(); const session = this.current(id); requireOwner(session, "owner_required", 401); return session; }
  signal(id: string): AbortSignal {
    let controller = this.controllers.get(id);
    if (!controller) { controller = new AbortController(); this.controllers.set(id, controller); }
    if (!this.current(id)) controller.abort();
    return controller.signal;
  }
  onRevoke(id: string, close: () => void): () => void {
    const signal = this.signal(id);
    if (signal.aborted) { close(); return () => {}; }
    signal.addEventListener("abort", close, { once: true }); return () => signal.removeEventListener("abort", close);
  }
  revokeSession(id: string): void {
    const next = { ...this.state, sessions: this.state.sessions.filter(s => s.id !== id) };
    this.controllers.get(id)?.abort(); this.controllers.delete(id); this.save(next, true);
  }
  private credential(id: string, status: "active" | "pending"): Credential {
    this.available(); const item = this.state.credentials.find(c => c.id === id && c.status === status && (status !== "pending" || c.created_at + TTL > this.now()));
    requireOwner(item, "unknown_credential", 401); return item;
  }
  private issue(credential: Credential, meta: Meta): { session: OwnerSession; cookie: string } {
    this.available();
    const now = this.now();
    const active = this.state.sessions.filter(s => s.idle_expires_at > now && s.absolute_expires_at > now && this.state.credentials.some(c => c.id === s.credential_id && c.status === "active")).length;
    requireOwner(active < 3, "owner_session_limit", 409);
    const token = random();
    const session: OwnerSession = { id: random(), token_hash: hash(token), credential_id: credential.id, created_at: now, last_active_at: now, idle_expires_at: now + IDLE, absolute_expires_at: now + ABSOLUTE, observed_ip: meta.ip, user_agent: meta.userAgent.slice(0, 160) };
    this.save({ ...this.state, credentials: this.state.credentials.map(c => c.id === credential.id ? credential : c), sessions: [...this.state.sessions, session] });
    return { session, cookie: `${OWNER_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ABSOLUTE / 1000}${this.config.origin.startsWith("https:") ? "; Secure" : ""}` };
  }
  private ceremony(purpose: Purpose, challenge: string, fields: Partial<Ceremony> = {}): string {
    this.available(); for (const [id, grant] of this.grants) if (grant.expiresAt <= this.now()) this.grants.delete(id);
    for (const [id, c] of this.ceremonies) if (c.expiresAt <= this.now()) this.ceremonies.delete(id);
    while (this.ceremonies.size >= 64) this.ceremonies.delete(this.ceremonies.keys().next().value!);
    const id = random(); this.ceremonies.set(id, { ...fields, id, purpose, challenge, expiresAt: this.now() + TTL }); return id;
  }
  private take(id: unknown, purposes: Purpose[], sessionId?: string): Ceremony {
    this.available(); requireOwner(typeof id === "string", "invalid_challenge");
    const ceremony = this.ceremonies.get(id); this.ceremonies.delete(id);
    requireOwner(ceremony && purposes.includes(ceremony.purpose) && ceremony.expiresAt > this.now() && ceremony.sessionId === sessionId, "invalid_challenge"); return ceremony;
  }
  private consumeToken(offered: unknown): void {
    requireOwner(!this.enrolled, "enrollment_closed", 409);
    requireOwner(typeof offered === "string" && offered.length <= 256, "enrollment_required", 401);
    const path = join(this.stateDir, "owner-enroll.token");
    let token: { token: string; expiresAt: number; failures: number };
    try { token = JSON.parse(readFileSync(path, "utf8")); } catch { throw new OwnerError("enrollment_required", 401); }
    requireOwner(typeof token.token === "string" && Number.isFinite(token.expiresAt) && token.expiresAt > this.now(), "enrollment_required", 401);
    if (!equal(offered, token.token)) {
      token.failures = (Number.isSafeInteger(token.failures) ? token.failures : 0) + 1;
      if (token.failures >= 5) unlinkSync(path); else privateJson(path, token);
      throw new OwnerError("enrollment_required", 401);
    }
    unlinkSync(path);
  }
  private async registrationOptions(sessionId?: string, grantId?: string): Promise<Response> {
    const options = await generateRegistrationOptions({ rpName: "Motoko", rpID: this.config.rpId, userName: "owner", userID: new TextEncoder().encode("motoko-owner"), supportedAlgorithmIDs: [-7], attestationType: "none", timeout: TTL,
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" }, excludeCredentials: this.state.credentials.map(c => ({ id: c.id })) });
    if (sessionId) this.assertCurrent(sessionId); else requireOwner(!this.enrolled, "enrollment_closed", 409);
    const ceremonyId = this.ceremony(sessionId ? "add-register" : "bootstrap-register", options.challenge, { sessionId, grantId, bootstrap: !sessionId });
    return jsonResponse({ ceremonyId, options });
  }
  private async authOptions(purpose: "sign-in" | "add-authorize" | "prove", fields: Partial<Ceremony> = {}): Promise<{ ceremonyId: string; options: Awaited<ReturnType<typeof generateAuthenticationOptions>> }> {
    const options = await generateAuthenticationOptions({ rpID: this.config.rpId, timeout: TTL, userVerification: "required", allowCredentials: purpose === "sign-in" ? [] : this.state.credentials.filter(c => fields.credentialId ? c.id === fields.credentialId : c.status === "active").map(c => ({ id: c.id })) });
    if (fields.sessionId) this.assertCurrent(fields.sessionId);
    return { ceremonyId: this.ceremony(purpose, options.challenge, fields), options };
  }
  private async verify(ceremony: Ceremony, response: AuthenticationResponseJSON, status: "active" | "pending"): Promise<VerifiedAssertion> {
    requireOwner(isJsonObject(response) && typeof response.id === "string", "verification_failed");
    if (ceremony.credentialId) requireOwner(response.id === ceremony.credentialId, "unknown_credential", 401);
    const original = this.credential(response.id, status);
    let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try { result = await this.authenticate({ response, expectedChallenge: ceremony.challenge, expectedOrigin: this.config.origin, expectedRPID: this.config.rpId, requireUserVerification: true, credential: { id: original.id, counter: original.counter, publicKey: new Uint8Array(Buffer.from(original.public_key, "base64url")) } }); }
    catch (error) { const detail = error instanceof Error ? error.message : ""; throw new OwnerError(/counter/i.test(detail) ? "counter_regressed" : /user verif/i.test(detail) ? "uv_required" : "verification_failed"); }
    requireOwner(result.verified, "verification_failed");
    if (ceremony.sessionId) this.assertCurrent(ceremony.sessionId);
    return { original, counter: result.authenticationInfo.newCounter };
  }
  private admitAssertion({ original, counter }: VerifiedAssertion): Credential {
    const current = this.credential(original.id, original.status);
    requireOwner(current.public_key === original.public_key && current.created_at === original.created_at && current.grant_id === original.grant_id, "unknown_credential", 401);
    requireOwner(current.counter === original.counter && (counter === 0 && current.counter === 0 || counter > current.counter), "counter_regressed");
    return { ...current, counter, last_used_at: this.now() };
  }
  redactedHealth(): Response { return jsonResponse({ ok: true, auth: { required: true, authenticated: false, reason: this.faulted ? "owner_store_unavailable" : "owner_required", owner: { enrolled: this.enrolled } } }, 200, { "cache-control": "no-store" }); }
  denied(): Response { return ownerError(new OwnerError(this.faulted ? "owner_store_unavailable" : "owner_required", this.faulted ? 503 : 401)); }
  signOut(request: Request): Response {
    this.available(); const session = this.match(request); if (session) this.revokeSession(session.id);
    return noContent(clearCookie(OWNER_COOKIE), clearCookie(TOKEN_COOKIE), clearCookie(DEVICE_COOKIE));
  }
  async handle(request: Request, url: URL, meta: Meta): Promise<Response | undefined> {
    if (!url.pathname.startsWith("/api/owner/")) return undefined;
    try {
      this.available();
      if (request.method !== "GET" && !ownerRequestAllowed(request, this.config)) throw new OwnerError("invalid_origin", 403);
      const path = url.pathname;
      if (path === "/api/owner/sessions" && request.method === "GET") {
        const session = this.match(request); requireOwner(session, "owner_required", 401);
        return jsonResponse({ sessions: this.state.sessions.filter(s => this.current(s.id)).map(({ id, credential_id, created_at, last_active_at, observed_ip, user_agent }) => ({ id, credential_id, created_at, last_active_at, observed_ip, user_agent, current: id === session.id })), credentials: this.state.credentials.map(({ id, label, status, created_at, last_used_at }) => ({ id, label, status, created_at, last_used_at })) }, 200, { "cache-control": "no-store" });
      }
      if (request.method === "DELETE") {
        const session = this.match(request, true); requireOwner(session, "owner_required", 401);
        const id = decodeURIComponent(path.split("/").at(-1)!);
        if (path.startsWith("/api/owner/sessions/")) { requireOwner(this.state.sessions.some(s => s.id === id), "not_found", 404); this.assertCurrent(session.id); this.revokeSession(id); return noContent(); }
        if (path.startsWith("/api/owner/credentials/")) {
          const credential = this.state.credentials.find(c => c.id === id); requireOwner(credential, "not_found", 404);
          requireOwner(credential.status !== "active" || this.state.credentials.filter(c => c.status === "active").length > 1, "last_credential", 409);
          this.assertCurrent(session.id); const removed = this.state.sessions.filter(s => s.credential_id === id);
          for (const s of removed) this.controllers.get(s.id)?.abort();
          this.save({ ...this.state, credentials: this.state.credentials.filter(c => c.id !== id), sessions: this.state.sessions.filter(s => s.credential_id !== id) }, true); return noContent();
        }
      }
      requireOwner(request.method === "POST", "not_found", 404);
      const body: unknown = await request.json(); requireOwner(isJsonObject(body), "invalid_json"); this.available();
      const session = this.match(request, true);
      if (path === "/api/owner/sign-out") return this.signOut(request);
      if (path === "/api/owner/bootstrap/options") {
        const wait = enrollmentWait(meta.client ?? null); if (wait) return wait;
        try { this.consumeToken(body["enrollmentToken"]); } catch (error) { if (error instanceof OwnerError && error.code === "enrollment_required") recordEnrollmentFailure(meta.client ?? null); throw error; }
        return await this.registrationOptions();
      }
      if (path === "/api/owner/sign-in/options") return jsonResponse(await this.authOptions("sign-in"));
      if (path === "/api/owner/credentials/add/options") { requireOwner(session, "owner_required", 401); return jsonResponse(await this.authOptions("add-authorize", { sessionId: session.id })); }
      if (path === "/api/owner/credentials/add/authorize") {
        requireOwner(session, "owner_required", 401);
        const ceremony = this.take(body["ceremonyId"], ["add-authorize"], session.id);
        const assertion = await this.verify(ceremony, body["response"] as AuthenticationResponseJSON, "active"); this.assertCurrent(session.id);
        const credential = this.admitAssertion(assertion);
        this.save({ ...this.state, credentials: this.state.credentials.map(c => c.id === credential.id ? credential : c) });
        const id = random(); this.grants.set(id, { id, sessionId: session.id, expiresAt: this.now() + TTL });
        return await this.registrationOptions(session.id, id);
      }
      if (path === "/api/owner/register") {
        requireOwner(typeof body["label"] === "string" && body["label"].trim().length > 0 && body["label"].length <= 48, "invalid_label");
        const id = body["ceremonyId"], known = typeof id === "string" ? this.ceremonies.get(id) : undefined;
        const ceremony = this.take(id, ["bootstrap-register", "add-register"], known?.sessionId ? session?.id : undefined);
        if (ceremony.sessionId) { this.assertCurrent(ceremony.sessionId); const grant = this.grants.get(ceremony.grantId!); this.grants.delete(ceremony.grantId!); requireOwner(grant && grant.sessionId === ceremony.sessionId && grant.expiresAt > this.now(), "invalid_challenge"); }
        let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
        try { result = await verifyRegistrationResponse({ response: body["response"] as RegistrationResponseJSON, expectedChallenge: ceremony.challenge, expectedOrigin: this.config.origin, expectedRPID: this.config.rpId, requireUserVerification: true, supportedAlgorithmIDs: [-7] }); }
        catch { throw new OwnerError("verification_failed"); }
        requireOwner(result.verified, "verification_failed");
        if (ceremony.sessionId) this.assertCurrent(ceremony.sessionId); else requireOwner(!this.enrolled, "enrollment_closed", 409);
        this.available(); const credential = result.registrationInfo.credential;
        requireOwner(!this.state.credentials.some(c => c.id === credential.id), "duplicate_credential", 409);
        const response = body["response"] as RegistrationResponseJSON;
        requireOwner(response.id === credential.id && response.clientExtensionResults.credProps?.rk !== false, "verification_failed");
        const pending: Credential = { id: credential.id, public_key: Buffer.from(credential.publicKey).toString("base64url"), alg: -7, counter: credential.counter, label: body["label"].trim(), status: "pending", created_at: this.now(), last_used_at: this.now(), grant_id: ceremony.grantId ?? null };
        this.save({ ...this.state, credentials: [...this.state.credentials.filter(c => c.status !== "pending" || c.created_at + TTL > this.now()), pending] });
        const proof = await this.authOptions("prove", { sessionId: ceremony.sessionId, credentialId: pending.id, bootstrap: ceremony.bootstrap });
        return jsonResponse({ pendingCredentialId: pending.id, ...proof });
      }
      if (path === "/api/owner/prove") {
        const id = body["ceremonyId"], known = typeof id === "string" ? this.ceremonies.get(id) : undefined;
        const ceremony = this.take(id, ["prove"], known?.sessionId ? session?.id : undefined);
        const assertion = await this.verify(ceremony, body["response"] as AuthenticationResponseJSON, "pending");
        if (ceremony.sessionId) this.assertCurrent(ceremony.sessionId); else requireOwner(!this.enrolled, "enrollment_closed", 409);
        const credential = this.admitAssertion(assertion);
        const active = { ...credential, status: "active" as const };
        if (ceremony.bootstrap) { const issued = this.issue(active, meta); return new Response(null, { status: 201, headers: { "set-cookie": issued.cookie } }); }
        this.save({ ...this.state, credentials: this.state.credentials.map(c => c.id === credential.id ? active : c) });
        return new Response(null, { status: 201 });
      }
      if (path === "/api/owner/sign-in") {
        const ceremony = this.take(body["ceremonyId"], ["sign-in"]);
        const assertion = await this.verify(ceremony, body["response"] as AuthenticationResponseJSON, "active");
        return noContent(this.issue(this.admitAssertion(assertion), meta).cookie);
      }
      throw new OwnerError("not_found", 404);
    } catch (error) { return ownerError(error); }
  }
}
export function ownerError(error: unknown): Response { return jsonResponse({ error: { code: error instanceof OwnerError ? error.code : "verification_failed", message: error instanceof OwnerError ? error.code : "verification_failed" } }, error instanceof OwnerError ? error.status : 400, { "cache-control": "no-store" }); }
export function ownerRequestAllowed(request: Request, config: OwnerConfig): boolean {
  return request.headers.get("origin") === config.origin && (!request.headers.has("sec-fetch-site") || request.headers.get("sec-fetch-site") === "same-origin") && (["GET", "HEAD", "OPTIONS"].includes(request.method) || request.headers.get("x-herdr-machine") === "1");
}
export function disabledOwnerRoute(path: string, url: URL, method: string): boolean {
  return path === "/api/auth" && method === "POST" || path === "/api/devices/pair" || path === "/api/devices/pair/start" || path === "/api/portal" || path.startsWith("/api/portal/") || (path === "/api/machines" ? method !== "GET" : path.startsWith("/api/machines/") && !(path === "/api/machines/events" && method === "GET") && !path.startsWith("/api/machines/local/")) || path === "/api/bridge" || path === "/ws" && url.searchParams.has("machine_id") && url.searchParams.get("machine_id") !== "local";
}
if (import.meta.main) {
  if (process.argv[2] !== "enroll-token" || process.argv[3] !== "--state-dir" || !process.argv[4]) { console.error("Use enroll-token --state-dir DIRECTORY"); process.exitCode = 2; }
  else { writeEnrollmentToken(process.argv[4]); console.log(join(process.argv[4], "owner-enroll.token")); }
}
