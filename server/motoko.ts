/** Owner-only status metadata. The production provider never substitutes fixtures. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Activity, Confidence, Domain, Known, MotokoNeedsYou, MotokoRig, MotokoSeat, MotokoStatus } from "../shared/motoko.ts";
import { createOpenRigProvider, MetadataTimeout } from "./motoko-reader.ts";
import { isJsonObject, jsonResponse } from "./http.ts";
import { CoordinationError, type Coordination, type OwnerContext } from "./motoko-coordination.ts";

export type MotokoProvider = ((signal: AbortSignal) => Promise<unknown>) & { source?: MotokoStatus["source"] };

const PROVIDER_TIMEOUT_MS = 2_000;
const SUMMARY_MAX = 500;
const ACTIVITIES: readonly Activity[] = ["working", "idle", "needs_input", "stopped", "unknown"];
const CONFIDENCES: readonly Confidence[] = ["oracle", "inferred", "stale", "unknown"];
const DOMAINS: readonly Domain[] = ["work", "personal", "unknown"];
const NAME = /^[a-z][a-z0-9-]{0,47}$/;

/** A fixture by name from server/fixtures/motoko/. `fail: "throw" | "timeout"` in the file makes the provider do that. */
export function fixtureProvider(name: string): MotokoProvider {
  if (!/^[a-z]+$/.test(name)) throw new Error(`invalid Motoko fixture name ${name}`);
  const path = join(import.meta.dir, "fixtures", "motoko", `${name}.json`);
  return async (signal) => {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isJsonObject(data) && data["fail"] === "throw") throw new Error("fixture collector failed");
    if (isJsonObject(data) && data["fail"] === "timeout") {
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    return data;
  };
}

/** The production default reads only the fixed selected rig. */
export const defaultMotokoProvider: MotokoProvider = createOpenRigProvider();

