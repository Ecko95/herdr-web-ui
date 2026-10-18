import { MotokoMap } from "./MotokoMap.tsx";
/**
 * Motoko: the owner's view of rigs and seats, over the pane area (App.tsx, `?page=motoko`), and
 * the owner's passkeys and sessions. It reads /api/motoko/status, which the server serves only
 * behind the owner gate from the selected OpenRig roster or an explicit test fixture.
 *
 * What it shows is what was observed: an unknown value says "Unknown" and why, never 0; a sample
 * past its limit says so with its age; a source that failed shows the failure and no rigs. Agent
 * text (a Needs-you summary) is shown as text, never as markup, and is not an approval.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { KeyRound, LogOut, RefreshCw, Send, X } from "lucide-react";

import "./Motoko.css";

import { MOTOKO_REQUEST_TEXT_MAX, occupancy, sampleAge, type Activity, type Known, type MotokoHealth, type MotokoRequests, type MotokoRequestView, type MotokoSeat, type MotokoStatus } from "../../shared/motoko.ts";
import type { MotokoDestination, MotokoRequest } from "../lib/actions.ts";
import { deviceLabel } from "../lib/phone.ts";
import { ApiError } from "../lib/api.ts";
import { currentLocale, useT } from "../lib/i18n.ts";
import { addPasskey, cancelCeremony, ceremonyCanceled, fetchMotokoHealth, fetchMotokoRequests, fetchMotokoStatus, fetchOwnerSessions, ownerErrorMessage, ownerMode, revokeOwnerCredential, revokeOwnerSession, submitMotokoRequest, type OwnerAuth, type OwnerSessions } from "../lib/motoko.ts";
import { MotokoBoot } from "./MotokoBoot.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

const POLL_MS = 15_000;
const ACTIVITY_BADGE: Record<Activity, string> = { working: "badge-working", idle: "badge-idle", needs_input: "badge-blocked", stopped: "badge-done", unknown: "badge-unknown" };

export interface MotokoProps {
  auth: OwnerAuth | null;
  request: MotokoRequest;
  onClose: () => void;
  /** the shell's own sign-out (App.tsx lock), which ends the owner session on the server */
  onSignOut: () => Promise<void>;
  /** the server said the owner session is over: the shell shows its sign-in gate */
  onSessionEnded: () => void;
}

function useAge(): (ms: number) => string {
  const t = useT();
  return (ms) => {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return t("{n}s ago", { n: seconds });
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return t("{n} min ago", { n: minutes });
    return t("{n} h ago", { n: Math.round(minutes / 60) });
  };
}

