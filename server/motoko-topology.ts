/** Owner-bound graph reads and structural draft checks. No operational dispatch belongs here. */
import { createHash } from "node:crypto";
import { YAML } from "bun";
import { mapScope, safeMapText, type MotokoMapScope } from "./motoko-config.ts";
import { isJsonObject as object, jsonResponse } from "./http.ts";
import { EDGE_KINDS, type EdgeKind, type RigCatalog, type RigMapModel, type RigDraftChange, type RigDraftResult, type DeclaredSeat } from "../shared/motoko-topology.ts";
import type { Known } from "../shared/motoko.ts";

export interface OwnerReadContext {ownerSessionId:string;allowedRigKeys:ReadonlySet<string>;signal:AbortSignal;recheck():void}
export interface RigModelReader {
 listAllowedRigs(context:OwnerReadContext):Promise<RigCatalog>;
 readRigModel(context:OwnerReadContext,key:string):Promise<RigMapModel>;
 validateDraft(context:OwnerReadContext,key:string,input:unknown):Promise<RigDraftResult>;
}
export class RigMapError extends Error { constructor(public code:string,public status=502){super(code);} }
function fail(code:string,status=502):never {throw new RigMapError(code,status);}
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
const unknown=<T>(reason:string):Known<T>=>({state:"unknown",reason});
const known=<T>(value:T,at:string):Known<T>=>({state:"known",value,observedAt:at});
const ID=/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const LOGICAL=/^[a-z][a-z0-9-]{0,47}(?:\.[a-z][a-z0-9-]{0,47})?$/;
const TOKEN=/^[a-zA-Z0-9][a-zA-Z0-9._:+-]{0,119}$/;
const omitted:RigMapModel["configuration"]["omitted"]=["paths","instructions","credentials","hooks","resume","resource-bodies"];
const string=(value:unknown,max=120):string=>safeMapText(value,max)?value:fail("invalid_graph");
const optional=(value:unknown,at:string):Known<string>=>value==null?unknown("not_reported"):known(string(value),at);
const edgeKind=(value:unknown):EdgeKind=>EDGE_KINDS.includes(value as EdgeKind)?value as EdgeKind:fail("unsupported_operation");
function check(context:OwnerReadContext,key?:string){
 try {context.signal.throwIfAborted();context.recheck();} catch {fail("owner_required",401);}
 if(key!==undefined&&!context.allowedRigKeys.has(key))fail("rig_not_allowed",404);
}
/** Read bytes before decode. Always cancel the reader, including errors and deadline exits. */
async function bounded(response:Response,limit:number,signal:AbortSignal):Promise<string>{
 const reader=response.body?.getReader();if(!reader)return "";
 const chunks:Uint8Array[]=[];let length=0;
 const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener("abort",cancel,{once:true});
 try {
  if(Number(response.headers.get("content-length"))>limit)fail("source_too_large");
  for(;;){signal.throwIfAborted();const next=await reader.read();if(next.done)break;length+=next.value.byteLength;if(length>limit)fail("source_too_large");chunks.push(next.value);}
  signal.throwIfAborted();const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return new TextDecoder("utf-8",{fatal:true}).decode(bytes);
 } finally {signal.removeEventListener("abort",cancel);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
function projectGraph(raw:unknown,rigId:string,started:string,completed:string):RigMapModel["graph"]{
 if(!object(raw)||!Array.isArray(raw["nodes"])||!Array.isArray(raw["edges"])||raw["nodes"].length>232||raw["edges"].length>1000)fail("invalid_graph");
 const ids=new Set<string>(),logical=new Set<string>();const pods:RigMapModel["graph"]["pods"]=[],seats:RigMapModel["graph"]["seats"]=[];
 for(const node of raw["nodes"]){
  if(!object(node)||!object(node["data"])||typeof node["id"]!=="string"||ids.has(node["id"]))fail("invalid_graph");ids.add(node["id"]);
  const data=node["data"];if(data["rigId"]!==rigId)fail("invalid_graph");
  if(node["type"]==="podGroup"){
   if(typeof data["podId"]!=="string"||!ID.test(data["podId"])||node["id"]!==`pod-${data["podId"]}`||typeof data["podNamespace"]!=="string"||!LOGICAL.test(data["podNamespace"]))fail("invalid_graph");
   pods.push({id:data["podId"],namespace:data["podNamespace"],label:string(data["podLabel"])});continue;
  }
  if(node["type"]!=="rigNode"||!ID.test(node["id"])||typeof data["logicalId"]!=="string"||!LOGICAL.test(data["logicalId"])||logical.has(data["logicalId"]))fail("invalid_graph");
  logical.add(data["logicalId"]);const podId=data["podId"]??null;
  if(!(podId===null||typeof podId==="string"&&ID.test(podId))||(podId===null?node["parentId"]!=null:node["parentId"]!==`pod-${podId}`))fail("invalid_graph");
  const source=(value:unknown)=>({value:optional(value,completed),source:"graph" as const,readAt:completed});
  const percent=data["contextUsedPercentage"];const available=data["contextAvailability"]==="known";
  seats.push({id:node["id"],logicalId:data["logicalId"],podId,sessionName:data["canonicalSessionName"]==null?unknown("not_reported"):known(string(data["canonicalSessionName"],160),completed),
   role:source(data["role"]),runtime:source(data["runtime"]),model:source(data["model"]),agentProfile:source(data["profile"]),sessionStatus:optional(data["status"],completed),startupStatus:optional(data["startupStatus"],completed),
   context:{percent:available&&typeof percent==="number"&&Number.isFinite(percent)&&percent>=0&&percent<=100?known(percent,completed):unknown("context_not_reported"),fresh:available&&data["contextFresh"]===true,availability:available?"known":"unknown"}});
 }
 if(pods.length>32||seats.length>200||new Set(pods.map(p=>p.namespace)).size!==pods.length||seats.some(s=>s.podId!==null&&!pods.some(p=>p.id===s.podId)))fail("invalid_graph");
 const seatIds=new Set(seats.map(s=>s.id)),edgeIds=new Set<string>();
 const edges=raw["edges"].map((edge:unknown)=>{
  if(!object(edge)||!safeMapText(edge["id"])||edgeIds.has(edge["id"])||typeof edge["source"]!=="string"||typeof edge["target"]!=="string"||!seatIds.has(edge["source"])||!seatIds.has(edge["target"]))fail("invalid_graph");
  edgeIds.add(edge["id"]);return {id:edge["id"],sourceId:edge["source"],targetId:edge["target"],kind:edgeKind(edge["label"])};
 });
 return {state:"known",readStartedAt:started,readCompletedAt:completed,staleAfterMs:30000,source:"OpenRig",captureRequested:false,pods,seats,edges};
}
interface Member {logicalId:string;raw:Record<string,unknown>;pod:string|null}
function members(raw:unknown,graph:RigMapModel["graph"],name:string):Member[]{
 if(!object(raw)||raw["name"]!==name)fail("invalid_configuration");const result:Member[]=[];
 if(Array.isArray(raw["pods"])){
  if(raw["pods"].length!==graph.pods.length)fail("invalid_configuration");const seen=new Set<string>();
  for(const pod of raw["pods"]){
   if(!object(pod)||typeof pod["id"]!=="string"||seen.has(pod["id"])||!graph.pods.some(p=>p.namespace===pod["id"])||!Array.isArray(pod["members"])||!Array.isArray(pod["edges"]))fail("invalid_configuration");seen.add(pod["id"]);
   for(const member of pod["members"]){if(!object(member)||typeof member["id"]!=="string"||!LOGICAL.test(member["id"])||member["id"].includes("."))fail("invalid_configuration");result.push({logicalId:`${pod["id"]}.${member["id"]}`,raw:member,pod:pod["id"]});}
  }
 }else if(Array.isArray(raw["nodes"])){
  if(graph.pods.length)fail("invalid_configuration");for(const node of raw["nodes"]){if(!object(node)||typeof node["id"]!=="string"||!LOGICAL.test(node["id"]))fail("invalid_configuration");result.push({logicalId:node["id"],raw:node,pod:null});}
 }else fail("invalid_configuration");
 if(result.length!==graph.seats.length||new Set(result.map(m=>m.logicalId)).size!==result.length||result.some(m=>!graph.seats.some(s=>s.logicalId===m.logicalId&&(m.pod===null?s.podId===null:graph.pods.some(p=>p.id===s.podId&&p.namespace===m.pod)))))fail("invalid_configuration");
 if(!Array.isArray(raw["edges"]))fail("invalid_configuration");return result;
}
function declared(rows:Member[],at:string):DeclaredSeat[]{
 return rows.map(m=>({logicalId:m.logicalId,role:optional(m.raw["role"],at),runtime:optional(m.raw["runtime"],at),model:optional(m.raw["model"],at),agentProfile:optional(m.raw["profile"],at),codexConfigProfile:optional(m.raw["codex_config_profile"],at),restorePolicy:optional(m.raw["restore_policy"],at)}));
}
function changes(input:unknown):{snapshotId:string;changes:RigDraftChange[]}{
 if(!object(input)||Object.keys(input).some(k=>k!=="snapshotId"&&k!=="changes")||typeof input["snapshotId"]!=="string"||!/^[a-f0-9]{64}$/.test(input["snapshotId"])||!Array.isArray(input["changes"])||input["changes"].length>20||Buffer.byteLength(JSON.stringify(input))>16384)fail("unsupported_operation",400);
 const parsed=input["changes"].map((c:unknown):RigDraftChange=>{
  if(!object(c))fail("unsupported_operation",400);
  const keys=(allowed:string[])=>{if(Object.keys(c).some(k=>!allowed.includes(k)))fail("unsupported_operation",400);};
  if(c["kind"]==="seat-model"||c["kind"]==="seat-profile"){
   keys(["kind","seatId","value"]);if(typeof c["seatId"]!=="string"||typeof c["value"]!=="string"||!TOKEN.test(c["value"])||!safeMapText(c["value"]))fail("unsupported_operation",400);
   return {kind:c["kind"],seatId:c["seatId"],value:c["value"]};
  }
  if(c["kind"]==="edge-add"){
   keys(["kind","sourceId","targetId","edgeKind"]);if(typeof c["sourceId"]!=="string"||typeof c["targetId"]!=="string")fail("unsupported_operation",400);
   return {kind:"edge-add",sourceId:c["sourceId"],targetId:c["targetId"],edgeKind:edgeKind(c["edgeKind"])};
  }
  if(c["kind"]==="edge-remove"){
   keys(["kind","edgeId"]);if(typeof c["edgeId"]!=="string")fail("unsupported_operation",400);return {kind:"edge-remove",edgeId:c["edgeId"]};
  }
  return fail("unsupported_operation",400);
 });
 const removed=parsed.filter(c=>c.kind==="edge-remove").map(c=>c.edgeId);if(new Set(removed).size!==removed.length)fail("unsupported_operation",400);
 return {snapshotId:input["snapshotId"],changes:parsed};
}
function amend(raw:Record<string,unknown>,rows:Member[],graph:RigMapModel["graph"],change:RigDraftChange){
 const seat=(id:string)=>{const s=graph.seats.find(s=>s.id===id);if(!s)fail("unsupported_operation",400);return rows.find(m=>m.logicalId===s.logicalId)!;};
 if(change.kind==="seat-model"||change.kind==="seat-profile"){seat(change.seatId).raw[change.kind==="seat-model"?"model":"profile"]=change.value;return;}
 const edge=(from:Member,to:Member)=>{
  if(from.pod!==null&&from.pod===to.pod){const pod=(raw["pods"] as Record<string,unknown>[]).find(p=>p["id"]===from.pod)!;return {container:pod,from:from.raw["id"],to:to.raw["id"]};}
  return {container:raw,from:from.logicalId,to:to.logicalId};
 };
 if(change.kind==="edge-add"){
  const e=edge(seat(change.sourceId),seat(change.targetId));(e.container["edges"] as unknown[]).push({from:e.from,to:e.to,kind:change.edgeKind});return;
 }
 if(change.kind!=="edge-remove")fail("unsupported_operation",400);
 const found=graph.edges.find(e=>e.id===change.edgeId);if(!found)fail("unsupported_operation",400);
 const e=edge(seat(found.sourceId),seat(found.targetId));const list=e.container["edges"] as Record<string,unknown>[];
 const index=list.findIndex(r=>r["from"]===e.from&&r["to"]===e.to&&r["kind"]===found.kind);if(index<0)fail("invalid_configuration");list.splice(index,1);
}
export function createRigModelReader(rawScope:MotokoMapScope|null,deps:{now?:()=>number;timeoutMs?:number;transport?:(url:string,init:RequestInit)=>Promise<Response>}={}):RigModelReader {
 const scope=rawScope===null?null:mapScope(rawScope,null);const now=deps.now??Date.now;const iso=()=>new Date(now()).toISOString();const transport=deps.transport??((url,init)=>{
  // @ts-expect-error Bun 1.4.3 supports proxy:false; remove when the Bun types accept it.
  return fetch(url,{...init,proxy:false});
 });
 const scopeRevision=hash(JSON.stringify(scope));
 function catalog(context:OwnerReadContext):RigCatalog{
  check(context);if(!scope)fail("scope_unconfigured",503);const at=iso();
  const mapping=(rows:{key:string;label:string}[],key:string|null)=>{const found=rows.find(r=>r.key===key);return found?known({key:found.key,label:found.label},at):unknown<{key:string;label:string}>("unassigned");};
  return {source:"private-scope",completeFleet:false,rigs:scope.rigs.filter(r=>context.allowedRigKeys.has(r.key)).map(r=>({key:r.key,id:r.rigId,name:r.rigName,label:r.label,ownerProfile:mapping(scope.ownerProfiles,r.ownerProfileKey),project:mapping(scope.projects,r.projectKey)}))};
 }
 const resolve=(context:OwnerReadContext,key:string)=>{check(context,key);const rig=catalog(context).rigs.find(r=>r.key===key);if(!rig)fail("rig_not_allowed",404);return rig;};
 async function read(context:OwnerReadContext,key:string,path:string,limit:number,body?:string,validation=false){
  check(context,key);const controller=new AbortController();let timedOut=false;
  let rejectStop!:(error:RigMapError)=>void;const stopped=new Promise<never>((_,reject)=>{rejectStop=reject;});
  const stop=()=>{rejectStop(new RigMapError("owner_required",401));controller.abort();};
  context.signal.addEventListener("abort",stop,{once:true});
  const timer=setTimeout(()=>{timedOut=true;rejectStop(new RigMapError("source_timeout"));controller.abort();},deps.timeoutMs??1500);
  try {
   check(context,key);
   const work=async()=>{const response=await transport(`http://127.0.0.1:7433${path}`,{method:body===undefined?"GET":"POST",redirect:"error",signal:controller.signal,headers:body===undefined?{}:{"content-type":"application/json"},...(body===undefined?{}:{body})});
    if(!response.ok&&!(validation&&response.status===400)){await response.body?.cancel().catch(()=>{});fail("source_unavailable");}
    return bounded(response,limit,controller.signal);
   };
   const text=await Promise.race([work(),stopped]);check(context,key);return text;
  } catch(error){if(context.signal.aborted)fail("owner_required",401);if(timedOut)fail("source_timeout");if(error instanceof RigMapError)throw error;return fail("source_unavailable");}
  finally{clearTimeout(timer);context.signal.removeEventListener("abort",stop);controller.abort();}
 }
 async function load(context:OwnerReadContext,key:string){
  const rig=resolve(context,key),started=iso();let graphRaw:unknown;
  try{graphRaw=JSON.parse(await read(context,key,`/api/rigs/${rig.id}/graph`,262144));}catch(error){if(error instanceof RigMapError)throw error;return fail("invalid_graph");}
  const graph=projectGraph(graphRaw,rig.id,started,iso());const configStarted=iso();
  let spec:Record<string,unknown>|null=null;let rows:Member[]=[];
  let configuration:RigMapModel["configuration"]={state:"unknown",readStartedAt:configStarted,readCompletedAt:null,snapshotId:null,declared:[],effectiveRuntime:unknown("complete_runtime_configuration_not_reported"),omitted,reason:"invalid_configuration"};
  try {
   const bytes=await read(context,key,`/api/rigs/${rig.id}/spec`,524288);const parsed:unknown=YAML.parse(bytes);rows=members(parsed,graph,rig.name);if(!object(parsed))fail("invalid_configuration");spec=parsed;
   const at=iso();configuration={state:"known",readStartedAt:configStarted,readCompletedAt:at,snapshotId:hash(JSON.stringify([rig.id,scopeRevision,bytes])),declared:declared(rows,at),effectiveRuntime:unknown("complete_runtime_configuration_not_reported"),omitted,reason:null};
  } catch(error){check(context,key);configuration.reason=error instanceof RigMapError?error.code:"invalid_configuration";configuration.readCompletedAt=iso();spec=null;rows=[];}
  const model:RigMapModel={version:1,rig:{key:rig.key,id:rig.id,name:rig.name,label:rig.label},scope:{ownerProfile:rig.ownerProfile,project:rig.project},graph,configuration,consistency:"separate-reads",viewRevision:"",capabilities:{inspect:true,validateDraft:spec!==null,apply:false,hermesAdapter:false}};
  model.viewRevision=hash(JSON.stringify(model));if(Buffer.byteLength(JSON.stringify(model))>262144)fail("source_too_large");check(context,key);return {model,spec,rows};
 }
 return {
  async listAllowedRigs(context){const result=catalog(context);check(context);return result;},
  async readRigModel(context,key){return (await load(context,key)).model;},
  async validateDraft(context,key,input){
   resolve(context,key);const request=changes(input);const {model,spec,rows}=await load(context,key);
   if(!spec||!model.configuration.snapshotId)fail("invalid_configuration");if(request.snapshotId!==model.configuration.snapshotId)fail("snapshot_changed",409);
   for(const change of request.changes)amend(spec,rows,model.graph,change);
   const body=JSON.stringify(spec);if(Buffer.byteLength(body)>524288)fail("source_too_large");
   let raw:unknown;try{raw=JSON.parse(await read(context,key,"/api/rigs/import/validate",65536,body,true));}catch(error){if(error instanceof RigMapError)throw error;return fail("invalid_configuration");}
   if(!object(raw)||typeof raw["valid"]!=="boolean")fail("invalid_configuration");check(context,key);
   return {valid:raw["valid"],applied:false,snapshotId:request.snapshotId,errors:raw["valid"]?[]:[{changeIndex:null,code:"schema_invalid",field:null}],effects:request.changes.map((c,changeIndex)=>({changeIndex,operation:c.kind==="seat-model"?"stored-model-only":c.kind==="seat-profile"?"unsupported-profile-edit":"unsupported-edge-edit",liveRuntimeChanged:false}))};
  }
 };
}
/** Future turn handlers supply a server-bound context. Model text supplies no authority. */
export function ownerRigTools(reader:RigModelReader,context:OwnerReadContext){
 return {
  async list_managed_rigs(){check(context);const result=await reader.listAllowedRigs(context);check(context);return result;},
  async read_rig_model(input:{rigKey:string}){
   if(!object(input)||Object.keys(input).length!==1||typeof input["rigKey"]!=="string")fail("rig_not_allowed",404);
   check(context,input["rigKey"]);const result=await reader.readRigModel(context,input["rigKey"]);check(context,input["rigKey"]);return result;
  }
 };
}
export async function handleRigMapRequest(request:Request,reader:RigModelReader,context:OwnerReadContext|null):Promise<Response>{
 const headers={"cache-control":"no-store"};
 try {
  if(!context)fail("owner_gate_required",404);check(context);
  const url=new URL(request.url);if(url.search)fail("unsupported_operation",400);
  let result:unknown;
  if(url.pathname==="/api/motoko/map/rigs"&&request.method==="GET")result=await reader.listAllowedRigs(context);
  else {
   const match=/^\/api\/motoko\/map\/rigs\/([a-z][a-z0-9-]{0,47})(\/validate)?$/.exec(url.pathname);
   if(!match)fail("rig_not_allowed",404);
   if(!match[2]&&request.method==="GET")result=await reader.readRigModel(context,match[1]!);
   else if(match[2]&&request.method==="POST"){
    let raw:unknown;try{raw=JSON.parse(await bounded(new Response(request.body),16384,context.signal));}catch(error){if(error instanceof RigMapError)throw error;return fail("unsupported_operation",400);}
    result=await reader.validateDraft(context,match[1]!,raw);
   }else fail("method_not_allowed",405);
  }
  check(context);return jsonResponse(result,200,headers);
 }catch(error){const e=error instanceof RigMapError?error:new RigMapError("source_unavailable");return jsonResponse({error:{code:e.code,message:e.code}},e.status,headers);}
}
