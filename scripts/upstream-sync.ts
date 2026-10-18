import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO = "Ecko95/herdr-web-ui";
const UPSTREAM = "devswha/herdr-web-ui";
const PREFIX = "automation/upstream-main-";
export const CONFLICT_FILE = ".github/upstream-sync-conflicts.json";
const START = "<!-- upstream-sync:start -->";
const END = "<!-- upstream-sync:end -->";
const SHA = /^[a-f0-9]{40}$/;
const BRANCH = /^automation\/upstream-main-[a-f0-9]{12,40}$/;
export interface Pull {
  number: number; state: "open" | "closed"; merged_at: string | null; draft: boolean; body: string | null;
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string };
}
export interface Plan {
  base: string; mergeBase: string; upstream: string; head: string;
  changed: string[]; overlaps: string[]; motoko: string[];
  conflicts: { phase: "base" | "upstream"; paths: string[] }[];
}
export type Gh = (args: string[], input?: string) => string;
type Git = (args: string[]) => string;
const quote = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll("`", "&#96;").replaceAll("[", "&#91;").replaceAll("]", "&#93;").replaceAll("\r", "\\r").replaceAll("\n", "\\n");
const lines = (paths: string[]) => paths.length ? paths.map((p) => `- <code>${quote(p)}</code>`).join("\n") : "None.";