export function Motoko({ auth, request, onClose, onSignOut, onSessionEnded }: MotokoProps) {
  const t = useT();
  const [selected, setSelected] = useState({ request, destination: request.destination });
  // A new shortcut can focus the same destination again without remounting the access form.
  if (selected.request !== request) setSelected({ request, destination: request.destination });
  const tab = selected.destination === "sessions" || selected.destination === "passkey" ? "access" : selected.destination;
  const setTab = (destination: MotokoDestination) => setSelected({ request, destination });
  const headingId = useId();
  const owner = ownerMode(auth) && auth?.authenticated === true;
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { if (tab !== "access" || !owner) heading.current?.focus(); }, [selected, owner]);
  return (
    <section className="motoko" aria-labelledby={headingId}>
      <header className="motoko-head">
        <h1 id={headingId} ref={heading} tabIndex={-1} className="motoko-title">Motoko</h1>
        <div className="motoko-tabs" role="tablist" aria-label={t("Motoko views")}>
          <button type="button" role="tab" aria-selected={tab === "boot"} className="btn btn-ghost" onClick={() => setTab("boot")}>{t("Boot")}</button>
          <button type="button" role="tab" aria-selected={tab === "status"} className="btn btn-ghost" onClick={() => setTab("status")}>{t("Status")}</button>
          <button type="button" role="tab" aria-selected={tab === "map"} className="btn btn-ghost" onClick={() => setTab("map")}>{t("Map")}</button>
          <button type="button" role="tab" aria-selected={tab === "health"} className="btn btn-ghost" onClick={() => setTab("health")}>{t("VPS health")}</button>
          <button type="button" role="tab" aria-selected={tab === "requests"} className="btn btn-ghost" onClick={() => setTab("requests")}>{t("Requests")}</button>
          <button type="button" role="tab" aria-selected={tab === "access"} className="btn btn-ghost" onClick={() => setTab("sessions")}>{t("Access")}</button>
        </div>
        <button type="button" className="icon-button" aria-label={t("Close Motoko")} onClick={onClose}><X /></button>
      </header>
      {!owner
        ? <p className="motoko-note" role="status">{t("Motoko needs owner passkey sign-in on this server. It shows nothing without it.")}</p>
        : tab === "boot" ? <MotokoBoot onStatus={() => setTab("status")} onSessionEnded={onSessionEnded} /> : tab === "status" ? <StatusView onSessionEnded={onSessionEnded} /> : tab === "map" ? <MotokoMap onSessionEnded={onSessionEnded} /> : tab === "health" ? <HealthView onSessionEnded={onSessionEnded} /> : tab === "requests" ? <RequestsView onSessionEnded={onSessionEnded} /> : <AccessView request={selected} onSignOut={onSignOut} onSessionEnded={onSessionEnded} />}
    </section>
  );
}

function HealthView({ onSessionEnded }: { onSessionEnded: () => void }) {
  const t = useT();
  const age = useAge();
  const sessionEnded = useRef(onSessionEnded);
  useLayoutEffect(() => { sessionEnded.current = onSessionEnded; }, [onSessionEnded]);
  const [health, setHealth] = useState<MotokoHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let closed = false, busy = false;
    let controller: AbortController | null = null;
    const load = async () => {
      if (closed || busy || document.visibilityState !== "visible") return;
      busy = true; controller = new AbortController();
      try {
        const next = await fetchMotokoHealth(controller.signal);
        if (!closed) { setHealth(next); setError(null); }
      } catch (failure) {
        if (closed) return;
        if (failure instanceof ApiError && failure.status === 401) { sessionEnded.current(); return; }
        setError(ownerErrorMessage(failure));
      } finally { busy = false; if (!closed) setNow(Date.now()); }
    };
    const refresh = () => { setNow(Date.now()); void load(); };
    void load();
    const timer = window.setInterval(refresh, 5_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { closed = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); controller?.abort(); };
  }, []);
  if (health === null) return <p className={error ? "motoko-banner is-error" : "motoko-note"} role={error ? "alert" : "status"}>{error ?? t("Health sample pending.")}</p>;
  const { ageMs, stale } = sampleAge(health, now);
  return (
    <div className="motoko-body">
      <p className="motoko-banner">{t("VPS health: the server that hosts this app. Remote PCs and rigs are not included.")}</p>
      {error && <p className="motoko-banner is-error" role="alert">{t("The last refresh failed: {error}", { error })}</p>}
      {stale && <p className="motoko-banner is-stale" role="status">{t("This sample is stale: taken {age}. Values below may no longer hold.", { age: age(ageMs) })}</p>}
      <p className="motoko-sample">{t("Sampled {age}", { age: age(ageMs) })}</p>
      <dl className="motoko-facts">
        <div><dt>{t("CPU utilization")}</dt><dd>{health.cpu.state === "known" ? t("{percent}% over {ms} ms", { percent: health.cpu.value.percent.toFixed(1), ms: Math.round(health.cpu.value.intervalMs) }) : t("Unknown")}</dd></div>
        <div><dt>{t("Memory use (includes caches)")}</dt><dd>{health.memory.state === "known" ? t("{used} of {total} bytes", { used: health.memory.value.usedBytes.toLocaleString(currentLocale()), total: health.memory.value.totalBytes.toLocaleString(currentLocale()) }) : t("Unknown")}</dd></div>
        <div><dt>{t("Server uptime")}</dt><dd>{health.uptime.state === "known" ? t("{seconds} seconds", { seconds: Math.floor(health.uptime.value).toLocaleString(currentLocale()) }) : t("Unknown")}</dd></div>
      </dl>
    </div>
  );
}

