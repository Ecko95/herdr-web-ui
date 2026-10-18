import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { OwnerStore, writeEnrollmentToken } from "./motoko-owner.ts";
import { SoftwareAuthenticator } from "./motoko-owner.fixture.ts";
const roots: string[] = [];
const temporary = () => { const root = mkdtempSync(join(tmpdir(), "owner-cap-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const clock = Date.now();
const config = { rpId: "localhost", origin: "http://localhost" };
const request = (path: string, body: unknown = {}, cookie?: string) => new Request(config.origin + path, { method: "POST", headers: { origin: config.origin, "x-herdr-machine": "1", "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
async function call(store: OwnerStore, path: string, body: unknown = {}, cookie?: string) {
  const req = request(path, body, cookie);
  return store.handle(req, new URL(req.url), { ip: "127.0.0.1", userAgent: "fiction-browser" });
}
async function enroll(store: OwnerStore, root: string, authenticator = new SoftwareAuthenticator()) {
  const token = writeEnrollmentToken(root, clock);
  const options = await (await call(store, "/api/owner/bootstrap/options", { enrollmentToken: token }))!.json();
  const pending = await (await call(store, "/api/owner/register", { ceremonyId: options.ceremonyId, label: "Fiction key", response: authenticator.registration(options.options.challenge) }))!.json();
  const response = await call(store, "/api/owner/prove", { ceremonyId: pending.ceremonyId, response: authenticator.assertion(pending.options.challenge) });
  expect(response?.status).toBe(201);
  return { authenticator, cookie: response!.headers.get("set-cookie")!.split(";")[0]!, pending };
}

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


const saved = (root: string) => JSON.parse(readFileSync(join(root, "owner.json"), "utf8"));
async function login(store: OwnerStore, key: SoftwareAuthenticator) {
  const options = await (await call(store, "/api/owner/sign-in/options"))!.json();
  return call(store, "/api/owner/sign-in", { ceremonyId: options.ceremonyId, response: key.assertion(options.options.challenge) });
}
test("fourth login refuses without a cookie or any durable state change", async () => {
  const root = temporary(), store = new OwnerStore(config, root, { now: () => clock });
  try {
    const first = await enroll(store, root);
    await signIn(store, first.authenticator); await signIn(store, first.authenticator);
    const before = readFileSync(join(root, "owner.json"), "utf8");
    const denied = (await login(store, first.authenticator))!;
    expect(denied.status).toBe(409); expect((await denied.json()).error.code).toBe("owner_session_limit");
    expect(denied.headers.get("set-cookie")).toBeNull();
    expect(readFileSync(join(root, "owner.json"), "utf8")).toBe(before);
    expect(saved(root).sessions).toHaveLength(3);
  } finally { store.close(); }
});
test("concurrent valid proofs from distinct credentials share one final slot", async () => {
  let hold = false, entered = 0, release!: () => void, ready!: () => void;
  const gate = new Promise<void>(r => release = r), both = new Promise<void>(r => ready = r);
  const root = temporary(), store = new OwnerStore(config, root, { now: () => clock, authenticate: async options => {
    const result = await verifyAuthenticationResponse(options);
    if (hold) { if (++entered === 2) ready(); await gate; } return result;
  } });
  try {
    const first = await enroll(store, root), second = await addPending(store, first.cookie, first.authenticator);
    expect((await call(store, "/api/owner/prove", { ceremonyId: second.pending.ceremonyId, response: second.next.assertion(second.pending.options.challenge) }, first.cookie))?.status).toBe(201);
    await signIn(store, first.authenticator);
    hold = true;
    const a = login(store, first.authenticator), b = login(store, second.next);
    await both; release(); const responses = (await Promise.all([a,b])).map(r => r!);
    expect(responses.map(r => r.status).sort()).toEqual([204,409]);
    expect(responses.filter(r => r.headers.has("set-cookie"))).toHaveLength(1);
    expect(saved(root).sessions).toHaveLength(3);
  } finally { release(); store.close(); }
});
test("add-passkey activation works at capacity and explicit revocation frees one slot", async () => {
  const root = temporary(), store = new OwnerStore(config, root, { now: () => clock });
  try {
    const first = await enroll(store, root); await signIn(store, first.authenticator); await signIn(store, first.authenticator);
    const second = await addPending(store, first.cookie, first.authenticator);
    const proof = (await call(store, "/api/owner/prove", { ceremonyId: second.pending.ceremonyId, response: second.next.assertion(second.pending.options.challenge) }, first.cookie))!;
    expect(proof.status).toBe(201); expect(proof.headers.has("set-cookie")).toBe(false);
    expect(saved(root).sessions).toHaveLength(3); expect((await login(store, second.next))?.status).toBe(409);
    const sessions = saved(root).sessions; const target = sessions[1].id;
    const signal = store.signal(target), other = store.signal(sessions[0].id);
    store.revokeSession(target); expect(signal.aborted).toBe(true); expect(other.aborted).toBe(false);
    expect(store.current(target)).toBeNull(); expect((await login(store, second.next))?.status).toBe(204);
  } finally { store.close(); }
});
for (const expiry of ["idle_expires_at", "absolute_expires_at"] as const) test(`${expiry} does not count after restart`, async () => {
  const root = temporary(); let store = new OwnerStore(config, root, { now: () => clock });
  try {
    const first = await enroll(store, root); await signIn(store, first.authenticator); await signIn(store, first.authenticator);
    store.close(); const state = saved(root); state.sessions[1][expiry] = 0;
    writeFileSync(join(root,"owner.json"),JSON.stringify(state)); store = new OwnerStore(config,root,{ now: () => clock });
    expect((await login(store, first.authenticator))?.status).toBe(204);
    expect(saved(root).sessions.filter((s: { idle_expires_at: number; absolute_expires_at: number }) => s.idle_expires_at > clock && s.absolute_expires_at > clock)).toHaveLength(3);
    expect((await login(store, first.authenticator))?.status).toBe(409);
  } finally { store.close(); }
});
test("pending credentials do not count and existing over-capacity sessions stay intact", async () => {
  const root = temporary(); let store = new OwnerStore(config,root,{ now: () => clock });
  try {
    const first = await enroll(store,root); await signIn(store,first.authenticator); await signIn(store,first.authenticator);
    const second = await addPending(store,first.cookie,first.authenticator); store.close();
    const state = saved(root); state.sessions.push({ ...state.sessions[0], id:"pending-session", credential_id:second.next.id });
    writeFileSync(join(root,"owner.json"),JSON.stringify(state)); store = new OwnerStore(config,root,{ now: () => clock });
    expect((await login(store,first.authenticator))?.status).toBe(409);
    expect(saved(root).sessions).toHaveLength(4); store.revokeSession(state.sessions[1].id);
    expect((await login(store,first.authenticator))?.status).toBe(204);
    store.close(); const over = saved(root); over.sessions.push({...over.sessions[0],id:"over-capacity"});
    writeFileSync(join(root,"owner.json"),JSON.stringify(over)); store = new OwnerStore(config,root,{ now: () => clock });
    const before = readFileSync(join(root,"owner.json"),"utf8");
    expect((await login(store,first.authenticator))?.status).toBe(409);
    expect(readFileSync(join(root,"owner.json"),"utf8")).toBe(before);
  } finally { store.close(); }
});
test("failed issuance save aborts active signals and emits no cookie", async () => {
  let fail = false; const root = temporary(), store = new OwnerStore(config,root,{now: () => clock, write:(path,state)=>{
    if(fail) throw Error("fake write failure"); writeFileSync(path,JSON.stringify(state));
  }});
  try {
    const first = await enroll(store,root), session = store.match(request("/",{},first.cookie))!;
    const signal = store.signal(session.id), before = readFileSync(join(root,"owner.json"),"utf8"); fail = true;
    const response = (await login(store,first.authenticator))!;
    expect(response.status).toBe(503); expect(response.headers.has("set-cookie")).toBe(false);
    expect(signal.aborted).toBe(true); expect(store.current(session.id)).toBeNull();
    expect(readFileSync(join(root,"owner.json"),"utf8")).toBe(before);
  } finally { store.close(); }
});

for (const invalidate of ["revoke", "expire"] as const) test(`${invalidate} during asynchronous passkey proof denies activation`, async () => {
  const root=temporary(); let now=clock, hold=false, entered!:()=>void, release!:()=>void;
  const started=new Promise<void>(r=>entered=r), gate=new Promise<void>(r=>release=r);
  const store=new OwnerStore(config,root,{now:()=>now,authenticate:async options=>{if(hold){entered();await gate;}return verifyAuthenticationResponse(options);}});
  try {
    const first=await enroll(store,root), second=await addPending(store,first.cookie,first.authenticator);
    const session=store.match(request("/",{},first.cookie))!, signal=store.signal(session.id); hold=true;
    const result=call(store,"/api/owner/prove",{ceremonyId:second.pending.ceremonyId,response:second.next.assertion(second.pending.options.challenge)},first.cookie);
    await started; if(invalidate==="revoke")store.revokeSession(session.id);else now+=31*60_000;
    release();const response=(await result)!;expect(response.status).toBe(401);expect(response.headers.has("set-cookie")).toBe(false);
    expect(signal.aborted).toBe(true);expect(saved(root).credentials.find((c:{id:string})=>c.id===second.next.id).status).toBe("pending");
  } finally {release();store.close();}
});
test("actual owner revocation denies final fake effects and closes only its connection",async()=>{
  const {createConnections,connectionData}=await import("./core/connections.ts");
  const root=temporary(),store=new OwnerStore(config,root,{now:()=>clock});
  try {
    const first=await enroll(store,root),otherCookie=await signIn(store,first.authenticator);
    const firstId=store.match(request("/",{},first.cookie))!.id,otherId=store.match(request("/",{},otherCookie))!.id;
    const closed:string[]=[],dropped:string[]=[],detached:string[]=[];
    const socket=(id:string)=>({data:connectionData({ownerSessionId:id,deviceId:undefined,readOnly:false}),close:()=>closed.push(id)}) as unknown as import("./core/connections.ts").Client;
    const a=socket(firstId),b=socket(otherId),clients=new Set([a,b]),present=new Set([a,b]);
    const connections=createConnections({clients,present,owner:store,
      devices:{onRevoke:()=>()=>{}} as unknown as import("./devices.ts").DeviceStore,
      pending:{close:()=>{}} as unknown as import("./pending-input.ts").PendingInputs<import("./core/connections.ts").Client,never>,
      detachClaimed:c=>detached.push(c.data.ownerSessionId!),dropClaims:c=>dropped.push(c.data.ownerSessionId!)});
    expect(connections.admit(a)).toBe(true);expect(connections.admit(b)).toBe(true);
    let release!:()=>void;const gate=new Promise<void>(r=>release=r),effects:string[]=[];
    const write=(async()=>{await gate;if(connections.mayType(a))effects.push("type");if(connections.mayEraseSecret(a))effects.push("erase");})();
    store.revokeSession(firstId);release();await write;
    expect(effects).toEqual([]);expect(closed).toEqual([firstId]);expect(dropped).toEqual([firstId]);expect(detached).toEqual([firstId]);
    expect(connections.mayType(b)).toBe(true);expect(()=>connections.authorizeSocket(a)).toThrow("Owner access revoked");
    connections.end(a,"closed");connections.end(b,"closed");
  }finally{store.close();}
});
