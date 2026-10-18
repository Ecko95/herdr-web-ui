/**
 * Owner requests to the orchestrator through the existing OpenRig queue.
 * Motoko keeps the owner proof in a private receipt; OpenRig keeps the obligation, its state and its result.
 * The only seam is the fixed queue: create, read item, read transitions. Nothing here picks a destination,
 * forwards a credential or sets an OpenRig identity header.
 */
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { MotokoQueueView, MotokoRequestView, MotokoRequests, MotokoResultView } from "../shared/motoko.ts";
import { MOTOKO_REQUEST_TEXT_MAX } from "../shared/motoko.ts";
import { motokoTarget } from "./motoko-config.ts";
import { isJsonObject } from "./http.ts";

export const ITEM_BUDGET = 262_144;
export const TRANSITIONS_BUDGET = 4_194_304;
const DEADLINE_MS = 2_000;
const RECEIPTS_MAX = 100;
const RECEIPT_FILE_MAX = 1_048_576;
const RESULT_MAX = 8_192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class CoordinationError extends Error { constructor(readonly code: string, readonly status = 400) { super(code); } }

export interface Binding { rigId: string; sourceSession: string; destinationSession: string }
export interface OwnerContext { sessionId: string; origin: string; recheck(): void }
export interface QueueCreate { qitemId: string; sourceSession: string; destinationSession: string; body: string; summary: string; tags: string[] }
export interface QueueReply { status: number; bytes: Uint8Array }
export interface CoordinationQueue {
  create(input: QueueCreate, signal: AbortSignal): Promise<QueueReply>;
  item(qitemId: string, signal: AbortSignal): Promise<QueueReply>;
  transitions(qitemId: string, signal: AbortSignal): Promise<QueueReply>;
}
interface Receipt {
  // Old receipts lack rigId: retain their bytes and refuse them before any queue read.
  rigId?: string;
  requestId: string; qitemId: string; createdAt: string; text: string; textSha256: string; sourceSession: string; destinationSession: string;
  origin: { kind: "motoko-owner"; sessionId: string; ownerOrigin: string; checkedAt: string };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/**
 * The configured source counts only when it is exactly the registered human address that the source check returns.
 * The check's other fields (connectors, readiness, paths) are dropped unread. No fallback source exists.
 */
export async function sourceBinding(env: Record<string, string | undefined>, check: () => Promise<unknown>): Promise<Binding | null> {
  const target = motokoTarget(env);
  if (!target) return null;
  try {
    const answer = await check();
    const record = isJsonObject(answer) ? answer["record"] : null;
    if (!isJsonObject(answer) || answer["ok"] !== true || !isJsonObject(record) || record["entityId"] !== target.humanId || record["address"] !== target.sourceSession) return null;
  } catch { return null; }
  return { rigId: target.rigId, sourceSession: target.sourceSession, destinationSession: target.destinationSession };
}

/** The immutable queue body: the same bytes for every retry of one receipt. */
export function envelope(receipt: Pick<Receipt, "requestId" | "qitemId" | "text" | "textSha256">): string {
  return JSON.stringify({
    kind: "motoko-request-v1", requestId: receipt.requestId, qitemId: receipt.qitemId, textSha256: receipt.textSha256, text: receipt.text,
    origin: "motoko-owner-receipt",
    instructions: [
      "Keep this root obligation with the orchestrator; dispatch worker work as separate queue items that name this qitemId.",
      "If the root is blocked, park it only on a typed gate: auth:motoko-coordination-prerequisite or external:motoko-coordination-dependency. Never park this root on a human seat.",
      "Finish with state done, closure reason no-follow-on, and a transition note that is JSON {kind:\"motoko-result-v1\",requestId,qitemId,text}.",
    ],
  });
}

function validInput(raw: unknown): { requestId: string; text: string } {
  if (!isJsonObject(raw) || Object.keys(raw).sort().join(",") !== "requestId,text") throw new CoordinationError("invalid_request");
  const { requestId, text } = raw as { requestId: unknown; text: unknown };
  if (typeof requestId !== "string" || !UUID.test(requestId)) throw new CoordinationError("invalid_request");
  if (typeof text !== "string" || text.trim() === "" || bytes(text) > MOTOKO_REQUEST_TEXT_MAX) throw new CoordinationError("invalid_request");
  return { requestId, text };
}

function validReceipt(value: unknown): value is Receipt {
  if (!isJsonObject(value) || !isJsonObject(value["origin"])) return false;
  const origin = value["origin"];
  return typeof value["requestId"] === "string" && UUID.test(value["requestId"]) && value["qitemId"] === `qitem-motoko-${value["requestId"]}`
    && typeof value["createdAt"] === "string" && typeof value["text"] === "string" && value["textSha256"] === sha256(value["text"])
    && typeof value["sourceSession"] === "string" && typeof value["destinationSession"] === "string"
    && origin["kind"] === "motoko-owner" && typeof origin["sessionId"] === "string" && typeof origin["ownerOrigin"] === "string" && typeof origin["checkedAt"] === "string";
}

/** The receipt store: bounded read, refuse anything malformed, private atomic write with a synced parent. */
function readReceipts(file: string): Receipt[] {
  let fd: number;
  try { fd = openSync(file, "r"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new CoordinationError("receipt_unavailable", 503);
  }
  try {
    const buffer = Buffer.alloc(RECEIPT_FILE_MAX + 1);
    let length = 0;
    for (let read; length <= RECEIPT_FILE_MAX && (read = readSync(fd, buffer, length, buffer.length - length, null)) > 0;) length += read;
    if (length > RECEIPT_FILE_MAX) throw new CoordinationError("receipt_unavailable", 503);
    const value: unknown = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    if (!isJsonObject(value) || value["version"] !== 1 || !Array.isArray(value["receipts"]) || value["receipts"].length > RECEIPTS_MAX || !value["receipts"].every(validReceipt)) {
      throw new CoordinationError("receipt_unavailable", 503);
    }
    const receipts = value["receipts"] as Receipt[];
    if (new Set(receipts.map((r) => r.requestId)).size !== receipts.length) throw new CoordinationError("receipt_unavailable", 503);
    return receipts;
  } catch (error) {
    throw error instanceof CoordinationError ? error : new CoordinationError("receipt_unavailable", 503);
  } finally { closeSync(fd); }
}

function writeReceipts(dir: string, receipts: Receipt[]): void {
  // readReceipts refuses a file above RECEIPT_FILE_MAX: a receipt that does not fit is refused before any write
  const document = JSON.stringify({ version: 1, receipts });
  if (bytes(document) > RECEIPT_FILE_MAX) throw new CoordinationError("history_full", 409);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "coordination.json");
    const temporary = `${file}.${createHash("sha256").update(`${process.pid}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 16)}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try { writeSync(fd, document); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temporary, file); } catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
    const parent = openSync(dir, "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } catch { throw new CoordinationError("receipt_unavailable", 503); }
}

