/**
 * Motoko's status contract: what the server says about rigs and their seats, and what the
 * browser may infer from it. A value the source did not observe is `unknown` with a reason,
 * never a zero, and a percentage exists only where both of its numbers were observed.
 *
 * Pure and environment-free: the browser imports values from here, unlike shared/protocol.ts.
 */

export type Known<T> = { state: "known"; value: T; observedAt: string } | { state: "unknown"; reason: string };
export type Confidence = "oracle" | "inferred" | "stale" | "unknown";
export type Activity = "working" | "idle" | "needs_input" | "stopped" | "unknown";
export type Domain = "work" | "personal" | "unknown";

export interface MotokoSeat {
  id: string;
  session: string;
  role: string;
  runtime: string;
  activity: Activity;
  confidence: Confidence;
  context: { used: Known<number>; window: Known<number>; sampledAt: string | null };
  appliedCompactions: Known<number>;
  workflow?: { lifecycle: "running" | "detached" | "recoverable" | "attention_required"; restoreAction: "resume-original" | "fresh-primed" | "awaiting-decision"; blocked: boolean };
}

export interface MotokoRig { id: string; name: string; domain: Domain; seats: MotokoSeat[] }

/** An agent's request for the owner. `summary` is the agent's own text: shown, never trusted or rendered as markup. */
export interface MotokoNeedsYou { id: string; kind: "agent_workflow"; rigId: string; seatId: string; summary: string; since: string }

export interface MotokoStatus {
  sampledAt: string;
  staleAfterMs: number;
  source: "fixture" | "OpenRig";
  /** Absent only for legacy fixture responses. OpenRig declares missing coverage explicitly. */
  coverage?: { activity: boolean; needsYou: boolean };
  rigs: MotokoRig[];
  needsYou: MotokoNeedsYou[];
  errors: { source: string; code: string; message: string }[];
}

/**
 * The owner gate's refusals and its health field (server/motoko-owner.ts). shared/protocol.ts
 * gains the same names with the gate; they are spelled here too so the browser compiles on its own.
 */
export type OwnerRefusal = "owner_required" | "owner_store_unavailable";
export interface OwnerHealth { owner?: { enrolled: boolean } }

/**
 * An owner request to the orchestrator and what OpenRig says about it. `saved` means the private receipt is
 * on disk; it does not mean the queue accepted the obligation. Text is the owner's own and is shown literally.
 */
export type MotokoQueueView =
  | { status: "known"; state: string; blockedOn: string | null; handedOffTo: string | null; closureReason: string | null; nudge: string | null; delivery: string | null; observedAt: string }
  | { status: "unknown"; reason: "create_unconfirmed" | "not_found" | "unavailable" | "too_large" | "timeout" | "invalid" };
export type MotokoResultView =
  | { status: "none" }
  | { status: "final"; text: string; at: string }
  | { status: "reopened"; text: string }
  | { status: "handed_off" }
  | { status: "complete_without_result" }
  | { status: "unavailable"; reason: "malformed" | "mismatched" | "too_large" | "untrusted_actor" | "unread" };
export interface MotokoRequestView { requestId: string; qitemId: string; createdAt: string; text: string; saved: true; queue: MotokoQueueView; result: MotokoResultView }
export interface MotokoRequests { enabled: boolean; requests: MotokoRequestView[]; sampledAt: string }
/** The two fields a browser sends; the server fixes the source, destination and origin. */
export interface MotokoRequestInput { requestId: string; text: string }
export const MOTOKO_REQUEST_TEXT_MAX = 4096;

/** Used over window, 0–100, or null when either is unknown or the window is not a positive count. */
export function occupancy(context: MotokoSeat["context"]): number | null {
  if (context.used.state !== "known" || context.window.state !== "known" || context.window.value <= 0) return null;
  return Math.round((context.used.value / context.window.value) * 100);
}

/** How old the sample is at `now`, in ms (never negative), and whether that is past its limit. */
export function sampleAge(status: Pick<MotokoStatus, "sampledAt" | "staleAfterMs">, now: number): { ageMs: number; stale: boolean } {
  const ageMs = Math.max(0, now - Date.parse(status.sampledAt));
  // an unreadable time is no proof of freshness
  return { ageMs, stale: !(ageMs <= status.staleAfterMs) };
}

/** Aggregate metrics for the operating system that hosts this app. */
export interface MotokoHealth {
  sampledAt: string;
  staleAfterMs: number;
  cpu: Known<{ percent: number; intervalMs: number }>;
  memory: Known<{ usedBytes: number; totalBytes: number }>;
  uptime: Known<number>;
}

/** Browser chat projections omit runtime paths, tickets and raw diagnostics. */
export interface ChatMessage {role:"user"|"assistant"|"tool";text:string}
export interface ChatPrompt {id:string;kind:"approval"|"clarify";generation:number;text:string;choices:string[]}
export interface ChatView {
 conversationId:string;bindingId:string;label:string;profile:string;rigKey:string;writerGeneration:number;
 memory:"uninitialized"|"ready"|"failed";tools:{name:string;status:"active"|"complete"}[];messages:ChatMessage[];prompts:ChatPrompt[];
 pending:{submissionId:string;status:"queued"|"started"|"unknown";canAcknowledge:boolean}|null;outcome:string|null;
 history:"ready"|"unavailable";hasEarlier:boolean;historyCursor:string|null;status:string;
}
export type ChatAction = {operation:"recover"}| {operation:"acknowledge";acknowledgeLostTurn:true}| {operation:"history";cursor:string}| {operation:"read"}|{operation:"stop"}|{operation:"release"}|{operation:"send";submissionId:string;text:string}|
 {operation:"approve"|"clarify";promptId:string;generation:number;answer:string};
export interface ChatBindingView {id:string;label:string;profile:string;rigKey:string}
