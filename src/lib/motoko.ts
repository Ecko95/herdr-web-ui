import type { RigCatalog, RigMapModel, RigDraftRequest, RigDraftResult } from "../../shared/motoko-topology.ts";
import type { ModelSaveInput, ModelSaveResult } from "../../shared/motoko-model-control.ts";
/**
 * The browser's side of Motoko: the status read and the owner's passkey ceremonies against
 * /api/owner/* (server/motoko-owner.ts). The ceremonies are the browser's own WebAuthn prompts,
 * driven by @simplewebauthn/browser; nothing here stores a credential, a token or a cookie, and
 * nothing retries by itself: every try asks the server for a fresh challenge.
 *
 * The enrollment token is a parameter only: the caller reads it from its input at submit and
 * clears the input (components/Motoko.tsx and AccessGate.tsx), so it is never React state, a
 * draft, a log line, an address or a retry's copy.
 */
import { startAuthentication, startRegistration, WebAuthnAbortService, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import type { AccessRefusal, HealthAuth } from "../../shared/protocol.ts";
import type { MotokoHealth, MotokoRequestInput, MotokoRequests, MotokoRequestView, MotokoStatus, OwnerHealth, OwnerRefusal } from "../../shared/motoko.ts";
import { ApiError } from "./api.ts";
import { t } from "./i18n.ts";

export type OwnerAuth = HealthAuth & OwnerHealth;
export type GateReason = AccessRefusal | OwnerRefusal;

export interface OwnerSession { id: string; credential_id: string; created_at: string; last_active_at: string; observed_ip: string | null; user_agent: string | null; current: boolean }
export interface OwnerCredential { id: string; label: string; status: "active" | "pending"; created_at: string; last_used_at: string | null }
export interface OwnerSessions { sessions: OwnerSession[]; credentials: OwnerCredential[] }

const OWNER_REASONS: ReadonlySet<string> = new Set<OwnerRefusal>(["owner_required", "owner_store_unavailable"]);

/** The server runs the owner gate: this browser is in through it, or is refused by it. */
export function ownerMode(auth: OwnerAuth | null): boolean {
  if (auth === null) return false;
  return (auth.via as string | undefined) === "owner" || auth.owner !== undefined || OWNER_REASONS.has(auth.reason ?? "");
}

async function request<T>(url: string, method: "GET" | "POST" | "DELETE" = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, method === "GET"
    ? { cache: "no-store", signal }
    : { method, signal, headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify(body ?? {}) });
  if (!response.ok) {
    let detail = response.statusText;
    let code: string | null = null;
    try {
      const parsed = (await response.json()) as { error?: { code?: string; message?: string } };
      detail = parsed.error?.message ?? detail;
      code = parsed.error?.code ?? null;
    } catch { /* not JSON */ }
    throw new ApiError(url, response.status, detail, code);
  }
  const answer = await response.text();
  return (answer === "" ? undefined : JSON.parse(answer)) as T;
}

export const fetchMotokoHealth = (signal?: AbortSignal): Promise<MotokoHealth> => request("/api/motoko/health", "GET", undefined, signal);
export const fetchMotokoStatus = (signal?: AbortSignal): Promise<MotokoStatus> => request("/api/motoko/status", "GET", undefined, signal);
/** One request to the orchestrator: the caller keeps the requestId so a retry it chooses reuses it; nothing retries here. */
export const submitMotokoRequest = (input: MotokoRequestInput): Promise<MotokoRequestView> => request("/api/motoko/requests", "POST", { requestId: input.requestId, text: input.text });
/** The owner's requests and what OpenRig says now; a read never creates or resends one. */
export const fetchMotokoRequests = (signal?: AbortSignal): Promise<MotokoRequests> => request("/api/motoko/requests", "GET", undefined, signal);
export const fetchOwnerSessions = (): Promise<OwnerSessions> => request("/api/owner/sessions");
export const revokeOwnerSession = (id: string): Promise<void> => request(`/api/owner/sessions/${encodeURIComponent(id)}`, "DELETE");
export const revokeOwnerCredential = (id: string): Promise<void> => request(`/api/owner/credentials/${encodeURIComponent(id)}`, "DELETE");
/** Ends this browser's owner session on the server, not just its cookie. */
export const ownerSignOut = (): Promise<void> => request("/api/owner/sign-out", "POST");

type Options<T> = { ceremonyId: string; options: T };

/** Sign in with a passkey already on this device or a nearby phone (discoverable, so no account is asked for). */
export async function signInWithPasskey(): Promise<void> {
  const begin = await request<Options<PublicKeyCredentialRequestOptionsJSON>>("/api/owner/sign-in/options", "POST");
  const response = await startAuthentication({ optionsJSON: begin.options });
  await request("/api/owner/sign-in", "POST", { ceremonyId: begin.ceremonyId, response });
}

/** Register, then prove the new key signs: the server activates a credential only after its proof. */
async function registerAndProve(begin: Options<PublicKeyCredentialCreationOptionsJSON>, label: string): Promise<void> {
  const registration = await startRegistration({ optionsJSON: begin.options });
  const proof = await request<Options<PublicKeyCredentialRequestOptionsJSON> & { pendingCredentialId: string }>("/api/owner/register", "POST", { ceremonyId: begin.ceremonyId, label, response: registration });
  const response = await startAuthentication({ optionsJSON: proof.options });
  await request("/api/owner/prove", "POST", { ceremonyId: proof.ceremonyId, response });
}

