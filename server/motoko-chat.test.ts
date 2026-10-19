import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RigMapModel } from "../shared/motoko-topology.ts";
import type { ChatAction } from "../shared/motoko.ts";
import * as chat from "./motoko-chat.ts";
const binding={id:"a".repeat(32),revision:1,rigKey:"alpha",rigId:"01ARZ3NDEKTSV4RRFFQ69G5FAV",label:"Alpha",profile:"alpha",home:"/fiction/profiles/alpha",bank:"alpha",workspace:"/fiction/workspace",endpoint:"http://127.0.0.1:7434",runtime:"/fiction/runtime",python:"/fiction/python",revisionSha:"b".repeat(40)};
function rigModel():RigMapModel {
 const at=new Date().toISOString(),unknown={state:"unknown" as const,reason:"not_reported"};
 return {version:1,rig:{id:binding.rigId,key:"alpha",name:"alpha",label:'Alpha @fiction "漢字" \\ data'},scope:{ownerProfile:unknown,project:unknown},
 graph:{state:"known",readStartedAt:at,readCompletedAt:at,staleAfterMs:30000,source:"OpenRig",captureRequested:false,pods:[{id:"pod-one",namespace:"team",label:"Team"}],seats:[{id:"seat-one",logicalId:"team.one",podId:"pod-one",sessionName:unknown,role:{value:unknown,source:"graph",readAt:at},runtime:{value:unknown,source:"graph",readAt:at},model:{value:unknown,source:"spec-export",readAt:at},agentProfile:{value:unknown,source:"spec-export",readAt:at},sessionStatus:unknown,startupStatus:unknown,context:{percent:unknown,fresh:false,availability:"unknown"}}],edges:[]},
 configuration:{state:"unknown",readStartedAt:at,readCompletedAt:at,snapshotId:null,declared:[],effectiveRuntime:{state:"unknown",reason:"complete_runtime_configuration_not_reported"},omitted:["paths","instructions","credentials","hooks","resume","resource-bodies"],reason:"source_unavailable"},consistency:"separate-reads",viewRevision:"fiction-one",capabilities:{inspect:true,validateDraft:false,apply:false,hermesAdapter:false}};
}
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),"motoko-chat-test-"));let connections=0;let valid=true,unknown=false,memory="uninitialized",lost=false;const calls:Record<string,unknown>[]=[];const hooks=new Map<string,()=>void|Promise<void>>();
 let stoppedResolve!:()=>void;const stopped=new Promise<void>(resolve=>stoppedResolve=resolve);
 const controller=new AbortController();const context={ownerSessionId:"owner-one",allowedRigKeys:new Set(["alpha"]),signal:controller.signal,recheck(){if(!valid)throw Error("revoked");}};
 let onEvent:(frame:Record<string,unknown>)=>void=()=>{};
 const snapshot={session_id:"session-one",authority_epoch:7,replay_epoch:"epoch-one",last_sequence:0,subscription_id:"subscription-one",execution_generation:0,messages:[{role:"user",content:"literal <script> text"}],pending:[],prompts:[],running:false};
 const connect=async(_binding?:unknown,_subject?:unknown,_sessions?:unknown,event?:(frame:Record<string,unknown>)=>void)=>{connections++;if(event)onEvent=event;return ({async command(c:Record<string,unknown>){calls.push(c);await hooks.get(String(c["operation"]))?.();if(c["operation"]==="stop")stoppedResolve();if(c["operation"]==="create"||c["operation"]==="resume")return snapshot;if(c["operation"]==="memory")return {state:memory};if(c["operation"]==="submit"){if(unknown)throw Error("secret raw transport");return {admission_id:"admission-one",status:"started",execution_generation:2};}if(c["operation"]==="resolve"){lost=false;return {admission_id:"admission-one",status:"terminal",outcome:"unknown_acknowledged",execution_generation:2};}if(c["operation"]==="receipt"||c["operation"]==="stop")return {admission_id:"admission-one",status:lost?"unknown":"terminal",outcome:"interrupted",execution_generation:2};return {};},close(){}});};
 const reader={async readRigModel(){return rigModel();}};
 const service=new chat.ChatService({stateDir:dir,bindings:[binding],reader,connect});
 return {service,dir,context,stopped,calls,hooks,connectionCount(){return connections;},connect,reader,snapshot,event(frame:Record<string,unknown>){onEvent(frame);},revoke(){valid=false;controller.abort();},lost(){lost=true;},ready(){memory="ready";},failed(){memory="failed";},unknown(){unknown=true;},cleanup(){service.close();rmSync(dir,{recursive:true,force:true});}};
}
test("chat uses durable canonical identities and exact terminal receipts",async()=>{
 const f=fixture();try{const view=await f.service.open(f.context,binding.id,"1".repeat(32));expect(view.memory).toBe("uninitialized");expect(view.messages[0]?.text).toBe("literal <script> text");
 const sent=await f.service.act(f.context,view.conversationId,view.writerGeneration,"1".repeat(32),{operation:"send",submissionId:"2".repeat(32),text:"hello"});expect(sent.pending?.status).toBe("started");
 const stopped=await f.service.act(f.context,view.conversationId,view.writerGeneration,"1".repeat(32),{operation:"stop"});expect(stopped.pending).toBeNull();expect(stopped.outcome).toBe("interrupted");
 expect(f.calls.find(x=>x["operation"]==="submit")?.["submissionId"]).toBe("2".repeat(32));
 expect(statSync(join(f.dir,"chat")).mode&0o777).toBe(0o700);expect(statSync(join(f.dir,"chat/identities.sqlite")).mode&0o777).toBe(0o600);
 }finally{f.cleanup();}
});
test("an unknown acknowledgement survives restart without another submit",async()=>{
 const f=fixture();try{const view=await f.service.open(f.context,binding.id,"1".repeat(32));f.unknown();
 const sent=await f.service.act(f.context,view.conversationId,view.writerGeneration,"1".repeat(32),{operation:"send",submissionId:"2".repeat(32),text:"hello"});expect(sent.pending?.status).toBe("unknown");
 f.service.close();const again=new chat.ChatService({stateDir:f.dir,bindings:[binding],reader:f.reader,connect:f.connect});
 try{const recovered=await again.open(f.context,binding.id,"3".repeat(32));expect(recovered.pending?.submissionId).toBe("2".repeat(32));expect(recovered.pending?.status).toBe("unknown");
 await expect(again.act(f.context,recovered.conversationId,recovered.writerGeneration,"3".repeat(32),{operation:"send",submissionId:"4".repeat(32),text:"hello"})).rejects.toThrow("conversation_busy");
 expect(f.calls.filter(x=>x["operation"]==="submit")).toHaveLength(1);
 }finally{again.close();}
 }finally{f.cleanup();}
});
test("a second writer and stale generation cannot control the conversation",async()=>{
 const f=fixture();try{const view=await f.service.open(f.context,binding.id,"1".repeat(32));
 expect((await f.service.open(f.context,binding.id,"2".repeat(32))).status).toBe("writer_busy");
 await expect(f.service.act(f.context,view.conversationId,view.writerGeneration,"9".repeat(32),{operation:"stop"})).rejects.toThrow("stale_writer");
 await expect(f.service.act(f.context,view.conversationId,view.writerGeneration+1,"1".repeat(32),{operation:"stop"})).rejects.toThrow("stale_writer");
 }finally{f.cleanup();}
});
test("revocation during creation blocks publication and later sends",async()=>{
 const f=fixture();f.service.close();const service=new chat.ChatService({stateDir:f.dir,bindings:[binding],reader:f.reader,connect:async()=>{f.revoke();return await f.connect();}});
 try{await expect(service.open(f.context,binding.id,"1".repeat(32))).rejects.toThrow("owner_required");expect(f.calls).toHaveLength(0);}finally{service.close();f.cleanup();}
});
test("unconfigured bindings and stale rig evidence refuse before connection",async()=>{
 const f=fixture();try{await expect(f.service.open(f.context,"c".repeat(32),"1".repeat(32))).rejects.toThrow("profile_unconfigured");expect(f.calls).toHaveLength(0);}finally{f.cleanup();}
});

