import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";

export function controlledEnvironment(root: string): Record<string, string> {
  const tools = ["bun", "node", "herdr"].map(name => Bun.which(name)).filter((path): path is string => path !== null);
  if (!tools.some(path => /^bun(?:\.exe)?$/i.test(basename(path)))) throw new Error("Bun is required");
  for (const name of ["home", "config", "data", "state", "cache", "tmp", "herdr-state"]) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  const home = join(root, "home");
  const systemRoot = process.platform === "win32" ? process.env["SystemRoot"] : undefined;
  const systemPaths = systemRoot ? [systemRoot, join(systemRoot, "System32"), join(systemRoot, "System32", "WindowsPowerShell", "v1.0")] : ["/usr/bin", "/bin"];
  const env: Record<string, string> = {
    PATH: [...new Set(tools.map(dirname)), ...systemPaths].join(delimiter), HOME: home,
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"), TMPDIR: join(root, "tmp"), HERDR_WEB_STATE_DIR: join(root, "herdr-state"),
    CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"), HERMES_HOME: join(home, ".hermes"),
    GROK_HOME: join(home, ".grok"), OPENCODE_DB: join(home, "opencode.db"),
    HERDR_SOCKET: join(root, "config/herdr/sessions/herdr-web-ui-test/herdr.sock"),
    LANG: "C.UTF-8", TZ: "UTC", HOST: "127.0.0.1", HERDR_TEST_MODE: process.env["HERDR_TEST_MODE"] === "integration" ? "integration" : "unit",
  };
  if (process.platform === "win32") {
    Object.assign(env, { USERPROFILE: home, APPDATA: join(root, "config"), LOCALAPPDATA: join(root, "data"), TEMP: join(root, "tmp"), TMP: join(root, "tmp") });
    if (systemRoot) Object.assign(env, { SystemRoot: systemRoot, COMSPEC: join(systemRoot, "System32", "cmd.exe") });
  }
  const chrome = Bun.which(process.env["CHROME_PATH"] || "chromium") || (existsSync("/opt/google/chrome/chrome") ? "/opt/google/chrome/chrome" : null);
  if (chrome) env["CHROME_PATH"] = resolve(chrome);
  return env;
}

export async function runControlled(argv: string[]): Promise<number> {
  if (process.env["HERDR_TEST_LIVE"] === "1") { console.error("Refuse HERDR_TEST_LIVE=1"); return 2; }
  if (argv.length === 0) throw new Error("Supply a command");
  const root = mkdtempSync(join(tmpdir(), "motoko-proof-"));
  const env = controlledEnvironment(root);
  try {
    const child = Bun.spawn(argv, { env, cwd: process.cwd(), stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    return await child.exited;
  } finally {
    const herdr = Bun.which("herdr", { PATH: env["PATH"] });
    if (herdr) Bun.spawnSync([herdr, "--session", "herdr-web-ui-test", "server", "stop"], { env, stdout: "ignore", stderr: "ignore", timeout: 5000 });
    rmSync(root, { recursive: true, force: true });
  }
}

export function syntheticServerOptions(root: string): NonNullable<Parameters<typeof import("../server/index.ts").createServer>[0]> {
  const { UsageService } = require("../server/usage.ts") as typeof import("../server/usage.ts");
  const { UsageLoginService } = require("../server/usage-login.ts") as typeof import("../server/usage-login.ts");
  const { VoiceService } = require("../server/voice.ts") as typeof import("../server/voice.ts");
  const { CLIProxyService } = require("../server/cliproxy.ts") as typeof import("../server/cliproxy.ts");
  const { TailnetIdentitySource } = require("../server/tailscale.ts") as typeof import("../server/tailscale.ts");
  const home = join(root, "home"), stateDir = join(root, "herdr-state");
  mkdirSync(home, { recursive: true, mode: 0o700 }); mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const refusingFetch = async (): Promise<Response> => { syntheticNetworkCalls++; throw new Error("Synthetic service refuses network access"); };
  const context: import("../server/usage.ts").UsageContext = { home, env: {}, platform: process.platform, fetch: refusingFetch, keychain: async () => ({ status: "missing" }), run: async () => null, now: Date.now };
  return { hostname: "127.0.0.1", port: 0, token: "", stateDir, tailscaleOwner: null, tailnet: new TailnetIdentitySource(async () => null),
    usage: new UsageService(context, []), usageLogin: new UsageLoginService(home, { PATH: "" }, context),
    voice: new VoiceService({ stateDir, env: {}, fetch: refusingFetch }), cliProxy: new CLIProxyService(stateDir),
    codexHome: join(home, ".codex"), grokHome: join(home, ".grok"), hermesHome: join(home, ".hermes"),
    opencodeDb: join(home, "opencode.db"), devinDbPath: join(home, "devin.db"), machines: false, registerBridge: false,
    herdrProfiles: async () => [], terminalAttach: false, sidecar: false };
}
export let syntheticNetworkCalls = 0;

if (import.meta.main) process.exitCode = await runControlled(process.argv.slice(2));