/** The first passkey, with the one-time enrollment token the owner read over SSH. */
export async function enrollFirstPasskey(enrollmentToken: string, label: string): Promise<void> {
  const begin = await request<Options<PublicKeyCredentialCreationOptionsJSON>>("/api/owner/bootstrap/options", "POST", { enrollmentToken });
  await registerAndProve(begin, label);
}

/** Another passkey: an active one signs first, then the new one registers and proves itself. */
export async function addPasskey(label: string): Promise<void> {
  const begin = await request<Options<PublicKeyCredentialRequestOptionsJSON>>("/api/owner/credentials/add/options", "POST");
  const authorization = await startAuthentication({ optionsJSON: begin.options });
  const grant = await request<Options<PublicKeyCredentialCreationOptionsJSON>>("/api/owner/credentials/add/authorize", "POST", { ceremonyId: begin.ceremonyId, response: authorization });
  await registerAndProve(grant, label);
}

/** Stops a passkey prompt this page opened (a closed dialog, an unmounted screen). */
export function cancelCeremony(): void {
  WebAuthnAbortService.cancelCeremony();
}

/** The person closed or timed out the browser's own prompt: not a failure to report. */
export function ceremonyCanceled(error: unknown): boolean {
  return error instanceof Error && (error.name === "NotAllowedError" || error.name === "AbortError");
}

/** What to tell the owner about a failed ceremony or request, in their language. */
export function ownerErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "owner_required": return t("Your owner session ended. Sign in again with your passkey.");
      case "owner_store_unavailable": return t("Owner sign-in is unavailable: the server cannot read its owner records. Fix it over SSH.");
      case "invalid_origin": return t("This page is not at the address the server expects for passkeys.");
      case "invalid_challenge": return t("That sign-in took too long or was already used. Try again.");
      case "verification_failed": return t("The passkey could not be verified. Try again.");
      case "uv_required": return t("Your device must verify you (PIN, fingerprint or face) to use this passkey.");
      case "unknown_credential": return t("This passkey is not registered here.");
      case "duplicate_credential": return t("This passkey is already registered here.");
      case "counter_regressed": return t("This passkey looks copied. Use another one and revoke it.");
      case "enrollment_required": return t("That enrollment token is wrong, used or expired. Create a new one over SSH.");
      case "enrollment_closed": return t("A passkey is already enrolled. Sign in with it instead.");
      case "too_many_attempts": return t("Too many wrong tries. Wait a moment, then try again.");
      case "owner_session_limit": return t("Three active logins already exist. Revoke an old login from a device that is signed in.");
      case "last_credential": return t("You cannot revoke your last passkey here. Use the SSH recovery steps.");
      case "disabled_in_owner_mode": return t("Owner sign-in turns this off.");
      case "coordination_origin_unbound": return t("Requests are not connected on this server. Nothing was sent.");
      case "identifier_conflict": return t("This request ID was already used with different text. Nothing was sent.");
      case "history_full": return t("The request history is full (100 requests or 1 MiB). Nothing was sent.");
      case "invalid_request": return t("Write 1 to 4096 bytes of text. Nothing was sent.");
      default: return error.status === 503 ? t("The server cannot save owner records now. Nothing changed.") : error.detail;
    }
  }
  if (error instanceof Error) {
    const code = (error as Error & { code?: string }).code;
    if (code === "ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT") return t("This authenticator cannot keep a passkey on the device. Use one that can.");
    if (error.name === "InvalidStateError") return t("This passkey is already registered here.");
    if (error.name === "NotSupportedError") return t("This browser or authenticator does not support the passkey type the server needs.");
    if (error.name === "SecurityError") return t("This page is not at the address the server expects for passkeys.");
    return error.message;
  }
  return String(error);
}

export const fetchRigCatalog = (signal?:AbortSignal):Promise<RigCatalog> => request("/api/motoko/map/rigs","GET",undefined,signal);
export const fetchRigModel = (key:string,signal?:AbortSignal):Promise<RigMapModel> => request(`/api/motoko/map/rigs/${encodeURIComponent(key)}`,"GET",undefined,signal);
export const validateRigDraft = (key:string,input:RigDraftRequest,signal?:AbortSignal):Promise<RigDraftResult> => request(`/api/motoko/map/rigs/${encodeURIComponent(key)}/validate`,"POST",input,signal);
export const saveSeatModel = (key:string,input:ModelSaveInput):Promise<ModelSaveResult> => request(`/api/motoko/map/rigs/${encodeURIComponent(key)}/model`,"POST",input);

/** Chat calls never retry a send after an unknown transport result. */
export const listChatBindings=(signal?:AbortSignal):Promise<{bindings:import("../../shared/motoko.ts").ChatBindingView[]}>=>request("/api/motoko/chat","POST",{operation:"list"},signal);
export const openChat=(bindingId:string,writerId:string,signal?:AbortSignal):Promise<import("../../shared/motoko.ts").ChatView>=>request("/api/motoko/chat","POST",{operation:"open",bindingId,writerId},signal);
export const actChat=(view:import("../../shared/motoko.ts").ChatView,writerId:string,action:import("../../shared/motoko.ts").ChatAction,signal?:AbortSignal):Promise<import("../../shared/motoko.ts").ChatView>=>request("/api/motoko/chat","POST",{conversationId:view.conversationId,writerGeneration:view.writerGeneration,writerId,...action},signal);