test("revocation attempts cancellation of the exact admitted input",async()=>{
 const f=fixture();try{const view=await f.service.open(f.context,binding.id,"1".repeat(32));await f.service.act(f.context,view.conversationId,view.writerGeneration,"1".repeat(32),{operation:"send",submissionId:"2".repeat(32),text:"hello"});f.revoke();await f.stopped;expect(f.calls).toContainEqual({operation:"stop",sessionId:"session-one",admissionId:"admission-one"});await expect(f.service.act(f.context,view.conversationId,view.writerGeneration,"1".repeat(32),{operation:"send",submissionId:"3".repeat(32),text:"no"})).rejects.toThrow("owner_required");}finally{f.cleanup();}
});
test("the service refuses stale evidence and raw private projection values",async()=>{
 const f=fixture();f.service.close();const reader={async readRigModel(){const m=rigModel();m.graph.readCompletedAt="2000-01-01T00:00:00Z";return m;}};
 const service=new chat.ChatService({stateDir:f.dir,bindings:[binding],reader,connect:f.connect});try{await expect(service.open(f.context,binding.id,"1".repeat(32))).rejects.toThrow("rig_scope_unverified");expect(f.calls).toHaveLength(0);}finally{service.close();f.cleanup();}
});

test("live deltas remain bounded and never establish a terminal outcome",async()=>{
 const f=fixture();try{const view=await f.service.open(f.context,binding.id,"1".repeat(32));
 f.snapshot.running=true;f.snapshot.execution_generation=1;
 f.event({kind:"event",event:{session_id:"session-one",replay_epoch:"epoch-one",seq:1,type:"message.delta",execution_generation:1,payload:{text:"live text"}}});
 const read=await f.service.act(f.context,view.conversationId,view.writerGeneration,"1".repeat(32),{operation:"read"});expect(read.messages.at(-1)?.text).toBe("live text");expect(read.outcome).toBeNull();
 }finally{f.cleanup();}
});

