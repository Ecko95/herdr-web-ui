import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { posix, win32 } from "node:path";

// Evaluate the exact source with fake children and RPC sockets; never load the server lifecycle.
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });
function between(text: string, start: string, end: string): string {
  const a = text.indexOf(start), b = text.indexOf(end, a);
  if (a < 0 || b <= a) throw new Error(`Missing source boundary: ${start}`);
  return text.slice(a, b);
}
function compile(text: string, deps: Record<string, unknown>, returned: string): any {
  return new Function(...Object.keys(deps), transpiler.transformSync(text.replaceAll("export ", "")) + `;return ${returned};`)(...Object.values(deps));
}

async function unitRunner(shell: boolean, failSpawn = false) {
  const files = ["server/large.test.ts", "src/small.test.ts", "server/excluded.contract.test.ts"];
  const children: { argv: string[]; env: Record<string, string> }[] = [], roots: string[] = [], removed: string[] = [];
  const inherited = { UNIT_TEST_WORKERS: "2", HERDR_WEB_TOKEN: "fiction-inherited", HERDR_SOCKET: "/fiction/live.sock", HOME: "/fiction/account" };
  const shellPath = "/host-only/git/usr/bin/sh";
  let shellLookups = 0;
  const exit = { code: -1 };
  const code = source("scripts/ci-tests.ts").replace(/^import .*;\n/gm, "");
  const run = compile(`async function run() { ${code} }`, {
    process: { argv: ["bun", "ci-tests.ts", "unit"], execPath: "/fiction/bun", env: inherited, cwd: () => "/fiction/source", exit: (code: number) => { exit.code = code; throw exit; } },
    availableParallelism: () => 4, console: { log() {} },
    mkdtempSync: (prefix: string) => { const root = prefix + roots.length; roots.push(root); return root; },
    tmpdir: () => "/fiction/tmp", join: posix.join,
    rmSync: (root: string, options: unknown) => { expect(options).toEqual({ recursive: true, force: true }); removed.push(root); },
    controlledEnvironment: (root: string) => ({ HOME: root + "/home", HERDR_SOCKET: root + "/config/herdr.sock", PATH: "/fiction/tools" }),
    Bun: {
      Glob: class { scanSync() { return files; } },
      which: (name: string) => { if (name === "sh") { shellLookups++; return shell ? shellPath : null; } return "/fiction/" + name; },
      file: (name: string) => ({ size: name.includes("large") ? 2 : 1 }),
      spawn(argv: string[], options: { env: Record<string, string> }) {
        children.push({ argv, env: options.env });
        if (failSpawn) throw new Error("fiction-spawn-failure");
        if (argv[0] === "sh") throw new Error("shell is absent from the controlled PATH");
        return { exited: Promise.resolve(0), stdout: new Blob([" 1 pass\n 0 fail\n"]).stream() };
      },
    },
  }, "run");
  try { await run(); } catch (error) { if (error !== exit && !(failSpawn && error instanceof Error && error.message === "fiction-spawn-failure")) throw error; }
  return { children, roots, removed, code: exit.code, shellPath, shellLookups };
}

for (const shell of [false, true]) {
  test(`unit runner controls each child and removes its roots with shell=${shell}`, async () => {
    const result = await unitRunner(shell);
    expect(result.code).toBe(0);
    expect(result.children).toHaveLength(shell ? 2 : 1);
    expect(result.roots).toHaveLength(result.children.length);
    expect(result.removed.sort()).toEqual(result.roots.sort());
    const selected = result.children.flatMap(child => child.argv.filter(arg => arg.endsWith(".test.ts")));
    expect(selected.sort()).toEqual(["./server/large.test.ts", "./src/small.test.ts"]);
    for (const child of result.children) {
      expect(child.env.HOME).toContain("motoko-proof-");
      expect(child.env.HERDR_TEST_MODE).toBe("unit");
      expect(child.env.HERDR_SOCKET).toContain("motoko-proof-");
      expect(child.env.HERDR_WEB_TOKEN).toBeUndefined();
    }
  });
  test(`unit runner removes roots after a spawn error with shell=${shell}`, async () => {
    const result = await unitRunner(shell, true);
    expect(result.roots.length).toBeGreaterThan(0);
    expect(result.removed.sort()).toEqual(result.roots.sort());
  });
}

for (const platform of ["posix", "win32"] as const) {
  test(`controlled environment accepts Bun and separates PATH on ${platform}`, () => {
    const paths = platform === "win32" ? win32 : posix;
    const root = platform === "win32" ? "C:\\fiction\\motoko-proof-test" : "/fiction/motoko-proof-test";
    const bin = platform === "win32" ? "C:\\tools\\bun.exe" : "/tools/bun";
    const text = between(source("scripts/motoko-env.ts"), "export function controlledEnvironment", "export async function runControlled");
    const environment = compile(text, { Bun: { which: (name: string) => name === "bun" ? bin : null },
      process: { platform, env: { SystemRoot: "C:\\Windows" } }, mkdirSync() {}, existsSync: () => false, ...paths,
    }, "controlledEnvironment");
    expect(() => environment(root)).not.toThrow();
    const env = environment(root);
    expect(env.PATH.split(paths.delimiter)).toContain(paths.dirname(bin));
    if (platform === "win32") {
      for (const key of ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) expect(env[key]?.startsWith(root)).toBe(true);
      expect(env.SystemRoot).toBe("C:\\Windows");
      expect(env.PATH.split(paths.delimiter)).toContain("C:\\Windows\\System32");
    }
  });
}

