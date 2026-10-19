import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONFLICT_FILE, synchronize, prepare, selectPull, renderReport, checkSnapshot, publish, type Pull, type Gh } from "./upstream-sync.ts";

const made: string[] = [];
afterEach(() => { for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "upstream-sync-")); made.push(dir);
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", dir, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim();
  };
  const edit = (path: string, text: string) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  const commit = (path: string, text: string) => { edit(path, text); git("add", "--", path); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  git("init", "-q", "--initial-branch=main");
  const start = commit("shared.txt", "base\n");
  git("branch", "upstream");
  const base = commit("server/motoko.ts", "fork\n");
  git("switch", "-q", "upstream");
  const upstream = commit("src/change.ts", "upstream\n");
  git("switch", "-q", "main");
  return { dir, git, edit, commit, start, base, upstream };
}
const pull = (overrides: Partial<Pull> = {}): Pull => ({ number: 7, state: "open", merged_at: null, draft: false, body: "Human notes", head: { ref: "automation/upstream-main-aaaaaaaaaaaa", sha: "a".repeat(40), repo: { full_name: "Ecko95/herdr-web-ui" } }, base: { ref: "main" }, ...overrides });

describe("local merge preparation", () => {
  it("merges cleanly, retains both histories, and repeats without a commit", () => {
    const f = fixture(); const first = prepare(f.dir, f.base, f.upstream);
    expect(first.conflicts).toEqual([]);
    expect(f.git("merge-base", "--is-ancestor", f.base, "HEAD")).toBe("");
    expect(f.git("merge-base", "--is-ancestor", f.upstream, "HEAD")).toBe("");
    expect(readFileSync(join(f.dir, "server/motoko.ts"), "utf8")).toBe("fork\n");
    expect(prepare(f.dir, f.base, f.upstream).head).toBe(first.head);
    expect(first.changed).toEqual(["src/change.ts"]);
    expect(first.motoko).toEqual(["src/change.ts"]);
  });
  it("makes a report-only conflict commit, no markers, and no repeat commit", () => {
    const f = fixture(); f.git("switch", "-q", "upstream"); const upstream = f.commit("shared.txt", "theirs\n");
    f.git("switch", "-q", "main"); const base = f.commit("shared.txt", "ours\n");
    const result = prepare(f.dir, base, upstream);
    expect(result.conflicts).toEqual([{ phase: "upstream", paths: ["shared.txt"] }]);
    expect(f.git("diff", "--name-only", base, "HEAD")).toBe(CONFLICT_FILE);
    expect(readFileSync(join(f.dir, "shared.txt"), "utf8")).toBe("ours\n");
    expect(f.git("status", "--porcelain")).toBe("");
    expect(prepare(f.dir, base, upstream).head).toBe(result.head);
    // A human resolves this exact upstream merge on the existing branch.
    const merge = spawnSync("git", ["-C", f.dir, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "merge", "--no-commit", upstream], { encoding: "utf8" });
    expect(merge.status).toBe(1);
    expect(f.git("rev-parse", "MERGE_HEAD")).toBe(upstream);
    f.edit("shared.txt", "human fix\n"); f.git("add", "shared.txt"); f.git("commit", "-qm", "human fix");
    const fixed = f.git("rev-parse", "HEAD");
    expect(f.git("rev-list", "--parents", "-n", "1", fixed).split(" ").slice(1)).toEqual([result.head, upstream]);
    f.git("switch", "-q", "upstream"); const next = f.commit("later.txt", "later\n");
    f.git("switch", "--detach", "-q", fixed);
    const clean = prepare(f.dir, base, next);
    expect(clean.conflicts).toEqual([]);
    expect(f.git("merge-base", "--is-ancestor", fixed, "HEAD")).toBe("");
    expect(readFileSync(join(f.dir, "shared.txt"), "utf8")).toBe("human fix\n");
    expect(() => readFileSync(join(f.dir, CONFLICT_FILE))).toThrow();
  });
  it("records base conflicts without partial upstream integration", () => {
    const f = fixture(); const human = f.commit("shared.txt", "human\n");
    f.git("switch", "--detach", "-q", f.base); const base = f.commit("shared.txt", "main changed\n");
    f.git("switch", "--detach", "-q", human);
    const result = prepare(f.dir, base, f.upstream);
    expect(result.conflicts).toEqual([{ phase: "base", paths: ["shared.txt"] }]);
    expect(readFileSync(join(f.dir, "shared.txt"), "utf8")).toBe("human\n");
  });
  it("refuses dirty worktrees, unrelated history, and report symlinks", () => {
    const f = fixture(); f.edit("untracked", "keep");
    expect(() => prepare(f.dir, f.base, f.upstream)).toThrow("clean");
    rmSync(join(f.dir, "untracked"));
    f.git("switch", "-q", "--orphan", "unrelated"); f.commit("other", "other");
    const unrelated = f.git("rev-parse", "HEAD"); f.git("switch", "-q", "main");
    expect(() => prepare(f.dir, f.base, unrelated)).toThrow();
    mkdirSync(join(f.dir, ".github"), { recursive: true });
    symlinkSync(join(f.dir, "shared.txt"), join(f.dir, CONFLICT_FILE)); f.git("add", ".github"); f.git("commit", "-qm", "unsafe report path");
    expect(() => prepare(f.dir, f.base, f.upstream)).toThrow("ordinary");
  });
  it("does not execute candidate scripts or Git hooks", () => {
    const f = fixture();
    f.git("switch", "-q", "upstream");
    const upstream = f.commit("package.json", JSON.stringify({ scripts: { postinstall: "exit 99" } }));
    f.git("switch", "-q", "main");
    const hook = join(f.dir, ".git/hooks/pre-merge-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    expect(prepare(f.dir, f.base, upstream).conflicts).toEqual([]);
    expect(readFileSync(join(f.dir, "package.json"), "utf8")).toContain("exit 99");
  });
  it("reports overlap, deletion, and both rename paths", () => {
    const f = fixture(); f.git("switch", "-q", "upstream"); f.git("mv", "shared.txt", "renamed.txt"); f.git("commit", "-qm", "rename");
    const upstream = f.git("rev-parse", "HEAD"); f.git("switch", "-q", "main");
    const base = f.commit("shared.txt", "fork edit\n");
    const result = prepare(f.dir, base, upstream);
    expect(result.changed).toContain("shared.txt"); expect(result.changed).toContain("renamed.txt");
    expect(result.overlaps).toEqual(["shared.txt"]);
  });
});

describe("PR policy and report", () => {
  it("keeps one open PR and refuses ambiguous or foreign branches", () => {
    expect(selectPull([pull()], "a".repeat(40)).open?.number).toBe(7);
    expect(() => selectPull([pull(), pull({ number: 8 })], "a".repeat(40))).toThrow("Multiple");
    const foreign = pull(); foreign.head.repo.full_name = "other/fork";
    expect(() => selectPull([foreign], "a".repeat(40))).toThrow("foreign");
    expect(() => selectPull([{}], "a".repeat(40))).toThrow("Malformed");
  });
  it("respects a closed unmerged PR and permits a new cycle after a squash merge", () => {
    expect(selectPull([pull({ state: "closed" })], "a".repeat(40)).suppressed).toBe(true);
    expect(selectPull([pull({ state: "closed", merged_at: "2026-01-01T00:00:00Z" })], "b".repeat(40)).suppressed).toBe(false);
  });
  it("never calls missing checks success or attributes stale checks to a new head", () => {
    expect(checkSnapshot({ headRefOid: "a", statusCheckRollup: [] }, "a")).toContain("NOT RUN");
    expect(checkSnapshot({ headRefOid: "b", statusCheckRollup: [] }, "a")).toContain("STALE");
    expect(checkSnapshot({ headRefOid: "a", statusCheckRollup: [{ name: "Fast checks", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/check" }] }, "a")).toContain("FAILURE");
    expect(checkSnapshot({ headRefOid: "a", statusCheckRollup: [{ name: "Fast checks", status: "QUEUED", conclusion: "", detailsUrl: "https://github.com/check" }] }, "a")).toContain("QUEUED");
    expect(checkSnapshot({}, "a")).toContain("UNKNOWN");
    expect(checkSnapshot({ headRefOid: "a", statusCheckRollup: [null] }, "a")).toContain("UNKNOWN");
    expect(checkSnapshot({ headRefOid: "a", statusCheckRollup: [{ name: "Fast", status: "QUEUED", conclusion: "SUCCESS" }] }, "a")).toContain("QUEUED");
  });
  it("preserves human notes and escapes data in the report", () => {
    const f = fixture(); const plan = prepare(f.dir, f.base, f.upstream);
    plan.changed = ["src/<script>\n`bad`.ts"];
    const body = renderReport(plan, "NOT RUN", "Human notes", "https://github.com/Ecko95/herdr-web-ui/actions/runs/1");
    expect(body).toStartWith("Human notes"); expect(body).not.toContain("<script>"); expect(body).toContain("&lt;script&gt;");
    expect(renderReport(plan, "NOT RUN", body, "https://github.com/run").split("Human notes")).toHaveLength(2);
  });
  it("creates a conflict draft through a fake GitHub boundary without a network action", () => {
    const f = fixture(); const plan = prepare(f.dir, f.base, f.upstream);
    plan.conflicts = [{ phase: "upstream", paths: ["server/motoko.ts"] }];
    const calls: { args: string[]; input?: string }[] = [];
    const gh: Gh = (args, input) => {
      calls.push({ args, input });
      if (args.includes("POST")) return JSON.stringify(pull({ draft: true, body: JSON.parse(input!).body }));
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ headRefOid: plan.head, statusCheckRollup: [] });
      return "{}";
    };
    const pushes: string[][] = [];
    publish(plan, "automation/upstream-main-aaaaaaaaaaaa", undefined, gh, (args) => { pushes.push(args); return ""; }, "https://github.com/run");
    expect(pushes).toEqual([["push", "origin", `${plan.head}:refs/heads/automation/upstream-main-aaaaaaaaaaaa`]]);
    const created = JSON.parse(calls.find((c) => c.args.includes("POST"))!.input!);
    expect(created.draft).toBe(true); expect(created.base).toBe("main");
    expect(created.body).toContain("INCOMPLETE"); expect(created.body).toContain("server/motoko.ts");
    expect(JSON.parse(calls.find((c) => c.args.includes("PATCH"))!.input!).body).toContain("NOT RUN");
    expect(calls.some((c) => c.args.includes("workflow") || c.args.includes("merge"))).toBe(false);
  });
  it("preserves an existing draft, notes, and failed checks without another PR", () => {
    const f = fixture(); const plan = prepare(f.dir, f.base, f.upstream);
    const calls: { args: string[]; input?: string }[] = [];
    const gh: Gh = (args, input) => {
      calls.push({ args, input });
      if (args[0] === "pr") return JSON.stringify({ headRefOid: plan.head, statusCheckRollup: [{ name: "Motoko", conclusion: "FAILURE" }] });
      return "{}";
    };
    publish(plan, "automation/upstream-main-aaaaaaaaaaaa", pull({ draft: true }), gh, () => "", "https://github.com/run");
    expect(calls.some((c) => c.args.includes("POST") || c.args.includes("ready"))).toBe(false);
    const body = JSON.parse(calls.find((c) => c.args.includes("PATCH"))!.input!).body;
    expect(body).toStartWith("Human notes"); expect(body).toContain("FAILURE");
  });
  it("reports API failure as unknown and preserves a full large report artifact", () => {
    const f = fixture(); const plan = prepare(f.dir, f.base, f.upstream);
    plan.changed = Array.from({ length: 2000 }, (_, i) => `src/path-${i}-${"x".repeat(40)}`);
    let full = "", patch = "";
    const gh: Gh = (args, input) => {
      if (args[0] === "pr") throw new Error("unavailable");
      patch = JSON.parse(input!).body; return "{}";
    };
    publish(plan, "automation/upstream-main-aaaaaaaaaaaa", pull(), gh, () => "", "https://github.com/run", (body) => { full = body; });
    expect(full.length).toBeGreaterThan(60000); expect(full).toContain(plan.changed[1999]!);
    expect(patch.length).toBeLessThan(60000); expect(patch).toContain("2000 paths"); expect(patch).toContain("UNKNOWN");
  });
  it("refuses malformed report boundaries before a push", () => {
    const f = fixture(); const plan = prepare(f.dir, f.base, f.upstream);
    expect(() => publish(plan, "automation/upstream-main-aaaaaaaaaaaa", pull({ body: "<!-- upstream-sync:start -->" }), () => "", () => { throw new Error("unexpected push"); }, "https://github.com/run")).toThrow("boundary");
  });
  it("uses only an explicit ordinary branch push and stops on a concurrent update", () => {
    const f = fixture(); const plan = prepare(f.dir, f.base, f.upstream);
    const calls: string[][] = [];
    const git = (args: string[]) => { calls.push(args); throw new Error("non-fast-forward"); };
    const gh: Gh = () => { throw new Error("GitHub must not receive a request after a push rejection"); };
    expect(() => publish(plan, "automation/upstream-main-aaaaaaaaaaaa", undefined, gh, git, "https://github.com/run")).toThrow("non-fast-forward");
    expect(calls).toEqual([["push", "origin", `${plan.head}:refs/heads/automation/upstream-main-aaaaaaaaaaaa`]]);
  });
});

describe("workflow orchestration with fake network operations", () => {
  it("recovers a pushed branch without a PR and repeats an open PR without a new commit", () => {
    const f = fixture();
    const rootHead = f.git("rev-parse", "HEAD");
    let published = "", branch = "", existing: Pull | undefined;
    const writes: string[] = [];
    const remote = (args: string[]) => {
      if (args[0] === "fetch") {
        const ref = args[args.length - 1]!;
        if (ref.includes("origin/main")) f.git("update-ref", "refs/remotes/origin/main", f.base);
        else if (ref.includes("upstream/main")) f.git("update-ref", "refs/remotes/upstream/main", f.upstream);
        else f.git("update-ref", "refs/remotes/origin/upstream-sync-head", published);
      }
      if (args[0] === "ls-remote") return { status: published ? 0 : 2, stdout: published };
      if (args[0] === "push") { published = args[2]!.split(":")[0]!; branch = args[2]!.split("refs/heads/")[1]!; }
      return { status: 0, stdout: "" };
    };
    let refuseCreation = true;
    const gh: Gh = (args, input) => {
      if (args.includes("--paginate")) return JSON.stringify([existing ? [existing] : []]);
      if (args.includes("POST")) {
        if (refuseCreation) throw new Error("PR creation is disabled");
        existing = pull({ draft: false, body: JSON.parse(input!).body, head: { ref: branch, sha: published, repo: { full_name: "Ecko95/herdr-web-ui" } } });
        writes.push("create"); return JSON.stringify(existing);
      }
      if (args[0] === "pr") return JSON.stringify({ headRefOid: published, statusCheckRollup: [] });
      writes.push("update"); return "{}";
    };
    expect(() => synchronize(f.dir, gh, remote, "https://github.com/run", () => {})).toThrow("PR creation is disabled");
    const first = published; expect(first).not.toBe("");
    refuseCreation = false;
    synchronize(f.dir, gh, remote, "https://github.com/run", () => {});
    expect(published).toBe(first); expect(writes).toEqual(["create", "update"]);
    synchronize(f.dir, gh, remote, "https://github.com/run", () => {});
    expect(published).toBe(first); expect(writes).toEqual(["create", "update", "update"]);
    expect(f.git("rev-parse", "HEAD")).toBe(rootHead);
    expect(f.git("status", "--porcelain")).toBe("");
    expect(f.git("tag", "--list")).toBe("");
    expect(f.git("worktree", "list", "--porcelain").split("worktree ")).toHaveLength(2);
  });
  it("does nothing when main already includes upstream", () => {
    const f = fixture(); const plan = prepare(f.dir, f.base, f.upstream);
    f.git("update-ref", "refs/remotes/origin/main", plan.head); f.git("update-ref", "refs/remotes/upstream/main", f.upstream);
    const remote = (args: string[]) => {
      if (args[0] !== "fetch") throw new Error("Unexpected publication");
      return { status: 0, stdout: "" };
    };
    synchronize(f.dir, (args) => { expect(args).toContain("--paginate"); return "[[]]"; }, remote, "https://github.com/run", () => { throw new Error("Unexpected report"); });
  });
  it("stops before GitHub operations on fetch failure", () => {
    const f = fixture();
    expect(() => synchronize(f.dir, () => { throw new Error("Unexpected GitHub operation"); }, () => ({ status: 128, stdout: "" }), "https://github.com/run", () => {})).toThrow("Remote Git fetch failed");
  });
  it("stops on rewritten recorded upstream history without a push", () => {
    const f = fixture();
    f.git("update-ref", "refs/remotes/origin/main", f.base); f.git("update-ref", "refs/remotes/upstream/main", f.upstream);
    f.git("update-ref", "refs/remotes/origin/upstream-sync-head", f.base);
    const current = pull({ head: { ref: "automation/upstream-main-aaaaaaaaaaaa", sha: f.base, repo: { full_name: "Ecko95/herdr-web-ui" } }, body: `<!-- upstream-sync-upstream:${f.base} -->` });
    const remote = (args: string[]) => { if (args[0] === "push") throw new Error("Unexpected push"); return { status: 0, stdout: "" }; };
    expect(() => synchronize(f.dir, () => JSON.stringify([[current]]), remote, "https://github.com/run", () => {})).toThrow("history changed");
  });
});

describe("incomplete-integration CI guard", () => {
  it("refuses a report before Fast checks and permits a complete tree", () => {
    const workflow = readFileSync(join(import.meta.dir, "../.github/workflows/ci.yml"), "utf8");
    const start = workflow.indexOf("      - name: Require complete upstream integration");
    const end = workflow.indexOf("      - run: bun run check fast", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const script = workflow.slice(start, end).split("run: |\n")[1]!.split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");
    const f = fixture();
    const run = () => spawnSync("bash", ["-e", "-c", script], { cwd: f.dir, encoding: "utf8" });
    expect(run().status).toBe(0);
    f.edit(CONFLICT_FILE, "{}\n");
    expect(run().status).toBe(1);
    rmSync(join(f.dir, CONFLICT_FILE)); symlinkSync(join(f.dir, "absent"), join(f.dir, CONFLICT_FILE));
    expect(run().status).toBe(1);
  });
});