test("history pages remain bound to one canonical snapshot",async()=>{
 const f=fixture();f.snapshot.messages=Array.from({length:205},(_,i)=>({role:"user",content:`row ${i}`}));
 try{const view=await f.service.open(f.context,binding.id,"1".repeat(32));expect(view.messages).toHaveLength(100);expect(view.messages[0]?.text).toBe("row 105");expect(view.historyCursor).not.toBeNull();
 const earlier=await f.service.act(f.context,view.conversationId,view.writerGeneration,"1".repeat(32),{operation:"history",cursor:view.historyCursor!});expect(earlier.messages[0]?.text).toBe("row 5");expect(earlier.messages).toHaveLength(100);
 f.snapshot.last_sequence=9;await f.service.act(f.context,view.conversationId,view.writerGeneration,"1".repeat(32),{operation:"read"});await expect(f.service.act(f.context,view.conversationId,view.writerGeneration,"1".repeat(32),{operation:"history",cursor:view.historyCursor!})).rejects.toThrow("stale_history_cursor");
 }finally{f.cleanup();}
});

test("a later read reports observed provider readiness",async()=>{
 const f=fixture();try{const view=await f.service.open(f.context,binding.id,"1".repeat(32));expect(view.memory).toBe("uninitialized");f.ready();const read=await f.service.act(f.context,view.conversationId,view.writerGeneration,"1".repeat(32),{operation:"read"});expect(read.memory).toBe("ready");}finally{f.cleanup();}
});

test("an explicit lost-turn acknowledgement never requeues the input",async()=>{
 const f=fixture();try{const view=await f.service.open(f.context,binding.id,"1".repeat(32));await f.service.act(f.context,view.conversationId,view.writerGeneration,"1".repeat(32),{operation:"send",submissionId:"2".repeat(32),text:"hello"});f.lost();const unknown=await f.service.act(f.context,view.conversationId,view.writerGeneration,"1".repeat(32),{operation:"read"});expect(unknown.pending?.status).toBe("unknown");const ack=await f.service.act(f.context,view.conversationId,view.writerGeneration,"1".repeat(32),{operation:"acknowledge",acknowledgeLostTurn:true});expect(ack.pending).toBeNull();expect(f.calls).toContainEqual({operation:"resolve",sessionId:"session-one",admissionId:"admission-one",generation:2});expect(f.calls.filter(c=>c["operation"]==="submit")).toHaveLength(1);}finally{f.cleanup();}
});

