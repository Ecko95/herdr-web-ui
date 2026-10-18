import "./AccessGate.css";

import { type FormEvent, useEffect, useRef, useState } from "react";

import { ApiError, authenticate, pairDevice } from "../lib/api.ts";
import { deviceLabel } from "../lib/phone.ts";
import { cancelCeremony, ceremonyCanceled, enrollFirstPasskey, ownerErrorMessage, signInWithPasskey, type GateReason } from "../lib/motoko.ts";
import { useT } from "../lib/i18n.ts";
import { userErrorMessage, type UserError } from "../lib/userError.ts";


export interface AccessGateProps {
  /** why the server refused this browser, when it said */
  reason: GateReason | null;
  /** with the owner gate: whether a passkey is enrolled yet (/api/health `auth.owner`) */
  ownerEnrolled?: boolean;
  /** the code a scanned QR code brought along: submitted at once */
  initialCode: string;
  /** Fires once the server set a cookie: the shell can mount, and every later fetch and the WebSocket carry it. */
  onUnlocked: () => void;
}

/**
 * Sign-in screen rendered instead of the shell while the server does not know this
 * browser. Pairing is the usual way in: a six-digit code the owner started on the PC
 * (Settings → Devices), typed once, or carried by the QR code's address. The shared
 * token stays as the other way. Nothing is stored here: the server answers with an
 * HttpOnly cookie either way.
 */
export function AccessGate({ reason, initialCode, ownerEnrolled, onUnlocked }: AccessGateProps) {
  if (reason === "owner_required" || reason === "owner_store_unavailable") return <OwnerGate reason={reason} enrolled={ownerEnrolled !== false} onUnlocked={onUnlocked} />;
  return <PairingGate reason={reason} initialCode={initialCode} onUnlocked={onUnlocked} />;
}

function PairingGate({ reason, initialCode, onUnlocked }: Omit<AccessGateProps, "ownerEnrolled">) {
  const t = useT();
  const codeRef = useRef<HTMLInputElement | null>(null);
  const tokenRef = useRef<HTMLInputElement | null>(null);
  const [code, setCode] = useState(initialCode);
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState<"code" | "token" | null>(null);
  const [error, setError] = useState<UserError | null>(null);
  const [codeShort, setCodeShort] = useState(false);
  const scanned = useRef(code.length === 6);

  const pair = async (value: string): Promise<void> => {
    if (submitting) return;
    setSubmitting("code");
    setError(null);
    try {
      await pairDevice(value, deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0));
      onUnlocked();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? { message: t("That code is wrong, used up or expired. Start a new pairing on the PC."), detail: null } : userErrorMessage(err));
      setSubmitting(null);
      codeRef.current?.select();
    }
  };

  // a scanned QR code brings the code along: no typing on the phone
  useEffect(() => { if (scanned.current) { scanned.current = false; void pair(code); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submitCode = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (code.length !== 6) { setCodeShort(true); codeRef.current?.focus(); return; }
    void pair(code);
  };

  const submitToken = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    if (token === "") { tokenRef.current?.focus(); return; }
    setSubmitting("token");
    setError(null);
    try {
      await authenticate(token);
      onUnlocked();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? { message: t("Token does not match."), detail: null } : userErrorMessage(err));
      setSubmitting(null);
      tokenRef.current?.select();
    }
  };

  return (
    <main className="access-gate-screen">
      <div className="access-gate" data-testid="token-gate">
        <img src="/icons/icon-192.png?v=ram1" alt="" width="44" height="44" className="access-gate-mark" />
        <h1 id="access-gate-title" className="access-gate-title">
          herdr <span className="brand-sub">web ui</span>
        </h1>
        {reason === "other_user" && (
          <p className="access-gate-refused" role="status">{t("Tailscale says this device belongs to someone other than this PC's owner. The owner can still let it in with a pairing code.")}</p>
        )}
        <p className="access-gate-copy">
          {t(reason === "token_required" ? "This server requires an access token or a pairing code." : "Pair this device with a code from the PC: Settings → Devices there, or the pair command in its terminal.")}
        </p>
        <form aria-labelledby="access-gate-title" onSubmit={submitCode}>
          <label className="access-gate-label" htmlFor="access-gate-code">{t("Pairing code")}</label>
          <input
            ref={codeRef}
            id="access-gate-code"
            className="access-gate-input"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={7}
            placeholder="000 000"
            autoFocus
            aria-invalid={codeShort || (error !== null && submitting !== "token")}
            aria-describedby={codeShort ? "access-gate-code-error" : error !== null ? "access-gate-error" : undefined}
            value={code}
            onChange={(event) => { setCodeShort(false); setCode(event.target.value.replace(/\D/g, "").slice(0, 6)); }}
          />
          {codeShort && <p id="access-gate-code-error" className="access-gate-error" role="alert">{t("Enter all 6 digits of the pairing code.")}</p>}
          <button type="submit" className="access-gate-submit" disabled={submitting !== null}>
            {t(submitting === "code" ? "Pairing…" : "Pair this device")}
          </button>
        </form>
        <details className="access-gate-alt">
          <summary>{t("Have an access token instead?")}</summary>
          <form onSubmit={(event) => void submitToken(event)}>
            <label className="access-gate-label" htmlFor="access-gate-token">{t("Access token")}</label>
            <input
              ref={tokenRef}
              id="access-gate-token"
              className="access-gate-input"
              type="password"
              name="token"
              autoComplete="current-password"
              inputMode="text"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
            <button type="submit" className="access-gate-submit" disabled={submitting !== null}>
              {t(submitting === "token" ? "Unlocking…" : "Unlock")}
            </button>
          </form>
        </details>
        {error !== null && (
          <p id="access-gate-error" className="access-gate-error" role="alert">{error.message}{error.detail !== null && <><br /><code>{error.detail}</code></>}</p>
        )}
      </div>
    </main>
  );
}

