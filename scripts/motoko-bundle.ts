/** Build a local non-Git app payload. Run only through motoko-env.ts, before activation. */
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const source = resolve(arg("source") ?? join(import.meta.dir, ".."));
const outputArg = arg("out");
if (!outputArg) throw new Error("Use --out=<private-payload-root> [--source=<verified-source>]");
const output = resolve(outputArg);
if (existsSync(output)) throw new Error("Bundle output must not exist");
if (!process.env.HOME?.includes("motoko-proof-")) throw new Error("Use the controlled runner");
if (!existsSync(join(source, "dist/index.html"))) throw new Error("Build the verified client first");
mkdirSync(output, { recursive: true, mode: 0o700 });
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const excluded = (path: string) => /(?:\.test\.ts|\.fixture\.ts|\.fake\.(?:ts|mjs))$/.test(path) || path.includes("/fixtures/") || path.endsWith("/fixtures");
for (const name of ["server", "shared", "dist", "patches"]) cpSync(join(source, name), join(output, name), { recursive: true, dereference: false, filter: (path) => !excluded(path) });
for (const name of ["package.json", "bun.lock", "bunfig.toml", "LICENSE", "THIRD_PARTY_NOTICES.md", "CHANGELOG.md", "release-summaries.json", "herdr-plugin.toml"]) {
  if (existsSync(join(source, name))) cpSync(join(source, name), join(output, name));
}
mkdirSync(join(output, "scripts"));
for (const name of ["plugin.ts", "plugin-port.ts", "plugin-runtime.ts"]) cpSync(join(source, "scripts", name), join(output, "scripts", name));
const install = Bun.spawnSync([process.execPath, "install", "--production", "--frozen-lockfile", "--ignore-scripts"], { cwd: output, env: process.env, stdout: "pipe", stderr: "pipe" });
if (install.exitCode !== 0) throw new Error(install.stderr.toString());
if (hash(join(output, "bun.lock")) !== hash(join(source, "bun.lock"))) throw new Error("Lockfile changed");
const entries: { path: string; type: "file" | "symlink"; sha256?: string; target?: string; mode: number; bytes?: number }[] = [];
function walk(path: string): void {
  for (const name of readdirSync(path).sort()) {
    const file = join(path, name), info = lstatSync(file), key = relative(output, file);
    if (name === ".git") throw new Error("Git metadata entered the payload");
    if (info.isSymbolicLink()) {
      const target = realpathSync(file);
      if (!target.startsWith(output + "/")) throw new Error(`External dependency link: ${key}`);
      entries.push({ path: key, type: "symlink", target: readlinkSync(file), mode: info.mode & 0o777 });
    } else if (info.isDirectory()) walk(file);
    else if (info.isFile()) entries.push({ path: key, type: "file", sha256: hash(file), mode: info.mode & 0o777, bytes: info.size });
    else throw new Error(`Unsupported bundle member: ${key}`);
  }
}
walk(output);
const digest = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
writeFileSync(output + ".manifest.json", JSON.stringify({ source, output, digest, files: entries, sourceLockSha256: hash(join(source, "bun.lock")), platform: `${process.platform}-${process.arch}`, runtime: { bun: Bun.version, bunExecutable: realpathSync(process.execPath), bunSha256: hash(realpathSync(process.execPath)), node: Bun.which("node"), herdr: Bun.which("herdr"), curl: "/usr/bin/curl" }, includes: ["runtime server/shared", "built dist", "plugin lifecycle", "production dependencies", "patches", "lock and package", "license and release metadata"], excludes: ["Git metadata", "private state/config", "control documents/evidence", "source client/designs", "test files/fixtures", "development dependencies"], startup: "bun scripts/plugin.ts start", installDuringActivation: false }, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ digest, files: entries.length, bytes: entries.reduce((n, e) => n + (e.bytes ?? 0), 0), output }));