test("a read reconnects after a lost reply without another submit",async()=>{
 const f=fixture();try{const view=await f.service.open(f.context,binding.id,"1".repeat(32));f.unknown();await f.service.act(f.context,view.conversationId,view.writerGeneration,"1".repeat(32),{operation:"send",submissionId:"2".repeat(32),text:"hello"});const recovered=await f.service.act(f.context,view.conversationId,view.writerGeneration,"1".repeat(32),{operation:"read"});expect(recovered.pending?.status).toBe("unknown");expect(f.connectionCount()).toBe(2);expect(f.calls.filter(c=>c["operation"]==="submit")).toHaveLength(1);}finally{f.cleanup();}
});

test("explicit writer recovery preserves pending identity and fences the former writer",async()=>{
 const f=fixture();try{const first=await f.service.open(f.context,binding.id,"1".repeat(32));f.unknown();
 await f.service.act(f.context,first.conversationId,first.writerGeneration,"1".repeat(32),{operation:"send",submissionId:"2".repeat(32),text:"hello"});
 const waiting=await f.service.open(f.context,binding.id,"3".repeat(32));expect(waiting.status).toBe("writer_busy");
 await expect(f.service.act(f.context,waiting.conversationId,waiting.writerGeneration,"3".repeat(32),{operation:"read"})).rejects.toThrow("stale_writer");
 const recovered=await f.service.act(f.context,waiting.conversationId,waiting.writerGeneration,"3".repeat(32),{operation:"recover"});
 expect(recovered.writerGeneration).toBeGreaterThan(first.writerGeneration);expect(recovered.pending?.submissionId).toBe("2".repeat(32));expect(recovered.pending?.status).toBe("unknown");
 await expect(f.service.act(f.context,first.conversationId,first.writerGeneration,"1".repeat(32),{operation:"stop"})).rejects.toThrow("stale_writer");
 await expect(f.service.act(f.context,waiting.conversationId,waiting.writerGeneration,"4".repeat(32),{operation:"recover"})).rejects.toThrow("stale_writer");
 expect(f.calls.filter(c=>c["operation"]==="submit")).toHaveLength(1);
 }finally{f.cleanup();}
});

test("live tools expose approved names without arguments or results",async()=>{
 const f=fixture();try{const view=await f.service.open(f.context,binding.id,"1".repeat(32));
 f.snapshot.running=true;f.snapshot.execution_generation=1;
 const event=(seq:number,type:string,name:string)=>f.event({kind:"event",event:{session_id:"session-one",replay_epoch:"epoch-one",seq,type,execution_generation:1,payload:{tool_id:"call-one",name,args:{password:"secret"},result:"/private/bank"}}});
 event(1,"tool.start","read_file");const active=await f.service.act(f.context,view.conversationId,view.writerGeneration,"1".repeat(32),{operation:"read"});
 expect(active.tools).toEqual([{name:"read_file",status:"active"}]);expect(JSON.stringify(active)).not.toContain("secret");
 event(2,"tool.complete","/private/secret");const complete=await f.service.act(f.context,view.conversationId,view.writerGeneration,"1".repeat(32),{operation:"read"});expect(complete.tools).toEqual([{name:"tool",status:"complete"}]);
 }finally{f.cleanup();}
});
test("late events from a closed bridge cannot reach a new connection",async()=>{
 const f=fixture();f.service.close();const callbacks:((e:Record<string,unknown>)=>void)[]=[];
 const service=new chat.ChatService({stateDir:f.dir,bindings:[binding],reader:f.reader,connect:async(b,s,ids,cb)=>{callbacks.push(cb);return f.connect(b,s,ids,cb);}});
 try{const v=await service.open(f.context,binding.id,"1".repeat(32));f.unknown();await service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"send",submissionId:"2".repeat(32),text:"hello"});await service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"read"});
 f.snapshot.running=true;f.snapshot.execution_generation=1;
 callbacks[0]!({kind:"event",event:{session_id:"session-one",replay_epoch:"epoch-one",seq:1,type:"message.delta",execution_generation:1,payload:{text:"stale bridge text"}}});
 const read=await service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"read"});expect(JSON.stringify(read)).not.toContain("stale bridge text");
 }finally{service.close();f.cleanup();}
});
test("late execution events cannot reset a newer partial reply",async()=>{
 const f=fixture();try{const v=await f.service.open(f.context,binding.id,"1".repeat(32));f.snapshot.running=true;f.snapshot.execution_generation=2;
 for(const [seq,generation,text] of [[1,2,"current"],[2,1,"stale"]] as const)f.event({kind:"event",event:{session_id:"session-one",replay_epoch:"epoch-one",seq,type:"message.delta",execution_generation:generation,payload:{text}}});
 const read=await f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"read"});expect(read.messages.at(-1)?.text).toBe("current");
 }finally{f.cleanup();}
});

