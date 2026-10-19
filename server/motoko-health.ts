import type { MotokoHealth } from "../shared/motoko.ts";
import { cpus, freemem, totalmem, uptime, type CpuInfo } from "node:os";
import { jsonResponse } from "./http.ts";
interface HealthSources {
  cpus: () => Pick<CpuInfo, "times">[];
  freemem: () => number;
  totalmem: () => number;
  uptime: () => number;
  monotonic: () => number;
  now: () => number;
}

const nonnegative = (value: number) => Number.isFinite(value) && value >= 0;
export function createHealthSampler(sources: HealthSources = { cpus, freemem, totalmem, uptime, monotonic: () => performance.now(), now: Date.now }): () => MotokoHealth {
  let previous: { count: number; totals: number[]; time: number } | null = null;
  return () => {
    const sampledAt = new Date(sources.now()).toISOString();
    const known = <T>(value: T) => ({ state: "known" as const, value, observedAt: sampledAt });
    const result: MotokoHealth = {
      sampledAt, staleAfterMs: 15_000,
      cpu: { state: "unknown", reason: "CPU sample unavailable" },
      memory: { state: "unknown", reason: "Memory sample unavailable" },
      uptime: { state: "unknown", reason: "Uptime sample unavailable" },
    };
    try {
      const time = sources.monotonic(), processors = sources.cpus();
      const totals = [0, 0, 0, 0, 0];
      for (const processor of processors) {
        const values = [processor.times.user, processor.times.nice, processor.times.sys, processor.times.idle, processor.times.irq];
        if (!values.every(nonnegative)) throw Error("Invalid counters");
        values.forEach((value, index) => { totals[index]! += value; });
      }
      if (!processors.length || !nonnegative(time) || !totals.every(nonnegative)) throw Error("Invalid sample");
      const next = { count: processors.length, totals, time };
      const old = previous; previous = next;
      if (old) {
        const intervalMs = time - old.time, deltas = totals.map((value, index) => value - old.totals[index]!);
        const total = deltas.reduce((sum, value) => sum + value, 0);
        if (old.count === next.count && intervalMs > 0 && intervalMs <= 30_000 && deltas.every(nonnegative) && Number.isFinite(total) && total > 0) {
          result.cpu = known({ percent: 100 * (total - deltas[3]!) / total, intervalMs });
        }
      }
    } catch { previous = null; }
    try {
      const totalBytes = sources.totalmem(), free = sources.freemem();
      if (nonnegative(free) && Number.isFinite(totalBytes) && totalBytes > 0 && free <= totalBytes) result.memory = known({ usedBytes: totalBytes - free, totalBytes });
    } catch { /* other metrics remain independent */ }
    try { const seconds = sources.uptime(); if (nonnegative(seconds)) result.uptime = known(seconds); } catch { /* other metrics remain independent */ }
    return result;
  };
}

export function handleHealthRequest(request: Request, { sample, owner }: { sample: () => MotokoHealth; owner: { recheck: () => void } | null }): Response {
  const denied = () => jsonResponse({ error: { code: "owner_required", message: "owner_required" } }, 401, { "cache-control": "no-store" });
  if (!owner) return denied();
  try { owner.recheck(); } catch { return denied(); }
  if (request.method !== "GET") return jsonResponse({ error: { code: "method_not_allowed", message: "Use GET" } }, 405, { "cache-control": "no-store", allow: "GET" });
  const result = sample();
  try { owner.recheck(); } catch { return denied(); }
  return jsonResponse(result, 200, { "cache-control": "no-store" });
}
