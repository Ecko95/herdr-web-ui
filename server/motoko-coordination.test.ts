import { SOURCE, ORCHESTRATOR, RIG_ID, ENV } from "./fixtures/motoko-target.ts";
import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CoordinationError, ITEM_BUDGET, TRANSITIONS_BUDGET, createCoordination, curlQueue, envelope, rigSourceCheck, sourceBinding,
  type CoordinationQueue, type OwnerContext, type QueueCreate,
} from "./motoko-coordination.ts";

const ID = "0b7f4a5c-1d2e-4f60-8a9b-0c1d2e3f4a5b";
const ID2 = "1c8f4a5c-1d2e-4f60-8a9b-0c1d2e3f4a5b";
const QID = `qitem-motoko-${ID}`;
const enc = new TextEncoder();
const reply = (status: number, value: unknown) => ({ status, bytes: enc.encode(typeof value === "string" ? value : JSON.stringify(value)) });
const goodCheck = async () => ({ ok: true, record: { entityId: "fiction-owner", address: SOURCE, deliveryReadiness: "ready", connector: { secret: "x" } } });

function owner(alive = { value: true }): OwnerContext {
  return { sessionId: "sess-private-1", origin: "https://owner.example", recheck: () => { if (!alive.value) throw new CoordinationError("owner_required", 401); } };
}

/** A disposable OpenRig queue: real create semantics (same id + same source/destination returns the row). */
class FakeQueue implements CoordinationQueue {
  items = new Map<string, Record<string, unknown>>();
  rows = new Map<string, Record<string, unknown>[]>();
  creates: QueueCreate[] = [];
  loseNextReply = false;
  down = false;
  delayMs = 0;
  async create(input: QueueCreate, signal: AbortSignal) {
    await this.wait(signal);
    this.creates.push(input);
    if (this.down) throw new Error("connection refused");
    const existing = this.items.get(input.qitemId);
    if (existing && (existing["sourceSession"] !== input.sourceSession || existing["destinationSession"] !== input.destinationSession)) return reply(409, { error: "qitem_id_reuse" });
    const item = existing ?? { qitemId: input.qitemId, sourceSession: input.sourceSession, destinationSession: input.destinationSession, body: input.body, state: "pending", blockedOn: null, handedOffTo: null, closureReason: null, lastNudgeResult: "delivered-ack-pending", deliveryOutcome: null, tsUpdated: "2026-10-18T00:00:00.000Z" };
    this.items.set(input.qitemId, item);
    if (!this.rows.has(input.qitemId)) this.rows.set(input.qitemId, [{ transitionId: 1, qitemId: input.qitemId, ts: "2026-10-18T00:00:00.000Z", state: "pending", transitionNote: null, actorSession: input.sourceSession, closureReason: null, closureTarget: null, identityProvenance: "claimed:v1" }]);
    if (this.loseNextReply) { this.loseNextReply = false; throw new Error("socket hang up"); }
    return reply(201, item);
  }
  async item(id: string, signal: AbortSignal) {
    await this.wait(signal);
    if (this.down) throw new Error("connection refused");
    const item = this.items.get(id);
    return item ? reply(200, item) : reply(404, { error: "qitem_not_found" });
  }
  async transitions(id: string, signal: AbortSignal) {
    await this.wait(signal);
    if (this.down) throw new Error("connection refused");
    return this.items.has(id) ? reply(200, this.rows.get(id) ?? []) : reply(404, { error: "qitem_not_found" });
  }
  private wait(signal: AbortSignal) {
    if (this.delayMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, this.delayMs);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  }
  finish(id: string, note: unknown, over: Partial<Record<string, unknown>> = {}) {
    const list = this.rows.get(id)!;
    list.push({ transitionId: list.length + 1, qitemId: id, ts: "2026-10-18T01:00:00.000Z", state: "done", transitionNote: typeof note === "string" ? note : JSON.stringify(note), actorSession: ORCHESTRATOR, closureReason: "no-follow-on", closureTarget: null, identityProvenance: "transport:v1", ...over });
    this.items.get(id)!["state"] = "done";
  }
}

