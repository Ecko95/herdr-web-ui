import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Extract only the selected source boundaries; never import the server or launcher lifecycle.
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
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function pluginScenario(wait: "snapshot" | "connect", ownerMode = true) {
  let valid = true, writes = 0;
  const reached = deferred(), release = deferred();
  const client = source("server/herdr/client.ts");
  const rpc = between(client, "const DEFAULT_TIMEOUT_MS", "export async function ping(");
  const wrapper = between(client, "export async function pluginActionInvoke(", "export async function pluginLogList(");
  const pluginActionInvoke = compile(rpc + wrapper, { Bun: {
    async connect(options: any) {
      if (wait === "connect") { reached.resolve(); await release.promise; }
      const socket = { end() {}, write(frame: string) {
        writes++;
        options.socket.data(socket, new TextEncoder().encode(JSON.stringify({ id: JSON.parse(frame).id, result: { log: {} } }) + "\n"));
      } };
      return socket;
    },
  } }, "pluginActionInvoke");
  const index = source("server/index.ts");
  const route = between(index, '      if (pathname === "/api/plugin/action") {', "      const paneResponse =");
  const owner = ownerMode ? { current: () => valid ? { id: "fiction-owner" } : null } : null;
  const deps = {
    pathname: "/api/plugin/action", request: new Request("https://owner.example/api/plugin/action", { method: "POST", body: JSON.stringify({ plugin_id: "fiction", action_id: "fixture", pane_id: "fiction-pane" }) }),
    readJsonObject: (request: Request) => request.json(), badRequest: () => new Response(null, { status: 400 }),
    sessionSnapshot: async () => { if (wait === "snapshot") { reached.resolve(); await release.promise; } return { panes: [{ pane_id: "fiction-pane" }] }; },
    pluginPaneContext: (_snapshot: unknown, pane: unknown) => pane, pluginActionInvoke,
    jsonResponse: (value: unknown) => Response.json(value), waitForPluginAction: async () => ({ complete: true }),
    options: {}, PLUGIN_ACTION_WAIT_MS: 1, PLUGIN_LOG_LIMIT: 1, pluginLogList: async () => [], livePaneIds: async () => [],
    HerdrError: Error, errorResponse: () => new Response(null, { status: 401 }),
    checkOwner: () => { if (ownerMode && !valid) throw new Error("owner_required"); }, owner, ownerSession: ownerMode ? { id: "fiction-owner" } : null,
  };
  const execute = compile(`async function run() { ${route} }`, deps, "run");
  const result = execute();
  await reached.promise;
  valid = false;
  release.resolve();
  const response = await result;
  return { writes, status: response.status };
}

test("plugin action refuses owner revocation during snapshot wait", async () => {
  expect(await pluginScenario("snapshot")).toEqual({ writes: 0, status: 401 });
});
test("plugin action refuses owner revocation during fake connection wait", async () => {
  expect(await pluginScenario("connect")).toEqual({ writes: 0, status: 401 });
});
test("legacy plugin action retains the fake connection write", async () => {
  expect(await pluginScenario("connect", false)).toEqual({ writes: 1, status: 200 });
});

function selectState(contents: string, explicit?: string, verifiedOwner = false) {
  let queries = 0, ownerReads = 0;
  const plugin = source("scripts/plugin.ts");
  const selector = between(plugin, "const STATE_DIR =", "const CONFIG_DIR =");
  const pidIn = between(plugin, "function pidIn(", "/** names the keys");
  const selected = compile(pidIn + selector, {
    process: { env: { HERDR_PLUGIN_STATE_DIR: explicit }, kill() { queries++; } },
    existsSync: () => true, readFileSync: () => contents, join,
    DEFAULT_STATE_DIR: "/fiction/default", MANAGED_STATE_DIR: "/fiction/managed",
    readOwnerLauncher: () => { ownerReads++; return verifiedOwner ? { pid: 4242, startedAt: 1, nonce: "fiction" } : null; },
  }, "STATE_DIR");
  return { selected, queries, ownerReads };
}
test("verified owner launcher keeps the default directory beside an existing managed directory", () => {
  expect(selectState('{"pid":4242}', undefined, true)).toMatchObject({ selected: "/fiction/default", queries: 0, ownerReads: 1 });
});
test("numeric legacy launcher keeps the default directory", () => {
  expect(selectState("4242\n")).toMatchObject({ selected: "/fiction/default", queries: 1 });
});
test("explicit launcher directory wins without identity queries", () => {
  expect(selectState('{"pid":4242}', "/fiction/explicit", true)).toEqual({ selected: "/fiction/explicit", queries: 0, ownerReads: 0 });
});
test("invalid and stale owner records fall back to the managed directory", () => {
  for (const record of ["invalid", '{"pid":4242,"startedAt":1}']) {
    expect(selectState(record)).toMatchObject({ selected: "/fiction/managed", queries: 0 });
  }
});