test("snapshot watermarks preserve received partial text without duplicate replay",async()=>{
 const f=fixture();try{const v=await f.service.open(f.context,binding.id,"1".repeat(32));f.snapshot.running=true;f.snapshot.execution_generation=1;f.snapshot.last_sequence=1;
 const e={kind:"event",event:{session_id:"session-one",replay_epoch:"epoch-one",seq:1,type:"message.delta",execution_generation:1,payload:{text:"partial text"}}};f.event(e);
 const first=await f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"read"});expect(first.messages.at(-1)?.text).toBe("partial text");
 f.event(e);const second=await f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"read"});expect(second.messages.at(-1)?.text).toBe("partial text");
 }finally{f.cleanup();}
});
test("overflow during a snapshot requires another snapshot before send",async()=>{
 const f=fixture();try{const v=await f.service.open(f.context,binding.id,"1".repeat(32));f.hooks.set("resume",()=>{
 for(let seq=1;seq<=129;seq++)f.event({kind:"event",event:{session_id:"session-one",replay_epoch:"epoch-one",seq,type:"message.delta",execution_generation:1,payload:{text:"x"}}});});
 const read=await f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"read"});expect(read.status).toBe("resync_required");
 await expect(f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"send",submissionId:"2".repeat(32),text:"blocked"})).rejects.toThrow("resync_required");
 expect(f.calls.some(c=>c["operation"]==="submit")).toBe(false);
 f.hooks.delete("resume");f.snapshot.last_sequence=129;expect((await f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"read"})).status).toBe("ready");
 }finally{f.cleanup();}
});
test("provider failure after ready refuses a later input",async()=>{
 const f=fixture();try{f.ready();const v=await f.service.open(f.context,binding.id,"1".repeat(32));expect(v.memory).toBe("ready");f.failed();
 expect((await f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"read"})).memory).toBe("failed");
 await expect(f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"send",submissionId:"2".repeat(32),text:"blocked"})).rejects.toThrow("memory_binding_unverified");expect(f.calls.some(c=>c["operation"]==="submit")).toBe(false);
 }finally{f.cleanup();}
});
test("unknown creation reconnects with the same creation identity",async()=>{
 const f=fixture();try{let first=true;f.hooks.set("create",()=>{if(first){first=false;throw Error("lost create");}});
 await expect(f.service.open(f.context,binding.id,"1".repeat(32))).rejects.toThrow();
 const recovered=await f.service.open(f.context,binding.id,"1".repeat(32));expect(recovered.conversationId).toMatch(/^[a-f0-9]{32}$/);expect(f.connectionCount()).toBe(2);
 const creates=f.calls.filter(c=>c["operation"]==="create");expect(creates).toHaveLength(2);expect(creates[0]!["requestId"]).toBe(creates[1]!["requestId"]);
 }finally{f.cleanup();}
});
test("revocation during a snapshot still detaches its canonical viewer",async()=>{
 const f=fixture();try{const v=await f.service.open(f.context,binding.id,"1".repeat(32));f.hooks.set("resume",()=>f.revoke());
 await expect(f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"read"})).rejects.toThrow("owner_required");
 expect(f.calls).toContainEqual({operation:"detach",sessionId:"session-one",subscriptionId:"subscription-one"});
 }finally{f.cleanup();}
});
test("approval prompts remain generation-bound and private choices stay private",async()=>{
 const f=fixture();try{const v=await f.service.open(f.context,binding.id,"1".repeat(32));f.snapshot.running=true;f.snapshot.execution_generation=2;
 const prompt={prompt_id:"prompt-one",kind:"approval",execution_generation:2,command:"/private/tool password=secret",choices:["once","/private/bank"]};
 Object.assign(f.snapshot,{prompts:[prompt]});const read=await f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"read"});expect(read.prompts[0]?.choices).toEqual(["once"]);expect(JSON.stringify(read.prompts)).not.toContain("secret");
 await expect(f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"approve",promptId:"prompt-one",generation:1,answer:"once"})).rejects.toThrow("stale_prompt");
 await f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"approve",promptId:"prompt-one",generation:2,answer:"once"});expect(f.calls.at(-1)).toEqual({operation:"approve",sessionId:"session-one",promptId:"prompt-one",generation:2,choice:"once"});
 }finally{f.cleanup();}
});

