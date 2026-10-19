/** Owner-bound canonical chat. The journal stores identities, never transcript history. */
import { Database } from "bun:sqlite";
import { jsonResponse } from "./http.ts";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, lstatSync, openSync, closeSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { chatBridgeEnvironment, type ChatBinding } from "./motoko-config.ts";
import type { OwnerReadContext } from "./motoko-topology.ts";
import type { ChatAction, ChatMessage, ChatPrompt, ChatView } from "../shared/motoko.ts";

type RecordValue=Record<string,unknown>;
export interface ChatBridge { command(input:RecordValue):Promise<RecordValue>;close():void }
export interface ChatRigReader {readRigModel(context:OwnerReadContext,key:string):Promise<{rig:{id:string;key:string};graph:{readCompletedAt:string;staleAfterMs:number}}>}
export interface ChatOptions {
 stateDir:string;bindings:ChatBinding[];reader:ChatRigReader;
 connect(binding:ChatBinding,subject:string,sessions:string[],event:(frame:RecordValue)=>void):Promise<ChatBridge>;
}
interface Pending {id:string;text:string;digest:string;admission:string|null;status:"queued"|"started"|"unknown";generation:number|null}
interface Conversation {id:string;binding:string;fingerprint:string;creation:string;session:string|null;owner:string|null;writer:string|null;generation:number;pending:Pending|null;revoke:boolean;outcome:string|null}
interface Live {tools:{id:string;name:string;status:"active"|"complete"}[];invalidations:number;bridge:ChatBridge;messages:ChatMessage[];prompts:ChatPrompt[];memory:ChatView["memory"];history:ChatView["history"];hasEarlier:boolean;status:string;epoch:string;sequence:number;subscription:string|null;buffer:RecordValue[];bytes:number;syncing:boolean;partial:string;generation:number;rows:ChatMessage[];snapshotKey:string;historyCursor:string|null}
export class ChatError extends Error {constructor(readonly code:string,readonly status=409){super(code);}}
const fail=(code:string,status=409):never=>{throw new ChatError(code,status);};
const random=()=>randomBytes(16).toString("hex");
const digest=(text:string)=>createHash("sha256").update(text).digest("hex");
const object=(v:unknown):v is RecordValue=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const token=(v:unknown):v is string=>typeof v==="string"&&/^[A-Za-z0-9_.:-]{1,160}$/.test(v);
const uuid=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{32}$/.test(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const bytes=(s:string)=>Buffer.byteLength(s,"utf8");
function safeText(value:unknown,max=65536):string {
 if(typeof value!=="string"||bytes(value)>max||Buffer.from(value,"utf8").toString("utf8")!==value)return "";
 // Private paths and common credential forms never enter a browser projection.
 return value.replace(/(?:\/(?:[^\s<>"']+\/)*[^\s<>"']+)/g,"[private path]").replace(/(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]+|(?:api[_-]?key|token|password)\s*[=:]\s*\S+)/gi,"[private value]");
}
function check(context:OwnerReadContext):void {try{context.signal.throwIfAborted();context.recheck();}catch{fail("owner_required",401);}}
function privatePath(path:string,directory=false):void {const s=lstatSync(path);if(s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile())||(s.mode&0o077)!==0||s.uid!==process.getuid?.())fail("chat_store_unavailable",503);}

export class ChatService {
 private db:Database;private marker:string;private closed=false;
 private records=new Map<string,Conversation>();private live=new Map<string,Live>();private busy=new Set<string>();
 private listeners=new Map<string,()=>void>();private subject:string;
 constructor(private options:ChatOptions){
  const dir=join(options.stateDir,"chat");mkdirSync(dir,{recursive:true,mode:0o700});privatePath(dir,true);
  this.marker=join(dir,"writer.lock");const fd=openSync(this.marker,"wx",0o600);closeSync(fd);
  try{
   const path=join(dir,"identities.sqlite");try{privatePath(path);}catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="ENOENT"))throw error;}
   this.db=new Database(path,{create:true,strict:true});chmodSync(path,0o600);
   this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS inputs(id TEXT PRIMARY KEY,conversation TEXT NOT NULL,digest TEXT NOT NULL,status TEXT NOT NULL);");
   this.db.query("INSERT OR IGNORE INTO meta VALUES('subject',?)").run("motoko-"+random());
   this.subject=(this.db.query("SELECT value FROM meta WHERE key='subject'").get() as {value:string}).value;
   const rows=this.db.query("SELECT payload FROM conversations").all() as {payload:string}[];
   if(rows.length>1024)fail("chat_store_unavailable",503);
   for(const row of rows){const r=JSON.parse(row.payload) as Conversation;if(!uuid(r.id)||!uuid(r.creation)||!Number.isSafeInteger(r.generation))fail("chat_store_unavailable",503);r.owner=null;r.writer=null;r.generation++;if(r.pending)r.pending.status="unknown";this.records.set(r.id,r);this.save(r);}
  }catch(error){unlinkSync(this.marker);throw error;}
 }
 private save(r:Conversation):void {
  if(this.closed)fail("chat_store_unavailable",503);
  const payload=JSON.stringify(r);const size=(this.db.query("SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) AS size FROM conversations WHERE id!=?").get(r.id) as {size:number}).size;
  if(size+bytes(payload)>16*1024*1024)fail("journal_full");
  this.db.query("INSERT OR REPLACE INTO conversations VALUES(?,?)").run(r.id,payload);
 }
 private binding(id:string):ChatBinding {return this.options.bindings.find(b=>b.id===id)??fail("profile_unconfigured",404);}
 private async scoped(context:OwnerReadContext,b:ChatBinding):Promise<void>{
  check(context);if(!context.allowedRigKeys.has(b.rigKey))fail("rig_not_allowed",404);
  const model=await this.options.reader.readRigModel(context,b.rigKey);check(context);
  const age=Date.now()-Date.parse(model.graph.readCompletedAt);
  if(model.rig.id!==b.rigId||model.rig.key!==b.rigKey||!Number.isFinite(age)||age<0||age>model.graph.staleAfterMs)fail("rig_scope_unverified");
 }
 private exclusive<T>(id:string,work:()=>Promise<T>):Promise<T>{
  if(this.busy.has(id))return Promise.reject(new ChatError("conversation_busy"));this.busy.add(id);
  return work().finally(async()=>{this.busy.delete(id);const revoked=[...this.records.values()].find(r=>r.binding===id&&r.revoke);if(revoked)await this.cleanRevoked(revoked);});
 }
 private watch(context:OwnerReadContext):void {
  if(this.listeners.has(context.ownerSessionId))return;
  const revoke=()=>{
   for(const r of this.records.values())if(r.owner===context.ownerSessionId){r.owner=null;r.writer=null;r.generation++;r.revoke=true;this.save(r);const l=this.live.get(r.id);if(l){l.status="owner_required";l.prompts=[];l.messages=[];l.partial="";l.tools=[];}if(!this.busy.has(r.binding))void this.cleanRevoked(r);}
  };
  context.signal.addEventListener("abort",revoke,{once:true});this.listeners.set(context.ownerSessionId,()=>context.signal.removeEventListener("abort",revoke));
 }
 list(context:OwnerReadContext){check(context);return this.options.bindings.filter(b=>context.allowedRigKeys.has(b.rigKey)).map(b=>({id:b.id,label:b.label,profile:b.profile,rigKey:b.rigKey}));}
 async open(context:OwnerReadContext,bindingId:string,writerId:string):Promise<ChatView>{
  if(!uuid(writerId))fail("invalid_request",400);const b=this.binding(bindingId);
  return this.exclusive(b.id,async()=>{
   await this.scoped(context,b);this.watch(context);
   let r=[...this.records.values()].find(r=>r.binding===b.id);
   if(!r){if(this.records.size>=1024)fail("journal_full");r={id:random(),binding:b.id,fingerprint:digest(JSON.stringify(b)),creation:random(),session:null,owner:null,writer:null,generation:0,pending:null,revoke:false,outcome:null};this.records.set(r.id,r);this.save(r);}
   if(r.fingerprint!==digest(JSON.stringify(b)))fail("binding_changed");
   if(r.owner!==null&&r.owner!==context.ownerSessionId)fail("writer_busy");
   const writerBusy=r.owner!==null&&r.writer!==writerId;
   if(!r.owner){r.owner=context.ownerSessionId;r.writer=writerId;r.generation++;this.save(r);}
   const l=await this.connection(context,r,b);
   check(context);
   if(!r.session){try{const result=await l.bridge.command({operation:"create",requestId:r.creation});
    r.session=token(result["session_id"])?result["session_id"]:fail("invalid_response",502);this.save(r);this.snapshot(r,l,result);check(context);
   }catch(error){if(r.owner){l.bridge.close();this.live.delete(r.id);}throw error;}}else{await this.refresh(context,r,l);}
   if(r.revoke&&r.pending?.admission){await this.stopRemote(r,l);check(context);}
   const memory=await l.bridge.command({operation:"memory",sessionId:r.session});check(context);
   l.memory=memory["state"]==="ready"?"ready":memory["state"]==="uninitialized"?"uninitialized":"failed";
   return {...this.view(context,r,l),...(writerBusy?{status:"writer_busy"}:{})};
  });
 }
 private async connection(context:OwnerReadContext,r:Conversation,b:ChatBinding):Promise<Live>{
  let l=this.live.get(r.id);if(l)return l;
  const bridge=await this.options.connect(b,this.subject,r.session?[r.session]:[],frame=>{if(l&&this.live.get(r.id)===l)this.event(r.id,frame);});
  try{check(context);}catch(error){bridge.close();throw error;}
  l={tools:[],invalidations:0,bridge,messages:[],prompts:[],memory:"uninitialized",history:"unavailable",hasEarlier:false,status:"ready",epoch:"",sequence:0,subscription:null,buffer:[],bytes:0,syncing:false,partial:"",generation:0,rows:[],snapshotKey:"",historyCursor:null};
  this.live.set(r.id,l);return l;
 }
 private snapshot(r:Conversation,l:Live,s:RecordValue):void {
  if(s["session_id"]!==r.session||!token(s["replay_epoch"])||!integer(s["last_sequence"]))return fail("invalid_response",502);
  const generation=integer(s["execution_generation"])?s["execution_generation"]:0;
  const snapshotSequence=s["last_sequence"];
  const after=l.buffer.filter(e=>e["replay_epoch"]!==s["replay_epoch"]||!integer(e["seq"])||e["seq"]>snapshotSequence);
  l.buffer=l.buffer.filter(e=>!after.includes(e));this.drain(r,l);
  if(!s["running"]||l.generation!==generation){l.partial="";l.tools=[];}l.generation=generation;
  const sequence=l.epoch===s["replay_epoch"]?Math.max(l.sequence,s["last_sequence"]):s["last_sequence"];
  l.epoch=s["replay_epoch"];l.sequence=sequence;l.buffer=after;l.bytes=after.reduce((sum,e)=>sum+bytes(JSON.stringify(e)),0);l.subscription=token(s["subscription_id"])?s["subscription_id"]:null;
  const raw=s["messages"];l.rows=[];l.history=Array.isArray(raw)?"ready":"unavailable";
  if(Array.isArray(raw)){for(const row of raw){
   if(!object(row)||!["user","assistant","tool"].includes(String(row["role"])))continue;
   const content=row["content"];
   const text=typeof content==="string"?content:content==null?"":Array.isArray(content)?content.map(block=>object(block)&&block["type"]==="text"&&typeof block["text"]==="string"?block["text"]:object(block)&&["thinking","reasoning"].includes(String(block["type"]))?"":"[non-text content]").join("\n"):"[non-text content]";
   if(bytes(text)>256*1024){l.history="unavailable";l.rows=[];break;}
   if(text)l.rows.push({role:row["role"] as ChatMessage["role"],text:safeText(text,256*1024)});
  }}
  l.snapshotKey=digest(r.fingerprint+String(r.session)+l.epoch+String(l.sequence)+JSON.stringify(l.rows));
  this.page(l,l.rows.length);
  l.status="ready";l.prompts=[];if(Array.isArray(s["prompts"]))for(const p of s["prompts"])this.prompt(l,p);
  if(r.pending&&!r.pending.admission&&Array.isArray(s["pending"])){
   const found=s["pending"].find(p=>object(p)&&p["input_id"]===r.pending?.id);
   if(object(found)&&token(found["admission_id"])){r.pending.admission=found["admission_id"];this.save(r);}
  }
 }
 private page(l:Live,end:number):void {
  let start=end,size=2;
  while(start>0&&end-start<100){const next=bytes(JSON.stringify(l.rows[start-1]!))+1;if(size+next>256*1024)break;size+=next;start--;}
  l.messages=l.rows.slice(start,end);l.hasEarlier=start>0;l.historyCursor=start>0?`${l.snapshotKey}:${start}`:null;
  if(start===end&&end>0)l.history="unavailable";
 }
 private prompt(l:Live,value:unknown):void {
  if(!object(value)||!token(value["prompt_id"])||!integer(value["execution_generation"])||value["execution_generation"]<1||value["execution_generation"]!==l.generation)return;
  const kind=value["kind"]??value["type"];if(kind!=="approval"&&kind!=="clarify")return;
  l.prompts=l.prompts.filter(p=>p.id!==value["prompt_id"]);
  if(l.prompts.length>=16){l.status="resync_required";return;}
  l.prompts.push({id:value["prompt_id"],kind,generation:value["execution_generation"],text:safeText(value["text"]??value["question"]??value["command"]),choices:Array.isArray(value["choices"])?value["choices"].filter((x):x is string=>typeof x==="string"&&bytes(x)<=120&&safeText(x,120)===x).slice(0,8):[]});
 }
 private event(id:string,frame:RecordValue):void {
  const r=this.records.get(id),l=this.live.get(id);if(!r||!l||!r.owner)return;
  if(frame["kind"]==="status"){if(frame["sessionId"]===r.session)this.invalidate(l);return;}
  const e=frame["event"];if(!object(e)||e["session_id"]!==r.session)return;
  const size=bytes(JSON.stringify(e));if(l.buffer.length>=128||l.bytes+size>256*1024||size>65536){this.invalidate(l);l.buffer=[];l.bytes=0;return;}
  l.buffer.push(e);l.bytes+=size;
 }
 private invalidate(l:Live):void {l.invalidations++;l.status="resync_required";l.partial="";l.tools=[];l.prompts=[];}
 private drain(r:Conversation,l:Live):void {
  for(const e of l.buffer){
   if(e["replay_epoch"]!==l.epoch||!integer(e["seq"])) {this.invalidate(l);break;}
   if(e["seq"]<=l.sequence)continue;
   // The Python bridge checks contiguous sequence, including omitted private event types.
   l.sequence=e["seq"];
   if(integer(e["execution_generation"])){if(e["execution_generation"]<l.generation)continue;if(e["execution_generation"]>l.generation){l.generation=e["execution_generation"];l.partial="";l.tools=[];l.prompts=[];}}
   if(e["admission_id"]&&r.pending?.admission&&e["admission_id"]!==r.pending.admission)continue;
   if(e["type"]==="approval.request"||e["type"]==="clarify.request"){
    if(object(e["payload"]))this.prompt(l,{...e["payload"],kind:e["type"]==="approval.request"?"approval":"clarify",execution_generation:e["execution_generation"]});
   }
   const payload=e["payload"];
   if((e["type"]==="tool.start"||e["type"]==="tool.complete")&&object(payload)){
    const id=payload["tool_id"]??payload["tool_call_id"],name=payload["name"]??payload["tool_name"];
    if(!token(id))continue;
    const approved=["terminal","read_file","write_file","patch","search_files","web_search","web_extract","delegate_task","execute_code"];
    const tool={id,name:typeof name==="string"&&approved.includes(name)?name:"tool",status:e["type"]==="tool.start"?"active" as const:"complete" as const};
    l.tools=l.tools.filter(t=>t.id!==id);l.tools.push(tool);if(l.tools.length>16)l.tools.shift();
    if(e["type"]==="tool.start")l.partial="";
   }
   if(e["type"]==="message.delta"&&object(payload)&&typeof payload["text"]==="string"){
    const text=safeText(payload["text"]);if(bytes(l.partial)+bytes(text)>65536){l.partial="";l.status="resync_required";}else l.partial+=text;
   }else if(e["type"]==="message.start")l.partial="";
   else if(e["type"]==="message.complete"||e["type"]==="message.interim"){l.partial="";l.status="resync_required";}
   else if(e["type"]==="session.info"||e["type"]==="approval.settled"||e["type"]==="clarify.settled")l.status="resync_required";
  }
  l.buffer=[];l.bytes=0;
 }
 private async refresh(context:OwnerReadContext,r:Conversation,l:Live):Promise<void>{
  l.syncing=true;
  try{const invalidations=l.invalidations;const s=await l.bridge.command({operation:"resume",sessionId:r.session});check(context);this.snapshot(r,l,s);if(l.invalidations!==invalidations)l.status="resync_required";
   const memory=await l.bridge.command({operation:"memory",sessionId:r.session});check(context);
   l.memory=memory["state"]==="ready"?"ready":memory["state"]==="uninitialized"?"uninitialized":"failed";
   if(r.pending?.admission){const receipt=await l.bridge.command({operation:"receipt",sessionId:r.session,admissionId:r.pending.admission});this.receipt(r,receipt);check(context);}
  }catch(error){if(r.owner){l.bridge.close();this.live.delete(r.id);}throw error;}finally{l.syncing=false;}
 }
 private receipt(r:Conversation,value:RecordValue):void {
  const p=r.pending;if(!p)return;
  if(!token(value["admission_id"])||(p.admission&&p.admission!==value["admission_id"]))return fail("invalid_response",502);
  p.admission=value["admission_id"];p.generation=integer(value["execution_generation"])?value["execution_generation"]:null;
  const status=value["status"];
  if(status==="terminal"){
   r.outcome=typeof value["outcome"]==="string"&&/^[a-z_]{1,80}$/.test(value["outcome"])?value["outcome"]:"unknown";
   this.db.query("UPDATE inputs SET status='terminal' WHERE id=?").run(p.id);r.pending=null;r.revoke=r.owner===null;
  }else{p.status=status==="queued"||status==="started"?status:"unknown";}
  this.save(r);
 }
 private async cleanRevoked(r:Conversation):Promise<void>{
  if(this.closed||this.busy.has(r.binding))return;
  const l=this.live.get(r.id);if(!l)return;this.busy.add(r.binding);
  try{await this.stopRemote(r,l);if(l.subscription)await l.bridge.command({operation:"detach",sessionId:r.session,subscriptionId:l.subscription});}
  catch{/* The unresolved identity remains in the private journal. */}
  finally{if(!this.closed){r.revoke=!!r.pending;this.save(r);}l.bridge.close();this.live.delete(r.id);this.busy.delete(r.binding);}
 }
 private async stopRemote(r:Conversation,l:Live):Promise<void>{
  if(!r.pending?.admission){r.revoke=!!r.pending;this.save(r);return;}
  try{const receipt=await l.bridge.command({operation:"stop",sessionId:r.session,admissionId:r.pending.admission});this.receipt(r,receipt);}
  catch{if(r.pending)r.pending.status="unknown";this.save(r);}
 }
 private view(context:OwnerReadContext,r:Conversation,l:Live):ChatView{
  check(context);const b=this.binding(r.binding);return {conversationId:r.id,bindingId:b.id,label:b.label,profile:b.profile,rigKey:b.rigKey,writerGeneration:r.generation,memory:l.memory,tools:l.tools.map(({name,status})=>({name,status})),messages:l.partial?[...l.messages,{role:"assistant",text:l.partial}]:l.messages,prompts:l.prompts,pending:r.pending?{submissionId:r.pending.id,status:r.pending.status,canAcknowledge:r.pending.status==="unknown"&&!!r.pending.admission&&!!r.pending.generation}:null,outcome:r.outcome,history:l.history,hasEarlier:l.hasEarlier,historyCursor:l.historyCursor,status:l.status};
 }
 async act(context:OwnerReadContext,id:string,generation:number,writerId:string,action:ChatAction):Promise<ChatView>{
  check(context);const r=this.records.get(id)??fail("conversation_not_owned",404);return this.exclusive(r.binding,async()=>{
   check(context);if(r.owner!==context.ownerSessionId||r.generation!==generation||(action.operation!=="recover"&&r.writer!==writerId))fail("stale_writer");
   const b=this.binding(r.binding);if(r.fingerprint!==digest(JSON.stringify(b)))fail("binding_changed");
   await this.scoped(context,b);
   if(action.operation==="recover"){r.writer=writerId;r.generation++;this.save(r);}
   const l=await this.connection(context,r,b);if(action.operation!=="read")this.drain(r,l);
   if(action.operation==="history"){
    if(typeof action.cursor!=="string"||!action.cursor.startsWith(l.snapshotKey+":"))fail("stale_history_cursor");const end=Number(action.cursor.split(":")[1]);
    if(!Number.isSafeInteger(end)||end<1||end>l.rows.length)return fail("stale_history_cursor");this.page(l,end);return this.view(context,r,l);
   }
   if(action.operation==="read"||action.operation==="recover"){await this.refresh(context,r,l);this.drain(r,l);return this.view(context,r,l);}
   if(action.operation==="release"){
    if(r.pending)fail("conversation_busy");if(l.subscription)await l.bridge.command({operation:"detach",sessionId:r.session,subscriptionId:l.subscription});check(context);
    const view=this.view(context,r,l);r.owner=null;r.writer=null;r.generation++;this.save(r);l.bridge.close();this.live.delete(id);return view;
   }
   if(action.operation==="acknowledge"){
    const p=r.pending;if(action.acknowledgeLostTurn!==true||!p?.admission||!p.generation||p.status!=="unknown")return fail("unknown_receipt_required");
    check(context);const receipt=await l.bridge.command({operation:"resolve",sessionId:r.session,admissionId:p.admission,generation:p.generation});this.receipt(r,receipt);check(context);return this.view(context,r,l);
   }
   if(action.operation==="stop"){await this.stopRemote(r,l);check(context);return this.view(context,r,l);}
   if(action.operation==="send"){
    if(!uuid(action.submissionId)||typeof action.text!=="string"||!action.text.trim()||Buffer.from(action.text,"utf8").toString("utf8")!==action.text||bytes(action.text)>16384)fail("invalid_request",400);
    const prior=this.db.query("SELECT conversation,digest FROM inputs WHERE id=?").get(action.submissionId) as {conversation:string;digest:string}|null;
    if(prior){if(prior.conversation!==id||prior.digest!==digest(action.text))fail("identifier_conflict");return this.view(context,r,l);}
    if(r.pending||r.revoke)fail("conversation_busy");if(l.status!=="ready")fail("resync_required");if(l.history!=="ready")fail("history_too_large");
    const memory=await l.bridge.command({operation:"memory",sessionId:r.session});check(context);if(memory["state"]!=="ready"&&memory["state"]!=="uninitialized")fail("memory_binding_unverified");
    if((this.db.query("SELECT count(*) AS count FROM inputs").get() as {count:number}).count>=100000)fail("journal_full");
    r.pending={id:action.submissionId,text:action.text,digest:digest(action.text),admission:null,status:"unknown",generation:null};r.outcome=null;
    this.db.transaction(()=>{this.db.query("INSERT INTO inputs VALUES(?,?,?,'unknown')").run(action.submissionId,id,digest(action.text));this.save(r);})();
    check(context);
    try{const result=await l.bridge.command({operation:"submit",sessionId:r.session,submissionId:action.submissionId,text:action.text});this.receipt(r,result);}
    catch{if(r.pending)r.pending.status="unknown";this.save(r);l.status="outcome_unknown";l.bridge.close();this.live.delete(r.id);}
    check(context);return this.view(context,r,l);
   }
   if(l.status!=="ready")fail("resync_required");
   const prompt=l.prompts.find(p=>p.id===action.promptId&&p.generation===action.generation&&p.kind===(action.operation==="approve"?"approval":"clarify"));
   if(!prompt||!integer(action.generation)||typeof action.answer!=="string"||bytes(action.answer)>16384||Buffer.from(action.answer,"utf8").toString("utf8")!==action.answer||(action.operation==="approve"&&!prompt.choices.includes(action.answer)))return fail("stale_prompt");
   check(context);await l.bridge.command({operation:action.operation,sessionId:r.session,promptId:prompt.id,generation:prompt.generation,[action.operation==="approve"?"choice":"answer"]:action.answer});check(context);l.prompts=l.prompts.filter(p=>p!==prompt);
   return this.view(context,r,l);
  });
 }
 close():void {if(this.closed)return;for(const off of this.listeners.values())off();for(const l of this.live.values())l.bridge.close();this.live.clear();this.db.close();this.closed=true;unlinkSync(this.marker);}
}

interface BridgeProcess {stdout:ReadableStream<Uint8Array>;stdin:{write(value:string):number|Promise<number>;flush():number|Promise<number>;end():unknown}}
/** The only launch path: approved executable, approved runtime, no inherited environment. */
export function connectChatBridge(binding:ChatBinding,subject:string,sessions:string[],event:(frame:RecordValue)=>void):Promise<ChatBridge>{
 const child=Bun.spawn([binding.python,"-B",join(import.meta.dir,"motoko-hermes.py")],{cwd:binding.runtime,env:chatBridgeEnvironment(binding),stdin:"pipe",stdout:"pipe",stderr:"ignore"});
 return attachChatBridge(child,{binding:{home:binding.home,profile:binding.profile,bank:binding.bank,workspace:binding.workspace,endpoint:binding.endpoint,revision:binding.revisionSha},subject,ownedSessions:sessions},event);
}
export async function attachChatBridge(child:BridgeProcess,config:RecordValue,event:(frame:RecordValue)=>void):Promise<ChatBridge>{
 let closed=false,sequence=0,initialized=false;
 const pending=new Map<string,{resolve(value:RecordValue):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>();
 let readyResolve!:()=>void,readyReject!:(error:Error)=>void;
 const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
 const reader=child.stdout.getReader();
 const close=()=>{if(closed)return;closed=true;readyReject(new ChatError("outcome_unknown",503));for(const p of pending.values()){clearTimeout(p.timer);p.reject(new ChatError("outcome_unknown",503));}pending.clear();child.stdin.end();void reader.cancel().catch(()=>{});};
 const startup=setTimeout(close,25000);
 const send=async(value:RecordValue)=>{const line=JSON.stringify(value)+"\n";if(bytes(line)>65536)fail("input_too_large",400);await child.stdin.write(line);await child.stdin.flush();};
 void (async()=>{
  let held=new Uint8Array(0);const decoder=new TextDecoder("utf-8",{fatal:true});
  try{while(!closed){const chunk=await reader.read();if(chunk.done)break;
   if(held.length+chunk.value.length>8*1024*1024)throw Error("frame_limit");
   const next=new Uint8Array(held.length+chunk.value.length);next.set(held);next.set(chunk.value,held.length);held=next;
   let end:number;while((end=held.indexOf(10))>=0){const line=held.slice(0,end);held=held.slice(end+1);const frame:unknown=JSON.parse(decoder.decode(line));
    if(!object(frame))throw Error("invalid_frame");
    if(frame["kind"]==="ready"){clearTimeout(startup);initialized=true;readyResolve();continue;}
    if(frame["kind"]==="event"||frame["kind"]==="status"){event(frame);continue;}
    if(!initialized&&frame["kind"]==="error"){readyReject(new ChatError(["incompatible_runtime","runtime_unavailable","invalid_binding"].includes(String(frame["code"]))?String(frame["code"]):"runtime_unavailable",503));close();return;}
    const id=frame["id"],p=typeof id==="string"?pending.get(id):undefined;
    if(!p)throw Error("unexpected_reply");pending.delete(String(id));clearTimeout(p.timer);
    if(frame["kind"]==="result"&&object(frame["result"]))p.resolve(frame["result"]);
    else p.reject(new ChatError(["incompatible_runtime","memory_binding_unverified","history_too_large","invalid_request","input_too_large","conversation_not_owned"].includes(String(frame["code"]))?String(frame["code"]):"outcome_unknown",502));
   }
  }}catch{/* No child diagnostics cross this private transport boundary. */}finally{clearTimeout(startup);close();}
 })();
 try{await send(config);await ready;}catch(error){close();throw error instanceof ChatError?error:new ChatError("outcome_unknown",503);}
 return {close,command(input){
  if(closed)return Promise.reject(new ChatError("outcome_unknown",503));
  const id=String(++sequence);
  return new Promise<RecordValue>((resolve,reject)=>{
   if(bytes(JSON.stringify({id,command:input})+"\n")>32768){reject(new ChatError("input_too_large",400));return;}
   const timer=setTimeout(()=>{pending.delete(id);reject(new ChatError("outcome_unknown",503));close();},7000);
   pending.set(id,{resolve,reject,timer});void send({id,command:input}).catch(()=>close());
  });
 }};
}

/** One closed HTTP operation list; the body cap applies before JSON allocation. */
export async function handleChatRequest(request:Request,service:Pick<ChatService,"list"|"open"|"act">,context:OwnerReadContext,origin:string):Promise<Response>{
 const response=(value:unknown,status=200)=>jsonResponse(value,status,{"cache-control":"no-store"});
 try{
  check(context);
  if(request.method!=="POST"||request.headers.get("origin")!==origin)fail("invalid_origin",403);
  if(!request.headers.get("content-type")?.startsWith("application/json"))fail("invalid_request",400);
  const reader=request.body?.getReader();if(!reader)fail("invalid_request",400);
  const bodySignal=AbortSignal.any([context.signal,request.signal,AbortSignal.timeout(5000)]);
  const cancel=()=>{void reader!.cancel().catch(()=>{});};bodySignal.addEventListener("abort",cancel,{once:true});
  const chunks:Uint8Array[]=[];let length=0;
  try{while(true){const part=await reader!.read();check(context);if(bodySignal.aborted)fail("request_timeout",408);if(part.done)break;length+=part.value.length;if(length>32768)fail("input_too_large",413);chunks.push(part.value);}}
  finally{bodySignal.removeEventListener("abort",cancel);await reader!.cancel().catch(()=>{});}
  const all=new Uint8Array(length);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.length;}
  let input:unknown;try{input=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(all));}catch{fail("invalid_request",400);}
  if(!object(input))return fail("invalid_request",400);
  const operation=input["operation"];
  const keys=operation==="list"?["operation"]:operation==="open"?["operation","bindingId","writerId"]:
   ["operation","conversationId","writerGeneration","writerId",...(operation==="acknowledge"?["acknowledgeLostTurn"]:operation==="history"?["cursor"]:operation==="send"?["submissionId","text"]:operation==="approve"||operation==="clarify"?["promptId","generation","answer"]:[])];
  if(Object.keys(input).length!==keys.length||keys.some(k=>!(k in input)))fail("invalid_request",400);
  if(operation==="list")return response({bindings:service.list(context)});
  let value:ChatView;
  if(operation==="open"){
   if(!uuid(input["bindingId"])||!uuid(input["writerId"]))return fail("invalid_request",400);
   value=await service.open(context,input["bindingId"],input["writerId"]);
  }else{
   if(!["read","recover","history","acknowledge","send","stop","release","approve","clarify"].includes(String(operation))||!uuid(input["conversationId"])||!uuid(input["writerId"])||!integer(input["writerGeneration"]))return fail("invalid_request",400);
   const {conversationId,writerGeneration,writerId,...action}=input;
   value=await service.act(context,conversationId as string,writerGeneration as number,writerId as string,action as ChatAction);
  }
  check(context);return response(value);
 }catch(error){const known=error instanceof ChatError?error:new ChatError("runtime_unavailable",503);return response({error:{code:known.code,message:known.code}},known.status);}
}
