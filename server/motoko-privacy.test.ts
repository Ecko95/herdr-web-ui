import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenRigProvider, type MetadataProcess } from "./motoko-reader.ts";
import { createCoordination, rigSourceCheck, sourceBinding, type CoordinationQueue } from "./motoko-coordination.ts";

const env = { HERDR_WEB_MOTOKO_RIG_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAV", HERDR_WEB_MOTOKO_RIG_NAME: "fiction-lab", HERDR_WEB_MOTOKO_SOURCE_SESSION: "fiction-owner@external" };
const binding = { rigId: env.HERDR_WEB_MOTOKO_RIG_ID, sourceSession: "fiction-owner@external", destinationSession: "team-orchestrator@fiction-lab" };
const raw = { rigId: env.HERDR_WEB_MOTOKO_RIG_ID, rigName: "fiction-lab", perSeat: [] };
const child = (value: unknown): MetadataProcess => ({ stdout: new Blob([JSON.stringify(value)]).stream(), exited: Promise.resolve(0), kill() {} });
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("private configuration accepts a fictional registered target", async () => {
  expect(await sourceBinding(env, async () => ({ ok: true, record: { entityId: "fiction-owner", address: binding.sourceSession } }))).toEqual(binding);
  let argv: readonly string[] = [];
  const provider = createOpenRigProvider(args => { argv = args; return child(raw); }, Date.now, env);
  expect(await provider(new AbortController().signal)).toMatchObject({ rigs: [{ name: "fiction-lab" }] });
  expect(argv.at(-1)).toBe(`http://127.0.0.1:7433/api/rigs/${raw.rigId}/status`);
});

test("private configuration refuses missing or malformed values before any child", async () => {
  const invalid = [{}, ...Object.keys(env).map(key => ({ ...env, [key]: "" })), { ...env, HERDR_WEB_MOTOKO_RIG_ID: "Z".repeat(26) }, { ...env, HERDR_WEB_MOTOKO_RIG_ID: "../escape" }, { ...env, HERDR_WEB_MOTOKO_RIG_NAME: "Bad Name" }, { ...env, HERDR_WEB_MOTOKO_SOURCE_SESSION: "-flag@external" }];
  for (const config of invalid) {
    let calls = 0;
    expect(await sourceBinding(config, async () => { calls++; return {}; })).toBeNull();
    await expect(createOpenRigProvider(() => { calls++; return child(raw); }, Date.now, config)(new AbortController().signal)).rejects.toThrow();
    expect(calls).toBe(0);
    await expect(rigSourceCheck(config, () => { calls++; return { ...child({}), stderr: new Blob([]).stream() }; })()).rejects.toThrow();
    expect(calls).toBe(0);
  }
});

test("private configuration rejects wrong returned rig and gateway identity", async () => {
  for (const value of [{ ...raw, rigId: "01BX5ZZKBKACTAV9WEVGEMMVRZ" }, { ...raw, rigName: "other-lab" }]) {
    await expect(createOpenRigProvider(() => child(value), Date.now, env)(new AbortController().signal)).rejects.toThrow();
  }
  for (const record of [{ entityId: "other-owner", address: binding.sourceSession }, { entityId: "fiction-owner", address: "other-owner@external" }]) {
    expect(await sourceBinding(env, async () => ({ ok: true, record }))).toBeNull();
  }
});

test("private configuration captures the target before requests", async () => {
  const config = { ...env };
  const provider = createOpenRigProvider(() => child(raw), Date.now, config);
  config.HERDR_WEB_MOTOKO_RIG_NAME = "other-lab";
  expect(await provider(new AbortController().signal)).toMatchObject({ rigs: [{ name: "fiction-lab" }] });
});

test("private configuration refuses stored scope mismatch without queue calls or writes", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "motoko-privacy-")); dirs.push(stateDir);
  let calls = 0;
  const reply = (value: unknown) => ({ status: 201, bytes: new TextEncoder().encode(JSON.stringify(value)) });
  const queue: CoordinationQueue = {
    async create(input) { calls++; return reply({ ...input, state: "pending" }); },
    async item() { calls++; return reply({}); },
    async transitions() { calls++; return reply([]); },
  };
  const owner = { sessionId: "fiction-session", origin: "https://owner.example", recheck() {} };
  const input = { requestId: "0b7f4a5c-1d2e-4f60-8a9b-0c1d2e3f4a5b", text: "Fictional question" };
  await createCoordination({ stateDir, binding, queue, now: Date.now }).submit(owner, input);
  const file = join(stateDir, "coordination.json"), before = readFileSync(file);
  for (const changed of [null, { ...binding, rigId: "01BX5ZZKBKACTAV9WEVGEMMVRZ" }, { ...binding, sourceSession: "other-owner@external" }, { ...binding, destinationSession: "team-orchestrator@other-lab" }]) {
    calls = 0;
    const coordination = createCoordination({ stateDir, binding: changed, queue, now: Date.now });
    await expect(coordination.history(owner, new AbortController().signal)).rejects.toMatchObject({ code: "coordination_scope_mismatch" });
    await expect(coordination.submit(owner, input)).rejects.toThrow();
    expect(calls).toBe(0);
    expect(readFileSync(file)).toEqual(before);
  }
  const legacy = JSON.parse(before.toString()); delete legacy.receipts[0].rigId;
  const legacyBytes = JSON.stringify(legacy); writeFileSync(file, legacyBytes);
  calls = 0;
  const sameScope = createCoordination({ stateDir, binding, queue, now: Date.now });
  await expect(sameScope.history(owner, new AbortController().signal)).rejects.toMatchObject({ code: "coordination_scope_mismatch" });
  await expect(sameScope.submit(owner, input)).rejects.toMatchObject({ code: "coordination_scope_mismatch" });
  expect(calls).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(legacyBytes);
});
