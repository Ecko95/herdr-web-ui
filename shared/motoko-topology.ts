import type { Known } from "./motoko.ts";

export const EDGE_KINDS = ["delegates_to", "spawned_by", "can_observe", "collaborates_with", "escalates_to"] as const;
export type EdgeKind = typeof EDGE_KINDS[number];
export interface RigCatalogEntry { key:string; id:string; name:string; label:string; ownerProfile:Known<{key:string;label:string}>; project:Known<{key:string;label:string}> }
export interface RigCatalog { rigs:RigCatalogEntry[]; source:"private-scope"; completeFleet:false }
export interface SourceValue<T> { value:Known<T>; source:"graph"|"spec-export"|"private-scope"; readAt:string }
export interface RigMapSeat {
 id:string;logicalId:string;podId:string|null;sessionName:Known<string>;
 role:SourceValue<string>;runtime:SourceValue<string>;model:SourceValue<string>;agentProfile:SourceValue<string>;
 sessionStatus:Known<string>;startupStatus:Known<string>;
 context:{percent:Known<number>;fresh:boolean;availability:"known"|"unknown"};
}
export interface DeclaredSeat { logicalId:string;role:Known<string>;runtime:Known<string>;model:Known<string>;agentProfile:Known<string>;codexConfigProfile:Known<string>;restorePolicy:Known<string> }
export interface RigMapModel {
 version:1;rig:{key:string;id:string;name:string;label:string};scope:{ownerProfile:RigCatalogEntry["ownerProfile"];project:RigCatalogEntry["project"]};
 graph:{state:"known";readStartedAt:string;readCompletedAt:string;staleAfterMs:30000;source:"OpenRig";captureRequested:false;pods:{id:string;namespace:string;label:string}[];seats:RigMapSeat[];edges:{id:string;sourceId:string;targetId:string;kind:EdgeKind}[]};
 configuration:{state:"known"|"unknown";readStartedAt:string|null;readCompletedAt:string|null;snapshotId:string|null;declared:DeclaredSeat[];effectiveRuntime:Known<never>;omitted:("paths"|"instructions"|"credentials"|"hooks"|"resume"|"resource-bodies")[];reason:string|null};
 consistency:"separate-reads";viewRevision:string;capabilities:{inspect:true;validateDraft:boolean;apply:false;hermesAdapter:false};
}
export type RigDraftChange = {kind:"seat-model"|"seat-profile";seatId:string;value:string}|{kind:"edge-add";sourceId:string;targetId:string;edgeKind:EdgeKind}|{kind:"edge-remove";edgeId:string};
export interface RigDraftRequest { snapshotId:string;changes:RigDraftChange[] }
export interface RigDraftResult { valid:boolean;applied:false;snapshotId:string;errors:{changeIndex:number|null;code:string;field:string|null}[];effects:{changeIndex:number;operation:"stored-model-only"|"unsupported-profile-edit"|"unsupported-edge-edit";liveRuntimeChanged:false}[] }

export interface MapPreferences {rigKey:string|null;mode:"map"|"list";zoom:number;podFilter:string|null}
export function sanitizeMapPreferences(raw:unknown):MapPreferences {
 const r=raw!==null&&typeof raw==="object"?raw as Record<string,unknown>:{};
 const key=(v:unknown)=>typeof v==="string"&&/^[a-z][a-z0-9-]{0,47}$/.test(v)?v:null;
 return {rigKey:key(r["rigKey"]),mode:r["mode"]==="list"?"list":"map",zoom:typeof r["zoom"]==="number"&&Number.isFinite(r["zoom"])&&r["zoom"]>=0.5&&r["zoom"]<=2?r["zoom"]:1,podFilter:key(r["podFilter"])};
}