async function secretScenario(transition: "none" | "rejoin" | "observe" | "observe-back" | "enter-connect", revoke?: "owner" | "device", failCleanup = false) {
  const clientSource = source("server/herdr/client.ts");
  const writes: { method: string; params: any }[] = [];
  let validOwner = true, closeDevice = () => {}, cleanupAttempted = false;
  const state = { closing: false, revoked: false, mode: "interact", roles: 0 };
  const client = { data: { ownerSessionId: "fiction-owner", deviceId: "fiction-device", readOnly: false, attached: new Map([["fiction-pane", {}]]) }, close() {} };
  const clients = new Set([client]);
  const connections = compile(between(source("server/core/connections.ts"), "export function createConnections", "\n  return {" ) +
    "\n return { mayType, mayEraseSecret: typeof mayEraseSecret === 'function' ? mayEraseSecret : undefined, admit, setRole, end }; }", {
    stateOf: () => state, HerdrError: Error,
  }, "createConnections")({ clients, present: new Set([client]), pending: { close() {} },
    devices: { onRevoke: (_id: string, close: () => void) => { closeDevice = close; return () => {}; } },
    owner: { current: () => validOwner ? {} : null, onRevoke: () => () => {} }, detachClaimed() {}, dropClaims() {},
  });
  connections.admit(client);
  const change = () => {
    if (transition === "rejoin" || transition === "enter-connect") client.data.attached.set("fiction-pane", {});
    if (transition.startsWith("observe")) {
      connections.setRole(client, "observe");
      if (transition === "observe-back") connections.setRole(client, "interact");
    }
  };
  const rpc = compile(between(clientSource, "const DEFAULT_TIMEOUT_MS", "export async function ping(") +
    between(clientSource, "export async function paneSendText(", "/**\n * herdr's own agent.prompt") +
    between(clientSource, "export async function paneSendKeys(", "export async function paneClose("), {
    Bun: { connect: async (options: any) => {
      const socket = { end() {}, write(frame: string) {
        const message = JSON.parse(frame);
        writes.push(message);
        options.socket.data(socket, new TextEncoder().encode(JSON.stringify({ id: message.id, result: {} }) + "\n"));
        if (message.method === "pane.send_text" && transition !== "enter-connect") change();
      } };
      const count = writes.length;
      if (count === 1 && transition === "enter-connect") change();
      // Text writes once; a cancelled Enter writes nothing. The following connect is cleanup.
      if (count === 1 && cleanupAttempted) {
        if (revoke === "owner") validOwner = false;
        if (revoke === "device") closeDevice();
        if (failCleanup) throw new Error("fiction-cleanup-connect-failure");
      } else if (count === 1) cleanupAttempted = true;
      return socket;
    } }, process: { env: { HERDR_SOCKET: "/fiction/socket" }, platform: "linux" },
  }, "({ paneSendText, paneSendKeys, HerdrError })");
  const message = { type: "secret", id: 900, pane_id: "fiction-pane", prompt: "Password:", secret: "fiction-secret" };
  const attachment = { clients, ready: true, held: false, pty: null, mirror: {}, cols: 80 };
  const responses: any[] = [];
  const fragment = between(source("server/index.ts"), '            case "secret": {', '            case "submit": {');
  const run = compile(`async function run() { switch (message.type) { ${fragment} } }`, {
    message, client, clients, attachments: new Map([[message.pane_id, attachment]]), paneQueues: new Map(),
    connectionOf: () => state, mayType: connections.mayType, mayEraseSecret: connections.mayEraseSecret,
    authorizeSocket() { if (!validOwner) throw new Error("owner_required"); },
    send: (_client: unknown, response: unknown) => responses.push(response), secretPrompt: () => "Password:", validSecret: () => true,
    paneRead: async () => ({ text: "Password:" }), serialize: async (_pane: unknown, work: () => Promise<void>) => work(), ...rpc,
  }, "run");
  await run();
  return { writes, response: responses[0], erased: message.secret };
}