type Errors = MotokoStatus["errors"];
const text = (value: unknown, max = 120): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** The instant `agoMs` before `now`; null when a Date cannot hold it, so the caller treats the age as malformed. */
const isoBefore = (now: number, agoMs: number): string | null => {
  const at = new Date(now - agoMs);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

function known(value: unknown, observedAt: string | null, reason: string): Known<number> | null {
  if (value === null || value === undefined) return { state: "unknown", reason };
  if (!count(value) || observedAt === null) return null;
  return { state: "known", value, observedAt };
}

/** Applied compactions, each (session, entry) once; null receipts: the source does not report them. */
export function appliedCompactions(receipts: unknown, observedAt: string): Known<number> | null {
  if (receipts === null || receipts === undefined) return { state: "unknown", reason: "compaction receipts not reported" };
  if (!Array.isArray(receipts)) return null;
  const applied = new Set<string>();
  for (const receipt of receipts) {
    if (!isJsonObject(receipt) || !text(receipt["session"]) || !text(receipt["entryId"]) || !text(receipt["status"], 20)) return null;
    if (receipt["status"] === "applied") applied.add(JSON.stringify([receipt["session"], receipt["entryId"]]));
  }
  return { state: "known", value: applied.size, observedAt };
}

function readSeat(raw: unknown, now: number, sampledAt: string): MotokoSeat | null {
  if (!isJsonObject(raw) || !text(raw["id"]) || !text(raw["session"]) || !text(raw["role"]) || !text(raw["runtime"])) return null;
  const activity = raw["activity"] as Activity;
  const confidence = raw["confidence"] as Confidence;
  if (!ACTIVITIES.includes(activity) || !CONFIDENCES.includes(confidence) || !isJsonObject(raw["context"])) return null;
  const context = raw["context"];
  const ago = context["observedAgoMs"];
  if (!(ago === null || ago === undefined || count(ago))) return null;
  const observedAt = count(ago) ? isoBefore(now, ago) : null;
  if (count(ago) && observedAt === null) return null;
  const used = known(context["used"], observedAt, "context use not reported");
  const window = known(context["window"], observedAt, "context window not reported");
  const compactions = appliedCompactions(raw["compactionReceipts"], sampledAt);
  if (!used || !window || !compactions) return null;
  const workflow = raw["workflow"];
  if (workflow !== undefined && (!isJsonObject(workflow) ||
    !["running", "detached", "recoverable", "attention_required"].includes(String(workflow["lifecycle"])) ||
    !["resume-original", "fresh-primed", "awaiting-decision"].includes(String(workflow["restoreAction"])) || typeof workflow["blocked"] !== "boolean")) return null;
  return {
    ...(workflow === undefined ? {} : { workflow: {
      lifecycle: workflow["lifecycle"] as NonNullable<MotokoSeat["workflow"]>["lifecycle"],
      restoreAction: workflow["restoreAction"] as NonNullable<MotokoSeat["workflow"]>["restoreAction"], blocked: workflow["blocked"] as boolean,
    } }),
    id: raw["id"], session: raw["session"], role: raw["role"], runtime: raw["runtime"], activity, confidence,
    context: { used, window, sampledAt: observedAt }, appliedCompactions: compactions,
  };
}

function readRig(raw: unknown, now: number, sampledAt: string, errors: Errors, source: MotokoStatus["source"]): MotokoRig | null {
  if (!isJsonObject(raw) || !NAME.test(String(raw["id"])) || !NAME.test(String(raw["name"])) || !DOMAINS.includes(raw["domain"] as Domain) || !Array.isArray(raw["seats"])) {
    errors.push({ source, code: "invalid_record", message: "A rig record was malformed and is not shown." });
    return null;
  }
  const seats: MotokoSeat[] = [];
  for (const [index, seat] of raw["seats"].entries()) {
    const read = readSeat(seat, now, sampledAt);
    if (read) seats.push(read);
    else errors.push({ source, code: "invalid_record", message: `Seat ${index + 1} of rig ${raw["id"]} was malformed and is not shown.` });
  }
  return { id: raw["id"] as string, name: raw["name"] as string, domain: raw["domain"] as Domain, seats };
}

function readNeedsYou(raw: unknown, now: number, rigs: MotokoRig[]): MotokoNeedsYou | null {
  if (!isJsonObject(raw) || !text(raw["id"]) || !text(raw["rigId"]) || !text(raw["seatId"]) || !text(raw["summary"], SUMMARY_MAX) || !count(raw["sinceAgoMs"])) return null;
  // a request for a seat that is not on the roster cannot be shown against it
  if (!rigs.some((rig) => rig.id === raw["rigId"] && rig.seats.some((seat) => seat.id === raw["seatId"]))) return null;
  const since = isoBefore(now, raw["sinceAgoMs"]);
  if (since === null) return null;
  return { id: raw["id"], kind: "agent_workflow", rigId: raw["rigId"], seatId: raw["seatId"], summary: raw["summary"], since };
}

const TIMED_OUT = Symbol("timed out");
const CANCELED = Symbol("canceled");

/**
 * One sample from the provider, bounded by `timeoutMs`; a failure is an error with no rigs. The deadline settles
 * the sample whether or not the provider heeds its aborted signal, and an answer after the deadline is discarded.
 */
export async function collectMotoko(provider: MotokoProvider, now: () => number, timeoutMs = PROVIDER_TIMEOUT_MS, signal?: AbortSignal): Promise<MotokoStatus> {
  const source = provider.source ?? "fixture";
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel!: () => void;
  const canceled = new Promise<typeof CANCELED>((resolve) => {
    cancel = () => { resolve(CANCELED); controller.abort(new Error("canceled")); };
  });
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      resolve(TIMED_OUT);
      controller.abort(new Error("timeout"));
    }, timeoutMs);
  });
  const failed = (code: string, message: string): MotokoStatus => ({ sampledAt: new Date(now()).toISOString(), staleAfterMs: 0, source, ...(source === "OpenRig" ? { coverage: { activity: false, needsYou: false } } : {}), rigs: [], needsYou: [], errors: [{ source, code, message }] });
  let raw: unknown;
  try {
    // the race also handles the provider's rejection after the deadline, so none surfaces as unhandled
    raw = controller.signal.aborted ? CANCELED : await Promise.race([provider(controller.signal), deadline, canceled]);
  } catch (error) {
    if (error instanceof MetadataTimeout) return failed("timeout", "The status source did not answer in time.");
    if (signal?.aborted) return failed("canceled", "The status request was canceled.");
    return controller.signal.aborted ? failed("timeout", "The status source did not answer in time.") : failed("collector_failed", "The status source failed.");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
  if (raw === CANCELED) return failed("canceled", "The status request was canceled.");
  if (raw === TIMED_OUT) return failed("timeout", "The status source did not answer in time.");
  const at = now();
  if (!isJsonObject(raw) || !count(raw["sampledAgoMs"]) || !count(raw["staleAfterMs"]) || !Array.isArray(raw["rigs"]) || !Array.isArray(raw["needsYou"])) {
    return failed("invalid_sample", "The status sample was malformed.");
  }
  const sampledAt = isoBefore(at, raw["sampledAgoMs"]);
  if (sampledAt === null) return failed("invalid_sample", "The status sample was malformed.");
  const errors: Errors = [];
  const rigs = raw["rigs"].map((rig) => readRig(rig, at, sampledAt, errors, source)).filter((rig): rig is MotokoRig => rig !== null);
  const needsYou: MotokoNeedsYou[] = [];
  for (const item of raw["needsYou"]) {
    const read = readNeedsYou(item, at, rigs);
    if (read) needsYou.push(read);
    else errors.push({ source, code: "invalid_record", message: "A Needs-you record was malformed and is not shown." });
  }
  const coverage = { activity: false, needsYou: false };
  return { sampledAt, staleAfterMs: raw["staleAfterMs"], source, ...(source === "OpenRig" ? { coverage } : {}), rigs, needsYou, errors };
}