/** One queue call under its own deadline and the caller's; the answer is parsed only within budget and time. */
async function call(read: (signal: AbortSignal) => Promise<QueueReply>, budget: number, deadline: number, outer?: AbortSignal):
  Promise<{ ok: true; status: number; value: unknown } | { ok: false; reason: "timeout" | "too_large" | "unavailable" | "invalid" }> {
  const remaining = Math.min(DEADLINE_MS, deadline - Date.now());
  if (remaining <= 0 || outer?.aborted) return { ok: false, reason: "timeout" };
  const signal = AbortSignal.any([AbortSignal.timeout(remaining), ...(outer ? [outer] : [])]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), remaining); });
  let reply: QueueReply | "late";
  try { reply = await Promise.race([read(signal), late]); } catch { return signal.aborted ? { ok: false, reason: "timeout" } : { ok: false, reason: "unavailable" }; }
  finally { clearTimeout(timer); }
  if (reply === "late" || Date.now() > deadline) return { ok: false, reason: "timeout" };
  if (reply.bytes.byteLength > budget) return { ok: false, reason: "too_large" };
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reply.bytes)); } catch { return { ok: false, reason: "invalid" }; }
  if (Date.now() > deadline) return { ok: false, reason: "timeout" };
  return { ok: true, status: reply.status, value };
}

const nullable = (value: unknown) => (typeof value === "string" && value.length <= 200 ? value : null);

function queueView(receipt: Receipt, item: Record<string, unknown>): MotokoQueueView | null {
  if (item["qitemId"] !== receipt.qitemId || item["sourceSession"] !== receipt.sourceSession || item["destinationSession"] !== receipt.destinationSession || item["body"] !== envelope(receipt) || typeof item["state"] !== "string") return null;
  return {
    status: "known", state: item["state"].slice(0, 40), blockedOn: nullable(item["blockedOn"]), handedOffTo: nullable(item["handedOffTo"]),
    closureReason: nullable(item["closureReason"]), nudge: nullable(item["lastNudgeResult"]), delivery: nullable(item["deliveryOutcome"]),
    observedAt: typeof item["tsUpdated"] === "string" ? item["tsUpdated"] : new Date().toISOString(),
  };
}