function StatusView({ onSessionEnded }: { onSessionEnded: () => void }) {
  const t = useT();
  const age = useAge();
  const [status, setStatus] = useState<MotokoStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const load = useCallback(async () => {
    try {
      setStatus(await fetchMotokoStatus());
      setError(null);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) { onSessionEnded(); return; }
      setError(ownerErrorMessage(failure));
    } finally {
      setNow(Date.now());
    }
  }, [onSessionEnded]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  if (status === null) return error ? <p className="motoko-banner is-error" role="alert">{error}</p> : <p className="motoko-note" role="status">{t("Loading status…")}</p>;
  const { ageMs, stale } = sampleAge(status, now);
  const seats = status.rigs.flatMap((rig) => rig.seats);
  const activityReported = status.coverage?.activity ?? status.source === "fixture";
  const requestsReported = status.coverage?.needsYou ?? status.source === "fixture";
  const waiting = seats.filter((seat) => seat.activity === "needs_input").length;
  return (
    <div className="motoko-body">
      <p className="motoko-banner" role="status">{status.source === "OpenRig" ? t("OpenRig roster: the configured rig only. Agent activity and owner requests are not reported. Agents with write access can falsify this source.") : t("Fictional fixture data. Nothing here is read from a real rig, and agents with write access could falsify a real source.")}</p>
      {error && <p className="motoko-banner is-error" role="alert">{t("The last refresh failed: {error}", { error })}</p>}
      {stale && <p className="motoko-banner is-stale" role="status">{t("This sample is stale: taken {age}. Values below may no longer hold.", { age: age(ageMs) })}</p>}
      {status.errors.map((item, index) => <p key={index} className="motoko-banner is-error" role="status">{item.message}</p>)}
      <div className="motoko-toolbar">
        <span className="motoko-sample">{t("Sampled {age}", { age: age(ageMs) })}</span>
        <button type="button" className="btn" onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" /> {t("Refresh")}</button>
      </div>
      <dl className="motoko-metrics">
        <div><dt>{t("Rigs")}</dt><dd>{status.rigs.length}</dd></div>
        <div><dt>{t("Seats")}</dt><dd>{seats.length}</dd></div>
        <div><dt>{t("Needs input")}</dt><dd>{!activityReported ? t("Unknown") : waiting}</dd></div>
        <div><dt>{t("Needs you")}</dt><dd>{!requestsReported ? t("Unknown") : status.needsYou.length}</dd></div>
      </dl>
      <section aria-label={t("Needs you")} className="motoko-section">
        <h2 className="motoko-subtitle">{t("Needs you")}</h2>
        <p className="motoko-hint">{t("A request from an agent is a status, not an approval. Its text is the agent's own.")}</p>
        {status.needsYou.length === 0
          ? <p className="motoko-hint">{!requestsReported ? t("Owner requests are not reported by this source.") : t("Nothing waits on you in this sample.")}</p>
          : <ul className="motoko-list">{status.needsYou.map((item) => (
            <li key={item.id} className="motoko-card is-attention">
              <span className="motoko-card-title">{item.rigId} · {item.seatId}</span>
              <span className="motoko-summary">{item.summary}</span>
              <span className="motoko-hint">{t("Waiting since {age}", { age: age(Math.max(0, now - Date.parse(item.since))) })}</span>
            </li>
          ))}</ul>}
      </section>
      {status.rigs.map((rig) => (
        <section key={rig.id} aria-label={rig.name} className="motoko-section">
          <h2 className="motoko-subtitle">{rig.name} <span className="motoko-domain">{t(rig.domain === "work" ? "Work" : rig.domain === "personal" ? "Personal" : "Unknown domain")}</span></h2>
          <ul className="motoko-list">{rig.seats.map((seat) => <SeatRow key={seat.id} seat={seat} now={now} />)}</ul>
        </section>
      ))}
    </div>
  );
}

