import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { processIdentity, readinessPath } from "../server/readiness.ts";
import { SoftwareAuthenticator } from "../server/motoko-owner.fixture.ts";
import { writeEnrollmentToken } from "../server/motoko-owner.ts";

const repo = resolve(import.meta.dir, "..");
function fixture(port: number) {
  const root = mkdtempSync(join(tmpdir(), "owner-plugin-"));
  for (const name of ["server","pid","config","app"]) mkdirSync(join(root,name),{mode:0o700});
  const env = {...process.env,HERDR_PLUGIN_ROOT:root,HERDR_PLUGIN_STATE_DIR:join(root,"pid"),HERDR_PLUGIN_CONFIG_DIR:join(root,"config"),HERDR_WEB_STATE_DIR:join(root,"app"),HERDR_WEB_OWNER_RP_ID:"localhost",HERDR_WEB_OWNER_ORIGIN:"http://localhost",HERDR_WEB_AUTO_UPDATE:"0",HOST:"127.0.0.1",PORT:String(port)};
  for (const name of ["readiness.ts","motoko-owner.ts"]) writeFileSync(join(root,"server",name),"// synthetic supported release\n");
  writeFileSync(join(root,"server/managed.ts"),`import {runManaged} from ${JSON.stringify(join(repo,"server/managed.ts"))}; await runManaged(${JSON.stringify(root)});`);
  writeFileSync(join(root,"server/index.ts"),`
    import {createServer} from ${JSON.stringify(join(repo,"server/index.ts"))};
    import {syntheticServerOptions} from ${JSON.stringify(join(repo,"scripts/motoko-env.ts"))};
    const server=createServer({...syntheticServerOptions(${JSON.stringify(root)}),port:Number(process.env.PORT),stateDir:process.env.HERDR_WEB_STATE_DIR});
    process.on("SIGTERM",()=>{server.stop();process.exit(0)});
    process.on("disconnect",()=>{server.stop();process.exit(0)});
  `);
  const run = async (command:string) => {
    const child=Bun.spawn([process.execPath,join(repo,"scripts/plugin.ts"),command],{env,stdout:"pipe",stderr:"pipe"});
    const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    return {code,out,err};
  };
  return {root,env,run,pid:join(root,"pid/server.pid"),app:join(root,"app")};
}
const reserve = () => Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response()});

test.skipIf(process.platform!=="linux")("owner plugin rejects foreign full-health JSON without a second instance",async()=>{
  const foreign=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>Response.json({ok:true,herdr:{},auth:{required:true,authenticated:false},bridge_protocol:1,web_ui:{boot_id:"fiction"}})});
  const f=fixture(foreign.port!);
  try {
    const result=await f.run("start");expect(result.code).toBe(1);expect(result.err).toContain("listener was left unchanged");
    expect(existsSync(f.pid)).toBe(false);expect(existsSync(join(f.app,"plugin-port"))).toBe(false);
    expect((await fetch(`http://127.0.0.1:${foreign.port}/`)).status).toBe(200);
  } finally {foreign.stop(true);rmSync(f.root,{recursive:true,force:true});}
});

test.skipIf(process.platform!=="linux")("owner stop keeps a stale PID record and sends no signal to its reused identity",async()=>{
  const reservation=reserve(),f=fixture(reservation.port!);reservation.stop(true);
  const held=Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"],{stdout:"ignore",stderr:"ignore"});
  try {
    const identity=processIdentity(held.pid)!;writeFileSync(f.pid,JSON.stringify({version:1,...identity,startedAt:identity.startedAt+1,nonce:crypto.randomUUID()}),{mode:0o600});
    const result=await f.run("stop");expect(result.code).toBe(1);expect(result.err).toContain("no signal was sent");
    expect(held.exitCode).toBeNull();expect(existsSync(f.pid)).toBe(true);
  } finally {held.kill();await held.exited;rmSync(f.root,{recursive:true,force:true});}
});

