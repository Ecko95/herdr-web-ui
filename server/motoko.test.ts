import { describe, expect, it } from "bun:test";
import { occupancy, sampleAge, type MotokoStatus } from "../shared/motoko.ts";
import { appliedCompactions, collectMotoko, fixtureProvider, handleMotokoRequest } from "./motoko.ts";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const now = () => NOW;
const collect = (name: string, timeoutMs?: number) => collectMotoko(fixtureProvider(name), now, timeoutMs);
const seat = (status: MotokoStatus, id: string) => status.rigs.flatMap((rig) => rig.seats).find((candidate) => candidate.id === id)!;

describe("Motoko status", () => {
  it("shows occupancy only where both numbers were observed, never 0 for unknown", async () => {
    const status = await collect("context");
    expect(occupancy(seat(status, "a").context)).toBe(42);
    expect(seat(status, "b").context.window).toEqual({ state: "unknown", reason: "context window not reported" });
    expect(occupancy(seat(status, "b").context)).toBeNull();
    expect(seat(status, "c").context.used.state).toBe("unknown");
    expect(seat(status, "c").context.sampledAt).toBeNull();
    expect(occupancy(seat(status, "c").context)).toBeNull();
    expect(status.errors).toEqual([]);
  });

  it("counts each applied (session, entry) once and leaves requested and prepared out", async () => {
    const status = await collect("compactions");
    expect(seat(status, "a").appliedCompactions).toMatchObject({ state: "known", value: 2 });
    expect(seat(status, "b").appliedCompactions).toEqual({ state: "unknown", reason: "compaction receipts not reported" });
    // the same entry id in another session is another compaction
    expect(appliedCompactions([{ session: "s1", entryId: "e", status: "applied" }, { session: "s2", entryId: "e", status: "applied" }], "t")).toMatchObject({ value: 2 });
    expect(appliedCompactions([], "t")).toMatchObject({ state: "known", value: 0 });
  });

  it("says when a sample is stale and how old it is", async () => {
    const stale = await collect("stale");
    expect(sampleAge(stale, NOW)).toEqual({ ageMs: 840_000, stale: true });
    expect(sampleAge(await collect("context"), NOW).stale).toBe(false);
    expect(sampleAge({ sampledAt: "not a time", staleAfterMs: 1000 }, NOW).stale).toBe(true);
  });

  it("turns a failing or silent source into an error with no rigs", async () => {
    for (const [name, code] of [["error", "collector_failed"], ["timeout", "timeout"]] as const) {
      const status = await collect(name, 20);
      expect(status.rigs).toEqual([]);
      expect(status.needsYou).toEqual([]);
      expect(status.errors).toEqual([expect.objectContaining({ code })]);
    }
    const thrown = await collectMotoko(async () => { throw new Error("/home/secret/path"); }, now);
    expect(JSON.stringify(thrown)).not.toContain("/home/secret");
    expect((await collectMotoko(async () => ({ rigs: "x" }), now)).errors).toEqual([expect.objectContaining({ code: "invalid_sample" })]);
  });

  it("settles at the deadline whether or not the provider answers, and discards a late answer", async () => {
    const timedOut: MotokoStatus = { sampledAt: new Date(NOW).toISOString(), staleAfterMs: 0, source: "fixture", rigs: [], needsYou: [], errors: [{ source: "fixture", code: "timeout", message: "The status source did not answer in time." }] };
    let signal: AbortSignal | undefined;
    // a provider that ignores its signal and never answers
    const silent = collectMotoko((given) => { signal = given; return new Promise(() => {}); }, now, 10);
    expect(await Promise.race([silent, Bun.sleep(200).then(() => "still pending")])).toEqual(timedOut);
    expect(signal?.aborted).toBe(true);
    // providers that answer the moment they are aborted, which is just after the deadline
    const sample = await fixtureProvider("normal")(new AbortController().signal);
    const answerOnAbort = (settle: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => void) => (given: AbortSignal) =>
      new Promise<unknown>((resolve, reject) => given.addEventListener("abort", () => settle(resolve, reject), { once: true }));
    expect(await collectMotoko(answerOnAbort((resolve) => resolve(sample)), now, 5)).toEqual(timedOut);
    expect(await collectMotoko(answerOnAbort((_, reject) => reject(new Error("late"))), now, 5)).toEqual(timedOut);
    // one task turn lets a late rejection that nothing handled reach bun:test, which then fails this test
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("treats an age that names no representable instant as malformed data", async () => {
    type Sample = { sampledAgoMs: number; rigs: { seats: { context: { observedAgoMs: number } }[] }[]; needsYou: { sinceAgoMs: number }[] };
    const sample = (await fixtureProvider("normal")(new AbortController().signal)) as Sample;
    const withAge = (field: "sampledAgoMs" | "observedAgoMs" | "sinceAgoMs", ago: number) => {
      const raw = structuredClone(sample);
      if (field === "sampledAgoMs") raw.sampledAgoMs = ago;
      if (field === "observedAgoMs") raw.rigs[0]!.seats[0]!.context.observedAgoMs = ago;
      if (field === "sinceAgoMs") raw.needsYou[0]!.sinceAgoMs = ago;
      return collectMotoko(async () => raw, now);
    };
    const seatIds = (status: MotokoStatus) => status.rigs.flatMap((rig) => rig.seats.map((candidate) => candidate.id));
    // a Date holds instants up to 8.64e15 ms either side of the epoch
    const earliestAgo = NOW + 8.64e15;
    const earliest = new Date(-8.64e15).toISOString();
    expect((await withAge("sampledAgoMs", earliestAgo)).sampledAt).toBe(earliest);
    expect(seat(await withAge("observedAgoMs", earliestAgo), "builder").context.sampledAt).toBe(earliest);
    expect((await withAge("sinceAgoMs", earliestAgo)).needsYou[0]!.since).toBe(earliest);
    for (const ago of [earliestAgo + 1, Number.MAX_SAFE_INTEGER]) {
      expect(await withAge("sampledAgoMs", ago)).toEqual({ sampledAt: new Date(NOW).toISOString(), staleAfterMs: 0, source: "fixture", rigs: [], needsYou: [], errors: [{ source: "fixture", code: "invalid_sample", message: "The status sample was malformed." }] });
      const badSeat = await withAge("observedAgoMs", ago);
      expect(seatIds(badSeat)).toEqual(["reviewer", "operator", "observer"]);
      expect(badSeat.needsYou).toHaveLength(1);
      expect(badSeat.errors).toEqual([{ source: "fixture", code: "invalid_record", message: "Seat 1 of rig sample-build was malformed and is not shown." }]);
      const badRequest = await withAge("sinceAgoMs", ago);
      expect(seatIds(badRequest)).toEqual(["builder", "reviewer", "operator", "observer"]);
      expect(badRequest.needsYou).toEqual([]);
      expect(badRequest.errors).toEqual([{ source: "fixture", code: "invalid_record", message: "A Needs-you record was malformed and is not shown." }]);
    }
  });

  it("drops malformed records with a named error and keeps the agent's text literal", async () => {
    const status = await collect("malformed");
    expect(status.rigs.map((rig) => rig.id)).toEqual(["sample-mixed"]);
    expect(status.rigs[0]!.seats.map((candidate) => candidate.id)).toEqual(["ok"]);
    expect(status.needsYou.map((item) => item.id)).toEqual(["ny-ok"]);
    expect(status.needsYou[0]!.summary).toBe("<img src=x onerror=alert(1)> literal text");
    // one rig, three seats, two Needs-you records
    expect(status.errors.filter((error) => error.code === "invalid_record")).toHaveLength(6);
  });

  it("serves an explicit fixture: fictional rigs, all rules at once", async () => {
    const status = await collectMotoko(fixtureProvider("normal"), now);
    expect(status.source).toBe("fixture");
    expect(status.rigs.map((rig) => rig.domain)).not.toContain("work");
    expect(seat(status, "builder").appliedCompactions).toMatchObject({ value: 2 });
    expect(occupancy(seat(status, "reviewer").context)).toBeNull();
    expect(status.needsYou).toHaveLength(1);
  });

  it("answers GET /api/motoko/status only", async () => {
    const deps = { provider: fixtureProvider("context"), now };
    const ok = await handleMotokoRequest(new Request("http://x/api/motoko/status"), new URL("http://x/api/motoko/status"), deps);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(((await ok.json()) as MotokoStatus).rigs).toHaveLength(1);
    const post = await handleMotokoRequest(new Request("http://x/api/motoko/status", { method: "POST" }), new URL("http://x/api/motoko/status"), deps);
    expect(post.status).toBe(405);
    const other = await handleMotokoRequest(new Request("http://x/api/motoko/other"), new URL("http://x/api/motoko/other"), deps);
    expect(other.status).toBe(404);
  });

  it("refuses a fixture name that could leave the fixture folder", () => {
    expect(() => fixtureProvider("../x")).toThrow();
  });
});
