import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { EDGE_KINDS, type RigCatalog, type RigMapModel, type RigDraftChange, type RigDraftResult } from "../../shared/motoko-topology.ts";
import type { Known } from "../../shared/motoko.ts";
import { useSettings } from "../lib/settings.ts";
import { fetchRigCatalog, fetchRigModel, validateRigDraft } from "../lib/motoko.ts";
import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import "./MotokoMap.css";

/** A deterministic grid groups pods without a hierarchy claim. Links retain their stored direction. */
export function mapLayout(model:RigMapModel) {
 const groups=[...model.graph.pods].sort((a,b)=>a.id.localeCompare(b.id)).map(p=>({id:p.id,label:p.label,namespace:p.namespace,y:0}));
 if(model.graph.seats.some(s=>s.podId===null))groups.push({id:"",label:"",namespace:"",y:0});
 let y=42;const positions=new Map<string,{x:number;y:number}>();
 for(const group of groups){group.y=y;const seats=model.graph.seats.filter(s=>(s.podId??"")===group.id).sort((a,b)=>a.id.localeCompare(b.id));
  for(const[i,seat]of seats.entries())positions.set(seat.id,{x:40+(i%3)*240,y:y+160+Math.floor(i/3)*180});
  y+=200+Math.ceil(seats.length/3)*180;
 }
 return {groups,positions,width:760,height:Math.max(220,y)};
}
export function MotokoMap({onSessionEnded}:{onSessionEnded:()=>void}) {
 const t=useT();const {settings,update}=useSettings();const prefs=settings.motokoMap;
 const callback=useRef(onSessionEnded);useLayoutEffect(()=>{callback.current=onSessionEnded;},[onSessionEnded]);
 const [catalog,setCatalog]=useState<RigCatalog|null>(null),[catalogError,setCatalogError]=useState(false),[catalogRefresh,setCatalogRefresh]=useState(0);
 const [profile,setProfile]=useState(""),[project,setProject]=useState("");
 const [sample,setSample]=useState<{key:string;model:RigMapModel}|null>(null),[failed,setFailed]=useState(false),[now,setNow]=useState(Date.now);
 const [selected,setSelected]=useState<string|null>(null),[kind,setKind]=useState<RigDraftChange["kind"]>("seat-model"),[value,setValue]=useState("");
 const [target,setTarget]=useState(""),[edgeId,setEdgeId]=useState(""),[edgeKind,setEdgeKind]=useState<typeof EDGE_KINDS[number]>("delegates_to");
 const [validation,setValidation]=useState<RigDraftResult|null>(null),[validationError,setValidationError]=useState(false),[validating,setValidating]=useState(false);
 const refresh=useRef<()=>void>(()=>{}),validationController=useRef<AbortController|null>(null);
 const scroll=useRef<HTMLDivElement>(null);
 const detailHeading=useRef<HTMLHeadingElement>(null),buttons=useRef(new Map<string,HTMLButtonElement>());const marker=useId();
 const save=(patch:Partial<typeof prefs>)=>update({motokoMap:{...prefs,...patch}});
 const available=catalog?.rigs.filter(r=>(!profile||(r.ownerProfile.state==="known"?r.ownerProfile.value.key:"unassigned")===profile)&&(!project||(r.project.state==="known"?r.project.value.key:"unassigned")===project))??[];
 const rigKey=available.find(r=>r.key===prefs.rigKey)?.key??available[0]?.key??null;
 const model=sample?.key===rigKey?sample.model:null;
 const stale=failed||model!==null&&now-Date.parse(model.graph.readCompletedAt)>model.graph.staleAfterMs;
 const currentSnapshot=useRef<string|null>(null);useLayoutEffect(()=>{currentSnapshot.current=model?.configuration.snapshotId??null;},[model]);
 useEffect(()=>{
  let closed=false;const controller=new AbortController();setCatalogError(false);
  void fetchRigCatalog(controller.signal).then(next=>{if(!closed)setCatalog(next);},error=>{if(closed)return;if(error instanceof ApiError&&error.status===401)callback.current();else setCatalogError(true);});
  return()=>{closed=true;controller.abort();};
 },[catalogRefresh]);
 useEffect(()=>{
  setSelected(null);setValidation(null);setValidationError(false);setValidating(false);setFailed(false);
  if(!rigKey){refresh.current=()=>{};return;}
  let closed=false,busy=false;let controller:AbortController|null=null;
  const load=async()=>{
   if(closed||busy||document.visibilityState!=="visible")return;busy=true;controller=new AbortController();
   try{const next=await fetchRigModel(rigKey,controller.signal);if(!closed){setSample({key:rigKey,model:next});setFailed(false);}}
   catch(error){if(closed)return;if(error instanceof ApiError&&error.status===401)callback.current();else setFailed(true);}
   finally{busy=false;if(!closed)setNow(Date.now());}
  };
  const tick=()=>{setNow(Date.now());void load();};refresh.current=tick;void load();const timer=window.setInterval(tick,15000);
  document.addEventListener("visibilitychange",tick);
  return()=>{closed=true;controller?.abort();validationController.current?.abort();validationController.current=null;window.clearInterval(timer);document.removeEventListener("visibilitychange",tick);};
 },[rigKey]);
 useLayoutEffect(()=>{if(selected)detailHeading.current?.focus();},[selected]);
 const shownPods=model?.graph.pods.filter(p=>!prefs.podFilter||!model.graph.pods.some(p=>p.namespace===prefs.podFilter)||p.namespace===prefs.podFilter)??[];
 const shownSeats=model?.graph.seats.filter(s=>!prefs.podFilter||!model.graph.pods.some(p=>p.namespace===prefs.podFilter)||s.podId===null||shownPods.some(p=>p.id===s.podId))??[];
 const seat=model?.graph.seats.find(s=>s.id===selected)??null;
 const declared=model?.configuration.declared.find(s=>s.logicalId===seat?.logicalId);
 const text=<T,>(v:Known<T>|undefined):string=>v?.state==="known"?String(v.value):t("Unknown");
 const mapping=(v:RigCatalog["rigs"][number]["project"])=>v.state==="known"?v.value.label:t("Unassigned");
 const onSeatKey=(event:KeyboardEvent<HTMLButtonElement>,id:string)=>{
  const index=shownSeats.findIndex(s=>s.id===id);const next=event.key==="Home"?0:event.key==="End"?shownSeats.length-1:event.key==="ArrowDown"||event.key==="ArrowRight"?(index+1)%shownSeats.length:event.key==="ArrowUp"||event.key==="ArrowLeft"?(index+shownSeats.length-1)%shownSeats.length:-1;
  if(next>=0){event.preventDefault();buttons.current.get(shownSeats[next]!.id)?.focus();}
 };
 const resetDraft=()=>{validationController.current?.abort();validationController.current=null;setValidating(false);setValidation(null);setValidationError(false);};
 let change:RigDraftChange|null=null;
 if(seat){if(kind==="seat-model"||kind==="seat-profile")change={kind,seatId:seat.id,value};else if(kind==="edge-add")change={kind,sourceId:seat.id,targetId:target||seat.id,edgeKind};else if(edgeId)change={kind:"edge-remove",edgeId};}
 const submit=async()=>{
  if(!rigKey||!model||!change||stale||!model.configuration.snapshotId||validationController.current)return;
  const controller=new AbortController();validationController.current=controller;setValidating(true);setValidationError(false);setValidation(null);const snapshotId=model.configuration.snapshotId;
  try{const result=await validateRigDraft(rigKey,{snapshotId,changes:[change]},controller.signal);if(!controller.signal.aborted&&currentSnapshot.current===snapshotId)setValidation(result);}
  catch(error){if(controller.signal.aborted)return;if(error instanceof ApiError&&error.status===401)callback.current();else setValidationError(true);}
  finally{if(validationController.current===controller){validationController.current=null;setValidating(false);}}
 };
 const layout=model?mapLayout(model):null;
 return <div className="motoko-body motoko-map">
  <p className="motoko-banner">{t("This catalog shows only configured rigs. It does not discover every rig.")}</p>
  <div className="motoko-map-controls">
   <label>{t("Owner profile")}<select aria-label={t("Owner profile")} value={profile} onChange={e=>setProfile(e.target.value)}><option value="">{t("All")}</option><option value="unassigned">{t("Unassigned")}</option>{catalog?.rigs.flatMap(r=>r.ownerProfile.state==="known"?[r.ownerProfile.value]:[]).filter((p,i,a)=>a.findIndex(v=>v.key===p.key)===i).map(p=><option key={p.key} value={p.key}>{p.label}</option>)}</select></label>
   <label>{t("Project")}<select aria-label={t("Project")} value={project} onChange={e=>setProject(e.target.value)}><option value="">{t("All")}</option><option value="unassigned">{t("Unassigned")}</option>{catalog?.rigs.flatMap(r=>r.project.state==="known"?[r.project.value]:[]).filter((p,i,a)=>a.findIndex(v=>v.key===p.key)===i).map(p=><option key={p.key} value={p.key}>{p.label}</option>)}</select></label>
   <label>{t("Rig")}<select aria-label={t("Rig")} value={rigKey??""} onChange={e=>save({rigKey:e.target.value})}>{available.map(r=><option key={r.key} value={r.key}>{r.label}</option>)}</select></label>
   <label>{t("Pod filter")}<select aria-label={t("Pod filter")} value={prefs.podFilter??""} onChange={e=>save({podFilter:e.target.value||null})}><option value="">{t("All")}</option>{model?.graph.pods.map(p=><option key={p.id} value={p.namespace}>{p.label}</option>)}</select></label>
  </div>
  <div className="motoko-map-controls" role="toolbar" aria-label={t("Map controls")}>
   <button type="button" className="btn" aria-label={t("Zoom in")} onClick={()=>save({zoom:Math.min(2,prefs.zoom+0.25)})}>{t("Zoom in")}</button>
   <button type="button" className="btn" aria-label={t("Zoom out")} onClick={()=>save({zoom:Math.max(0.5,prefs.zoom-0.25)})}>{t("Zoom out")}</button>
   <button type="button" className="btn" aria-label={t("Fit")} onClick={()=>save({zoom:Math.max(0.5,Math.min(1,(scroll.current?.clientWidth||760)/760))})}>{t("Fit")}</button>
   <button type="button" className="btn" aria-label={t("Refresh")} onClick={()=>{if(!catalog||catalogError)setCatalogRefresh(n=>n+1);else refresh.current();}}>{t("Refresh")}</button>
   <button type="button" className="btn" aria-label={t("List")} aria-pressed={prefs.mode==="list"} onClick={()=>save({mode:prefs.mode==="map"?"list":"map"})}>{t("List")}</button>
  </div>
  {catalogError&&<p role="alert" className="motoko-banner is-error">{t("The rig catalog is unavailable. Use Refresh to retry.")}</p>}
  {catalog&&!rigKey&&<p role="status">{t("No configured rig matches these filters.")}</p>}
  {rigKey&&!model&&!failed&&<p role="status">{t("Map sample pending.")}</p>}
  {failed&&<p role="alert" className="motoko-banner is-error">{t("The map refresh failed. Use Refresh to retry.")}</p>}
  {model&&layout&&<>
   <p className={`motoko-banner${stale?" is-stale":""}`} role="status">{stale?t("Stale map"):t("Retrieved map")} · {model.graph.readCompletedAt} · {mapping(model.scope.ownerProfile)} · {mapping(model.scope.project)}</p>
   <p className="motoko-hint">{t("Stored links show declared relationships. They do not prove active communication permissions.")} {t("Metadata labels can be false.")}</p>
   <div className="motoko-map-scroll" ref={scroll}><div className={`motoko-map-canvas is-${prefs.mode}`} style={{"--map-zoom":prefs.zoom,"--map-width":`${layout.width*prefs.zoom}px`,"--map-height":`${layout.height*prefs.zoom}px`} as CSSProperties}>
    <svg aria-hidden="true" viewBox={`0 0 ${layout.width} ${layout.height}`}><defs><marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z"/></marker></defs>
     {model.graph.edges.map(e=>{const a=layout.positions.get(e.sourceId)!,b=layout.positions.get(e.targetId)!;if(!shownSeats.some(s=>s.id===e.sourceId)||!shownSeats.some(s=>s.id===e.targetId))return null;
      const parallel=model.graph.edges.filter(link=>link.sourceId===e.sourceId&&link.targetId===e.targetId);const rank=parallel.findIndex(link=>link.id===e.id);
      const offset=24+(rank+1)*Math.min(20,180/parallel.length);const x=a.x+170,y=a.y+35,tx=b.x,ty=b.y+35;
      const d=e.sourceId===e.targetId?`M ${x} ${y} C ${x+24} ${y-80-offset}, ${a.x-24} ${y-80-offset}, ${a.x} ${y}`:`M ${x} ${y} C ${x+offset} ${y-offset}, ${tx-offset} ${ty-offset}, ${tx} ${ty}`;
      return <g key={e.id} className={selected===e.sourceId||selected===e.targetId?"is-selected":""}><path d={d} markerEnd={`url(#${marker})`}/><text x={(x+tx)/2} y={(y+ty)/2-offset/2}>{e.kind}</text></g>;
     })}
    </svg>
    {layout.groups.filter(group=>shownSeats.some(s=>(s.podId??"")===group.id)).map(group=><section className="motoko-map-group" key={group.id}><h3 style={{top:group.y*prefs.zoom,left:40*prefs.zoom}}>{group.label||t("Ungrouped")}</h3>{shownSeats.filter(s=>(s.podId??"")===group.id).map(s=>{const pos=layout.positions.get(s.id)!;return <button type="button" className="motoko-card motoko-map-seat" key={s.id} data-seat={s.id} aria-pressed={selected===s.id} ref={el=>{if(el)buttons.current.set(s.id,el);else buttons.current.delete(s.id);}} style={{"--seat-x":`${pos.x*prefs.zoom}px`,"--seat-y":`${pos.y*prefs.zoom}px`,"--seat-w":"170px"} as CSSProperties} onKeyDown={e=>onSeatKey(e,s.id)} onClick={()=>{resetDraft();setSelected(s.id);setValue("");setEdgeId("");}}><strong>{s.logicalId}</strong><span>{text(s.runtime.value)} · {text(s.model.value)}</span><span>{text(s.startupStatus)}</span></button>;})}</section>)}
   </div></div>
   <section className="motoko-section"><h2 className="motoko-subtitle">{t("Directed relationships")}</h2>{model.graph.edges.length===0?<p>{t("No relationship links reported in this sample.")}</p>:<ul>{model.graph.edges.map(e=><li key={e.id}>{model.graph.seats.find(s=>s.id===e.sourceId)!.logicalId} → {e.kind} → {model.graph.seats.find(s=>s.id===e.targetId)!.logicalId}</li>)}</ul>}</section>
   {seat&&<section className="motoko-card" onKeyDown={e=>{if(e.key==="Escape"){e.preventDefault();buttons.current.get(seat.id)?.focus();setSelected(null);}}}>
    <h2 className="motoko-subtitle" tabIndex={-1} ref={detailHeading}>{seat.logicalId}</h2>
    <dl className="motoko-facts"><div><dt>{t("Session")}</dt><dd>{text(seat.sessionName)}</dd></div><div><dt>{t("Session status")}</dt><dd>{text(seat.sessionStatus)}</dd></div><div><dt>{t("Startup status")}</dt><dd>{text(seat.startupStatus)}</dd></div><div><dt>{t("Role")}</dt><dd>{text(seat.role.value)}</dd></div><div><dt>{t("Runtime")}</dt><dd>{text(seat.runtime.value)}</dd></div><div><dt>{t("Model")}</dt><dd>{text(seat.model.value)}</dd></div><div><dt>{t("AgentSpec profile")}</dt><dd>{text(seat.agentProfile.value)}</dd></div><div><dt>{seat.context.fresh?t("Context"):t("Stale context")}</dt><dd>{seat.context.percent.state==="known"?`${seat.context.percent.value}%`:t("Unknown")}</dd></div></dl>
    <h3>{t("Declared export")} · {model.configuration.readCompletedAt??t("Unknown")}</h3><p className="motoko-hint">{t("Export values can include fallback values. Effective runtime configuration stays Unknown.")}</p>
    <dl className="motoko-facts"><div><dt>{t("Model")}</dt><dd>{text(declared?.model)}</dd></div><div><dt>{t("AgentSpec profile")}</dt><dd>{text(declared?.agentProfile)}</dd></div><div><dt>{t("Codex config profile")}</dt><dd>{text(declared?.codexConfigProfile)}</dd></div><div><dt>{t("Restore policy")}</dt><dd>{text(declared?.restorePolicy)}</dd></div></dl>
    <ul>{model.graph.edges.filter(e=>e.sourceId===seat.id||e.targetId===seat.id).map(e=><li key={e.id}>{model.graph.seats.find(s=>s.id===e.sourceId)!.logicalId} → {e.kind} → {model.graph.seats.find(s=>s.id===e.targetId)!.logicalId}</li>)}</ul>
    <form className="motoko-map-draft" onSubmit={e=>{e.preventDefault();void submit();}}><h3>{t("Validation only")}</h3><p>{t("This check changes no rig or active agent.")}</p>
     <label>{t("Proposed change")}<select value={kind} onChange={e=>{resetDraft();setKind(e.target.value as RigDraftChange["kind"]);}}><option value="seat-model">{t("Model")}</option><option value="seat-profile">{t("AgentSpec profile")}</option><option value="edge-add">{t("Add relationship")}</option><option value="edge-remove">{t("Remove relationship")}</option></select></label>
     {(kind==="seat-model"||kind==="seat-profile")&&<label>{t("Proposed value")}<input name="draft-value" maxLength={120} value={value} onChange={e=>{resetDraft();setValue(e.target.value);}}/></label>}
     {kind==="edge-add"&&<><label>{t("Target seat")}<select value={target||seat.id} onChange={e=>{resetDraft();setTarget(e.target.value);}}>{model.graph.seats.map(s=><option key={s.id} value={s.id}>{s.logicalId}</option>)}</select></label><label>{t("Relationship kind")}<select value={edgeKind} onChange={e=>{resetDraft();setEdgeKind(e.target.value as typeof edgeKind);}}>{EDGE_KINDS.map(k=><option key={k}>{k}</option>)}</select></label></>}
     {kind==="edge-remove"&&<label>{t("Relationship")}<select value={edgeId} onChange={e=>{resetDraft();setEdgeId(e.target.value);}}><option value="">{t("Select a relationship")}</option>{model.graph.edges.map(e=><option key={e.id} value={e.id}>{model.graph.seats.find(s=>s.id===e.sourceId)!.logicalId} → {e.kind} → {model.graph.seats.find(s=>s.id===e.targetId)!.logicalId}</option>)}</select></label>}
     <p className="motoko-banner">{model.rig.label} · {seat.logicalId} · {kind==="seat-model"?`${text(declared?.model)} → ${value}`:kind==="seat-profile"?`${text(declared?.agentProfile)} → ${value}`:kind==="edge-add"?`${seat.logicalId} → ${edgeKind} → ${model.graph.seats.find(s=>s.id===(target||seat.id))?.logicalId}`:model.graph.edges.filter(e=>e.id===edgeId).map(e=>`${model.graph.seats.find(s=>s.id===e.sourceId)!.logicalId} → ${e.kind} → ${model.graph.seats.find(s=>s.id===e.targetId)!.logicalId}`).join("")}</p>
     <p>{kind==="seat-model"?t("The supported model operation changes stored metadata only. It does not restart the active agent."):t("No supported in-place operation is selected for this change.")}</p>
     <button className="btn" disabled={stale||!model.capabilities.validateDraft||validating||!change||((kind==="seat-model"||kind==="seat-profile")&&!value)}>{t("Validate draft")}</button>
     {validationError&&<p role="alert">{t("Draft validation failed. Refresh the map before another check.")}</p>}
     {validation&&validation.snapshotId===model.configuration.snapshotId&&<p role="status">{validation.valid?t("The draft passes structural validation. No change occurs."):t("The draft fails structural validation. No change occurs.")}</p>}
    </form>
   </section>}
   {model.configuration.state==="unknown"&&<p className="motoko-banner">{t("Declared configuration is Unknown. Draft validation is unavailable.")}</p>}
   <p className="motoko-hint">{t("Operational controls and the real Hermes connection require a separate accepted task.")}</p>
  </>}
 </div>;
}