function SeatRow({ seat, now }: { seat: MotokoSeat; now: number }) {
  const t = useT();
  const age = useAge();
  const percent = occupancy(seat.context);
  const unknown = (value: Known<number>) => value.state === "unknown" ? t("Unknown: {reason}", { reason: value.reason }) : null;
  const number = (value: number) => value.toLocaleString(currentLocale());
  const activity: Record<Activity, string> = { working: t("Working"), idle: t("Idle"), needs_input: t("Needs input"), stopped: t("Stopped"), unknown: t("Unknown") };
  const confidence = { oracle: t("observed"), inferred: t("inferred"), stale: t("stale"), unknown: t("confidence unknown") }[seat.confidence];
  return (
    <li className="motoko-card">
      <span className="motoko-card-title">{seat.session}</span>
      <span className="motoko-hint">{seat.role} · {seat.runtime}</span>
      <span className="motoko-row"><span className={`badge ${ACTIVITY_BADGE[seat.activity]}`}>{activity[seat.activity]}</span> <span className="motoko-hint">{confidence}</span></span>
      {seat.workflow && <span className="motoko-hint">{t("Workflow")}: {seat.workflow.lifecycle} · {seat.workflow.restoreAction}</span>}
      <dl className="motoko-facts">
        <div>
          <dt>{t("Context")}</dt>
          <dd>{percent !== null && seat.context.used.state === "known" && seat.context.window.state === "known"
            ? t("{percent}% · {used} of {window}", { percent, used: number(seat.context.used.value), window: number(seat.context.window.value) })
            : unknown(seat.context.window) ?? unknown(seat.context.used) ?? t("Unknown")}</dd>
        </div>
        <div>
          <dt>{t("Context sample")}</dt>
          <dd>{seat.context.sampledAt === null ? t("Unknown: not reported") : age(Math.max(0, now - Date.parse(seat.context.sampledAt)))}</dd>
        </div>
        <div>
          <dt>{t("Applied compactions")}</dt>
          <dd>{seat.appliedCompactions.state === "known" ? number(seat.appliedCompactions.value) : unknown(seat.appliedCompactions)}</dd>
        </div>
      </dl>
    </li>
  );
}

/**
 * The owner's requests to the orchestrator. The text stays in the DOM textarea until the server confirms
 * its receipt; an unconfirmed send keeps the same requestId for an explicit retry or discard, and nothing
 * sends by itself. A reconnect or refresh only reads (GET); a result is the orchestrator's text, shown as text.
 */