/** A final answer is the last transition that is not a note, done/no-follow-on, from the fixed orchestrator over transport:v1, matching the receipt. */
function readResult(receipt: Receipt, note: unknown): { text: string } | { reason: "malformed" | "mismatched" | "too_large" } | null {
  if (typeof note !== "string" || !note.trimStart().startsWith("{")) return null;
  let value: unknown;
  try { value = JSON.parse(note); } catch { return { reason: "malformed" }; }
  if (!isJsonObject(value) || value["kind"] !== "motoko-result-v1") return null;
  if (Object.keys(value).sort().join(",") !== "kind,qitemId,requestId,text" || typeof value["text"] !== "string" || value["text"].trim() === "") return { reason: "malformed" };
  if (value["requestId"] !== receipt.requestId || value["qitemId"] !== receipt.qitemId) return { reason: "mismatched" };
  if (bytes(value["text"]) > RESULT_MAX) return { reason: "too_large" };
  return { text: value["text"] };
}

function resultView(receipt: Receipt, queue: MotokoQueueView, transitions: unknown): MotokoResultView {
  if (!Array.isArray(transitions)) return { status: "unavailable", reason: "unread" };
  const rows = transitions.filter(isJsonObject).filter((t) => t["qitemId"] === receipt.qitemId)
    .sort((a, b) => Number(a["transitionId"]) - Number(b["transitionId"]));
  const handed = queue.status === "known" && (queue.handedOffTo !== null || queue.closureReason === "handed_off_to");
  if (handed || rows.some((t) => t["closureReason"] === "handed_off_to")) return { status: "handed_off" };
  const trusted = (t: Record<string, unknown>) => t["actorSession"] === receipt.destinationSession && t["identityProvenance"] === "transport:v1";
  // a note append keeps the item's state and sets no closure (OpenRig queue-repository.js:1686-1714): it decides nothing
  const decisive = rows.filter((t, i) => i === 0 || t["closureReason"] != null || t["closureTarget"] != null || t["state"] !== rows[i - 1]!["state"]);
  const finals = decisive.filter((t) => t["state"] === "done" && t["closureReason"] === "no-follow-on");
  const last = decisive.at(-1);
  if (last && finals.at(-1) === last && queue.status === "known" && queue.state === "done") {
    const read = readResult(receipt, last["transitionNote"]);
    if (read === null) return { status: "complete_without_result" };
    if ("reason" in read) return { status: "unavailable", reason: read.reason };
    if (!trusted(last)) return { status: "unavailable", reason: "untrusted_actor" };
    return { status: "final", text: read.text, at: typeof last["ts"] === "string" ? last["ts"] : "" };
  }
  const earlier = [...finals].reverse().map((t) => ({ t, read: readResult(receipt, t["transitionNote"]) }))
    .find(({ t, read }) => read !== null && "text" in read && trusted(t));
  if (earlier && earlier.read && "text" in earlier.read) return { status: "reopened", text: earlier.read.text };
  return { status: "none" };
}