function gitResult(cwd: string, args: string[], authenticated = false) {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "0" };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GIT_CONFIG_PARAMETERS;
  if (authenticated) {
    const token = process.env.GH_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN is absent.");
    Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` });
  }
  return spawnSync("git", ["-C", cwd, "-c", `core.hooksPath=${devNull}`, "-c", "commit.gpgsign=false", "-c", "rerere.enabled=false",
    "-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", ...args],
  { encoding: "utf8", env, maxBuffer: 32 * 1024 * 1024 });
}
function git(cwd: string, args: string[], authenticated = false): string {
  const result = gitResult(cwd, args, authenticated);
  if (result.status !== 0) throw new Error(`Git ${args[0]} failed (exit ${result.status ?? "unknown"}).`);
  return result.stdout.trimEnd();
}
const paths = (cwd: string, from: string, to: string) => git(cwd, ["diff", "--name-only", "--no-renames", "-z", from, to]).split("\0").filter(Boolean);
function ordinaryReport(cwd: string) {
  for (const path of [".github", CONFLICT_FILE]) {
    const full = join(cwd, path);
    let stat;
    try { stat = lstatSync(full); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink() || (path === ".github" ? !stat.isDirectory() : !stat.isFile())) throw new Error("The conflict report path must be ordinary.");
  }
}

/** Operates only on a disposable, clean worktree; it executes no candidate code. */
export function prepare(cwd: string, base: string, upstream: string): Plan {
  if (!SHA.test(base) || !SHA.test(upstream)) throw new Error("Invalid commit ID.");
  if (git(cwd, ["status", "--porcelain"])) throw new Error("The candidate worktree must be clean.");
  ordinaryReport(cwd);
  const mergeBase = git(cwd, ["merge-base", base, upstream]);
  const changed = paths(cwd, mergeBase, upstream);
  const forkPaths = new Set(paths(cwd, mergeBase, base));
  const result: Plan = { base, upstream, mergeBase, head: "", changed, overlaps: changed.filter((p) => forkPaths.has(p)),
    motoko: changed.filter((p) => /^(src|server|shared|scripts|patches|public|\.github)\//.test(p)
      || /^(package\.json|bun\.lock|herdr-plugin\.toml|index\.html)$/.test(p)), conflicts: [] };
  for (const [phase, target] of [["base", base], ["upstream", upstream]] as const) {
    const merged = gitResult(cwd, ["merge", "--no-edit", "--no-ff", target]);
    if (merged.status === 0) continue;
    const unmerged = git(cwd, ["diff", "--name-only", "--diff-filter=U", "-z"]).split("\0").filter(Boolean);
    if (!unmerged.length) throw new Error(`Git merge failed without conflict paths (${phase}).`);
    git(cwd, ["merge", "--abort"]);
    result.conflicts.push({ phase, paths: unmerged });
    break;
  }
  ordinaryReport(cwd);
  const report = join(cwd, CONFLICT_FILE);
  if (result.conflicts.length) {
    const content = JSON.stringify({ base, upstream, conflicts: result.conflicts }, null, 2) + "\n";
    mkdirSync(dirname(report), { recursive: true });
    if (!existsSync(report) || readFileSync(report, "utf8") !== content) {
      writeFileSync(report, content);
      git(cwd, ["add", "--", CONFLICT_FILE]);
      git(cwd, ["commit", "-m", "chore: report incomplete upstream integration"]);
    }
  } else if (existsSync(report)) {
    git(cwd, ["rm", "--", CONFLICT_FILE]);
    git(cwd, ["commit", "-m", "chore: clear resolved upstream conflict report"]);
  }
  result.head = git(cwd, ["rev-parse", "HEAD"]);
  return result;
}

export function selectPull(rows: unknown[], upstream: string): { open?: Pull; suppressed: boolean; previousUpstream?: string } {
  if (!Array.isArray(rows) || !SHA.test(upstream)) throw new Error("Malformed PR response.");
  const selected: Pull[] = [];
  for (const raw of rows) {
    const p = raw as Pull;
    if (!p || typeof p.head?.ref !== "string" || typeof p.base?.ref !== "string") throw new Error("Malformed PR response.");
    if (!p.head.ref.startsWith(PREFIX) || p.base.ref !== "main") continue;
    if (p.head.repo?.full_name !== REPO) throw new Error("A foreign repository uses the automation branch prefix.");
    if (!BRANCH.test(p.head.ref) || !Number.isSafeInteger(p.number) || p.number < 1 || !SHA.test(p.head.sha)
      || !["open", "closed"].includes(p.state) || typeof p.draft !== "boolean" || (p.body !== null && typeof p.body !== "string")) throw new Error("Malformed automation PR.");
    selected.push(p);
  }
  const open = selected.filter((p) => p.state === "open");
  if (open.length > 1) throw new Error("Multiple open upstream update PRs require human review.");
  const previous = open[0] ?? selected.find((p) => p.merged_at);
  const previousUpstream = previous?.body?.match(/<!-- upstream-sync-upstream:([a-f0-9]{40}) -->/)?.[1];
  return { open: open[0], previousUpstream, suppressed: selected.some((p) => p.state === "closed" && !p.merged_at && upstream.startsWith(p.head.ref.slice(PREFIX.length))) };
}

export function checkSnapshot(raw: unknown, head: string): string {
  const data = raw as { headRefOid?: string; statusCheckRollup?: Record<string, unknown>[] };
  if (!data || typeof data.headRefOid !== "string" || !Array.isArray(data.statusCheckRollup)) return "UNKNOWN: the check response is unavailable or malformed.";
  if (data.headRefOid !== head) return `STALE: checks name another head (${quote(data.headRefOid)}).`;
  if (!data.statusCheckRollup.length) return "NOT RUN: no checks exist for this head. Approve the PR workflows after source review.";
  return data.statusCheckRollup.map((c) => {
    if (!c || typeof c !== "object") return "- UNKNOWN: malformed check record.";
    const name = typeof c.name === "string" ? c.name : typeof c.context === "string" ? c.context : "Unknown check";
    const state = typeof c.status === "string" && c.status !== "COMPLETED" ? c.status
      : typeof c.conclusion === "string" && c.conclusion ? c.conclusion : typeof c.state === "string" ? c.state : "UNKNOWN";
    const url = c.detailsUrl || c.targetUrl;
    const link = typeof url === "string" && /^https:\/\/github\.com\//.test(url) ? ` (${quote(url)})` : "";
    return `- ${quote(name)}: ${quote(String(state))}${link}`;
  }).join("\n");
}

export function renderReport(plan: Plan, checks: string, oldBody: string, runUrl: string, compact = false): string {
  const display = (paths: string[]) => compact && paths.length ? `${paths.length} paths. See the complete workflow report artifact.` : lines(paths);
  const start = oldBody.indexOf(START), end = oldBody.indexOf(END);
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) throw new Error("Malformed automation report boundary.");
  const report = `${START}
<!-- upstream-sync-upstream:${plan.upstream} -->
## Upstream update

${plan.conflicts.length ? "INCOMPLETE: source integration has conflicts. Do not merge this report-only draft." : "Source integration is complete. Human review and required checks still apply."}

Fork base: ${plan.base}
Upstream merge base: ${plan.mergeBase}
Upstream head: ${plan.upstream}
Candidate head: ${plan.head}
Upstream range: https://github.com/${UPSTREAM}/compare/${plan.mergeBase}...${plan.upstream}
Workflow run and complete report artifact: ${quote(runUrl)}

### Upstream changed paths

${display(plan.changed)}

### Fork and upstream overlap paths

${display(plan.overlaps)}

### Motoko review paths

${display(plan.motoko)}

This conservative set includes shared application and CI paths. It does not prove that other paths cannot affect Motoko.

### Conflicts

${plan.conflicts.length ? plan.conflicts.map((c) => `Phase: ${c.phase}\n${display(c.paths)}`).join("\n") : "None."}

Resolve the named merge on this same PR branch. Keep human fixes in ordinary commits.
The next run preserves those commits. Mark the draft ready only after complete integration and source review.

### Actual checks

Snapshot head: ${plan.head}
Snapshot time: ${new Date().toISOString()}
${checks}

GITHUB_TOKEN PR runs require human approval. A successful push does not mean CI passed.
The live PR checks remain the current source after this snapshot.
${END}`;
  return start === -1 ? `${oldBody}${oldBody ? "\n\n" : ""}${report}` : oldBody.slice(0, start) + report + oldBody.slice(end + END.length);
}

export function publish(plan: Plan, branch: string, current: Pull | undefined, gh: Gh, push: Git, runUrl: string, saveReport: (body: string) => void = () => {}): void {
  if (!BRANCH.test(branch) || !SHA.test(plan.head)) throw new Error("Invalid publication target.");
  if (current && (current.head.ref !== branch || current.head.repo.full_name !== REPO)) throw new Error("PR publication target mismatch.");
  const report = (checks: string, prior: string) => {
    const full = renderReport(plan, checks, prior, runUrl);
    saveReport(full);
    const body = full.length > 60000 ? renderReport(plan, checks, prior, runUrl, true) : full;
    if (body.length > 60000) throw new Error("Human notes and conflict details exceed the PR limit; inspect the complete report artifact.");
    return body;
  };
  const initial = report("NOT RUN: this run has no observed checks yet.", current?.body ?? "");
  push(["push", "origin", `${plan.head}:refs/heads/${branch}`]);
  let pr = current;
  if (!pr) {
    pr = JSON.parse(gh(["api", "--method", "POST", `repos/${REPO}/pulls`, "--input", "-"], JSON.stringify({
      title: "chore: review upstream main update", head: branch, base: "main", draft: plan.conflicts.length > 0,
      body: initial,
    }))) as Pull;
    if (!Number.isSafeInteger(pr?.number) || pr.number < 1) throw new Error("Malformed PR creation response.");
  }
  if (plan.conflicts.length && !pr.draft) gh(["pr", "ready", String(pr.number), "--undo", "--repo", REPO]);
  let checks: string;
  try { checks = checkSnapshot(JSON.parse(gh(["pr", "view", String(pr.number), "--repo", REPO, "--json", "headRefOid,statusCheckRollup"])), plan.head); }
  catch { checks = "UNKNOWN: the check query failed. Inspect the live PR checks."; }
  const body = report(checks, current?.body ?? "");
  gh(["api", "--method", "PATCH", `repos/${REPO}/pulls/${pr.number}`, "--input", "-"], JSON.stringify({ body }));
}

function gh(args: string[], input?: string): string {
  const result = spawnSync("gh", args, { encoding: "utf8", input, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error("GitHub request failed. Check Actions PR creation policy and the workflow permissions; no credential fallback follows.");
  return result.stdout;
}

type Remote = (args: string[], authenticated: boolean) => { status: number | null; stdout: string };

/** The remote boundary permits local fixture proof without a push or GitHub side effect. */
export function synchronize(root: string, gh: Gh, remote: Remote, runUrl: string, saveReport: (body: string) => void): void {
  const network = (args: string[], authenticated: boolean) => {
    const result = remote(args, authenticated);
    if (result.status !== 0) throw new Error(`Remote Git ${args[0]} failed (exit ${result.status ?? "unknown"}).`);
    return result.stdout;
  };
  const parent = mkdtempSync(join(tmpdir(), "upstream-sync-"));
  const candidate = join(parent, "candidate");
  try {
    network(["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"], true);
    network(["fetch", "--no-tags", `https://github.com/${UPSTREAM}.git`, "refs/heads/main:refs/remotes/upstream/main"], false);
    const base = git(root, ["rev-parse", "refs/remotes/origin/main"]);
    const upstream = git(root, ["rev-parse", "refs/remotes/upstream/main"]);
    const pages = JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${REPO}/pulls?state=all&base=main&sort=updated&direction=desc&per_page=100`]));
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error("Malformed PR pagination.");
    const selection = selectPull(pages.flat(), upstream);
    if (!selection.open && (selection.suppressed || gitResult(root, ["merge-base", "--is-ancestor", upstream, base]).status === 0)) {
      console.log(selection.suppressed ? "A closed PR suppresses this upstream revision." : "No upstream update is necessary.");
    } else {
      const current = selection.open;
      const branch = current?.head.ref ?? `${PREFIX}${upstream.slice(0, 12)}`;
      // A prior run can push successfully before PR creation fails under repository policy.
      const remoteBranch = remote(["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`], true);
      if (remoteBranch.status !== 0 && remoteBranch.status !== 2) throw new Error("Cannot inspect the update branch.");
      const exists = remoteBranch.status === 0;
      if (current && !exists) throw new Error("The open PR branch is absent.");
      if (exists) network(["fetch", "--no-tags", "origin", `refs/heads/${branch}:refs/remotes/origin/upstream-sync-head`], true);
      const head = exists ? git(root, ["rev-parse", "refs/remotes/origin/upstream-sync-head"]) : base;
      if (current && head !== current.head.sha) throw new Error("The PR head changed during preparation; retry from a fresh run.");
      const prior = selection.previousUpstream;
      if (prior && gitResult(root, ["merge-base", "--is-ancestor", prior, upstream]).status !== 0) throw new Error("The recorded upstream history changed or is unavailable; human review is required.");
      git(root, ["worktree", "add", "--detach", candidate, head]);
      const plan = prepare(candidate, base, upstream);
      publish(plan, branch, current, gh, (args) => network(args, true), runUrl, saveReport);
    }
  } finally {
    if (existsSync(candidate)) git(root, ["worktree", "remove", "--force", candidate]);
    rmSync(parent, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.env.GITHUB_REPOSITORY !== REPO || process.env.GITHUB_REF !== "refs/heads/main"
    || !["schedule", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME ?? "")) throw new Error("This workflow requires the fork main branch and an allowed event.");
  if (!process.env.RUNNER_TEMP || !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? "")) throw new Error("The workflow run context is absent.");
  const root = resolve(process.cwd());
  synchronize(root, gh, (args, authenticated) => gitResult(root, args, authenticated),
    `https://github.com/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    (body) => writeFileSync(join(process.env.RUNNER_TEMP!, "upstream-sync-report.md"), body));
}