for(const operation of ["create","memory","resume","receipt","submit","stop","resolve","approve","clarify","detach"]){
 test(`owner revocation at awaited ${operation} blocks publication and later effects`,async()=>{
  const f=fixture();try{
   if(operation==="create"||operation==="memory"){
    f.hooks.set(operation,()=>f.revoke());await expect(f.service.open(f.context,binding.id,"1".repeat(32))).rejects.toThrow("owner_required");
   }else{
    const v=await f.service.open(f.context,binding.id,"1".repeat(32));
    if(["receipt","stop","resolve"].includes(operation)){await f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"send",submissionId:"2".repeat(32),text:"hello"});}
    if(operation==="resolve"){f.lost();await f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"read"});}
    if(operation==="approve"||operation==="clarify"){
     f.snapshot.running=true;f.snapshot.execution_generation=2;Object.assign(f.snapshot,{prompts:[{prompt_id:"decision-one",kind:operation==="approve"?"approval":"clarify",execution_generation:2,text:"question",choices:["once"]}]});await f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"read"});
    }
    f.hooks.set(operation,()=>f.revoke());
    const action:ChatAction=operation==="submit"?{operation:"send" as const,submissionId:"2".repeat(32),text:"hello"}:operation==="stop"?{operation:"stop" as const}:operation==="resolve"?{operation:"acknowledge" as const,acknowledgeLostTurn:true as const}:operation==="approve"||operation==="clarify"?{operation,promptId:"decision-one",generation:2,answer:"once"}:operation==="detach"?{operation:"release" as const}:{operation:"read" as const};
    await expect(f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),action)).rejects.toThrow("owner_required");
    await expect(f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"send",submissionId:"3".repeat(32),text:"later"})).rejects.toThrow("owner_required");
   }
   expect(f.calls.some(c=>c["operation"]===operation)).toBe(true);
   const revokedAt=f.calls.findIndex(c=>c["operation"]===operation);
   expect(f.calls.slice(revokedAt+1).every(c=>c["operation"]==="stop"||c["operation"]==="detach")).toBe(true);
   expect(f.calls.some(c=>c["operation"]==="detach")).toBe(true);
   if(["receipt","stop","resolve"].includes(operation)){
    f.hooks.delete(operation);const nextContext={...f.context,ownerSessionId:"owner-two",signal:new AbortController().signal,recheck(){}};
    const recovered=await f.service.open(nextContext,binding.id,"4".repeat(32));
    const sent=await f.service.act(nextContext,recovered.conversationId,recovered.writerGeneration,"4".repeat(32),{operation:"send",submissionId:"5".repeat(32),text:"new input"});expect(sent.pending?.status).toBe("started");
   }
  }finally{f.cleanup();}
 });
}
test("a snapshot reconciles unknown admission by the original input identity",async()=>{
 const f=fixture();try{const v=await f.service.open(f.context,binding.id,"1".repeat(32));f.unknown();await f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"send",submissionId:"2".repeat(32),text:"hello"});
 Object.assign(f.snapshot,{pending:[{input_id:"2".repeat(32),admission_id:"admission-one"}]});
 const recovered=await f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"read"});expect(recovered.pending).toBeNull();expect(f.calls.filter(c=>c["operation"]==="submit")).toHaveLength(1);expect(f.calls).toContainEqual({operation:"receipt",sessionId:"session-one",admissionId:"admission-one"});
 }finally{f.cleanup();}
});
test("an unknown input without canonical admission cannot be acknowledged",async()=>{
 const f=fixture();try{const v=await f.service.open(f.context,binding.id,"1".repeat(32));f.unknown();const sent=await f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"send",submissionId:"2".repeat(32),text:"hello"});expect(sent.pending?.canAcknowledge).toBe(false);
 await expect(f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"acknowledge",acknowledgeLostTurn:true})).rejects.toThrow("unknown_receipt_required");expect(f.calls.some(c=>c["operation"]==="resolve")).toBe(false);
 }finally{f.cleanup();}
});