async function setup(options: { check?: () => Promise<unknown>; env?: Record<string, string> } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "motoko-coord-"));
  const queue = new FakeQueue();
  const binding = await sourceBinding(options.env ?? ENV, options.check ?? goodCheck);
  const coordination = createCoordination({ stateDir, binding, queue, now: () => Date.parse("2026-10-18T00:00:00.000Z") });
  return { stateDir, queue, coordination };
}
const result = (text = "done: 42", requestId = ID, qitemId = QID) => ({ kind: "motoko-result-v1", requestId, qitemId, text });

describe("source binding", () => {
  it("binds only the exact registered human address", async () => {
    expect(await sourceBinding(ENV, goodCheck)).toEqual({ rigId: RIG_ID, sourceSession: SOURCE, destinationSession: ORCHESTRATOR });
    for (const env of [{}, { HERDR_WEB_MOTOKO_SOURCE_SESSION: "" }, { HERDR_WEB_MOTOKO_SOURCE_SESSION: "fiction-owner@External" }, { HERDR_WEB_MOTOKO_SOURCE_SESSION: "team-orchestrator@fiction-lab" }]) {
      expect(await sourceBinding(env, goodCheck)).toBeNull();
    }
    const bad = [
      async () => ({ ok: false }), async () => ({ ok: true, record: { entityId: "fiction-owner", address: "other@external" } }),
      async () => ({ ok: true, record: { entityId: "someone", address: SOURCE } }), async () => "nonsense", async () => { throw new Error("rig failed"); },
    ];
    for (const check of bad) expect(await sourceBinding(ENV, check)).toBeNull();
  });
  it("keeps submission disabled without a binding and reports it", async () => {
    const { coordination, queue } = await setup({ env: {} });
    await expect(coordination.submit(owner(), { requestId: ID, text: "hi" })).rejects.toMatchObject({ code: "coordination_origin_unbound" });
    expect((await coordination.history(owner(), new AbortController().signal)).enabled).toBe(false);
    expect(queue.creates).toHaveLength(0);
  });
});

describe("request validation and origin", () => {
  it("accepts exactly requestId and text and rejects spoofed fields before any write", async () => {
    const { coordination, queue, stateDir } = await setup();
    const bad: unknown[] = [
      { requestId: ID, text: "x", sourceSession: "team-worker-a@fiction-lab" }, { requestId: ID, text: "x", destinationSession: "x@y" },
      { requestId: ID, text: "x", actor: "fiction-owner@external" }, { requestId: ID.toUpperCase(), text: "x" }, { requestId: "not-a-uuid", text: "x" },
      { requestId: ID, text: "   " }, { requestId: ID, text: "" }, { requestId: ID, text: "é".repeat(2049) }, { requestId: ID }, null, [],
    ];
    for (const body of bad) await expect(coordination.submit(owner(), body)).rejects.toMatchObject({ code: "invalid_request" });
    expect(queue.creates).toHaveLength(0);
    expect(readdirSync(stateDir)).toEqual([]);
  });
  it("uses only the fixed source and destination, whatever the server environment says", async () => {
    const previous = process.env["OPENRIG_SESSION_NAME"];
    process.env["OPENRIG_SESSION_NAME"] = "team-worker-a@fiction-lab";
    try {
      const { coordination, queue } = await setup();
      await coordination.submit(owner(), { requestId: ID, text: "hello" });
      expect(queue.creates[0]).toMatchObject({ qitemId: QID, sourceSession: SOURCE, destinationSession: ORCHESTRATOR });
      expect(JSON.stringify(queue.creates[0])).not.toContain("team-worker-a");
      expect(JSON.stringify(queue.creates[0])).not.toContain("sess-private-1");
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_SESSION_NAME"]; else process.env["OPENRIG_SESSION_NAME"] = previous;
    }
  });
  it("tells the orchestrator to keep custody, park on typed gates and return motoko-result-v1", () => {
    const body = JSON.parse(envelope({ requestId: ID, qitemId: QID, text: "x", textSha256: "a".repeat(64) }));
    expect(body).toMatchObject({ kind: "motoko-request-v1", requestId: ID, qitemId: QID, origin: "motoko-owner-receipt" });
    expect(body.instructions.join(" ")).toContain("auth:motoko-coordination-prerequisite");
    expect(body.instructions.join(" ")).toContain("external:motoko-coordination-dependency");
    expect(body.instructions.join(" ")).toContain("Never park this root on a human seat");
    expect(body.instructions.join(" ")).toContain("no-follow-on");
  });
});

