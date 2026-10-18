import { expect, test } from "bun:test";
import { bootFacts, nextPose } from "./motokoBoot.ts";
import type { MotokoStatus } from "../../shared/motoko.ts";
const now = Date.parse("2026-10-17T22:00:00Z");
const status: MotokoStatus = { source: "OpenRig", sampledAt: new Date(now).toISOString(), staleAfterMs: 30_000, coverage: { activity: false, needsYou: false }, rigs: [{ id: "fiction-lab", name: "fiction-lab", domain: "unknown", seats: [] }], needsYou: [], errors: [] };
test("boot facts preserve unknown coverage and stale/error states", () => {
  expect(bootFacts(status, now)).toMatchObject({ rigs: "fiction-lab", seats: 0, working: null, needsYou: null, stale: false });
  expect(bootFacts(status, now + 30_001).stale).toBe(true);
  expect(bootFacts({ ...status, errors: [{ source: "OpenRig", code: "collector_failed", message: "failure" }] }, now)).toMatchObject({ rigs: null, seats: null, working: null, needsYou: null });
  expect(bootFacts({ ...status, source: "fixture", coverage: undefined }, now).needsYou).toBe(0);
  expect(bootFacts(null, now).seats).toBeNull();
});
test("replay chooses a different valid pose at both random bounds", () => {
  for (let current = 0; current < 5; current++) for (const random of [0, 0.999999]) {
    const next = nextPose(current, random);
    expect(next).not.toBe(current); expect(next).toBeGreaterThanOrEqual(0); expect(next).toBeLessThan(5);
  }
});
