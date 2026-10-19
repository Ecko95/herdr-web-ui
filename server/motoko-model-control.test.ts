import { expect, it, spyOn } from "bun:test";
import { createRigModelReader } from "./motoko-topology.ts";
import type { OwnerReadContext } from "./motoko-topology.ts";

// A missing module is an assertion about the absent feature, not an import failure.
const implementation = await import("./motoko-model-control.ts").catch(() => null);
const rigId = "01AAAAAAAAAAAAAAAAAAAAAAAA", seatId = "01BBBBBBBBBBBBBBBBBBBBBBBB";
function fixture() {
 let stored = "old", revoked = false, reads = 0;
 let onRead = () => {}, onWrite = () => {};
 let reply = () => Response.json({ok:true,changed:true,from:"old",to:"new",seat:{rigId,nodeId:seatId,logicalId:"team.a"}});
 const calls:{url:string;init:RequestInit}[]=[];
 const controller = new AbortController();
 const owner:OwnerReadContext & {origin:string} = {origin:"https://owner.example",ownerSessionId:"fake-owner",allowedRigKeys:new Set(["main"]),signal:controller.signal,recheck(){if(revoked)throw Error("revoked");}};
 const scope = {rigs:[{key:"main",rigId,rigName:"test-rig",label:"Test rig",ownerProfileKey:null,projectKey:null}],ownerProfiles:[],projects:[]};
 const reader = createRigModelReader(scope,{transport:async url=>{
  reads++;onRead();
  if(url.endsWith("/graph"))return Response.json({nodes:[{id:seatId,type:"rigNode",data:{rigId,logicalId:"team.a",podId:null,canonicalSessionName:"team-a@test-rig",model:stored}}],edges:[]});
  return new Response(JSON.stringify({name:"test-rig",nodes:[{id:"team.a",model:"declared"}],edges:[]}));
 }});
 function control(timeoutMs=30){expect(implementation?.createModelControl).toBeFunction();return implementation!.createModelControl(reader,{timeoutMs,transport:async(url:string,init:RequestInit)=>{calls.push({url,init});onWrite();return reply();}});}
 const input = {seatId,logicalId:"team.a",expectedModel:"old",model:"new",reason:"Owner selects the next model"};
 const request=(body:unknown=input,origin:string|null=owner.origin)=>new Request("https://owner.example/api/motoko/map/rigs/main/model",{method:"POST",headers:{"content-type":"application/json",...(origin?{origin}:{})},body:JSON.stringify(body)});
 return {owner,reader,calls,input,request,control,get reads(){return reads;},setStored(v:string){stored=v;},onRead(fn:()=>void){onRead=fn;},onWrite(fn:()=>void){onWrite=fn;},reply(fn:()=>Response){reply=fn;},revoke(){revoked=true;},abort(){controller.abort();}};
}
it("saves only through the fixed canonical route and confirms a fresh graph",async()=>{
 const f=fixture();f.onWrite(()=>f.setStored("new"));
 const result=await f.control().save(f.owner,"main",f.input);
 expect(result).toMatchObject({outcome:"saved",changed:true,savedModel:"new",readback:"known"});
 expect(f.reads).toBe(4);expect(f.calls).toHaveLength(1);
 expect(f.calls[0]!.url).toBe("http://127.0.0.1:7433/api/seat/set-model/team-a%40test-rig");
 expect(f.calls[0]!.init).toMatchObject({method:"POST",redirect:"error"});
 expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({model:"new",reason:f.input.reason,operator:"motoko-owner"});
});
it("refuses wrong rig, wrong seat, changed identity and stale expected model without a write",async()=>{
 for(const patch of [{seatId:"01CCCCCCCCCCCCCCCCCCCCCCCC"},{logicalId:"team.b"},{expectedModel:"stale"}]){
  const f=fixture();await expect(f.control().save(f.owner,"main",{...f.input,...patch})).rejects.toThrow();expect(f.calls).toHaveLength(0);
 }
 const f=fixture();await expect(f.control().save(f.owner,"other",f.input)).rejects.toThrow();expect(f.reads).toBe(0);expect(f.calls).toHaveLength(0);
});
it("validates input before reads and never accepts client transport or operator fields",async()=>{
 for(const patch of [{reason:""},{reason:"x".repeat(501)},{model:"../path"},{model:"sk-abcdefghijklmnopqrstuvwxyz123456"},{operator:"owner"},{url:"http://evil"},{route:"/api/other"},{session:"team-a@test-rig"},{command:"run"},{extra:true}]){
  const f=fixture();await expect(f.control().save(f.owner,"main",{...f.input,...patch})).rejects.toThrow();expect(f.reads).toBe(0);expect(f.calls).toHaveLength(0);
 }
});
it("returns a no-op without an operational call",async()=>{
 const f=fixture();const r=await f.control().save(f.owner,"main",{...f.input,model:"old"});
 expect(r).toMatchObject({outcome:"no-op",changed:false,savedModel:"old"});expect(f.calls).toHaveLength(0);
});
it("rechecks owner authority after graph reads and refuses before dispatch",async()=>{
 const f=fixture();f.onRead(()=>f.revoke());await expect(f.control().save(f.owner,"main",f.input)).rejects.toThrow("owner_required");expect(f.calls).toHaveLength(0);
});
it("refuses a revoked owner after the write without a second write",async()=>{
 const f=fixture();f.onWrite(()=>f.revoke());await expect(f.control().save(f.owner,"main",f.input)).rejects.toThrow("owner_required");expect(f.calls).toHaveLength(1);
});
it("does not trust the response descriptor or hide a conflicting readback",async()=>{
 const f=fixture();f.onWrite(()=>f.setStored("another-model"));
 expect(await f.control().save(f.owner,"main",f.input)).toMatchObject({outcome:"conflict",savedModel:"another-model",readback:"known"});
});
it("reports a concurrent prior value even when readback matches the target",async()=>{
 const f=fixture();f.onWrite(()=>f.setStored("new"));f.reply(()=>Response.json({ok:true,changed:true,from:"concurrent-model",to:"new",seat:{rigId,nodeId:seatId,logicalId:"team.a"}}));
 expect(await f.control().save(f.owner,"main",f.input)).toMatchObject({outcome:"conflict",savedModel:"new",readback:"known",changed:true});
});
it("keeps a malformed success or ambiguous server failure UNKNOWN without retry",async()=>{
 for(const reply of [()=>new Response("private /secret sk-canary",{status:500}),()=>Response.json({ok:true}),()=>Response.json({ok:true,changed:true,to:"new",seat:{rigId:"wrong",nodeId:seatId,logicalId:"team.a"}})]){
  const f=fixture();f.reply(reply);const r=await f.control().save(f.owner,"main",f.input);expect(r.outcome).toBe("unknown");expect(JSON.stringify(r)).not.toContain("private");expect(f.calls).toHaveLength(1);
 }
});
it("returns only a bounded definite refusal",async()=>{
 const f=fixture();f.reply(()=>Response.json({ok:false,code:"seat_not_found",message:"private canary"},{status:404}));
 const r=await f.control().save(f.owner,"main",f.input);expect(r.outcome).toBe("refused");expect(JSON.stringify(r)).not.toContain("canary");expect(f.calls).toHaveLength(1);
});
it("times out once even when transport ignores abort",async()=>{
 const f=fixture();expect(implementation?.createModelControl).toBeFunction();let writes=0;
 const c=implementation!.createModelControl(f.reader,{timeoutMs:5,transport:()=>{writes++;return new Promise<Response>(()=>{});}});
 expect((await c.save(f.owner,"main",f.input)).outcome).toBe("unknown");expect(writes).toBe(1);
});
it("requires exact Origin, owner context and a bounded closed HTTP shape",async()=>{
 const f=fixture(),c=f.control();expect(implementation?.handleModelControlRequest).toBeFunction();
 for(const origin of [null,"https://evil.example","https://owner.example/"]){expect((await implementation!.handleModelControlRequest(f.request(f.input,origin),c,f.owner)).status).toBe(403);}
 expect((await implementation!.handleModelControlRequest(f.request(),c,null)).status).toBe(404);
 const huge=f.request({reason:"x".repeat(17000)});expect((await implementation!.handleModelControlRequest(huge,c,f.owner)).status).toBe(400);
 expect(f.calls).toHaveLength(0);
});
it("bypasses environment proxies for fixed writes",async()=>{
 const f=fixture();expect(implementation?.createModelControl).toBeFunction();const calls:RequestInit[]=[];
 const mock=spyOn(globalThis,"fetch").mockImplementation(Object.assign(async(_url:RequestInfo|URL,init?:RequestInit)=>{calls.push(init!);return Response.json({ok:false,code:"seat_not_found"},{status:404});},{preconnect:globalThis.fetch.preconnect}));
 try{await implementation!.createModelControl(f.reader).save(f.owner,"main",f.input);expect(calls).toHaveLength(1);expect(calls[0]).toMatchObject({proxy:false,redirect:"error"});}finally{mock.mockRestore();}
});
it("bounds an incomplete inbound body before any Save",async()=>{
 const f=fixture();let cancelled=false,saves=0;
 const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode("{"));},cancel(){cancelled=true;}});
 const request=new Request(f.request().url,{method:"POST",headers:f.request().headers,body:stream});
 const control={save:async()=>{saves++;throw Error("unexpected save");}};
 const work=implementation!.handleModelControlRequest(request,control,f.owner,{bodyTimeoutMs:5});
 let watchdog:ReturnType<typeof setTimeout>;
 const outcome=await Promise.race([work,new Promise<null>(resolve=>{watchdog=setTimeout(()=>resolve(null),40);})]);
 clearTimeout(watchdog!);if(!outcome){f.abort();await work;}
 expect(outcome?.status).toBe(408);expect(cancelled).toBe(true);expect(saves).toBe(0);
});
it("cancels an incomplete inbound body after owner revocation",async()=>{
 const f=fixture();let cancelled=false,saves=0;
 const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode("{"));},cancel(){cancelled=true;}});
 const request=new Request(f.request().url,{method:"POST",headers:f.request().headers,body:stream});
 const work=implementation!.handleModelControlRequest(request,{save:async()=>{saves++;throw Error("unexpected save");}},f.owner,{bodyTimeoutMs:50});
 f.abort();expect((await work).status).toBe(401);expect(cancelled).toBe(true);expect(saves).toBe(0);
});
it("permits a complete inbound body within its deadline",async()=>{
 const f=fixture();f.onWrite(()=>f.setStored("new"));
 const response=await implementation!.handleModelControlRequest(f.request(),f.control(),f.owner,{bodyTimeoutMs:50});
 expect(response.status).toBe(200);expect(await response.json()).toMatchObject({outcome:"saved"});expect(f.calls).toHaveLength(1);
});
