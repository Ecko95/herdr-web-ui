import { sampleAge, type MotokoStatus } from "../../shared/motoko.ts";

export const nextPose = (current: number, random = Math.random()): number => (current + 1 + Math.floor(random * 4)) % 5;

/** Missing coverage and failed samples cannot prove a zero. */
export function bootFacts(status: MotokoStatus | null, now: number) {
  const valid = status !== null && status.errors.length === 0;
  const seats = status?.rigs.flatMap((rig) => rig.seats) ?? [];
  return {
    rigs: valid ? status.rigs.map((rig) => rig.name).join(", ") : null,
    seats: valid ? seats.length : null,
    working: valid && (status.coverage?.activity ?? status.source === "fixture") ? seats.filter((seat) => seat.activity === "working").length : null,
    needsYou: valid && (status.coverage?.needsYou ?? status.source === "fixture") ? status.needsYou.length : null,
    stale: status !== null && sampleAge(status, now).stale,
  };
}