// The exact media lifecycle runs against fake file metadata and an in-memory Blob only.
function mediaHarness() {
  let tokenCounter = 0, size = 1;
  const media = between(source("server/file-view.ts"), "export const PAGE_MEDIA_PATH", "/** A page's relative URL");
  const api = compile(media, {
    randomBytes: () => Buffer.alloc(24, ++tokenCounter),
    statSync: () => ({ isFile: () => true, dev: 1, ino: 2, size, mtimeMs: 3 }),
    realpathSync: (path: string) => path,
    Bun: { file: () => new Blob(["fiction media"], { type: "video/mp4" }) },
  }, "({pageMediaUrl, pageMediaResponse, forgetPageMedia, PAGE_MEDIA_PATH, PAGE_MEDIA_ROUTE, PAGE_MEDIA_LIFETIME_MS})");
  return { ...api, replaceFile: () => { size++; } };
}
async function mediaGate(api: any, token: string, ownerMode = true, suffix = "", method = "GET") {
  const path = api.PAGE_MEDIA_PATH + token + suffix;
  const index = source("server/index.ts");
  const gate = between(index, "      const mutating =", "      const bridgeAuthorized =");
  const deps = {
    owner: ownerMode ? { config: {}, match: () => null, handle: async () => undefined, denied: () => new Response(null, { status: 401 }) } : null,
    request: new Request("https://owner.example" + path, { method }), pathname: path, url: new URL("https://owner.example" + path),
    ownerRequestAllowed: () => true, disabledOwnerRoute: () => false,
    bunServer: { requestIP: () => ({ address: "192.0.2.1" }) }, authClient: () => "fiction-client",
    jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }),
    badRequest: () => new Response(null, { status: 400 }),
    handleAuthRequest: () => { throw new Error("unexpected auth route"); }, ownerError: (error: unknown) => { throw error; }, token: "",
    PAGE_MEDIA_ROUTE: api.PAGE_MEDIA_ROUTE, PAGE_MEDIA_PATH: api.PAGE_MEDIA_PATH, pageMediaResponse: api.pageMediaResponse,
  };
  return compile(`async function run() { ${gate} return pageMediaResponse(url.pathname.slice(PAGE_MEDIA_PATH.length), "fiction-client") ?? new Response(null, {status:404}); }`, deps, "run")();
}

