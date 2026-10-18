import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useT } from "../lib/i18n.ts";
import { ApiError } from "../lib/api.ts";
import { fetchMotokoStatus, ownerErrorMessage } from "../lib/motoko.ts";
import { bootFacts, nextPose } from "../lib/motokoBoot.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import type { MotokoStatus } from "../../shared/motoko.ts";
import "./MotokoBoot.css";

const smile = new URL("../assets/motoko/smile.webp", import.meta.url).href;
const still = new URL("../assets/motoko/smile-still.webp", import.meta.url).href;
const wine = new URL("../assets/motoko/wine.webp", import.meta.url).href;
const glance = new URL("../assets/motoko/glance.webp", import.meta.url).href;
const shrug = new URL("../assets/motoko/shrug.webp", import.meta.url).href;
const visor = new URL("../assets/motoko/visor.webp", import.meta.url).href;

const POSES = [smile, wine, glance, shrug, visor];

/** Owner-only status presentation. No terminal or command starts here. */
export function MotokoBoot({ onStatus, onSessionEnded }: { onStatus: () => void; onSessionEnded: () => void }) {
  const t = useT();
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [pose, setPose] = useState(() => Math.floor(Math.random() * POSES.length));
  const [replay, setReplay] = useState(0);
  const [status, setStatus] = useState<MotokoStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ended = useRef(onSessionEnded);
  ended.current = onSessionEnded;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const controller = new AbortController();
    void fetchMotokoStatus(controller.signal).then((sample) => {
      if (!controller.signal.aborted) { setStatus(sample); setNow(Date.now()); }
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 401) ended.current();
      else setError(ownerErrorMessage(failure));
    });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!status) return;
    const delay = Date.parse(status.sampledAt) + status.staleAfterMs + 1 - Date.now();
    if (delay <= 0 || !Number.isFinite(delay)) return;
    // This timer ages the status sample; CSS owns every animation.
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [status]);
  const facts = bootFacts(status, now);
  const unknown = t("Unknown");
  const rows = [
    [t("Source"), status?.source ?? unknown],
    [t("Rigs"), facts.rigs || unknown],
    [t("Seats"), facts.seats ?? unknown],
    [t("Working"), facts.working ?? unknown],
    [t("Needs you"), facts.needsYou ?? unknown],
    [t("Host"), t("Unknown: not reported")],
    [t("Sample"), status?.sampledAt ?? unknown],
    [t("Status"), error || status?.errors.length ? t("Status unavailable") : status === null ? t("Loading status…") : facts.stale ? t("Stale sample") : t("Roster sample received")],
  ];
  const notice = facts.needsYou === null ? t("Owner requests are not reported by this source.") : status?.needsYou[0]?.summary ?? t("Nothing waits on you in this sample.");
  return (
    <section className="motoko-boot" aria-label={t("Motoko boot status")} data-reduced-motion={reduced}>
      <div className="motoko-boot-toolbar">
        <span className="motoko-boot-prompt">motoko &gt; {t("Status view")}</span>
        <button type="button" className="btn btn-ghost" onClick={() => { setPose((current) => nextPose(current)); setReplay((current) => current + 1); }}>{t("Replay boot")}</button>
      </div>
      <p className="motoko-hint">{t("A status view. No terminal command starts here.")}</p>
      <div key={replay} className="motoko-boot-scene">
        <img className="motoko-boot-portrait" src={reduced && pose === 0 ? still : POSES[pose]} alt={t("Motoko dot-matrix portrait")} />
        <div className="motoko-boot-output">
          <h2>{t("Motoko status")}</h2>
          <dl>{rows.map(([label, value], index) => <div key={label} className="motoko-boot-line" style={{ "--boot-delay": `${2 + index * 0.11}s` } as CSSProperties}><dt>{label}:</dt><dd>{value}</dd></div>)}</dl>
          <span className="motoko-boot-cursor" aria-hidden="true" />
          {status?.source === "OpenRig" && <p className="motoko-hint">{t("Agent activity and owner requests are not reported.")}</p>}
          {(error || Boolean(status?.errors.length)) && <p role="alert">{error ?? status!.errors.map((item) => item.message).join(" ")}</p>}
        </div>
      </div>
      <div className="motoko-boot-notice"><strong>{t("Needs you")}</strong><p>{error || status?.errors.length ? t("Status unavailable") : notice}</p></div>
      <button type="button" className="btn motoko-boot-continue" onClick={onStatus}>{t("Open Motoko status")} <span aria-hidden="true">↓</span></button>
    </section>
  );
}