test("live tool projection keeps only sixteen bounded labels",async()=>{
 const f=fixture();try{const v=await f.service.open(f.context,binding.id,"1".repeat(32));f.snapshot.running=true;f.snapshot.execution_generation=1;
 for(let seq=1;seq<=40;seq++)f.event({kind:"event",event:{session_id:"session-one",replay_epoch:"epoch-one",seq,type:"tool.start",execution_generation:1,payload:{tool_id:`tool-${seq}`,name:"read_file",args:{secret:"private"}}}});
 const read=await f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"read"});expect(read.tools).toHaveLength(16);expect(JSON.stringify(read.tools)).not.toContain("private");
 }finally{f.cleanup();}
});
test("prompt overflow keeps admission disabled",async()=>{
 const f=fixture();try{const v=await f.service.open(f.context,binding.id,"1".repeat(32));f.snapshot.running=true;f.snapshot.execution_generation=1;
 Object.assign(f.snapshot,{prompts:Array.from({length:17},(_,i)=>({prompt_id:`prompt-${i}`,execution_generation:1,kind:"approval",command:"question",choices:["once"]}))});
 const read=await f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"read"});expect(read.status).toBe("resync_required");expect(read.prompts).toHaveLength(16);
 }finally{f.cleanup();}
});
test("history pages bound serialized bytes, including escaped text",async()=>{
 const f=fixture();try{f.snapshot.messages=[{role:"user",content:"\n".repeat(200000)}];const v=await f.service.open(f.context,binding.id,"1".repeat(32));expect(Buffer.byteLength(JSON.stringify(v.messages))).toBeLessThanOrEqual(256*1024);expect(v.history).toBe("unavailable");
 }finally{f.cleanup();}
});
test("revocation during the scope read prevents an effect",async()=>{
 const f=fixture();try{const v=await f.service.open(f.context,binding.id,"1".repeat(32));const read=f.reader.readRigModel;f.reader.readRigModel=async()=>{const value=await read();f.revoke();return value;};
 await expect(f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"send",submissionId:"2".repeat(32),text:"blocked"})).rejects.toThrow("owner_required");expect(f.calls.some(c=>c["operation"]==="submit")).toBe(false);expect(f.calls.at(-1)?.["operation"]).toBe("detach");
 }finally{f.cleanup();}
});

