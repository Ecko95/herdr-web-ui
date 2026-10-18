/**
 * Test-only cleanup of a fixture process tree through pinned pidfds: never a numeric-PID signal, a process
 * group or a process scan. Each target is a birth identity (pid + startedAt) the test observed itself; it is
 * signalled only when the same birth still holds after its pidfd is open and its cwd lies under the fixture root.
 * Linux and glibc 2.36+ only (pidfd_open, pidfd_send_signal).
 */
import { dlopen, FFIType } from "bun:ffi";
import { readFileSync, readlinkSync } from "node:fs";
import { maintenanceQueryable, processIdentity, type ProcessIdentity } from "../server/readiness.ts";

let libc: ReturnType<typeof open> | null = null;
function open() {
  return dlopen("libc.so.6", {
    pidfd_open: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
    pidfd_send_signal: { args: [FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  }).symbols;
}
export const sameBirth = (target: ProcessIdentity) => maintenanceQueryable(target.pid) && processIdentity(target.pid)?.startedAt === target.startedAt;

/** The root and its live descendants, parents first, read only from the fixture processes' own child lists. */
export function fixtureTree(root: ProcessIdentity): ProcessIdentity[] {
  const tree: ProcessIdentity[] = [];
  const visit = (node: ProcessIdentity) => {
    if (!sameBirth(node) || tree.some(seen => seen.pid === node.pid)) return;
    tree.push(node);
    let children: string[] = [];
    try { children = readFileSync(`/proc/${node.pid}/task/${node.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean); } catch { /* exited */ }
    for (const child of children.map(Number)) {
      const identity = maintenanceQueryable(child) ? processIdentity(child) : null;
      if (identity) visit(identity);
    }
  };
  visit(root);
  return tree;
}

/** "sent" through a pidfd pinned to this exact birth, else "absent"; throws for a process outside the fixture root. */
export function signalPinned(target: ProcessIdentity, signal: 9 | 15, fixtureRoot: string): "sent" | "absent" {
  if (!sameBirth(target)) return "absent";
  libc ??= open();
  const fd = libc.pidfd_open(target.pid, 0);
  if (fd < 0) return "absent";
  try {
    if (!sameBirth(target)) return "absent"; // the pidfd may name a newer process with this PID
    const cwd = readlinkSync(`/proc/${target.pid}/cwd`);
    if (cwd !== fixtureRoot && !cwd.startsWith(fixtureRoot + "/")) throw new Error(`pid ${target.pid} is outside the fixture root (${cwd})`);
    return libc.pidfd_send_signal(fd, signal, null, 0) === 0 ? "sent" : "absent";
  } finally { libc.close(fd); }
}

/**
 * Ends the trees under `roots` (leaves first, SIGKILL) and waits for every member. Returns what it signalled and
 * what still lives at the end: the caller reports survivors, it never infers cleanup.
 */
export async function endFixtureTree(roots: (ProcessIdentity | null | undefined)[], fixtureRoot: string, timeoutMs = 10_000): Promise<{ signalled: ProcessIdentity[]; survivors: ProcessIdentity[] }> {
  const tree: ProcessIdentity[] = [], signalled: ProcessIdentity[] = [];
  for (const root of roots) if (root) for (const member of fixtureTree(root)) if (!tree.some(seen => seen.pid === member.pid)) tree.push(member);
  for (const member of [...tree].reverse()) if (signalPinned(member, 9, fixtureRoot) === "sent") signalled.push(member);
  const deadline = Date.now() + timeoutMs;
  while (tree.some(sameBirth) && Date.now() < deadline) await Bun.sleep(25);
  return { signalled, survivors: tree.filter(sameBirth) };
}