export function createCoordination(deps: { stateDir: string; binding: Binding | null; queue: CoordinationQueue; now: () => number; deadlineMs?: number }) {
  const binding = deps.binding ? { ...deps.binding } : null;
  const file = join(deps.stateDir, "coordination.json");
  const checkScope = (receipts: Receipt[]) => {
    if (receipts.some(r => !binding || r.rigId !== binding.rigId || r.sourceSession !== binding.sourceSession || r.destinationSession !== binding.destinationSession)) {
      throw new CoordinationError("coordination_scope_mismatch", 409);
    }
  };
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => {});
    return next;
  };

  async function project(receipt: Receipt, deadline: number, signal?: AbortSignal): Promise<MotokoRequestView> {
    const base = { requestId: receipt.requestId, qitemId: receipt.qitemId, createdAt: receipt.createdAt, text: receipt.text, saved: true as const };
    const item = await call((s) => deps.queue.item(receipt.qitemId, s), ITEM_BUDGET, deadline, signal);
    if (!item.ok) return { ...base, queue: { status: "unknown", reason: item.reason }, result: { status: "unavailable", reason: "unread" } };
    if (item.status === 404) return { ...base, queue: { status: "unknown", reason: "not_found" }, result: { status: "none" } };
    const queue = item.status === 200 && isJsonObject(item.value) ? queueView(receipt, item.value) : null;
    if (!queue) return { ...base, queue: { status: "unknown", reason: "invalid" }, result: { status: "unavailable", reason: "unread" } };
    const transitions = await call((s) => deps.queue.transitions(receipt.qitemId, s), TRANSITIONS_BUDGET, deadline, signal);
    if (!transitions.ok) return { ...base, queue, result: { status: "unavailable", reason: transitions.reason === "too_large" ? "too_large" : "unread" } };
    return { ...base, queue, result: transitions.status === 200 ? resultView(receipt, queue, transitions.value) : { status: "unavailable", reason: "unread" } };
  }

  return {
    enabled: binding !== null,
    /** Validate, persist the receipt, recheck the owner, create once; a lost reply stays unknown. */
    submit(owner: OwnerContext, raw: unknown): Promise<MotokoRequestView> {
      if (!binding) return Promise.reject(new CoordinationError("coordination_origin_unbound", 409));
      let input: { requestId: string; text: string };
      try { input = validInput(raw); } catch (error) { return Promise.reject(error); }
      return serial(async () => {
        const receipts = readReceipts(file);
        checkScope(receipts);
        let receipt = receipts.find((r) => r.requestId === input.requestId);
        if (receipt) {
          if (receipt.text !== input.text || receipt.textSha256 !== sha256(input.text) || receipt.sourceSession !== binding.sourceSession || receipt.destinationSession !== binding.destinationSession) {
            throw new CoordinationError("identifier_conflict", 409);
          }
        } else {
          if (receipts.length >= RECEIPTS_MAX) throw new CoordinationError("history_full", 409);
          owner.recheck();
          const at = new Date(deps.now()).toISOString();
          receipt = { requestId: input.requestId, qitemId: `qitem-motoko-${input.requestId}`, createdAt: at, text: input.text, textSha256: sha256(input.text),
            ...binding, origin: { kind: "motoko-owner", sessionId: owner.sessionId, ownerOrigin: owner.origin, checkedAt: at } };
          writeReceipts(deps.stateDir, [...receipts, receipt]);
        }
        owner.recheck();
        const body = envelope(receipt);
        const created = await call((s) => deps.queue.create({ qitemId: receipt.qitemId, sourceSession: binding.sourceSession, destinationSession: binding.destinationSession, body, summary: "Motoko owner request", tags: ["motoko-coordination"] }, s), ITEM_BUDGET, Date.now() + (deps.deadlineMs ?? DEADLINE_MS));
        owner.recheck();
        const base = { requestId: receipt.requestId, qitemId: receipt.qitemId, createdAt: receipt.createdAt, text: receipt.text, saved: true as const, result: { status: "none" as const } };
        if (!created.ok || created.status >= 500) return { ...base, queue: { status: "unknown", reason: "create_unconfirmed" } };
        if (created.status === 409) throw new CoordinationError("identifier_conflict", 409);
        const queue = (created.status === 200 || created.status === 201) && isJsonObject(created.value) ? queueView(receipt, created.value) : null;
        if (queue) return { ...base, queue };
        if (isJsonObject(created.value) && created.value["qitemId"] === receipt.qitemId) throw new CoordinationError("identifier_conflict", 409);
        return { ...base, queue: { status: "unknown", reason: "create_unconfirmed" } };
      });
    },
    /** The owner's receipts with OpenRig's current view; never creates, nudges or reads an unnamed row. */
    async history(owner: OwnerContext, signal: AbortSignal): Promise<MotokoRequests> {
      owner.recheck();
      const receipts = await serial(async () => readReceipts(file));
      checkScope(receipts);
      const deadline = Date.now() + (deps.deadlineMs ?? DEADLINE_MS);
      const requests: MotokoRequestView[] = [];
      for (const receipt of [...receipts].reverse()) requests.push(await project(receipt, deadline, signal));
      owner.recheck();
      return { enabled: binding !== null, requests, sampledAt: new Date(deps.now()).toISOString() };
    },
  };
}
export type Coordination = ReturnType<typeof createCoordination>;