describe("receipts and queue outcomes", () => {
  it("persists a private immutable receipt before the first create", async () => {
    const { coordination, queue, stateDir } = await setup();
    const view = await coordination.submit(owner(), { requestId: ID, text: "<b>hello</b>" });
    expect(view).toMatchObject({ requestId: ID, qitemId: QID, saved: true, text: "<b>hello</b>", queue: { status: "known", state: "pending", nudge: "delivered-ack-pending" } });
    const file = join(stateDir, "coordination.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved).toMatchObject({ version: 1, receipts: [{ requestId: ID, qitemId: QID, text: "<b>hello</b>", rigId: RIG_ID, sourceSession: SOURCE, destinationSession: ORCHESTRATOR, origin: { kind: "motoko-owner", sessionId: "sess-private-1", ownerOrigin: "https://owner.example" } }] });
    expect(JSON.stringify(view)).not.toContain("sess-private-1");
    expect(JSON.stringify(view)).not.toContain(stateDir);
    expect(queue.creates).toHaveLength(1);
  });
  it("does not dispatch when the receipt cannot be written", async () => {
    const { coordination, queue, stateDir } = await setup();
    chmodSync(stateDir, 0o500);
    try {
      await expect(coordination.submit(owner(), { requestId: ID, text: "x" })).rejects.toMatchObject({ code: "receipt_unavailable" });
    } finally { chmodSync(stateDir, 0o700); }
    expect(queue.creates).toHaveLength(0);
  });
  it("refuses malformed receipt state instead of starting empty", async () => {
    const { coordination, queue, stateDir } = await setup();
    writeFileSync(join(stateDir, "coordination.json"), "{not json", { mode: 0o600 });
    await expect(coordination.submit(owner(), { requestId: ID, text: "x" })).rejects.toMatchObject({ code: "receipt_unavailable" });
    await expect(coordination.history(owner(), new AbortController().signal)).rejects.toMatchObject({ code: "receipt_unavailable" });
    expect(queue.creates).toHaveLength(0);
    expect(readFileSync(join(stateDir, "coordination.json"), "utf8")).toBe("{not json");
  });
  it("makes one obligation from matching retries and refuses changed text", async () => {
    const { coordination, queue } = await setup();
    await coordination.submit(owner(), { requestId: ID, text: "same" });
    await coordination.submit(owner(), { requestId: ID, text: "same" });
    expect(queue.items.size).toBe(1);
    expect(queue.creates.map((c) => c.body)).toEqual([queue.creates[0]!.body, queue.creates[0]!.body]);
    await expect(coordination.submit(owner(), { requestId: ID, text: "same " })).rejects.toMatchObject({ code: "identifier_conflict" });
  });
  it("reports identifier_conflict when another payload owns the queue id", async () => {
    const { coordination, queue } = await setup();
    queue.items.set(QID, { qitemId: QID, sourceSession: "someone@else", destinationSession: ORCHESTRATOR, body: "other", state: "pending" });
    await expect(coordination.submit(owner(), { requestId: ID, text: "x" })).rejects.toMatchObject({ code: "identifier_conflict" });
    queue.items.set(QID, { qitemId: QID, sourceSession: SOURCE, destinationSession: ORCHESTRATOR, body: "a different body", state: "pending" });
    await expect(coordination.submit(owner(), { requestId: ID, text: "x" })).rejects.toMatchObject({ code: "identifier_conflict" });
  });
  it("keeps a lost create reply unknown, then reconciles the same id after a restart", async () => {
    const { coordination, queue, stateDir } = await setup();
    queue.loseNextReply = true;
    const view = await coordination.submit(owner(), { requestId: ID, text: "x" });
    expect(view.queue).toEqual({ status: "unknown", reason: "create_unconfirmed" });
    const restarted = createCoordination({ stateDir, binding: await sourceBinding(ENV, goodCheck), queue, now: Date.now });
    const history = await restarted.history(owner(), new AbortController().signal);
    expect(history.requests[0]).toMatchObject({ requestId: ID, queue: { status: "known", state: "pending" } });
    expect(queue.creates).toHaveLength(1);
  });
  it("keeps an unreachable daemon unknown and never claims nothing changed", async () => {
    const { coordination, queue } = await setup();
    queue.down = true;
    const view = await coordination.submit(owner(), { requestId: ID, text: "x" });
    expect(view.queue).toEqual({ status: "unknown", reason: "create_unconfirmed" });
    const history = await coordination.history(owner(), new AbortController().signal);
    expect(history.requests[0]!.queue).toEqual({ status: "unknown", reason: "unavailable" });
  });
  it("checks owner authority before dispatch and withholds the answer after revocation", async () => {
    const { coordination, queue } = await setup();
    const alive = { value: false };
    await expect(coordination.submit(owner(alive), { requestId: ID, text: "x" })).rejects.toMatchObject({ code: "owner_required" });
    expect(queue.creates).toHaveLength(0);
    const revokeDuringCreate = { value: true };
    const original = queue.create.bind(queue);
    queue.create = async (input, signal) => { const r = await original(input, signal); revokeDuringCreate.value = false; return r; };
    await expect(coordination.submit(owner(revokeDuringCreate), { requestId: ID2, text: "y" })).rejects.toMatchObject({ code: "owner_required" });
    expect(queue.items.has(`qitem-motoko-${ID2}`)).toBe(true);
    const history = await coordination.history(owner(), new AbortController().signal);
    expect(history.requests.map((r) => r.requestId)).toContain(ID2);
  });
  it("stops at 100 receipts with history_full", async () => {
    const { coordination, stateDir } = await setup();
    const receipts = Array.from({ length: 100 }, (_, i) => {
      const id = `${i.toString(16).padStart(8, "0")}-1d2e-4f60-8a9b-0c1d2e3f4a5b`;
      return { requestId: id, qitemId: `qitem-motoko-${id}`, createdAt: "2026-10-18T00:00:00.000Z", text: "t", textSha256: new Bun.CryptoHasher("sha256").update("t").digest("hex"), rigId: RIG_ID, sourceSession: SOURCE, destinationSession: ORCHESTRATOR, origin: { kind: "motoko-owner", sessionId: "s", ownerOrigin: "https://owner.example", checkedAt: "2026-10-18T00:00:00.000Z" } };
    });
    writeFileSync(join(stateDir, "coordination.json"), JSON.stringify({ version: 1, receipts }), { mode: 0o600 });
    await expect(coordination.submit(owner(), { requestId: ID, text: "x" })).rejects.toMatchObject({ code: "history_full" });
  });
});

describe("encoded receipt capacity", () => {
  it("refuses a receipt that would not fit 1 MiB before writing or dispatching, and keeps the store usable", async () => {
    const { coordination, stateDir, queue } = await setup();
    const file = join(stateDir, "coordination.json");
    // 4096 valid UTF-8 bytes that JSON escapes to about 24 KiB
    const heavy = "x" + "\u0000".repeat(4095);
    const ids: string[] = [];
    let refused: unknown = null;
    for (let i = 0; i < 100 && refused === null; i++) {
      const requestId = `${i.toString(16).padStart(8, "0")}-1d2e-4f60-8a9b-0c1d2e3f4a5b`;
      const before = existsSync(file) ? readFileSync(file) : null;
      const creates = queue.creates.length;
      try { await coordination.submit(owner(), { requestId, text: heavy }); ids.push(requestId); }
      catch (error) {
        refused = error;
        expect(existsSync(file) ? readFileSync(file) : null).toEqual(before);
        expect(queue.creates.length).toBe(creates);
      }
    }
    expect(refused).toMatchObject({ code: "history_full", status: 409 });
    const size = statSync(file).size;
    expect(size).toBeLessThanOrEqual(1_048_576);
    expect(size).toBeGreaterThan(1_048_576 - 2 * 24_700);
    expect((await coordination.history(owner(), new AbortController().signal)).requests).toHaveLength(ids.length);
    const restarted = createCoordination({ stateDir, binding: { rigId: RIG_ID, sourceSession: SOURCE, destinationSession: ORCHESTRATOR }, queue, now: () => Date.parse("2026-10-18T00:00:00.000Z") });
    expect((await restarted.history(owner(), new AbortController().signal)).requests).toHaveLength(ids.length);
    const creates = queue.creates.length, bytesBefore = readFileSync(file);
    await expect(restarted.submit(owner(), { requestId: ids[0]!, text: heavy })).resolves.toMatchObject({ requestId: ids[0], queue: { status: "known" } });
    expect(readFileSync(file)).toEqual(bytesBefore);
    expect(queue.creates.length).toBe(creates + 1);
    expect(new Set(queue.creates.map((c) => c.qitemId)).size).toBe(ids.length);
    await expect(restarted.submit(owner(), { requestId: ID, text: "short" })).resolves.toMatchObject({ saved: true });
    expect(statSync(file).size).toBeLessThanOrEqual(1_048_576);
  });
});

describe("result projection", () => {
  async function submitted() {
    const s = await setup();
    await s.coordination.submit(owner(), { requestId: ID, text: "question" });
    const read = async () => (await s.coordination.history(owner(), new AbortController().signal)).requests[0]!;
    return { ...s, read };
  }
  it("shows pending, blocked and delivery states as recorded", async () => {
    const { queue, read } = await submitted();
    expect((await read()).result).toEqual({ status: "none" });
    Object.assign(queue.items.get(QID)!, { state: "blocked", blockedOn: "auth:motoko-coordination-prerequisite", lastNudgeResult: "failed", deliveryOutcome: "undeliverable" });
    expect((await read()).queue).toMatchObject({ status: "known", state: "blocked", blockedOn: "auth:motoko-coordination-prerequisite", nudge: "failed", delivery: "undeliverable" });
  });
  it("returns a valid final result from the fixed orchestrator", async () => {
    const { queue, read } = await submitted();
    queue.finish(QID, result("<script>x</script> answer"));
    expect((await read()).result).toEqual({ status: "final", text: "<script>x</script> answer", at: "2026-10-18T01:00:00.000Z" });
  });
  it("refuses a claimed actor, a wrong id, malformed JSON and oversized text", async () => {
    const cases: [unknown, Record<string, unknown>, string][] = [
      [result(), { identityProvenance: "claimed:v1" }, "untrusted_actor"],
      [result(), { actorSession: "team-worker-a@fiction-lab" }, "untrusted_actor"],
      [result("x", ID2), {}, "mismatched"],
      [result("x", ID, `qitem-motoko-${ID2}`), {}, "mismatched"],
      ['{"kind":"motoko-result-v1",', {}, "malformed"],
      [result("y".repeat(8193)), {}, "too_large"],
      [{ ...result(), extra: 1 }, {}, "malformed"],
    ];
    for (const [note, over, reason] of cases) {
      const { queue, read } = await submitted();
      queue.finish(QID, note, over);
      expect((await read()).result).toEqual({ status: "unavailable", reason } as never);
    }
  });
  it("distinguishes complete without result, reopen and root handoff", async () => {
    let s = await submitted();
    s.queue.finish(QID, "plain closing note");
    expect((await s.read()).result).toEqual({ status: "complete_without_result" });
    s = await submitted();
    s.queue.finish(QID, result("first answer"));
    s.queue.rows.get(QID)!.push({ transitionId: 99, qitemId: QID, ts: "2026-10-18T02:00:00.000Z", state: "in-progress", transitionNote: "reopened", actorSession: ORCHESTRATOR, closureReason: null, closureTarget: null, identityProvenance: "transport:v1" });
    s.queue.items.get(QID)!["state"] = "in-progress";
    expect((await s.read()).result).toEqual({ status: "reopened", text: "first answer" });
    s = await submitted();
    s.queue.finish(QID, "handed", { closureReason: "handed_off_to", closureTarget: "team-worker-b@fiction-lab" });
    s.queue.items.get(QID)!["handedOffTo"] = "team-worker-b@fiction-lab";
    const handed = await s.read();
    expect(handed.result).toEqual({ status: "handed_off" });
    expect(handed.queue).toMatchObject({ handedOffTo: "team-worker-b@fiction-lab" });
  });
  it("keeps the final result after state-preserving notes, and not after a later reopen or plain completion", async () => {
    // the daemon's note append (queue-repository.js:1686-1714): the item's current state, no closure reason or target
    const note = (s: { queue: FakeQueue }, state: string, text = "Evidence attached") => {
      const list = s.queue.rows.get(QID)!;
      list.push({ transitionId: list.length + 1, qitemId: QID, ts: "2026-10-18T03:00:00.000Z", state, transitionNote: text, actorSession: ORCHESTRATOR, closureReason: null, closureTarget: null, identityProvenance: "transport:v1" });
    };
    let s = await submitted();
    s.queue.finish(QID, result("final answer"));
    note(s, "done"); note(s, "done", "second note");
    expect((await s.read()).result).toEqual({ status: "final", text: "final answer", at: "2026-10-18T01:00:00.000Z" });
    s = await submitted();
    s.queue.finish(QID, result("first answer"));
    note(s, "done"); note(s, "in-progress", "reopened"); note(s, "in-progress");
    s.queue.items.get(QID)!["state"] = "in-progress";
    expect((await s.read()).result).toEqual({ status: "reopened", text: "first answer" });
    s = await submitted();
    s.queue.finish(QID, result("first answer"));
    note(s, "in-progress", "reopened");
    s.queue.finish(QID, "closed again without a result");
    note(s, "done");
    expect((await s.read()).result).toEqual({ status: "complete_without_result" });
  });
  it("reads a final result after more than 400 transitions above 256 KiB", async () => {
    const { queue, read } = await submitted();
    const list = queue.rows.get(QID)!;
    for (let i = 0; i < 450; i++) list.push({ transitionId: list.length + 1, qitemId: QID, ts: "2026-10-18T00:30:00.000Z", state: "in-progress", transitionNote: "watchdog wake ".padEnd(600, "."), actorSession: ORCHESTRATOR, closureReason: null, closureTarget: null, identityProvenance: "transport:v1" });
    queue.finish(QID, result("after many"));
    const size = JSON.stringify(list).length;
    expect(size).toBeGreaterThan(ITEM_BUDGET);
    expect(size).toBeLessThan(TRANSITIONS_BUDGET);
    expect((await read()).result).toEqual({ status: "final", text: "after many", at: "2026-10-18T01:00:00.000Z" });
  });
  it("reports oversized transitions, an oversized item and a missed deadline as unavailable", async () => {
    let s = await submitted();
    const list = s.queue.rows.get(QID)!;
    for (let i = 0; i < 4200; i++) list.push({ transitionId: i + 2, qitemId: QID, ts: "t", state: "in-progress", transitionNote: "x".repeat(1000), actorSession: ORCHESTRATOR, closureReason: null, closureTarget: null, identityProvenance: "transport:v1" });
    s.queue.finish(QID, result());
    expect((await s.read()).result).toEqual({ status: "unavailable", reason: "too_large" });
    s = await submitted();
    s.queue.items.get(QID)!["summary"] = "z".repeat(ITEM_BUDGET);
    expect((await s.read()).queue).toEqual({ status: "unknown", reason: "too_large" });
    s = await submitted();
    s.queue.delayMs = 2_500;
    const started = Date.now();
    const late = await s.read();
    expect(Date.now() - started).toBeLessThan(2_400);
    expect(late.queue).toEqual({ status: "unknown", reason: "timeout" });
    expect(late.result).toEqual({ status: "unavailable", reason: "unread" });
  }, 10_000);
  it("never returns daemon rows that the receipts do not name", async () => {
    const { queue, coordination } = await submitted();
    queue.items.set("qitem-unrelated", { qitemId: "qitem-unrelated", sourceSession: "x", destinationSession: "y", body: "private", state: "pending" });
    const history = await coordination.history(owner(), new AbortController().signal);
    expect(history.requests).toHaveLength(1);
    expect(JSON.stringify(history)).not.toContain("qitem-unrelated");
  });
});

describe("production adapters (fake spawn only)", () => {
  const proc = (stdout: string, stderr = "", exit = 0) => ({ stdout: new Blob([stdout]).stream(), stderr: new Blob([stderr]).stream(), exited: Promise.resolve(exit), kill() {} });
  it("talks to the fixed daemon with curl, no proxy, no seat variables and no identity headers", async () => {
    const calls: { argv: readonly string[]; env: Record<string, string>; stdin?: string }[] = [];
    const queue = curlQueue((argv, env, stdin) => { calls.push({ argv, env, stdin }); return proc('{"ok":1}', "201"); });
    const created = await queue.create({ qitemId: QID, sourceSession: SOURCE, destinationSession: ORCHESTRATOR, body: "b", summary: "s", tags: ["t"] }, new AbortController().signal);
    expect(created.status).toBe(201);
    await queue.item(QID, new AbortController().signal);
    await queue.transitions(QID, new AbortController().signal);
    expect(calls.map((c) => c.argv.at(-1))).toEqual(["http://127.0.0.1:7433/api/queue/create", `http://127.0.0.1:7433/api/queue/${QID}`, `http://127.0.0.1:7433/api/queue/${QID}/transitions`]);
    for (const c of calls) {
      expect(c.argv).toContain("--noproxy");
      expect(c.argv.join(" ")).not.toMatch(/x-openrig|cookie|authorization/i);
      expect(c.env).toEqual({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });
    }
    expect(JSON.parse(calls[0]!.stdin!)).toEqual({ qitemId: QID, sourceSession: SOURCE, destinationSession: ORCHESTRATOR, body: "b", summary: "s", tags: ["t"], nudge: true });
    await expect(queue.item("../x", new AbortController().signal)).rejects.toThrow();
  });
  it("stops reading past the transitions budget", async () => {
    const queue = curlQueue(() => proc("x".repeat(TRANSITIONS_BUDGET + 10), "200"));
    expect((await queue.transitions(QID, new AbortController().signal)).bytes.byteLength).toBe(TRANSITIONS_BUDGET + 1);
  });
  it("runs the source check without inherited seat variables and keeps only three fields", async () => {
    let seen: { argv: readonly string[]; env: Record<string, string> } | null = null;
    const check = rigSourceCheck({ ...ENV, PATH: "/p", HOME: "/h", OPENRIG_SESSION_NAME: "team-x@y", RIGGED_SESSION_NAME: "z", SECRET: "s" }, (argv, env) => {
      seen = { argv, env };
      return proc(JSON.stringify({ ok: true, record: { entityId: "fiction-owner", address: SOURCE, connector: { token: "t" }, path: "/private" }, deliveryReadiness: "ready" }));
    });
    expect(await check()).toEqual({ ok: true, record: { entityId: "fiction-owner", address: SOURCE } });
    expect(seen!.argv).toEqual(["rig", "gateway", "human", "show", "fiction-owner", "--json"]);
    expect(seen!.env).toEqual({ PATH: "/p", HOME: "/h" });
  });
});
