import { ENV } from "./fixtures/motoko-target.ts";
import { motokoTarget } from "./motoko-config.ts";
import { describe, expect, it } from "bun:test";
import { runMetadataCommand, type MetadataProcess } from "./motoko-reader.ts";

const TARGET = motokoTarget(ENV);
const signal = () => new AbortController();
function child(stdout: string, exit = 0): MetadataProcess {
  return { stdout: new Blob([stdout]).stream(), exited: Promise.resolve(exit), kill() {} };
}

describe("bounded metadata command", () => {
  it("uses fixed argv and parses metadata without stderr disclosure", async () => {
    let argv: readonly string[] = [];
    expect(await runMetadataCommand(signal().signal, (args) => { argv = args; return child('{"rows":[]}'); }, 1_500, TARGET)).toEqual({ rows: [] });
    expect(argv).toEqual(["/usr/bin/curl", "--disable", "--silent", "--show-error", "--fail", "--noproxy", "*", "--proto", "=http", "--connect-timeout", "1", "--max-time", "1.5", "http://127.0.0.1:7433/api/rigs/01ARZ3NDEKTSV4RRFFQ69G5FAV/status"]);
  });
  it("refuses malformed output, command failure, and excess output", async () => {
    for (const process of [child("broken"), child("{}", 1)]) {
      await expect(runMetadataCommand(signal().signal, () => process, 1_500, TARGET)).rejects.toThrow();
    }
    await expect(runMetadataCommand(signal().signal, () => child(JSON.stringify({ value: "x".repeat(65_537) })), 1_500, TARGET)).rejects.toThrow("exceeds limit");
    expect(await runMetadataCommand(signal().signal, () => child(" ".repeat(65_534) + "{}"), 1_500, TARGET)).toEqual({});
  });
  it("kills and reaps the child on timeout or cancellation", async () => {
    for (const abort of [false, true]) {
      const controller = signal();
      let killed = false;
      let reap!: (code: number) => void;
      const process: MetadataProcess = {
        stdout: new ReadableStream(),
        exited: new Promise((resolve) => { reap = resolve; }),
        kill() { killed = true; reap(137); },
      };
      const result = runMetadataCommand(controller.signal, () => process, 10, TARGET);
      if (abort) controller.abort();
      await expect(result).rejects.toThrow();
      expect(killed).toBe(true);
    }
  });
  it("does not spawn for an aborted request", async () => {
    const controller = signal(); controller.abort();
    let spawned = false;
    await expect(runMetadataCommand(controller.signal, () => { spawned = true; return child("{}"); }, 1_500, TARGET)).rejects.toThrow();
    expect(spawned).toBe(false);
  });
});

import { createOpenRigProvider, mapRigStatus } from "./motoko-reader.ts";
import { collectMotoko, defaultMotokoProvider, handleMotokoRequest } from "./motoko.ts";
import { sampleAge } from "../shared/motoko.ts";
const NOW = Date.parse("2026-10-17T22:00:00Z");
const metadata = () => ({
  rigId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", rigName: "fiction-lab",
  perSeat: [{ logicalId: "team.worker-b", runtime: "codex", lifecycleState: "running", intendedAction: "resume-original", blocked: false }],
});

