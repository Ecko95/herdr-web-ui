import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as config from "./motoko-config.ts";

const scope = {
  rigs: [
    { key: "alpha", rigId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", rigName: "fiction-alpha", label: "Alpha", ownerProfileKey: null, projectKey: null },
    { key: "beta", rigId: "01ARZ3NDEKTSV4RRFFQ69G5FAW", rigName: "fiction-beta", label: "Beta", ownerProfileKey: null, projectKey: null },
  ], ownerProfiles: [], projects: [],
};
const env = (value: string) => ({ HERDR_WEB_MOTOKO_MAP_SCOPE: value });
const parse = (value: string) => config.motokoMapScopeFromEnv(env(value));

test("startup scope accepts a multi-rig catalog with unknown mappings", () => {
  expect(parse(JSON.stringify(scope))).toEqual(scope);
});
test("absent startup scope preserves the existing one-rig fallback", () => {
  const raw = config.motokoMapScopeFromEnv({});
  expect(raw).toBeUndefined();
  const target = config.motokoTarget({ HERDR_WEB_MOTOKO_RIG_ID: scope.rigs[0]!.rigId, HERDR_WEB_MOTOKO_RIG_NAME: "fiction-alpha", HERDR_WEB_MOTOKO_SOURCE_SESSION: "fiction-owner@external" });
  expect(config.mapScope(raw, target)?.rigs).toEqual([{ ...scope.rigs[0]!, key: "fiction-alpha", label: "fiction-alpha" }]);
});
test("explicit invalid scope never becomes the absent-input fallback", () => {
  for (const value of ["", " ", "{", "null", "[]", "{}"]) expect(() => parse(value)).toThrow("invalid_map_scope");
});
test("startup scope checks UTF-8 bytes before JSON parse", () => {
  const text = JSON.stringify(scope);
  expect(parse(text + " ".repeat(65536 - Buffer.byteLength(text)))).toEqual(scope);
  expect(() => parse(text + " ".repeat(65537 - Buffer.byteLength(text)))).toThrow("invalid_map_scope");
  const multibyte = JSON.stringify({ ...scope, rigs: [{ ...scope.rigs[0]!, label: "é".repeat(120) }] });
  const oversized = multibyte + " ".repeat(65536 - multibyte.length);
  expect(oversized.length).toBe(65536);
  expect(() => parse(oversized)).toThrow("invalid_map_scope");
  expect(() => parse("{".repeat(65537))).toThrow("invalid_map_scope");
});
test("startup scope rejects duplicate identities and invalid mappings", () => {
  for (const field of ["key", "rigId", "rigName"] as const) {
    expect(() => parse(JSON.stringify({ ...scope, rigs: [scope.rigs[0], { ...scope.rigs[1], [field]: scope.rigs[0]![field] }] }))).toThrow("invalid_map_scope");
  }
  for (const field of ["ownerProfileKey", "projectKey"] as const) {
    expect(() => parse(JSON.stringify({ ...scope, rigs: [{ ...scope.rigs[0], [field]: "unmapped" }] }))).toThrow("invalid_map_scope");
  }
});

// Execute the real startup prefix with inert dependencies; never import the full server.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
function startup(environment: Record<string, string | undefined>) {
  const start = source.indexOf("if (import.meta.main) {");
  const end = source.indexOf("  telemetry.start();", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  let options: Record<string, unknown> | undefined;
  let starts = 0;
  const dependencies = {
    process: { env: environment, exit: () => { throw Error("exit"); } },
    console: { error: () => {} }, ownerConfiguration: () => {},
    motokoMapScopeFromEnv: config.motokoMapScopeFromEnv,
    connectUpdater: () => { starts++; return { installed: () => ({}) }; },
    readFileSync: () => '{"version":"0.0.0"}', join: (...parts: string[]) => parts.join("/"),
    defaultStateDir: () => "fiction-state", fetch: () => { throw Error("unexpected fetch"); },
    Telemetry: class {}, PortalService: class {}, HerdrUpdater: class {}, readHerdrProfiles: () => [],
    createServer: (input: Record<string, unknown>) => { options = input; return {}; },
  };
  const prefix = source.slice(start + "if (import.meta.main) {".length, end).replaceAll("import.meta.dir", '"fiction-server"');
  const js = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(prefix);
  new Function(...Object.keys(dependencies), js)(...Object.values(dependencies));
  return { options, starts };
}
test("normal startup hands the validated scope to createServer", () => {
  expect(startup(env(JSON.stringify(scope))).options?.["motokoMapScope"]).toEqual(scope);
  expect(startup({}).options?.["motokoMapScope"]).toBeUndefined();
});
test("invalid explicit startup scope stops before createServer", () => {
  expect(() => startup(env("null"))).toThrow("invalid_map_scope");
});
