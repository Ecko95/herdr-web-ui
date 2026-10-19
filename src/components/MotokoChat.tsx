import { useEffect,useLayoutEffect,useRef,useState } from "react";
import type { ChatView,ChatBindingView,ChatAction } from "../../shared/motoko.ts";
import { listChatBindings,openChat,actChat } from "../lib/motoko.ts";
import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import "./MotokoChat.css";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
const random=()=>crypto.randomUUID().replaceAll("-","");
export function MotokoChat({onSessionEnded}:{onSessionEnded:()=>void}){
 const t=useT(),ended=useRef(onSessionEnded);useLayoutEffect(()=>{ended.current=onSessionEnded;},[onSessionEnded]);
 const [bindings,setBindings]=useState<ChatBindingView[]|null>(null),[binding,setBinding]=useState(""),[view,setView]=useState<ChatView|null>(null),[draft,setDraft]=useState(""),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[acknowledge,setAcknowledge]=useState(false),[recover,setRecover]=useState(false);
 const writer=useRef<string|null>(null),current=useRef<ChatView|null>(null),active=useRef(true),older=useRef(false),inflight=useRef(false),controller=useRef<AbortController|null>(null);
 const accept=(value:ChatView)=>{current.current=value;setView(value);setUncertain(false);};
 const failed=(failure:unknown)=>{
  if(!active.current)return;
  if(failure instanceof ApiError&&failure.status===401){current.current=null;setView(null);ended.current();return;}
  const code=failure instanceof ApiError?failure.code:null;
  setError(code==="incompatible_runtime"?t("The runtime is incompatible with required memory."):code==="writer_busy"||code==="stale_writer"?t("Another view owns this conversation."):code==="profile_unconfigured"?t("Chat has no approved profile mapping."):t("Chat is unavailable. Check the current outcome before another send."));
 };
 useEffect(()=>{
  active.current=true;writer.current=random();const first=new AbortController();controller.current=first;
  void listChatBindings(first.signal).then(value=>{if(active.current)setBindings(value.bindings);}).catch(failed);
  const timer=window.setInterval(()=>{if(!current.current||current.current.status==="writer_busy"||inflight.current||!active.current||older.current)return;void perform({operation:"read"});},2000);
  return ()=>{active.current=false;window.clearInterval(timer);controller.current?.abort();const old=current.current;if(old&&old.status!=="writer_busy"&&!old.pending&&!inflight.current&&writer.current)void actChat(old,writer.current,{operation:"release"}).catch(()=>{});current.current=null;};
 },[]);
 async function perform(action:ChatAction):Promise<void>{
  const old=current.current;if(!old||inflight.current||!writer.current||(old.status==="writer_busy"&&action.operation!=="recover"))return;
  inflight.current=true;setBusy(true);controller.current=new AbortController();
  if(action.operation==="send")setUncertain(true);
  try{const next=await actChat(old,writer.current,action,controller.current.signal);if(active.current){accept(next);older.current=action.operation==="history";setError(null);if(action.operation==="send")setDraft("");}}
  catch(failure){failed(failure);}finally{inflight.current=false;if(active.current)setBusy(false);}
 }
 async function open():Promise<void>{
  if(inflight.current||!binding||!writer.current||current.current?.pending||uncertain)return;
  inflight.current=true;setBusy(true);controller.current=new AbortController();
  try{if(current.current)await actChat(current.current,writer.current,{operation:"release"},controller.current.signal);
   if(!active.current)return;current.current=null;setView(null);setDraft("");
   const next=await openChat(binding,writer.current,controller.current.signal);if(active.current){accept(next);setError(null);}
  }catch(failure){failed(failure);}finally{inflight.current=false;if(active.current)setBusy(false);}
 }
 const writerBusy=view?.status==="writer_busy";
 const blocked=busy||writerBusy||!!view?.pending||uncertain;
 return <div className="motoko-body motoko-chat">
  <div className="motoko-chat-controls"><label>{t("Chat profile")}<select aria-label={t("Chat profile")} value={binding} disabled={blocked} onChange={e=>setBinding(e.target.value)}><option value="">{t("Select a profile")}</option>{bindings?.map(b=><option key={b.id} value={b.id}>{b.label} · {b.profile} · {b.rigKey}</option>)}</select></label><button type="button" className="btn btn-secondary" disabled={!binding||blocked} onClick={()=>void open()}>{t("Open chat")}</button></div>
  {bindings?.length===0&&<p role="status">{t("Chat has no approved profile mapping.")}</p>}
  {error&&<p role="alert" className="motoko-banner is-error">{error}</p>}
  {view&&<>
   <h2 className="motoko-subtitle">{view.label} · {view.profile} · {view.rigKey}</h2>
   <p role="status">{view.memory==="ready"?t("Memory is ready."):view.memory==="failed"?t("Memory failed. Send is disabled."):t("Memory is not initialized. The runtime checks it before inference.")}</p>
   {writerBusy&&<><p role="status">{t("Another view owns this conversation.")}</p><button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>setRecover(true)}>{t("Recover writer")}</button></>}
   {recover&&<ConfirmDialog title={t("Recover writer")} body={t("This action transfers control to this view. The former view loses control. Pending input stays unchanged.")} confirmLabel={t("Recover writer")} onClose={()=>setRecover(false)} onConfirm={async()=>{await perform({operation:"recover"});setRecover(false);}}/>}
   {view.tools?.length>0&&<ul aria-label={t("Tool activity")}>{view.tools.map((tool,i)=><li key={i}>{tool.name}: {tool.status==="active"?t("Tool active"):t("Tool complete")}</li>)}</ul>}
   {view.history==="unavailable"&&<p role="alert">{t("History is unavailable. Send is disabled.")}</p>}
   {view.historyCursor&&<button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void perform({operation:"history",cursor:view.historyCursor!})}>{t("Earlier messages")}</button>}
   {older.current&&<button type="button" className="btn btn-ghost" disabled={busy||writerBusy} onClick={()=>void perform({operation:"read"})}>{t("Latest messages")}</button>}
   {view.hasEarlier&&<p>{t("This view shows the latest 100 messages. Earlier history remains in Hermes.")}</p>}
   <ol className="motoko-chat-history" aria-label={t("Chat history")}>{view.messages.map((m,i)=><li key={i} className={`motoko-chat-${m.role}`}><strong>{m.role}</strong><pre>{m.text}</pre></li>)}</ol>
   {(view.pending||uncertain)&&<p role="status">{view.pending?.status==="unknown"||uncertain?t("The outcome is unknown. This view will not resend the input."):t("The turn is active.")}</p>}
   {view.outcome&&<p role="status">{t("Turn outcome")}: {view.outcome}</p>}
   {view.pending?.canAcknowledge&&<button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>setAcknowledge(true)}>{t("Acknowledge lost turn")}</button>}
   {acknowledge&&<ConfirmDialog title={t("Acknowledge lost turn")} body={t("The runtime lost this turn. This action clears its unresolved state. It does not resend the input.")} confirmLabel={t("Acknowledge")} onClose={()=>setAcknowledge(false)} onConfirm={async()=>{await perform({operation:"acknowledge",acknowledgeLostTurn:true});setAcknowledge(false);}}/>}
   <button type="button" className="btn btn-secondary" disabled={busy||writerBusy||!view.pending} onClick={()=>void perform({operation:"stop"})}>{t("Stop")}</button>
   <button type="button" className="btn btn-ghost" disabled={busy||writerBusy} onClick={()=>void perform({operation:"read"})}>{t("Check outcome")}</button>
   {view.prompts.map(p=><Prompt key={`${p.id}:${p.generation}`} prompt={p} disabled={busy||writerBusy} respond={answer=>void perform({operation:p.kind==="approval"?"approve":"clarify",promptId:p.id,generation:p.generation,answer})}/>)}
   <form onSubmit={e=>{e.preventDefault();if(!blocked&&draft.trim()&&new TextEncoder().encode(draft).length<=16384)void perform({operation:"send",submissionId:random(),text:draft});}}>
    <label>{t("Message")}<textarea aria-label={t("Message")} value={draft} disabled={blocked} onChange={e=>setDraft(e.target.value)} rows={4}/></label>
    <button type="submit" className="btn btn-primary" disabled={blocked||!draft.trim()||new TextEncoder().encode(draft).length>16384||view.memory==="failed"||view.history!=="ready"||view.status!=="ready"}>{t("Send")}</button>
   </form>
  </>}
 </div>;
}
function Prompt({prompt,disabled,respond}:{prompt:ChatView["prompts"][number];disabled:boolean;respond(answer:string):void}){
 const t=useT();const [answer,setAnswer]=useState("");
 return <section className="motoko-card" aria-label={t("Owner decision")}><p>{prompt.text}</p>{prompt.kind==="approval"?prompt.choices.map(choice=><button key={choice} type="button" className="btn btn-secondary" disabled={disabled} onClick={()=>respond(choice)}>{choice}</button>):<form onSubmit={e=>{e.preventDefault();if(answer.trim())respond(answer);}}><label>{t("Answer")}<input value={answer} disabled={disabled} onChange={e=>setAnswer(e.target.value)}/></label><button type="submit" className="btn btn-primary" disabled={disabled||!answer.trim()}>{t("Answer")}</button></form>}</section>;
}