/**
 * The owner gate (server/motoko-owner.ts): a passkey is the only way in. Pairing codes and the
 * shared token are off there. The first passkey needs the one-time enrollment token the owner
 * made over SSH; it is read from its input at submit and the input is cleared at once, so the
 * token is never React state, a draft, a log line, an address or a retry's copy.
 */
function OwnerGate({ reason, enrolled, onUnlocked }: { reason: "owner_required" | "owner_store_unavailable"; enrolled: boolean; onUnlocked: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState<"sign-in" | "enroll" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const signInRef = useRef<HTMLButtonElement>(null);
  const enrollRef = useRef<HTMLButtonElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  // the control that started a failed try takes the focus back once it is enabled again
  const refocus = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (busy === null && refocus.current) { refocus.current.focus(); refocus.current = null; } }, [busy]);
  // a prompt this screen opened goes with it; a hidden page drops a typed token
  useEffect(() => {
    const clear = () => { if (tokenRef.current) tokenRef.current.value = ""; };
    const hidden = () => { if (document.hidden) clear(); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", clear);
    return () => { cancelCeremony(); clear(); document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", clear); };
  }, []);

  const run = async (kind: "sign-in" | "enroll", ceremony: () => Promise<void>): Promise<void> => {
    setBusy(kind); setError(null); setNotice(null);
    try {
      await ceremony();
      onUnlocked();
      return;
    } catch (failure) {
      if (ceremonyCanceled(failure)) setNotice(t("Passkey prompt canceled. Nothing changed."));
      else setError(ownerErrorMessage(failure));
    }
    refocus.current = (kind === "sign-in" ? signInRef : enrollRef).current;
    setBusy(null);
  };

  const enroll = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy || !tokenRef.current) return;
    const token = tokenRef.current.value.trim();
    tokenRef.current.value = "";
    if (token === "") { setError(t("Enter the enrollment token from the SSH command.")); tokenRef.current.focus(); return; }
    const label = labelRef.current?.value.trim().slice(0, 48) || deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0);
    void run("enroll", () => enrollFirstPasskey(token, label));
  };

  return (
    <main className="access-gate-screen">
      <div className="access-gate" data-testid="owner-gate">
        <img src="/icons/icon-192.png?v=ram1" alt="" width="44" height="44" className="access-gate-mark" />
        <h1 id="owner-gate-title" className="access-gate-title">
          herdr <span className="brand-sub">web ui</span>
        </h1>
        {reason === "owner_store_unavailable" ? (
          <p className="access-gate-refused" role="alert">{t("Owner sign-in is unavailable: the server cannot read its owner records. Fix it over SSH.")}</p>
        ) : <>
          <p className="access-gate-copy">{t(enrolled ? "Sign in with your owner passkey." : "No passkey is enrolled yet. Enroll the first one with the token from the SSH command.")}</p>
          {enrolled && (
            <button ref={signInRef} type="button" className="access-gate-submit" autoFocus disabled={busy !== null} aria-describedby={error !== null ? "owner-gate-error" : undefined} onClick={() => void run("sign-in", signInWithPasskey)}>
              {t(busy === "sign-in" ? "Waiting for your passkey…" : "Sign in with a passkey")}
            </button>
          )}
          <details className="access-gate-alt" open={!enrolled}>
            <summary>{t("Enroll the first passkey")}</summary>
            <form aria-labelledby="owner-gate-title" onSubmit={enroll}>
              <label className="access-gate-label" htmlFor="owner-gate-token">{t("Enrollment token")}</label>
              <input ref={tokenRef} id="owner-gate-token" className="access-gate-input" type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={256} />
              <label className="access-gate-label" htmlFor="owner-gate-label">{t("Name for this passkey")}</label>
              <input ref={labelRef} id="owner-gate-label" className="access-gate-input" type="text" autoComplete="off" maxLength={48} />
              <button ref={enrollRef} type="submit" className="access-gate-submit" disabled={busy !== null} aria-describedby={error !== null ? "owner-gate-error" : undefined}>
                {t(busy === "enroll" ? "Waiting for your passkey…" : "Enroll passkey")}
              </button>
            </form>
          </details>
        </>}
        {notice !== null && <p className="access-gate-copy" role="status">{notice}</p>}
        {error !== null && <p id="owner-gate-error" className="access-gate-error" role="alert">{error}</p>}
      </div>
    </main>
  );
}