test.skipIf(process.platform!=="linux"||process.env["HERDR_TEST_MODE"]!=="integration")("owner plugin cold start, idempotent start, enrolled restart, and stop use private identity",async()=>{
  const reservation=reserve(),port=reservation.port!,f=fixture(port);reservation.stop(true);
  try {
    const first=await f.run("start");expect(first.code).toBe(0);
    const initial=readFileSync(f.pid,"utf8"),ready=readinessPath(f.root,port,f.app);
    expect(existsSync(ready)).toBe(true);
    const repeated=await f.run("start");expect(repeated.code).toBe(0);expect(repeated.out).toContain("already running");expect(readFileSync(f.pid,"utf8")).toBe(initial);
    const key=new SoftwareAuthenticator();
    const send=(path:string,body:unknown)=>fetch(`http://127.0.0.1:${port}`+path,{method:"POST",headers:{origin:"http://localhost","x-herdr-machine":"1","content-type":"application/json"},body:JSON.stringify(body)});
    const options=await(await send("/api/owner/bootstrap/options",{enrollmentToken:writeEnrollmentToken(f.app)})).json();
    const pending=await(await send("/api/owner/register",{ceremonyId:options.ceremonyId,label:"Fiction owner",response:key.registration(options.options.challenge)})).json();
    expect((await send("/api/owner/prove",{ceremonyId:pending.ceremonyId,response:key.assertion(pending.options.challenge)})).status).toBe(201);
    expect((await f.run("stop")).code).toBe(0);expect(existsSync(ready)).toBe(false);expect(existsSync(f.pid)).toBe(false);expect(existsSync(join(f.app,"owner.dirty"))).toBe(false);
    expect((await f.run("start")).code).toBe(0);expect(existsSync(ready)).toBe(true);
    const health=await(await fetch(`http://127.0.0.1:${port}/api/health`)).json();expect(health.auth.owner.enrolled).toBe(true);expect(health.web_ui).toBeUndefined();
  } finally {await f.run("stop");rmSync(f.root,{recursive:true,force:true});}
},15000);


test.skipIf(process.platform!=="linux"||process.env["HERDR_TEST_MODE"]!=="integration")("dirty owner state prevents actual plugin readiness and remains unchanged",async()=>{
  const reservation=reserve(),port=reservation.port!,f=fixture(port);reservation.stop(true);
  const marker=join(f.app,"owner.dirty"),store=join(f.app,"owner.json");
  const saved=JSON.stringify({version:1,credentials:[],sessions:[]});writeFileSync(store,saved,{mode:0o600});writeFileSync(marker,"synthetic recovery required",{mode:0o600});
  try {
    const result=await f.run("start");expect(result.code).toBe(1);expect(result.err).toContain("Owner bridge readiness failed");
    expect(existsSync(readinessPath(f.root,port,f.app))).toBe(false);
    expect(readFileSync(store,"utf8")).toBe(saved);expect(readFileSync(marker,"utf8")).toBe("synthetic recovery required");
  } finally {await f.run("stop");rmSync(f.root,{recursive:true,force:true});}
},10000);

test.skipIf(process.platform!=="linux"||process.env["HERDR_TEST_MODE"]!=="integration")("owner plugin carries the Motoko source binding from its config file to the server process",async()=>{
  const reservation=reserve(),port=reservation.port!,f=fixture(port);reservation.stop(true);
  const seen=join(f.root,"server-env.json");
  writeFileSync(join(f.root,"config/.env"),"HERDR_WEB_MOTOKO_SOURCE_SESSION=fiction-owner@external\nHERDR_WEB_MOTOKO_RIG_ID=01ARZ3NDEKTSV4RRFFQ69G5FAV\nHERDR_WEB_MOTOKO_RIG_NAME=fiction-lab\n",{mode:0o600});
  writeFileSync(join(f.root,"server/index.ts"),`import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(seen)},JSON.stringify({source:process.env.HERDR_WEB_MOTOKO_SOURCE_SESSION??null,rigId:process.env.HERDR_WEB_MOTOKO_RIG_ID??null,rigName:process.env.HERDR_WEB_MOTOKO_RIG_NAME??null}));\n`+readFileSync(join(f.root,"server/index.ts"),"utf8"));
  try {
    expect((await f.run("start")).code).toBe(0);
    expect(JSON.parse(readFileSync(seen,"utf8"))).toEqual({source:"fiction-owner@external",rigId:"01ARZ3NDEKTSV4RRFFQ69G5FAV",rigName:"fiction-lab"});
  } finally {await f.run("stop");rmSync(f.root,{recursive:true,force:true});}
},15000);
