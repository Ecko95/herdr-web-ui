import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { OwnerStore } from "./motoko-owner.ts";
import { ownerStartupRequired, requirePrivateReadiness, requireOwnerRelease, writeOwnerLauncher, readOwnerLauncher, writeReadiness, readReadiness, clearReadiness, readinessPath } from "./readiness.ts";

test("owner readiness selects explicit mode and fails closed without stable platform identity", () => {
  expect(ownerStartupRequired({})).toBe(false);
  expect(ownerStartupRequired({HERDR_WEB_OWNER_ORIGIN:"http://localhost"})).toBe(true);
  expect(() => requirePrivateReadiness("win32")).toThrow("unsupported");
  expect(() => requirePrivateReadiness("darwin")).toThrow("unsupported");
  expect(() => requirePrivateReadiness("linux")).not.toThrow();
  expect(() => requireOwnerRelease(tmpdir())).toThrow("private readiness support");
});

test.skipIf(process.platform !== "linux")("private readiness rejects stale identities, mismatched nonces, foreign scope, and public files", async () => {
  const root = mkdtempSync(join(tmpdir(), "private-ready-unit-")), nonce = randomUUID(), file = join(root,"server.pid"), port = 12345;
  const child = Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"], {stdout:"ignore",stderr:"ignore"});
  try {
    const launcher = writeOwnerLauncher(file, process.ppid, nonce);
    writeReadiness(root,port,root,nonce,randomUUID(),process.ppid,child.pid);
    const path = readinessPath(root,port,root), valid = readFileSync(path,"utf8");
    expect(readReadiness(root,port,root,launcher)?.bridge.pid).toBe(child.pid);
    expect(statSync(path).mode & 0o777).toBe(0o600); expect(statSync(join(path,"..")).mode & 0o777).toBe(0o700);
    for (const change of [
      (v: ReturnType<typeof JSON.parse>) => { v.bridge.startedAt++; },
      (v: ReturnType<typeof JSON.parse>) => { v.supervisor.startedAt++; },
      (v: ReturnType<typeof JSON.parse>) => { v.launcher.startedAt++; },
      (v: ReturnType<typeof JSON.parse>) => { v.nonce = randomUUID(); },
      (v: ReturnType<typeof JSON.parse>) => { v.root += "/foreign"; },
      (v: ReturnType<typeof JSON.parse>) => { v.port++; },
      (v: ReturnType<typeof JSON.parse>) => { v.bridge = v.launcher; },
    ]) {
      const value = JSON.parse(valid); change(value); writeFileSync(path,JSON.stringify(value));
      expect(readReadiness(root,port,root,launcher)).toBeNull();
    }
    writeFileSync(path,valid);
    chmodSync(path, 0o644); expect(readReadiness(root,port,root,launcher)).toBeNull(); chmodSync(path, 0o600);
    clearReadiness(root,port,root,randomUUID()); expect(existsSync(path)).toBe(true);
    child.kill(); await child.exited; expect(readReadiness(root,port,root,launcher)).toBeNull();
    clearReadiness(root,port,root,nonce); expect(existsSync(path)).toBe(false);
    writeFileSync(file,JSON.stringify({...launcher,startedAt:launcher.startedAt+1})); expect(readOwnerLauncher(file)).toBeNull();
    writeFileSync(file,"malformed"); expect(readOwnerLauncher(file)).toBeNull();
  } finally { if (child.exitCode === null) child.kill(); await child.exited; rmSync(root,{recursive:true,force:true}); }
});


test("a persistence fault notifies readiness synchronously after owner admission closes",()=>{
  const root=mkdtempSync(join(tmpdir(),"ready-fault-"));let notified=false;
  const store=new OwnerStore({rpId:"localhost",origin:"http://localhost"},root,{write:()=>{throw new Error("synthetic write fault")},onFault:()=>{notified=true;expect(store.fault).toBe(true)}});
  try {expect(()=>store.revokeSession("fiction-session")).toThrow("owner_store_unavailable");expect(notified).toBe(true);expect(store.fault).toBe(true);}
  finally {store.close();rmSync(root,{recursive:true,force:true});}
});