function RequestsView({ onSessionEnded }: { onSessionEnded: () => void }) {
  const t = useT();
  const age = useAge();
  const [data, setData] = useState<MotokoRequests | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // the request whose answer never arrived: retry sends the same id and text, so it cannot make a second obligation
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const textRef = useRef<HTMLTextAreaElement>(null);
  const load = useCallback(async () => {
    try { setData(await fetchMotokoRequests()); setStale(null); }
    catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) { onSessionEnded(); return; }
      setStale(ownerErrorMessage(failure));
    } finally { setNow(Date.now()); }
  }, [onSessionEnded]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const send = async (requestId: string, text: string, fromForm: boolean): Promise<void> => {
    if (sending) return;
    setSending(true); setError(null); setNotice(null);
    try {
      await submitMotokoRequest({ requestId, text });
      if (fromForm) { if (textRef.current) textRef.current.value = ""; setUnconfirmed(null); }
      setNotice(t("Saved locally. The queue state below is what OpenRig reports."));
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) { onSessionEnded(); return; }
      if (failure instanceof ApiError && failure.status < 500) { if (fromForm) setUnconfirmed(null); setError(ownerErrorMessage(failure)); }
      else { if (fromForm) setUnconfirmed(requestId); setError(t("The server did not confirm this request. It can already exist. Retry it or discard it.")); }
    } finally {
      setSending(false);
      await load();
    }
  };
  const submit = (): void => {
    const text = textRef.current?.value ?? "";
    if (text.trim() === "") { setError(t("Write 1 to 4096 bytes of text. Nothing was sent.")); return; }
    void send(unconfirmed ?? crypto.randomUUID(), text, true);
  };
  const discard = (): void => { if (textRef.current) textRef.current.value = ""; setUnconfirmed(null); setError(null); };

  return (
    <div className="motoko-body">
      <p className="motoko-banner" role="status">{t("A request goes to the orchestrator queue as an owner obligation. Saved locally does not mean the queue accepted it.")}</p>
      {data && !data.enabled && <p className="motoko-banner is-error" role="status">{t("Requests are not connected on this server. Nothing was sent.")}</p>}
      {stale && <p className="motoko-banner is-stale" role="alert">{data ? t("The last refresh failed: {error}. The list below is from {age}.", { error: stale, age: age(Math.max(0, now - Date.parse(data.sampledAt))) }) : stale}</p>}
      {error && <p className="motoko-banner is-error" role="alert">{error}</p>}
      {notice && <p className="motoko-note" role="status">{notice}</p>}
      <form className="motoko-add" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <label className="motoko-label" htmlFor="motoko-request-text">{t("Request to the orchestrator")}</label>
        <textarea ref={textRef} id="motoko-request-text" className="input motoko-request-text" rows={4} maxLength={MOTOKO_REQUEST_TEXT_MAX} readOnly={unconfirmed !== null} autoComplete="off" />
        <div className="motoko-row">
          <button type="submit" className="btn btn-primary" disabled={sending || data?.enabled === false}><Send size={14} aria-hidden="true" /> {t(sending ? "Sending…" : unconfirmed ? "Retry" : "Send")}</button>
          {unconfirmed && <button type="button" className="btn" disabled={sending} onClick={discard}>{t("Discard")}</button>}
        </div>
      </form>
      <div className="motoko-toolbar">
        {data && <span className="motoko-sample">{t("Sampled {age}", { age: age(Math.max(0, now - Date.parse(data.sampledAt))) })}</span>}
        <button type="button" className="btn" onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" /> {t("Refresh")}</button>
      </div>
      <h2 className="motoko-subtitle">{t("Requests")}</h2>
      {data === null ? <p className="motoko-note" role="status">{t("Loading requests…")}</p>
        : data.requests.length === 0 ? <p className="motoko-hint">{t("No requests yet.")}</p>
        : <ul className="motoko-list motoko-requests">{data.requests.map((item) => <RequestRow key={item.requestId} item={item} sending={sending} onRetry={() => void send(item.requestId, item.text, false)} />)}</ul>}
    </div>
  );
}

