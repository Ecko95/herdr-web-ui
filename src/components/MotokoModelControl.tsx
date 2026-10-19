import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { saveSeatModel } from "../lib/motoko.ts";
import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import type { ModelSaveResult } from "../../shared/motoko-model-control.ts";

interface Props {rigKey:string;rigId:string;rigName:string;seatId:string;logicalId:string;savedModel:string|null;stale:boolean;refreshVersion?:number;selectionVersion?:number;onSessionEnded:()=>void}
/** A different selection gets a fresh form. A late reply belongs only to its original form. */
export function MotokoModelControl(props:Props){
 return <Control key={`${props.rigKey}:${props.rigId}:${props.seatId}:${props.logicalId}`} {...props}/>;
}
function Control({rigKey,rigId,rigName,seatId,logicalId,savedModel,stale,refreshVersion=0,selectionVersion=0,onSessionEnded}:Props){
 const t=useT(),[target,setTarget]=useState(""),[reason,setReason]=useState("");
 const [busy,setBusy]=useState(false),[result,setResult]=useState<ModelSaveResult|null>(null);
 const active=useRef(true),pending=useRef(false),callback=useRef(onSessionEnded);
 const latestRefresh=useRef(refreshVersion),resultRefresh=useRef(refreshVersion),lastSelection=useRef(selectionVersion);
 useLayoutEffect(()=>{latestRefresh.current=refreshVersion;},[refreshVersion]);
 useLayoutEffect(()=>{
  if(lastSelection.current===selectionVersion)return;lastSelection.current=selectionVersion;
  if(!pending.current&&result&&refreshVersion>resultRefresh.current){setResult(null);setTarget("");setReason("");}
 },[selectionVersion,refreshVersion,result]);
 useLayoutEffect(()=>{callback.current=onSessionEnded;},[onSessionEnded]);
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 const valid=savedModel!==null&&!stale&&/^[a-zA-Z0-9][a-zA-Z0-9._:+-]{0,119}$/.test(target)&&reason.trim().length>0&&reason.length<=500;
 const submit=async()=>{
  if(!valid||pending.current||result)return;
  pending.current=true;setBusy(true);
  const unknown:ModelSaveResult={outcome:"unknown",rigId,seatId,logicalId,targetModel:target,changed:null,savedModel:null,readback:"unknown"};
  try{
   const reply=await saveSeatModel(rigKey,{seatId,logicalId,expectedModel:savedModel!,model:target,reason:reason.trim()});
   if(!active.current)return;
   const matches=reply&&reply.rigId===rigId&&reply.seatId===seatId&&reply.logicalId===logicalId&&reply.targetModel===target;
   resultRefresh.current=latestRefresh.current;setResult(matches?reply:unknown);
  }catch(error){
   if(!active.current)return;resultRefresh.current=latestRefresh.current;setResult(unknown);
   if(error instanceof ApiError&&error.status===401)callback.current();
  }finally{pending.current=false;if(active.current)setBusy(false);}
 };
 return <form className="motoko-map-draft" onSubmit={e=>{e.preventDefault();void submit();}}>
  <h3>{t("Save a model for the next managed resume")}</h3>
  <p>{t("This save does not change the current native model.")}</p>
  <p>{t("A view change does not cancel a remote save.")}</p>
  <p className="motoko-banner">{rigName} · {rigId} · {logicalId} · {seatId} · {savedModel??t("Unknown")} → {target}</p>
  <label>{t("Target model")}<input name="model-target" maxLength={120} value={target} disabled={busy||result!==null} onChange={e=>setTarget(e.target.value)}/></label>
  <label>{t("Reason")}<input name="model-reason" maxLength={500} value={reason} disabled={busy||result!==null} onChange={e=>setReason(e.target.value)}/></label>
  <button className="btn" disabled={!valid||busy||result!==null}>{t("Save")}</button>
  {result&&<p role="status">{result.outcome==="saved"&&result.readback==="known"?t("Saved for the next managed resume."):result.outcome==="no-op"?t("The saved model is unchanged."):result.outcome==="conflict"?t("The model state conflicts with this request."):result.outcome==="refused"?t("The server refused the save."):t("The save result is Unknown.")} {result.readback==="known"&&<span>{t("Saved next-resume model")}: {result.savedModel??t("Unknown")}</span>}</p>}
  {result&&<p>{t("Refresh the map. Select the seat again before another save. No automatic retry occurs.")}</p>}
 </form>;
}
