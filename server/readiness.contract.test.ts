import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { updateStateDir } from "./update-state.ts";

const repo = resolve(import.meta.dir, "..");
test.skipIf(process.platform !== "linux" || process.env["HERDR_TEST_MODE"] !== "integration")("owner managed startup uses private readiness while public health stays redacted", async () => {
  const root = mkdtempSync(join(tmpdir(), "private-ready-contract-"));
  mkdirSync(join(root, "server"));
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!; reservation.stop(true);
  const state = join(root, "state");
  writeFileSync(join(root, "server", "readiness.ts"), "// synthetic supported release\n");
  writeFileSync(join(root, "server", "motoko-owner.ts"), "// real owner module is imported by the synthetic bridge\n");
  writeFileSync(join(root, "server", "index.ts"), `
    import {createServer} from ${JSON.stringify(join(repo, "server/index.ts"))};
    import {syntheticServerOptions} from ${JSON.stringify(join(repo, "scripts/motoko-env.ts"))};
    const server = createServer({...syntheticServerOptions(${JSON.stringify(root)}), stateDir: ${JSON.stringify(state)}, port: Number(process.env.PORT)});
    process.on("SIGTERM", () => {server.stop(); process.exit(0)});
    process.on("disconnect", () => {server.stop(); process.exit(0)});
  `);
  const child = Bun.spawn([process.execPath, "--eval", `import {runManaged} from ${JSON.stringify(join(repo, "server/managed.ts"))}; await runManaged(${JSON.stringify(root)});`], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), HERDR_WEB_STATE_DIR: state, HERDR_WEB_OWNER_RP_ID: "localhost", HERDR_WEB_OWNER_ORIGIN: "http://localhost" }, stdout: "ignore", stderr: "pipe",
  });
  const path = join(updateStateDir(root, port, state), "ready.json");
  try {
    const deadline = Date.now() + 4000;
    while (!existsSync(path) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(path)).toBe(true);
    const record = JSON.parse(readFileSync(path, "utf8"));
    expect(record.launcher.pid).toBe(child.pid); expect(record.owner).toBe(true);
    for (const scope of ["", "?scope=bridge"]) {
      const response = await fetch(`http://127.0.0.1:${port}/api/health${scope}`);
      expect(await response.json()).toEqual({ok:true,auth:{required:true,authenticated:false,reason:"owner_required",owner:{enrolled:false}}});
    }
  } finally {
    child.kill("SIGTERM"); await child.exited;
    const stderr = await new Response(child.stderr).text();
    if (child.exitCode !== 0) console.error(stderr);
    expect(existsSync(path)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);


for (const behavior of ["silent", "wrong-nonce", "dirty"] as const) {
  test.skipIf(process.platform !== "linux")(`owner supervisor rejects ${behavior} readiness without child cooperation`, async () => {
    const root = mkdtempSync(join(tmpdir(), "private-ready-deadline-")); mkdirSync(join(root,"server"));
    const reservation = Bun.serve({ hostname:"127.0.0.1",port:0,fetch:()=>new Response() }); const port = reservation.port!; reservation.stop(true);
    for (const file of ["readiness.ts","motoko-owner.ts"]) writeFileSync(join(root,"server",file),"// synthetic supported release\n");
    writeFileSync(join(root,"server/index.ts"), behavior === "silent" ? "setInterval(()=>{},1000);" : `
      process.send({type:"bridge-ready",protocol:1,owner:true,boot_id:${behavior === "wrong-nonce" ? '"00000000-0000-0000-0000-000000000000"' : 'process.env.HERDR_WEB_BOOT_ID'},port:Number(process.env.PORT),status:${JSON.stringify(behavior === "dirty" ? "failed" : "ready")}});
      setInterval(()=>{},1000);
    `);
    const child = Bun.spawn([process.execPath,"--eval",`import {runSupervisor} from ${JSON.stringify(join(repo,"server/supervisor.ts"))}; await runSupervisor(${JSON.stringify(root)},{startupTimeoutMs:150});`],{env:{...process.env,HOST:"127.0.0.1",PORT:String(port),HERDR_WEB_STATE_DIR:join(root,"state"),HERDR_WEB_OWNER_RP_ID:"localhost",HERDR_WEB_OWNER_ORIGIN:"http://localhost",HERDR_WEB_LAUNCHER_PID:String(process.pid),HERDR_WEB_LAUNCH_NONCE:crypto.randomUUID()},stdout:"ignore",stderr:"pipe"});
    try {
      const deadline = Date.now()+3000;
      while(child.exitCode===null && Date.now()<deadline) await Bun.sleep(20);
      expect(child.exitCode).toBe(1);
      expect(await new Response(child.stderr).text()).toContain("Owner bridge readiness failed");
      expect(existsSync(join(updateStateDir(root,port,join(root,"state")),"ready.json"))).toBe(false);
    } finally { if(child.exitCode===null) child.kill(); await child.exited; rmSync(root,{recursive:true,force:true}); }
  });
}


test.skipIf(process.platform!=="linux")("owner startup never executes a legacy bridge without private readiness support",async()=>{
  const root=mkdtempSync(join(tmpdir(),"owner-legacy-refusal-"));mkdirSync(join(root,"server"));
  const sentinel=join(root,"legacy-executed");writeFileSync(join(root,"server/index.ts"),`await Bun.write(${JSON.stringify(sentinel)},"unsafe legacy bridge executed");`);
  const reservation=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response()}),port=reservation.port!;reservation.stop(true);
  const child=Bun.spawn([process.execPath,"--eval",`import {runManaged} from ${JSON.stringify(join(repo,"server/managed.ts"))};await runManaged(${JSON.stringify(root)});`],{env:{...process.env,HOST:"127.0.0.1",PORT:String(port),HERDR_WEB_STATE_DIR:join(root,"state"),HERDR_WEB_OWNER_RP_ID:"localhost",HERDR_WEB_OWNER_ORIGIN:"http://localhost"},stdout:"ignore",stderr:"pipe"});
  try {
    expect(await child.exited).toBe(1);expect(existsSync(sentinel)).toBe(false);expect(await new Response(child.stderr).text()).toContain("Owner mode requires a release with private readiness support");
  } finally {if(child.exitCode===null)child.kill();await child.exited;rmSync(root,{recursive:true,force:true});}
});