function RequestRow({ item, sending, onRetry }: { item: MotokoRequestView; sending: boolean; onRetry: () => void }) {
  const t = useT();
  const queue = item.queue;
  const unknown: Record<Extract<typeof queue, { status: "unknown" }>["reason"], string> = {
    create_unconfirmed: t("Queue outcome unknown: the create was not confirmed."), not_found: t("Queue outcome unknown: OpenRig has no such item now."),
    unavailable: t("Queue outcome unknown: OpenRig did not answer."), too_large: t("Queue outcome unknown: the item is too large to read."),
    timeout: t("Queue outcome unknown: OpenRig did not answer in time."), invalid: t("Queue outcome unknown: the item does not match this request."),
  };
  const result = item.result;
  const unavailable = { malformed: t("the result note is malformed"), mismatched: t("the result is for another request"), too_large: t("the history is too large to read"), untrusted_actor: t("the result is not from the orchestrator"), unread: t("the history was not read") };
  return (
    <li className={`motoko-card${result.status === "final" ? " is-final" : queue.status === "known" && queue.blockedOn ? " is-attention" : ""}`}>
      <span className="motoko-card-title">{item.requestId}</span>
      <span className="motoko-summary">{item.text}</span>
      <span className="motoko-hint">{t("Saved locally {when}", { when: new Date(item.createdAt).toLocaleString(currentLocale()) })}</span>
      <dl className="motoko-facts">
        <div><dt>{t("Queue")}</dt><dd>{queue.status === "known" ? queue.state : unknown[queue.reason]}</dd></div>
        {queue.status === "known" && queue.blockedOn && <div><dt>{t("Blocked on")}</dt><dd>{queue.blockedOn}</dd></div>}
        {queue.status === "known" && <div><dt>{t("Agent delivery")}</dt><dd>{[queue.nudge, queue.delivery].filter((value) => value !== null).join(" · ") || t("Unknown")}</dd></div>}
      </dl>
      {result.status === "final" && <><span className="motoko-label">{t("Result")}</span><span className="motoko-summary">{result.text}</span></>}
      {result.status === "reopened" && <><span className="motoko-hint">{t("Reopened after an earlier result. The earlier result is not final.")}</span><span className="motoko-summary">{result.text}</span></>}
      {result.status === "handed_off" && <span className="motoko-hint">{t("Handed off; final result unavailable.")}</span>}
      {result.status === "complete_without_result" && <span className="motoko-hint">{t("Closed without a valid result.")}</span>}
      {result.status === "unavailable" && <span className="motoko-hint">{t("Result unavailable: {reason}.", { reason: unavailable[result.reason] })}</span>}
      {queue.status === "unknown" && queue.reason === "create_unconfirmed" && <button type="button" className="btn" disabled={sending} onClick={onRetry}>{t("Retry this request")}</button>}
    </li>
  );
}