/** /api/motoko/*: the status read and the owner's requests. index.ts calls this after the owner gate admitted the request. */
export async function handleMotokoRequest(request: Request, url: URL, deps: { provider: MotokoProvider; now: () => number; timeoutMs?: number; coordination?: Coordination | null; owner?: OwnerContext | null }): Promise<Response> {
  if (url.pathname === "/api/motoko/requests") return handleRequests(request, deps.coordination ?? null, deps.owner ?? null);
  if (url.pathname !== "/api/motoko/status") return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
  if (request.method !== "GET") return jsonResponse({ error: { code: "method_not_allowed", message: "use GET" } }, 405, { allow: "GET" });
  return jsonResponse(await collectMotoko(deps.provider, deps.now, deps.timeoutMs, request.signal), 200, { "cache-control": "no-store" });
}

const REQUEST_BODY_MAX = 32_768;
const refuse = (error: unknown): Response => error instanceof CoordinationError
  ? jsonResponse({ error: { code: error.code, message: error.code } }, error.status, { "cache-control": "no-store" })
  : jsonResponse({ error: { code: "coordination_failed", message: "coordination_failed" } }, 500, { "cache-control": "no-store" });

/** POST creates or retries one request (exactly requestId and text); GET returns the owner's history. Never both. */
async function handleRequests(request: Request, coordination: Coordination | null, owner: OwnerContext | null): Promise<Response> {
  if (!coordination || !owner) return refuse(new CoordinationError("coordination_origin_unbound", 409));
  try {
    if (request.method === "GET") return jsonResponse(await coordination.history(owner, request.signal), 200, { "cache-control": "no-store" });
    if (request.method !== "POST") return jsonResponse({ error: { code: "method_not_allowed", message: "use GET or POST" } }, 405, { allow: "GET, POST" });
    const raw = new Uint8Array(await request.arrayBuffer());
    if (raw.byteLength > REQUEST_BODY_MAX) throw new CoordinationError("invalid_request", 413);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { throw new CoordinationError("invalid_request"); }
    return jsonResponse(await coordination.submit(owner, body), 200, { "cache-control": "no-store" });
  } catch (error) { return refuse(error); }
}