test("owner media plays without a cookie through only the exact capability route", async () => {
  const api = mediaHarness();
  const token = api.pageMediaUrl("/fiction/movie.mp4", "video/mp4", { client: "fiction-client", device: null, owner: { sessionId: "fiction-owner", current: () => true } });
  const response = await mediaGate(api, token);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("fiction media");
  expect((await mediaGate(api, token, true, "/extra")).status).toBe(401);
  expect((await mediaGate(api, token, true, "", "POST")).status).toBe(400);
});
test("owner media refuses a grant after its creating session loses authority", () => {
  const api = mediaHarness();
  let valid = true;
  const token = api.pageMediaUrl("/fiction/movie.mp4", "video/mp4", { client: "fiction-client", device: null, owner: { sessionId: "fiction-owner", current: () => valid } });
  expect(api.pageMediaResponse(token, "fiction-client")).not.toBeNull();
  valid = false;
  expect(api.pageMediaResponse(token, "fiction-client")).toBeNull();
  valid = true;
  expect(api.pageMediaResponse(token, "fiction-client")).toBeNull();
});
test("owner media refuses expired grants and client mismatches", () => {
  const api = mediaHarness(), now = Date.now();
  const token = api.pageMediaUrl("/fiction/movie.mp4", "video/mp4", { client: "fiction-client", device: null, owner: { sessionId: "fiction-owner", current: () => true } }, now);
  expect(api.pageMediaResponse(token, "another-client", now)).toBeNull();
  expect(api.pageMediaResponse(token, "fiction-client", now + api.PAGE_MEDIA_LIFETIME_MS)).toBeNull();
});
test("invalid owner media tokens reveal no file", async () => {
  const api = mediaHarness();
  const response = await mediaGate(api, "A".repeat(32));
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("fiction media");
});
test("owner capability route refuses a legacy grant", async () => {
  const api = mediaHarness();
  const token = api.pageMediaUrl("/fiction/movie.mp4", "video/mp4", { client: "fiction-client", device: null });
  expect((await mediaGate(api, token)).status).toBe(404);
});
test("legacy media retains client, device, and file restrictions", async () => {
  const api = mediaHarness();
  const token = api.pageMediaUrl("/fiction/movie.mp4", "video/mp4", { client: "fiction-client", device: "fiction-device" });
  expect((await mediaGate(api, token, false)).status).toBe(200);
  expect(api.pageMediaResponse(token, "another-client")).toBeNull();
  api.forgetPageMedia({ device: "fiction-device" });
  expect(api.pageMediaResponse(token, "fiction-client")).toBeNull();
  const other = api.pageMediaUrl("/fiction/movie.mp4", "video/mp4", { client: "fiction-client", device: null });
  api.replaceFile();
  expect(api.pageMediaResponse(other, "fiction-client")).toBeNull();
});
test("the render binds media to its creating owner session after file lookup", () => {
  let valid = true;
  const index = source("server/index.ts");
  const render = between(index, "        const mediaSource =", "      // a rendered page's own video");
  const deps = {
    bridgeAuthorized: false, pageMediaSource: () => "https://owner.example/api/fs/page-media/", requestHost: "owner.example", isSecureRequest: () => true,
    request: new Request("https://owner.example/api/fs/file?render=1"), forwarded: false, client: "fiction-client", access: { level: "full" },
    owner: { current: (id: string) => valid && id === "fiction-owner" ? { id } : null }, ownerSession: { id: "fiction-owner" },
    checkOwner: () => { if (!valid) throw new Error("owner_required"); },
    found: { info: {} }, pathname: "/api/fs/file", url: new URL("https://owner.example/api/fs/file?render=1"), jsonResponse: Response.json,
    fileResponse: (_info: unknown, _download: boolean, _render: boolean, media: any) => media,
  };
  const media = compile(`function render() { ${render.slice(0, render.lastIndexOf("}"))} }`, deps, "render")();
  expect(media.owner?.sessionId).toBe("fiction-owner");
  expect(media.owner.current()).toBe(true);
  valid = false;
  expect(media.owner.current()).toBe(false);
  expect(source("server/file-view.ts")).toContain('"sandbox allow-scripts"');
  expect(source("server/file-view.ts")).not.toContain('"sandbox allow-scripts allow-same-origin"');
});

test("bundle copy list covers every copied script's local runtime imports", () => {
  const bundle = source("scripts/motoko-bundle.ts");
  const match = /for \(const name of (\[[^\n]+\])\) cpSync\(join\(source, "scripts", name\)/.exec(bundle);
  if (!match) throw new Error("Missing scripts copy list");
  const copied: string[] = JSON.parse(match[1]!);
  const missing: string[] = [];
  for (const name of copied) {
    const runtime = transpiler.transformSync(source(`scripts/${name}`));
    for (const imported of runtime.matchAll(/\bfrom ["'](\.\/[^"']+)["']/g)) {
      if (!copied.includes(imported[1]!.slice(2))) missing.push(`${name} -> ${imported[1]}`);
    }
  }
  expect(missing).toEqual([]);
});
