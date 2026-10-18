import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { runCommand } from "./updater.ts";

/** A child the test drives: Node sets exitCode/signalCode in the same tick as waitpid, before "close". */
class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  own: string[] = [];
  kill(signal: string) { this.own.push(signal); return true; }
  exit(code: number | null, signal: NodeJS.Signals | null = null) { this.exitCode = code; this.signalCode = signal; this.emit("exit", code, signal); }
  close(code: number | null) { this.emit("close", code); }
}

function run(options: { timeout?: number; signal?: AbortSignal } = {}) {
  const child = new FakeChild(), group: [number, string | number | undefined][] = [];
  const result = runCommand("/", ["git", "fetch"], options.signal, options.timeout ?? 60_000, {
    spawn: (() => child) as never,
    kill: ((pid: number, signal?: string | number) => { group.push([pid, signal]); return true; }) as never,
  });
  return { child, group, result };
}

describe("update command cancel (IC5)", () => {
  it("signals the group of a live child, then rejects on close", async () => {
    const controller = new AbortController(), { child, group, result } = run({ signal: controller.signal });
    controller.abort();
    expect(group).toEqual([[-4242, "SIGKILL"]]);
    child.exit(null, "SIGKILL"); child.close(null);
    await expect(result).rejects.toThrow("Update cancelled");
  });

  it("sends no signal after the leader exited, and still rejects", async () => {
    const controller = new AbortController(), { child, group, result } = run({ signal: controller.signal });
    child.exit(0);
    controller.abort();
    expect(group).toEqual([]); expect(child.own).toEqual([]);
    child.close(0);
    await expect(result).rejects.toThrow("Update cancelled");
  });

  it("sends no signal after the leader was signaled", async () => {
    const controller = new AbortController(), { child, group, result } = run({ signal: controller.signal });
    child.exit(null, "SIGTERM");
    controller.abort();
    expect(group).toEqual([]); expect(child.own).toEqual([]);
    child.close(null);
    await expect(result).rejects.toThrow("Update cancelled");
  });

  it("an abort between exit and close sends nothing and keeps the rejection", async () => {
    const controller = new AbortController(), { child, group, result } = run({ signal: controller.signal });
    child.exit(1);
    controller.abort();
    child.close(1);
    expect(group).toEqual([]);
    await expect(result).rejects.toThrow("Update cancelled");
  });

  it("a timeout between exit and close sends nothing and keeps the rejection", async () => {
    const { child, group, result } = run({ timeout: 10 });
    child.exit(0);
    // fixed wait: the 10 ms deadline must pass between exit and close, and it leaves no observable trace until close
    await Bun.sleep(30);
    child.close(0);
    expect(group).toEqual([]); expect(child.own).toEqual([]);
    await expect(result).rejects.toThrow("git timed out");
  });

  it("a live child that times out is signaled once", async () => {
    const { child, group, result } = run({ timeout: 10 });
    const deadline = Date.now() + 2000;
    while (group.length === 0) { if (Date.now() > deadline) throw new Error("no group signal"); await Bun.sleep(5); }
    expect(group).toEqual([[-4242, "SIGKILL"]]);
    child.exit(null, "SIGKILL"); child.close(null);
    await expect(result).rejects.toThrow("git timed out");
  });
});
