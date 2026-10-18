import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Execute only the existing wait helper and readiness assertion with fake process data and a fake clock.
const source = readFileSync(new URL("./portal.test.ts", import.meta.url), "utf8");
const helper = source.slice(source.indexOf("async function waitFor("), source.indexOf("function seedSavedPortal("));
const fixture = source.slice(source.indexOf('  it("does not treat an arbitrary interpreter as a Portal script"'));
const start = fixture.indexOf("    try {");
const end = fixture.indexOf("    } finally {", start);
expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
const body = fixture.slice(start + "    try {".length, end);
const js = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(`${helper}
async function check() {${body}}`);

async function run(delay: number | null) {
  let now = 0, reads = 0, sleeps = 0, resumed = 0;
  const scriptPath = "/fiction/portal/portal";
  const ready = ["/fiction/bun", scriptPath, "expose", "--identity-path", "/fiction/identity.json"];
  const deps = {
    Date: { now: () => now }, Bun: { sleep: async (ms: number) => { expect(ms).toBe(10); now += ms; expect(now).toBeLessThanOrEqual(2000); sleeps++; } },
    unrelated: { pid: 4242 }, scriptPath, expect,
    alive: (pid: number) => { expect(pid).toBe(4242); return true; },
    internals: { processArgv: async (pid: number) => {
      expect(pid).toBe(4242); reads++;
      return delay !== null && reads > delay ? ready : ["/fiction/bun", "test", "--timeout", "5000"];
    } },
    service: { resume: async () => { expect(delay).not.toBeNull(); expect(reads).toBeGreaterThan(delay!); resumed++; } },
  };
  await new Function(...Object.keys(deps), `${js}; return check();`)(...Object.values(deps));
  return { reads, sleeps, resumed };
}

test("readiness waits through inherited runner argv before the identity assertion", async () => {
  const result = await run(3);
  expect(result.reads).toBeGreaterThan(3);
  expect(result.sleeps).toBe(3);
  expect(result.resumed).toBe(1);
});
test("readiness accepts an already executed child", async () => {
  expect((await run(0)).resumed).toBe(1);
});
test("readiness retains the existing deadline when exec never occurs", async () => {
  await expect(run(null)).rejects.toThrow("Timed out: unrelated interpreter started");
});