/** A bounded child process; tests pass a fake. */
export interface ChildProcess { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void }
type Spawn = (argv: readonly string[], env: Record<string, string>, stdin?: string) => ChildProcess;
const spawnChild: Spawn = (argv, env, stdin) => {
  const child = Bun.spawn([...argv], { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe", env });
  return { stdout: child.stdout, stderr: child.stderr, exited: child.exited, kill: () => child.kill("SIGKILL") };
};

/** Reads at most `limit + 1` bytes, so a caller can tell "over budget" without holding an unbounded answer. */
async function readLimited(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length <= limit) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      length += next.value.byteLength;
    }
  } finally { await reader.cancel().catch(() => {}); }
  const out = new Uint8Array(Math.min(length, limit + 1));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, out.byteLength - offset);
    out.set(part, offset);
    offset += part.byteLength;
    if (offset >= out.byteLength) break;
  }
  return out;
}

async function run(spawn: Spawn, argv: readonly string[], env: Record<string, string>, limit: number, signal: AbortSignal, stdin?: string) {
  signal.throwIfAborted();
  const child = spawn(argv, env, stdin);
  const stop = () => child.kill();
  signal.addEventListener("abort", stop, { once: true });
  try {
    const [stdout, stderr, exit] = await Promise.all([readLimited(child.stdout, limit), readLimited(child.stderr, 64), child.exited]);
    signal.throwIfAborted();
    return { stdout, stderr: new TextDecoder().decode(stderr).trim(), exit };
  } finally { signal.removeEventListener("abort", stop); child.kill(); }
}

const DAEMON = "http://127.0.0.1:7433/api/queue";
const CURL = ["/usr/bin/curl", "--disable", "--silent", "--noproxy", "*", "--proto", "=http", "--connect-timeout", "1", "--max-time", "2", "--write-out", "%{stderr}%{http_code}"];
const CURL_ENV = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };

/**
 * The fixed local daemon, headerless: OpenRig records the body source as claimed:v1. No seat variable reaches curl,
 * no proxy applies, and no identity, cookie or authorization header is sent.
 */
export function curlQueue(spawn: Spawn = spawnChild): CoordinationQueue {
  const get = async (path: string, limit: number, signal: AbortSignal): Promise<QueueReply> => {
    const { stdout, stderr, exit } = await run(spawn, [...CURL, `${DAEMON}/${path}`], CURL_ENV, limit, signal);
    const status = Number(stderr);
    if (exit !== 0 || !Number.isInteger(status) || status < 100) throw new Error("daemon request failed");
    return { status, bytes: stdout };
  };
  const id = (qitemId: string) => { if (!/^qitem-motoko-[0-9a-f-]{36}$/.test(qitemId)) throw new Error("invalid qitem id"); return qitemId; };
  return {
    async create(input, signal) {
      const body = JSON.stringify({ ...input, nudge: true });
      const { stdout, stderr, exit } = await run(spawn, [...CURL, "-X", "POST", "-H", "content-type: application/json", "--data-binary", "@-", `${DAEMON}/create`], CURL_ENV, ITEM_BUDGET, signal, body);
      const status = Number(stderr);
      if (exit !== 0 || !Number.isInteger(status) || status < 100) throw new Error("daemon request failed");
      return { status, bytes: stdout };
    },
    item: async (qitemId, signal) => get(id(qitemId), ITEM_BUDGET, signal),
    transitions: async (qitemId, signal) => get(`${id(qitemId)}/transitions`, TRANSITIONS_BUDGET, signal),
  };
}

/**
 * The startup source check: `rig gateway human show <configured-human> --json` with only PATH and HOME, so no OPENRIG_* or
 * RIGGED_* seat identity is inherited. Only ok, entityId and address leave this function; nothing is logged.
 */
export function rigSourceCheck(env: Record<string, string | undefined> = process.env, spawn: Spawn = spawnChild): () => Promise<unknown> {
  const target = motokoTarget(env);
  return async () => {
    if (!target) throw new Error("Motoko configuration unavailable");
    const clean: Record<string, string> = {};
    for (const key of ["PATH", "HOME"]) if (env[key]) clean[key] = env[key]!;
    const { stdout, exit } = await run(spawn, ["rig", "gateway", "human", "show", target.humanId, "--json"], clean, 65_536, AbortSignal.timeout(5_000));
    if (exit !== 0 || stdout.byteLength > 65_536) throw new Error("source check failed");
    const value: unknown = JSON.parse(new TextDecoder().decode(stdout));
    const record = isJsonObject(value) ? value["record"] : null;
    return { ok: isJsonObject(value) && value["ok"] === true, record: isJsonObject(record) ? { entityId: record["entityId"], address: record["address"] } : null };
  };
}
