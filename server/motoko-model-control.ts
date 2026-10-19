import { isJsonObject as object, jsonResponse } from "./http.ts";
import { safeMapText } from "./motoko-config.ts";
import { RigMapError, type OwnerReadContext, type RigModelReader } from "./motoko-topology.ts";
import type { ModelSaveInput, ModelSaveResult } from "../shared/motoko-model-control.ts";
import type { RigMapModel } from "../shared/motoko-topology.ts";

export interface ModelOwnerContext extends OwnerReadContext {origin:string}
function fail(code:string,status=400):never{throw new RigMapError(code,status);}
const ID=/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const LOGICAL=/^[a-z][a-z0-9-]{0,47}(?:\.[a-z][a-z0-9-]{0,47})?$/;
const TOKEN=/^[a-zA-Z0-9][a-zA-Z0-9._:+-]{0,119}$/;
function check(context:OwnerReadContext,key:string){
 try{context.signal.throwIfAborted();context.recheck();}catch{fail("owner_required",401);}
 if(!context.allowedRigKeys.has(key))fail("rig_not_allowed",404);
}
function input(raw:unknown):ModelSaveInput {
 if(!object(raw)||Object.keys(raw).length!==5||Object.keys(raw).some(k=>!["seatId","logicalId","expectedModel","model","reason"].includes(k)))fail("invalid_model_request");
 for(const key of ["seatId","logicalId","expectedModel","model","reason"])if(typeof raw[key]!=="string")fail("invalid_model_request");
 if(!ID.test(raw["seatId"] as string)||!LOGICAL.test(raw["logicalId"] as string))fail("invalid_model_request");
 for(const key of ["expectedModel","model"])if(!TOKEN.test(raw[key] as string)||!safeMapText(raw[key]))fail("invalid_model_request");
 const reason=raw["reason"] as string;
 if(!reason.trim()||reason.length>500||!safeMapText(reason,500))fail("invalid_model_request");
 return {seatId:raw["seatId"] as string,logicalId:raw["logicalId"] as string,expectedModel:raw["expectedModel"] as string,model:raw["model"] as string,reason:reason.trim()};
}
async function body(response:Response,limit:number,signal:AbortSignal):Promise<string>{
 const stream=response.body?.getReader();if(!stream)return "";
 const chunks:Uint8Array[]=[];let size=0;
 const cancel=()=>{void stream.cancel().catch(()=>{});};signal.addEventListener("abort",cancel,{once:true});
 try{
  if(Number(response.headers.get("content-length"))>limit)fail("invalid_model_request");
  for(;;){signal.throwIfAborted();const next=await stream.read();signal.throwIfAborted();if(next.done)break;size+=next.value.byteLength;if(size>limit)fail("invalid_model_request");chunks.push(next.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return new TextDecoder("utf-8",{fatal:true}).decode(bytes);
 }finally{signal.removeEventListener("abort",cancel);void stream.cancel().catch(()=>{});stream.releaseLock();}
}
function seatIn(model:RigMapModel,rigId:string,request:ModelSaveInput){
 if(model.rig.id!==rigId)fail("seat_changed",409);
 const seat=model.graph.seats.find(s=>s.id===request.seatId&&s.logicalId===request.logicalId);
 if(!seat||seat.sessionName.state!=="known"||!safeMapText(seat.sessionName.value,160)||!seat.sessionName.value.endsWith(`@${model.rig.name}`)||seat.sessionName.value.split("@").length!==2)fail("seat_changed",409);
 return seat;
}
export function createModelControl(reader:RigModelReader,deps:{timeoutMs?:number;transport?:(url:string,init:RequestInit)=>Promise<Response>}={}){
 const transport=deps.transport??((url,init)=>{
  // @ts-expect-error Bun 1.4.3 supports proxy:false; remove when the Bun types accept it.
  return fetch(url,{...init,proxy:false});
 });
 return {async save(context:OwnerReadContext,key:string,raw:unknown):Promise<ModelSaveResult>{
  check(context,key);const request=input(raw);
  const catalog=await reader.listAllowedRigs(context);check(context,key);
  const rig=catalog.rigs.find(r=>r.key===key);if(!rig)fail("rig_not_allowed",404);
  const before=await reader.readRigModel(context,key);check(context,key);
  const seat=seatIn(before,rig.id,request);
  if(before.rig.name!==rig.name||seat.model.value.state!=="known"||seat.model.value.value!==request.expectedModel)fail("model_changed",409);
  const result=(outcome:ModelSaveResult["outcome"],changed:boolean|null=null,savedModel:string|null=null,readback:ModelSaveResult["readback"]="unknown"):ModelSaveResult=>({outcome,rigId:rig.id,seatId:seat.id,logicalId:seat.logicalId,targetModel:request.model,changed,savedModel,readback});
  if(request.model===request.expectedModel)return result("no-op",false,request.model,"known");
  const controller=new AbortController();
  let rejectStop!:(error:Error)=>void;
  const stopped=new Promise<never>((_,reject)=>{rejectStop=reject;});
  const abort=()=>{rejectStop(new Error("write_unknown"));controller.abort();};
  const timer=setTimeout(abort,deps.timeoutMs??1500);
  context.signal.addEventListener("abort",abort,{once:true});
  let response:Response,answer:unknown;
  try{
   // The upstream route has no conditional write. This check cannot exclude another writer.
   check(context,key);
   const work=async()=>{
    const response=await transport(`http://127.0.0.1:7433/api/seat/set-model/${encodeURIComponent(seat.sessionName.state==="known"?seat.sessionName.value:fail("seat_changed",409))}`,{method:"POST",redirect:"error",signal:controller.signal,headers:{"content-type":"application/json"},body:JSON.stringify({model:request.model,reason:request.reason,operator:"motoko-owner"})});
    check(context,key);const text=await body(response,16384,controller.signal);check(context,key);
    return {response,answer:JSON.parse(text) as unknown};
   };
   ({response,answer}=await Promise.race([work(),stopped]));check(context,key);
  }catch{check(context,key);return result("unknown");}
  finally{clearTimeout(timer);context.signal.removeEventListener("abort",abort);controller.abort();}
  if(!object(answer))return result("unknown");
  if(!response.ok){
   const definite=answer["ok"]===false&&[400,404,409].includes(response.status)&&["seat_not_found","seat_ambiguous","seat_ref_required","missing_model","reason_required"].includes(String(answer["code"]));
   return result(definite?"refused":"unknown");
  }
  if(answer["ok"]!==true||typeof answer["changed"]!=="boolean"||!(answer["from"]===null||typeof answer["from"]==="string"&&safeMapText(answer["from"]))||answer["to"]!==request.model||!object(answer["seat"])||answer["seat"]["rigId"]!==rig.id||answer["seat"]["nodeId"]!==seat.id||answer["seat"]["logicalId"]!==seat.logicalId)return result("unknown");
  const changed=answer["changed"];
  try{
   const after=await reader.readRigModel(context,key);check(context,key);
   const current=seatIn(after,rig.id,request);
   if(current.sessionName.state!=="known"||seat.sessionName.state!=="known"||current.sessionName.value!==seat.sessionName.value||current.model.value.state!=="known")return result("unknown",changed);
   const saved=current.model.value.value;
   return result(saved!==request.model||answer["from"]!==request.expectedModel?"conflict":changed?"saved":"no-op",changed,saved,"known");
  }catch{check(context,key);return result("unknown",changed);}
 }};
}
export async function handleModelControlRequest(request:Request,control:ReturnType<typeof createModelControl>,context:ModelOwnerContext|null,deps:{bodyTimeoutMs?:number}={}):Promise<Response>{
 const headers={"cache-control":"no-store"};
 try{
  if(!context)fail("owner_gate_required",404);
  const url=new URL(request.url),match=/^\/api\/motoko\/map\/rigs\/([a-z][a-z0-9-]{0,47})\/model$/.exec(url.pathname);
  if(!match||url.search)fail("invalid_model_request");check(context,match[1]!);
  if(request.method!=="POST")fail("method_not_allowed",405);
  if(request.headers.get("origin")!==context.origin)fail("invalid_origin",403);
  if(request.headers.get("content-type")?.split(";")[0]?.trim()!=="application/json")fail("invalid_model_request");
  const deadline=new AbortController(),signal=AbortSignal.any([context.signal,deadline.signal]);
  const timer=setTimeout(()=>deadline.abort(),deps.bodyTimeoutMs??5000);
  let raw:unknown;
  try{raw=JSON.parse(await body(new Response(request.body),4096,signal));}
  catch{check(context,match[1]!);fail(deadline.signal.aborted?"model_body_timeout":"invalid_model_request",deadline.signal.aborted?408:400);}
  finally{clearTimeout(timer);}
  check(context,match[1]!);const result=await control.save(context,match[1]!,raw);check(context,match[1]!);
  return jsonResponse(result,200,headers);
 }catch(error){const e=error instanceof RigMapError?error:new RigMapError("model_save_unavailable",502);return jsonResponse({error:{code:e.code,message:"The model save did not return a confirmed result."}},e.status,headers);}
}