describe("selected rig metadata", () => {
  it("maps only the selected roster and leaves absent metrics unknown", async () => {
    const provider = createOpenRigProvider(() => child(JSON.stringify(metadata())), () => NOW, ENV);
    const status = await collectMotoko(provider, () => NOW);
    expect(status.source).toBe("OpenRig");
    expect(status.rigs).toHaveLength(1);
    const seat = status.rigs[0]!.seats[0]!;
    expect(seat).toMatchObject({ id: "team.worker-b", session: "team-worker-b@fiction-lab", activity: "unknown", confidence: "unknown", workflow: { lifecycle: "running", restoreAction: "resume-original", blocked: false } });
    expect(seat.context.used.state).toBe("unknown");
    expect(seat.context.window.state).toBe("unknown");
    expect(seat.appliedCompactions.state).toBe("unknown");
    expect(status.needsYou).toEqual([]);
    expect(status.errors).toEqual([]);
    expect(sampleAge(status, NOW + 30_001).stale).toBe(true);
  });
  it("refuses another rig, invalid rows, duplicate seats, and invalid fields", () => {
    const raw = metadata();
    for (const invalid of [null, {}, { ...raw, rigId: "other" }, { ...raw, rigName: "other" }, { ...raw, perSeat: {} }, { ...raw, perSeat: [raw.perSeat[0], raw.perSeat[0]] }, { ...raw, perSeat: [{ ...raw.perSeat[0], logicalId: "../other" }] }, { ...raw, perSeat: [{ ...raw.perSeat[0], lifecycleState: "made-up" }] }]) {
      expect(() => mapRigStatus(invalid, 0, TARGET)).toThrow();
    }
  });
  it("does not copy extra fields into its result", () => {
    const raw = metadata();
    const result = mapRigStatus({ ...raw, secret: "UNRELATED", perSeat: [{ ...raw.perSeat[0], reason: "PRIVATE", resumeToken: "TOKEN", evidence: "WORK" }] }, 12, TARGET);
    expect(JSON.stringify(result)).not.toMatch(/UNRELATED|PRIVATE|TOKEN|WORK/);
  });
  it("returns structured OpenRig failures without a fixture fallback", async () => {
    const provider = createOpenRigProvider(() => child("{}", 1), () => NOW, ENV);
    const status = await collectMotoko(provider, () => NOW);
    expect((await collectMotoko(createOpenRigProvider(() => child("", 28), () => NOW, ENV), () => NOW)).errors[0]!.code).toBe("timeout");
    expect(status.source).toBe("OpenRig");
    expect(status.rigs).toEqual([]);
    expect(status.errors).toEqual([{ source: "OpenRig", code: "collector_failed", message: "The status source failed." }]);
  });
});

describe("native child cleanup with synthetic data", () => {
  it("kills and reaps a real child on overflow, timeout, and cancellation", async () => {
    for (const mode of ["overflow", "timeout", "abort"] as const) {
      const controller = new AbortController();
      let process: Bun.Subprocess<"ignore", "pipe", "ignore"> | undefined;
      const result = runMetadataCommand(controller.signal, () => {
        process = Bun.spawn([Bun.which("bun")!, "-e", mode === "overflow" ? 'process.stdout.write("x".repeat(70000)); setInterval(()=>{},1000)' : 'setInterval(()=>{},1000)'], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
        return { stdout: process.stdout, exited: process.exited, kill: () => process!.kill("SIGKILL") };
      }, mode === "overflow" ? 1000 : 30, TARGET);
      if (mode === "abort") controller.abort();
      await expect(result).rejects.toThrow();
      expect(await process!.exited).not.toBe(0);
      expect(() => globalThis.process.kill(process!.pid, 0)).toThrow();
    }
  });
});


describe("status request cancellation", () => {
  it("retains the production source and aborts the provider on request cancellation", async () => {
    expect(defaultMotokoProvider.source).toBe("OpenRig");
    const controller = new AbortController();
    let given: AbortSignal | undefined;
    const provider = Object.assign((signal: AbortSignal) => { given = signal; return new Promise<unknown>(() => {}); }, { source: "OpenRig" as const });
    const url = new URL("http://localhost/api/motoko/status");
    const result = handleMotokoRequest(new Request(url, { signal: controller.signal }), url, { provider, now: () => NOW });
    controller.abort();
    const status = await (await result).json();
    expect(given?.aborted).toBe(true);
    expect(status).toMatchObject({ source: "OpenRig", rigs: [], coverage: { activity: false, needsYou: false }, errors: [{ code: "canceled" }] });
    let called = false;
    await collectMotoko(async () => { called = true; return {}; }, () => NOW, 10, controller.signal);
    expect(called).toBe(false);
  });
});
