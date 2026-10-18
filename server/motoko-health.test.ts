import { expect, test } from "bun:test";
import { createHealthSampler, handleHealthRequest } from "./motoko-health.ts";

const cpu = (idle: number, user: number) => ({ times: { idle, user, nice: 0, sys: 0, irq: 0 } });
function fixture() {
  let time = 0, counters = [cpu(100,100)], free = 40, total = 100, up = 50;
  let failCpu = false, failMemory = false, failUptime = false, reads = 0;
  const sample = createHealthSampler({
    cpus: () => { reads++; if (failCpu) throw Error("private CPU detail"); return counters; },
    freemem: () => { if (failMemory) throw Error("private memory detail"); return free; },
    totalmem: () => total, uptime: () => { if (failUptime) throw Error("private uptime detail"); return up; },
    monotonic: () => time, now: () => 1_700_000_000_000,
  });
  return { sample, get reads() { return reads; }, set: (next: { time?: number; counters?: ReturnType<typeof cpu>[]; free?: number; total?: number; up?: number; failCpu?: boolean; failMemory?: boolean; failUptime?: boolean }) => {
    time = next.time ?? time; counters = next.counters ?? counters; free = next.free ?? free; total = next.total ?? total; up = next.up ?? up;
    failCpu = next.failCpu ?? failCpu; failMemory = next.failMemory ?? failMemory; failUptime = next.failUptime ?? failUptime;
  } };
}
test("sampler reads only on request and reports the actual CPU interval", () => {
  const f = fixture(); expect(f.reads).toBe(0);
  const first = f.sample(); expect(first.cpu.state).toBe("unknown");
  expect(first.memory).toMatchObject({state:"known",value:{usedBytes:60,totalBytes:100}});
  expect(first.uptime).toMatchObject({state:"known",value:50}); expect(first.staleAfterMs).toBe(15000);
  f.set({time:5000,counters:[cpu(150,250)]});
  expect(f.sample().cpu).toMatchObject({state:"known",value:{percent:75,intervalMs:5000}});
  f.set({time:6000,counters:[cpu(250,250)]}); expect(f.sample().cpu).toMatchObject({state:"known",value:{percent:0,intervalMs:1000}});
  f.set({time:7000,counters:[cpu(250,350)]}); expect(f.sample().cpu).toMatchObject({state:"known",value:{percent:100,intervalMs:1000}});
});
test("CPU failures clear the baseline without hiding independent memory and uptime", () => {
  const f = fixture(); f.sample(); f.set({time:1000,failCpu:true});
  const failed=f.sample(); expect(failed.cpu.state).toBe("unknown"); expect(failed.memory.state).toBe("known"); expect(failed.uptime.state).toBe("known");
  expect(JSON.stringify(failed)).not.toContain("private CPU detail");
  f.set({time:2000,failCpu:false}); expect(f.sample().cpu.state).toBe("unknown");
  f.set({time:3000,counters:[cpu(200,200)],failMemory:true,failUptime:true});
  const next=f.sample(); expect(next.cpu.state).toBe("known"); expect(next.memory.state).toBe("unknown"); expect(next.uptime.state).toBe("unknown");
});
for (const next of [
  {time:31000,counters:[cpu(200,200)]}, {time:0,counters:[cpu(200,200)]},
  {time:1000,counters:[cpu(100,100)]}, {time:1000,counters:[cpu(99,200)]},
  {time:1000,counters:[cpu(NaN,200)]}, {time:1000,counters:[]},
  {time:1000,counters:[cpu(200,200),cpu(200,200)]}, {time:NaN,counters:[cpu(200,200)]},
]) test("invalid CPU sample stays Unknown: " + JSON.stringify(next), () => {
  const f=fixture(); f.sample(); f.set(next); expect(f.sample().cpu.state).toBe("unknown");
});
for (const next of [{free:-1},{free:101},{total:0},{total:Infinity},{up:-1},{up:NaN}]) test("invalid memory or uptime stays Unknown: "+JSON.stringify(next),()=>{
  const f=fixture(); f.set(next); const result=f.sample(); expect("up" in next ? result.uptime.state : result.memory.state).toBe("unknown");
});
test("health requires a current owner before reads and rechecks before its response", async () => {
  const f=fixture(), request=new Request("http://localhost/api/motoko/health");
  const denied=handleHealthRequest(request,{sample:f.sample,owner:null}); expect(denied.status).toBe(401); expect(f.reads).toBe(0);
  const revoked=handleHealthRequest(request,{sample:f.sample,owner:{recheck:()=>{throw Error("revoked");}}}); expect(revoked.status).toBe(401); expect(f.reads).toBe(0);
  let checks=0;
  const late=handleHealthRequest(request,{sample:f.sample,owner:{recheck:()=>{if(++checks===2) throw Error("expired");}}});
  expect(late.status).toBe(401); expect(checks).toBe(2); expect(await late.text()).not.toContain("usedBytes");
  const ok=handleHealthRequest(request,{sample:f.sample,owner:{recheck:()=>{}}});
  expect(ok.status).toBe(200); expect(ok.headers.get("cache-control")).toBe("no-store");
  const body=await ok.json(); expect(Object.keys(body).sort()).toEqual(["cpu","memory","sampledAt","staleAfterMs","uptime"]);
  const before=f.reads;
  const method=handleHealthRequest(new Request(request,{method:"POST"}),{sample:f.sample,owner:{recheck:()=>{}}});
  expect(method.status).toBe(405); expect(method.headers.get("cache-control")).toBe("no-store"); expect(f.reads).toBe(before);
});