function AccessView({ request, onSignOut, onSessionEnded }: { request: MotokoRequest; onSignOut: () => Promise<void>; onSessionEnded: () => void }) {
  const t = useT();
  const [data, setData] = useState<OwnerSessions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "session" | "credential"; id: string; name: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const labelRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const sessionsHeading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const target = request.destination === "passkey" ? labelRef.current : sessionsHeading.current;
    target?.focus();
    target?.scrollIntoView({ block: "nearest" });
  }, [request]);
  // the Add button takes the focus back once it is enabled again
  const refocus = useRef(false);
  useEffect(() => { if (!adding && refocus.current) { refocus.current = false; addRef.current?.focus(); } }, [adding]);
  const load = useCallback(async () => {
    try { setData(await fetchOwnerSessions()); setError(null); }
    catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) { onSessionEnded(); return; }
      setError(ownerErrorMessage(failure));
    }
  }, [onSessionEnded]);
  useEffect(() => { void load(); }, [load]);
  // a passkey prompt this view opened goes when the view does
  useEffect(() => () => cancelCeremony(), []);

  const add = async (): Promise<void> => {
    if (adding) return;
    const label = labelRef.current?.value.trim() || t("Passkey");
    setAdding(true); setError(null); setNotice(null);
    try {
      await addPasskey(label.slice(0, 48));
      if (labelRef.current) labelRef.current.value = "";
      setNotice(t("Passkey added."));
      await load();
    } catch (failure) {
      if (ceremonyCanceled(failure)) setNotice(t("Passkey prompt canceled. Nothing changed."));
      else setError(ownerErrorMessage(failure));
    } finally {
      refocus.current = true;
      setAdding(false);
    }
  };

  const revoke = async (): Promise<void> => {
    if (!confirm) return;
    const current = confirm.kind === "session" && data?.sessions.find((session) => session.id === confirm.id)?.current === true;
    if (confirm.kind === "session") await revokeOwnerSession(confirm.id);
    else await revokeOwnerCredential(confirm.id);
    setConfirm(null);
    if (current) { onSessionEnded(); return; }
    setNotice(t("Revoked."));
    await load();
    listHeading.current?.focus();
  };

  const when = (value: string | null) => value === null ? t("never") : new Date(value).toLocaleString(currentLocale());
  return (
    <div className="motoko-body">
      {error && <p className="motoko-banner is-error" role="alert">{error}</p>}
      {notice && <p className="motoko-note" role="status">{notice}</p>}
      <h2 ref={listHeading} tabIndex={-1} className="motoko-subtitle">{t("Passkeys")}</h2>
      <ul className="motoko-list">{data?.credentials.map((credential) => (
        <li key={credential.id} className="motoko-card">
          <span className="motoko-card-title">{credential.label}{credential.status === "pending" ? ` · ${t("not yet proved")}` : ""}</span>
          <span className="motoko-hint">{t("Added {when} · last used {used}", { when: when(credential.created_at), used: when(credential.last_used_at) })}</span>
          <button type="button" className="btn btn-danger" aria-label={t("Revoke passkey {name}", { name: credential.label })} onClick={() => setConfirm({ kind: "credential", id: credential.id, name: credential.label })}>{t("Revoke")}</button>
        </li>
      ))}</ul>
      <form className="motoko-add" onSubmit={(event) => { event.preventDefault(); void add(); }}>
        <label className="motoko-label" htmlFor="motoko-passkey-label">{t("Name for another passkey")}</label>
        <input ref={labelRef} id="motoko-passkey-label" className="input" type="text" maxLength={48} autoComplete="off" placeholder={t("Backup key")} />
        <button ref={addRef} type="submit" className="btn btn-primary" disabled={adding}><KeyRound size={14} aria-hidden="true" /> {t(adding ? "Waiting for passkeys…" : "Add a passkey")}</button>
        <p className="motoko-hint">{t("One of your passkeys signs first, then the new one registers and proves itself.")}</p>
      </form>
      <h2 ref={sessionsHeading} tabIndex={-1} className="motoko-subtitle">{t("Sessions")}</h2>
      <p className="motoko-hint">{t("A browser cannot report a device's MAC address. These are the address and browser the server saw.")}</p>
      <ul className="motoko-list">{data?.sessions.map((session) => {
        const name = session.user_agent ? deviceLabel(session.user_agent) : t("unknown browser");
        return (
          <li key={session.id} className="motoko-card">
            <span className="motoko-card-title">{name}{session.current ? ` · ${t("this browser")}` : ""}</span>
            <span className="motoko-hint">{t("From {ip} · active {when}", { ip: session.observed_ip ?? t("unknown address"), when: when(session.last_active_at) })}</span>
            <button type="button" className="btn btn-danger" aria-label={t("Revoke session from {name}", { name })} onClick={() => setConfirm({ kind: "session", id: session.id, name })}>{t("Revoke")}</button>
          </li>
        );
      })}</ul>
      <button type="button" className="btn" onClick={() => void onSignOut().catch((failure: unknown) => setError(ownerErrorMessage(failure)))}><LogOut size={14} aria-hidden="true" /> {t("Sign out")}</button>
      {confirm && (
        <ConfirmDialog
          title={t(confirm.kind === "session" ? "Revoke this session?" : "Revoke this passkey?")}
          body={confirm.kind === "session" ? t("{name} is signed out at its next request, and its open connections close.", { name: confirm.name }) : t("{name} can no longer sign in, and every session it opened ends now.", { name: confirm.name })}
          confirmLabel={t("Revoke")}
          onConfirm={revoke}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
