import { realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
/** Private startup scope. Request fields never select this target. */
export interface MotokoTarget { rigId: string; rigName: string; sourceSession: string; humanId: string; destinationSession: string }

export function motokoTarget(env: Record<string, string | undefined>): MotokoTarget | null {
  const rigId = env["HERDR_WEB_MOTOKO_RIG_ID"];
  const rigName = env["HERDR_WEB_MOTOKO_RIG_NAME"];
  const sourceSession = env["HERDR_WEB_MOTOKO_SOURCE_SESSION"];
  if (!rigId || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(rigId) || !rigName || !/^[a-z][a-z0-9-]{0,47}$/.test(rigName) ||
    !sourceSession || !/^[a-z][a-z0-9-]{0,47}@external$/.test(sourceSession)) return null;
  return { rigId, rigName, sourceSession, humanId: sourceSession.slice(0, -"@external".length), destinationSession: `team-orchestrator@${rigName}` };
}

export interface MotokoMapScope {
 rigs:{key:string;rigId:string;rigName:string;label:string;ownerProfileKey:string|null;projectKey:string|null}[];
 ownerProfiles:{key:string;label:string}[];
 projects:{key:string;label:string}[];
}
const MAP_KEY = /^[a-z][a-z0-9-]{0,47}$/;
export function safeMapText(value:unknown, max=120): value is string {
 return typeof value === "string" && value.length>0 && value.length<=max && !/[\x00-\x1f\x7f<>\\/]/.test(value) && !/(?:sk-|Bearer |token[=:]|password[=:]|[a-f0-9]{32,})/i.test(value);
}
/** Explicit invalid scope fails closed. This function never discovers rigs. */
export function mapScope(raw:unknown, target:MotokoTarget|null):MotokoMapScope|null {
 if(raw===undefined) return target ? {rigs:[{key:target.rigName,rigId:target.rigId,rigName:target.rigName,label:target.rigName,ownerProfileKey:null,projectKey:null}],ownerProfiles:[],projects:[]} : null;
 const object=(v:unknown):v is Record<string,unknown>=>v!==null && typeof v==="object" && !Array.isArray(v);
 const bad=()=>{throw new Error("invalid_map_scope");};
 if(!object(raw)||!Array.isArray(raw["rigs"])||raw["rigs"].length<1||raw["rigs"].length>32||!Array.isArray(raw["ownerProfiles"])||!Array.isArray(raw["projects"]))return bad();
 const mappings=(rows:unknown[]):{key:string;label:string}[]=>{
  if(rows.length>32)return bad();const seen=new Set<string>();return rows.map(r=>{
   if(!object(r)||typeof r["key"]!=="string"||!MAP_KEY.test(r["key"])||!safeMapText(r["label"])||seen.has(r["key"]))return bad();
   seen.add(r["key"]);return {key:r["key"],label:r["label"]};
  });
 };
 const ownerProfiles=mappings(raw["ownerProfiles"]),projects=mappings(raw["projects"]);
 const keys=new Set<string>(),ids=new Set<string>(),names=new Set<string>();
 const rigs=raw["rigs"].map(r=>{
  if(!object(r)||typeof r["key"]!=="string"||!MAP_KEY.test(r["key"])||typeof r["rigId"]!=="string"||!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(r["rigId"])||typeof r["rigName"]!=="string"||!MAP_KEY.test(r["rigName"])||!safeMapText(r["label"])||keys.has(r["key"])||ids.has(r["rigId"])||names.has(r["rigName"]))return bad();
  const profile=r["ownerProfileKey"],project=r["projectKey"];
  if(!(profile===null||typeof profile==="string"&&ownerProfiles.some(p=>p.key===profile))||!(project===null||typeof project==="string"&&projects.some(p=>p.key===project)))return bad();
  keys.add(r["key"]);ids.add(r["rigId"]);names.add(r["rigName"]);
  return {key:r["key"],rigId:r["rigId"],rigName:r["rigName"],label:r["label"],ownerProfileKey:profile,projectKey:project};
 });
 return {rigs,ownerProfiles,projects};
}

/** Optional JSON catalog from private startup configuration; absent input keeps the one-rig fallback. */
export function motokoMapScopeFromEnv(env: Record<string, string | undefined>): MotokoMapScope | undefined {
  const text = env["HERDR_WEB_MOTOKO_MAP_SCOPE"];
  if (text === undefined) return undefined;
  if (Buffer.byteLength(text, "utf8") > 65536) throw new Error("invalid_map_scope");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("invalid_map_scope"); }
  return mapScope(raw, null)!;
}

/** Private owner-selected records. An absent mapping never selects a default profile. */
export interface ChatBinding {
 id:string; revision:number; rigKey:string; rigId:string; label:string; profile:string; home:string; bank:string;
 workspace:string; endpoint:string; runtime:string; python:string; revisionSha:string;
}
export function chatBindings(text:string|undefined, scope:MotokoMapScope|null, canonical:(path:string)=>string=realpathSync):ChatBinding[] {
 if(text===undefined)return [];
 const bad=():never=>{throw new Error("invalid_chat_binding");};
 if(Buffer.byteLength(text)>65536)return bad();
 let raw:unknown;try{raw=JSON.parse(text);}catch{return bad();}
 if(!Array.isArray(raw)||raw.length>32)return bad();
 const ids=new Set<string>(),rigs=new Set<string>();
 return raw.map(value=>{
  if(value===null||typeof value!=="object"||Array.isArray(value))return bad();
  const r=value as Record<string,unknown>;
  const keys=["id","revision","rigKey","rigId","label","profile","home","bank","workspace","endpoint","runtime","python","revisionSha"];
  if(Object.keys(r).length!==keys.length||keys.some(k=>!(k in r)))return bad();
  if(typeof r["id"]!=="string"||!/^([a-f0-9]{32})$/.test(r["id"])||ids.has(r["id"])||!Number.isSafeInteger(r["revision"])||Number(r["revision"])<1||
   typeof r["rigKey"]!=="string"||rigs.has(r["rigKey"])||!scope?.rigs.some(x=>x.key===r["rigKey"]&&x.rigId===r["rigId"])||!safeMapText(r["label"])||
   typeof r["profile"]!=="string"||!MAP_KEY.test(r["profile"])||r["bank"]!==r["profile"]||typeof r["revisionSha"]!=="string"||! /^[a-f0-9]{40}$/.test(r["revisionSha"]))return bad();
  for(const k of ["home","workspace","runtime","python"]){
   const path=r[k];if(typeof path!=="string"||!isAbsolute(path)||normalize(path)!==path||/[\x00-\x1f\x7f]/.test(path))return bad();
   // A virtualenv executable can be a symlink; its launch spelling selects the environment.
   try{const resolved=canonical(path);if(!isAbsolute(resolved)||(k!=="python"&&resolved!==path))return bad();}catch{return bad();}
  }
  try{const u=new URL(String(r["endpoint"]));if(u.protocol!=="http:"||!["127.0.0.1","[::1]"].includes(u.hostname)||!u.port||u.username||u.password||u.search||u.hash||u.pathname!=="/")return bad();}catch{return bad();}
  ids.add(r["id"]);rigs.add(r["rigKey"]);
  return r as unknown as ChatBinding;
 });
}
export function chatBridgeEnvironment(binding:ChatBinding):Record<string,string> {
 return {PATH:"/usr/bin:/bin",HOME:binding.home,HERMES_HOME:binding.home,HERMES_PROFILE_NAME:binding.profile,PYTHONDONTWRITEBYTECODE:"1",PYTHONNOUSERSITE:"1",PYTHONPATH:binding.runtime};
}