for (const transition of ["none", "rejoin", "observe", "observe-back", "enter-connect"] as const) {
  test(`mirrored secret uses the final RPC guard after ${transition}`, async () => {
    const result = await secretScenario(transition);
    expect(result.erased).toBe("");
    expect(result.writes[0]?.method).toBe("pane.send_text");
    const keys = result.writes.filter(write => write.method === "pane.send_keys").map(write => write.params.keys);
    if (transition === "none") {
      expect(result.response.ok).toBe(true);
      expect(keys).toEqual([["Enter"]]);
    } else {
      expect(result.response).toMatchObject({ ok: false, code: transition.startsWith("observe") ? "read_only" : "not_attached" });
      expect(keys).toEqual([Array("fiction-secret".length).fill("Backspace")]);
    }
  });
}
for (const revoke of ["owner", "device"] as const) {
  test(`mirrored cleanup refuses ${revoke} revocation at its final RPC write`, async () => {
    const result = await secretScenario("observe", revoke);
    expect(result.erased).toBe("");
    expect(result.response).toMatchObject({ ok: false, code: "secret_failed" });
    expect(result.writes.map(write => write.method)).toEqual(["pane.send_text"]);
  });
}
test("mirrored cleanup failure stays explicit and clears submitted bytes", async () => {
  const result = await secretScenario("observe", undefined, true);
  expect(result.erased).toBe("");
  expect(result.response).toMatchObject({ ok: false, code: "secret_failed" });
  expect(result.writes.map(write => write.method)).toEqual(["pane.send_text"]);
});

test("secret cleanup retains every connection authority check except the temporary observe role", () => {
  const client = { data: { ownerSessionId: "fiction-owner", readOnly: false } };
  const clients = new Set([client]);
  const state = { closing: false, revoked: false, mode: "observe" };
  let validOwner = true;
  const text = between(source("server/core/connections.ts"), "  function mayEraseSecret(", "  function authorizeSocket(");
  const { mayEraseSecret, mayType } = compile(text, {
    stateOf: () => state, clients, owner: { current: () => validOwner ? {} : null },
  }, "({ mayEraseSecret, mayType })");
  expect(mayEraseSecret(client)).toBe(true);
  expect(mayType(client)).toBe(false);
  for (const field of ["closing", "revoked"] as const) {
    state[field] = true;
    expect(clients.has(client)).toBe(true);
    expect(mayEraseSecret(client)).toBe(false);
    state[field] = false;
  }
  client.data.readOnly = true;
  expect(mayEraseSecret(client)).toBe(false);
  client.data.readOnly = false;
  validOwner = false;
  expect(mayEraseSecret(client)).toBe(false);
  validOwner = true;
  client.data.ownerSessionId = "";
  expect(mayEraseSecret(client)).toBe(false);
  client.data.ownerSessionId = "fiction-owner";
  clients.delete(client);
  expect(mayEraseSecret(client)).toBe(false);
});

test("parallel runner uses its one detected shell outside the controlled PATH", async () => {
  const result = await unitRunner(true);
  expect(result.code).toBe(0);
  expect(result.shellLookups).toBe(1);
  expect(result.children).toHaveLength(2);
  for (const child of result.children) {
    expect(child.argv[0]).toBe(result.shellPath);
    expect(child.env.PATH.split(posix.delimiter)).not.toContain(posix.dirname(result.shellPath));
  }
});

function ownerRootAssertion(platform: "posix" | "win32", overrides: Record<string, string> = {}) {
  const paths = platform === "win32" ? win32 : posix;
  const root = platform === "win32" ? "C:\\fiction\\motoko-proof-parent" : "/fiction/motoko-proof-parent";
  const bin = platform === "win32" ? "C:\\tools\\bun.exe" : "/tools/bun";
  const environment = compile(between(source("scripts/motoko-env.ts"), "export function controlledEnvironment", "export async function runControlled"), {
    Bun: { which: (name: string) => name === "bun" ? bin : null },
    process: { platform, env: {} }, mkdirSync() {}, existsSync: () => false, ...paths,
  }, "controlledEnvironment");
  const env = { ...environment(root), ...overrides };
  const start = 'test("controlled child roots exclude inherited accounts, selectors, and live sockets", () => {';
  const body = between(source("server/motoko-owner.test.ts"), start, "\n});").slice(start.length);
  const homedir = () => env.HOME, tmpdir = () => env.TMPDIR;
  const defaultStateDir = compile(between(source("server/update-state.ts"), "export function defaultStateDir", "/** One update state"), {
    process: { env }, homedir, ...paths,
  }, "defaultStateDir");
  return compile(`function run() { ${body} }`, {
    expect, temporary: () => paths.join(env.TMPDIR, "owner-unit-fiction"), controlledEnvironment: environment,
    process: { env }, homedir, tmpdir, defaultStateDir, ...paths,
  }, "run");
}

for (const platform of ["posix", "win32"] as const) {
  test(`the exact owner assertion accepts the controlled sibling roots on ${platform}`, () => {
    expect(ownerRootAssertion(platform)).not.toThrow();
  });
  test(`the exact owner assertion rejects a socket beneath TMPDIR on ${platform}`, () => {
    const paths = platform === "win32" ? win32 : posix;
    const root = platform === "win32" ? "C:\\fiction\\motoko-proof-parent" : "/fiction/motoko-proof-parent";
    expect(ownerRootAssertion(platform, { HERDR_SOCKET: paths.join(root, "tmp", "wrong.sock") })).toThrow();
  });
}
