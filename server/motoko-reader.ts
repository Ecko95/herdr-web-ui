/** A fixed read of metadata from the selected OpenRig domain. */
import { motokoTarget, type MotokoTarget } from "./motoko-config.ts";
import { isJsonObject } from "./http.ts";
import type { MotokoProvider } from "./motoko.ts";

const MAX_BYTES = 65_536;

export class MetadataTimeout extends Error {}

export interface MetadataProcess {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}
type SpawnMetadata = (argv: readonly string[]) => MetadataProcess;
const spawnMetadata: SpawnMetadata = (argv) => {
  const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
  return { stdout: child.stdout, exited: child.exited, kill: () => child.kill("SIGKILL") };
};

export async function runMetadataCommand(signal: AbortSignal, spawn: SpawnMetadata = spawnMetadata, timeoutMs = 1_500, target: MotokoTarget | null = motokoTarget(process.env)): Promise<unknown> {
  signal.throwIfAborted();
  if (!target) throw new Error("Motoko configuration unavailable");
  const child = spawn(["/usr/bin/curl", "--disable", "--silent", "--show-error", "--fail", "--noproxy", "*", "--proto", "=http", "--connect-timeout", "1", "--max-time", "1.5", `http://127.0.0.1:7433/api/rigs/${target.rigId}/status`]);
  const reader = child.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectStop!: (reason: Error) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
  const cancel = () => rejectStop(new Error("Metadata read canceled"));
  signal.addEventListener("abort", cancel, { once: true });
  timer = setTimeout(() => rejectStop(new MetadataTimeout("Metadata read timed out")), timeoutMs);
  try {
    if (signal.aborted) cancel();
    const read = async () => {
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > MAX_BYTES) throw new Error("Metadata output exceeds limit");
        chunks.push(next.value);
      }
      const exit = await child.exited;
      if (exit === 28) throw new MetadataTimeout("Metadata read timed out");
      if (exit !== 0) throw new Error("Metadata command failed");
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    };
    return await Promise.race([read(), stopped]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    child.kill();
    await reader.cancel().catch(() => {});
    await child.exited;
    reader.releaseLock();
  }
}

const LIFECYCLES = ["running", "detached", "recoverable", "attention_required"];
const ACTIONS = ["resume-original", "fresh-primed", "awaiting-decision"];

/** The endpoint reports lifecycle, not agent activity or owner requests. */
export function mapRigStatus(raw: unknown, sampledAgoMs: number, target: MotokoTarget | null = motokoTarget(process.env)): unknown {
  if (!target || !isJsonObject(raw) || raw["rigId"] !== target.rigId || raw["rigName"] !== target.rigName || !Array.isArray(raw["perSeat"]) || raw["perSeat"].length > 100) {
    throw new Error("Invalid selected-rig metadata");
  }
  const ids = new Set<string>();
  const seats = raw["perSeat"].map((seat: unknown) => {
    if (!isJsonObject(seat) || typeof seat["logicalId"] !== "string" || !/^[a-z][a-z0-9-]{0,47}\.[a-z][a-z0-9-]{0,47}$/.test(seat["logicalId"]) || ids.has(seat["logicalId"]) ||
      !(seat["runtime"] === null || (typeof seat["runtime"] === "string" && /^[a-z][a-z0-9-]{0,47}$/.test(seat["runtime"]))) ||
      !LIFECYCLES.includes(String(seat["lifecycleState"])) || !ACTIONS.includes(String(seat["intendedAction"])) || typeof seat["blocked"] !== "boolean") {
      throw new Error("Invalid selected-rig seat");
    }
    ids.add(seat["logicalId"]);
    return {
      id: seat["logicalId"], session: `${seat["logicalId"].replace(".", "-")}@${target.rigName}`, role: "unknown", runtime: seat["runtime"] ?? "unknown",
      activity: "unknown", confidence: "unknown", context: {}, compactionReceipts: null,
      workflow: { lifecycle: seat["lifecycleState"], restoreAction: seat["intendedAction"], blocked: seat["blocked"] },
    };
  });
  return { sampledAgoMs, staleAfterMs: 30_000, coverage: { activity: false, needsYou: false }, rigs: [{ id: target.rigName, name: target.rigName, domain: "unknown", seats }], needsYou: [] };
}

export function createOpenRigProvider(spawn: SpawnMetadata = spawnMetadata, now: () => number = Date.now, env: Record<string, string | undefined> = process.env): MotokoProvider {
  const target = motokoTarget(env);
  return Object.assign(async (signal: AbortSignal) => {
    const started = now();
    const raw = await runMetadataCommand(signal, spawn, 1_500, target);
    return mapRigStatus(raw, Math.max(0, now() - started), target);
  }, { source: "OpenRig" as const });
}