test("each explicit send carries the complete projected model with its original identity",async()=>{
 const f=fixture();try{
  const v=await f.service.open(f.context,binding.id,"1".repeat(32));const model=rigModel();
  const at=model.graph.readCompletedAt;
  model.scope.project={state:"known",value:{key:"project",label:"Project"},observedAt:at};
  model.graph.seats[0]!.role={value:{state:"known",value:"reviewer",observedAt:at},source:"graph",readAt:at};
  model.graph.edges=[{id:"edge-one",sourceId:"seat-one",targetId:"seat-two",kind:"delegates_to"}];
  model.configuration={...model.configuration,state:"known",readStartedAt:"2001-01-01T00:00:00Z",readCompletedAt:at,snapshotId:"snapshot-one",reason:null,declared:[{logicalId:"team.one",role:{state:"known",value:"reviewer",observedAt:at},runtime:{state:"unknown",reason:"not_reported"},model:{state:"unknown",reason:"not_reported"},agentProfile:{state:"unknown",reason:"not_reported"},codexConfigProfile:{state:"unknown",reason:"not_reported"},restorePolicy:{state:"unknown",reason:"not_reported"}}]};
  const expected=structuredClone(model);
  Object.assign(model,{rawSpec:"forbidden-root"});Object.assign(model.graph,{hooks:"forbidden-graph"});
  Object.assign(model.graph.seats[0]!.role,{raw:"forbidden-field"});
  let reads=0;f.reader.readRigModel=async()=>{reads++;return model;};
  const send=(id:string)=>f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"send",submissionId:id,text:"hello user"});
  await send("2".repeat(32));const first=f.calls.find(c=>c["operation"]==="submit")!;
  if(process.env["MOTOKO_CONTEXT_FIXTURE"])writeFileSync(process.env["MOTOKO_CONTEXT_FIXTURE"],JSON.stringify(first));
  expect(first["text"]).toBe("hello user");expect(first["submissionId"]).toBe("2".repeat(32));
  const api=String(first["apiText"]);expect(api).toContain("\\u0040fiction");expect(api).not.toContain("@fiction");expect(api).toEndWith("hello user");expect(api).not.toContain("forbidden-");
  const envelope=JSON.parse(api.split("\n")[1]!);expect(envelope.rigKey).toBe("alpha");
  expect(envelope.model).toEqual(expected);
  expect(envelope.model.rig).toEqual(model.rig);expect(envelope.model.configuration).toEqual(model.configuration);
  expect(envelope.model.graph.seats[0].role).toEqual({value:model.graph.seats[0]!.role.value,source:"graph",readAt:model.graph.seats[0]!.role.readAt});
  expect(envelope.model.consistency).toBe("separate-reads");expect(envelope.model.scope).toEqual(model.scope);
  await send("2".repeat(32));expect(f.calls.filter(c=>c["operation"]==="submit")).toHaveLength(1);
  await f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),{operation:"stop"});
  model.viewRevision="fiction-two";await send("3".repeat(32));expect(reads).toBeGreaterThan(1);
  expect(String(f.calls.filter(c=>c["operation"]==="submit")[1]!["apiText"])).toContain("fiction-two");
 }finally{f.cleanup();}
});
for(const problem of ["stale","future","wrong-id","wrong-key","failure","revoked","oversized","encoded-overflow"]){
 test(`context ${problem} refuses before journal insertion`,async()=>{
  const f=fixture();try{const v=await f.service.open(f.context,binding.id,"1".repeat(32));
   // The memory hook changes only the model read after memory verification.
   f.hooks.set("memory",()=>{f.reader.readRigModel=async()=>{
    const m=rigModel();if(problem==="stale")m.graph.readCompletedAt="2000-01-01T00:00:00Z";
    if(problem==="future")m.graph.readCompletedAt="2099-01-01T00:00:00Z";
    if(problem==="wrong-id")m.rig.id="other";if(problem==="wrong-key")m.rig.key="other";
    if(problem==="failure")throw Error("source unavailable");if(problem==="revoked")f.revoke();
    if(problem==="oversized")m.rig.label="x".repeat(262145);if(problem==="encoded-overflow")m.rig.label="@".repeat(200000);return m;
   };});
   const action={operation:"send" as const,submissionId:"7".repeat(32),text:"hello"};
   await expect(f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),action)).rejects.toThrow();
   expect(f.calls.some(c=>c["operation"]==="submit")).toBe(false);
   if(problem!=="revoked"){
    f.hooks.delete("memory");f.reader.readRigModel=async()=>rigModel();
    await f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),action);
    expect(f.calls.filter(c=>c["operation"]==="submit")).toHaveLength(1);
   }
  }finally{f.cleanup();}
 });
}

test("freshness and owner authority are checked again after context serialization",async()=>{
 for(const problem of ["age","owner"]){
  const f=fixture();const realNow=Date.now;let clock=realNow();
  try{const v=await f.service.open(f.context,binding.id,"1".repeat(32));clock=realNow();Date.now=()=>clock;
   f.hooks.set("memory",()=>{f.reader.readRigModel=async()=>{
    const model=rigModel();model.graph.readCompletedAt=new Date(clock).toISOString();Object.defineProperty(model,"viewRevision",{get(){if(problem==="age")clock+=30001;else f.revoke();return "revision";}});return model;
   };});
   const action={operation:"send" as const,submissionId:"8".repeat(32),text:"hello"};
   await expect(f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),action)).rejects.toThrow(problem==="age"?"rig_scope_unverified":"owner_required");
   expect(f.calls.some(c=>c["operation"]==="submit")).toBe(false);
   if(problem==="age"){Date.now=realNow;f.hooks.delete("memory");f.reader.readRigModel=async()=>rigModel();await f.service.act(f.context,v.conversationId,v.writerGeneration,"1".repeat(32),action);expect(f.calls.filter(c=>c["operation"]==="submit")).toHaveLength(1);}
  }finally{Date.now=realNow;f.cleanup();}
 }
});
