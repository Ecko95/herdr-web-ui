import { beforeEach,afterEach,test,expect,spyOn } from "bun:test";
import { act,create,type ReactTestRenderer } from "react-test-renderer";
import { SettingsProvider } from "../lib/settings.ts";
import * as dialogs from "./ConfirmDialog.tsx";
import { MotokoChat } from "./MotokoChat.tsx";
const binding={id:"a".repeat(32),label:"Alpha",profile:"alpha",rigKey:"alpha"};
const view={conversationId:"c".repeat(32),bindingId:binding.id,label:"Alpha",profile:"alpha",rigKey:"alpha",writerGeneration:1,memory:"uninitialized",messages:[{role:"assistant",text:"literal <script> text"}],prompts:[],pending:null,outcome:null,history:"ready",hasEarlier:false,status:"ready"};
let renderer:ReactTestRenderer|undefined,spy:ReturnType<typeof spyOn>,calls:{input:Record<string,unknown>;init?:RequestInit;reply:(r:Response)=>void}[],ticks:Map<number,()=>void>,ended:number;
const descriptors=new Map<string,PropertyDescriptor|undefined>();
beforeEach(()=>{calls=[];ticks=new Map();ended=0;for(const k of ["window","document","navigator","IS_REACT_ACT_ENVIRONMENT"])descriptors.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,"IS_REACT_ACT_ENVIRONMENT",{configurable:true,value:true});Object.defineProperty(globalThis,"document",{configurable:true,value:{documentElement:{dataset:{},style:{setProperty(){},removeProperty(){}}},querySelector:()=>null}});Object.defineProperty(globalThis,"navigator",{configurable:true,value:{languages:["en-US"]}});Object.defineProperty(globalThis,"window",{configurable:true,value:{localStorage:{getItem:()=>null},addEventListener(){},removeEventListener(){},sessionStorage:{getItem:()=>null,setItem(){}},setInterval(fn:()=>void){const id=ticks.size+1;ticks.set(id,fn);return id;},clearInterval(id:number){ticks.delete(id);}}});spy=spyOn(globalThis,"fetch").mockImplementation(Object.assign((_url:RequestInfo|URL,init?:RequestInit)=>new Promise<Response>(reply=>calls.push({input:JSON.parse(String(init?.body)),init,reply})),{preconnect:globalThis.fetch.preconnect}));});
afterEach(async()=>{await act(async()=>renderer?.unmount());renderer=undefined;spy.mockRestore();for(const[k,d]of descriptors){if(d)Object.defineProperty(globalThis,k,d);else Reflect.deleteProperty(globalThis,k);}descriptors.clear();});
async function open(result:unknown=view){await act(async()=>{renderer=create(<SettingsProvider><MotokoChat onSessionEnded={()=>ended++}/></SettingsProvider>);});await act(async()=>calls[0]!.reply(Response.json({bindings:[binding]})));const select=renderer!.root.findByType("select");await act(async()=>select.props.onChange({target:{value:binding.id}}));await act(async()=>renderer!.root.findAllByType("button").find(x=>x.props.children==="Open chat")!.props.onClick());await act(async()=>calls[1]!.reply(Response.json(result)));}
test("chat opens an explicit profile and renders escaped text with a composer",async()=>{await open();expect(calls[1]!.input).toMatchObject({operation:"open",bindingId:binding.id});expect(JSON.stringify(renderer!.toJSON())).toContain("literal <script> text");expect(renderer!.root.findByType("textarea").props["aria-label"]).toBe("Message");expect(JSON.stringify(renderer!.toJSON())).toContain("Memory is not initialized. The runtime checks it before inference.");});
test("unknown sends block another send and a profile change",async()=>{await open();await act(async()=>renderer!.root.findByType("textarea").props.onChange({target:{value:"hello"}}));await act(async()=>renderer!.root.findByType("form").props.onSubmit({preventDefault(){}}));const sent=calls.at(-1)!;expect(sent.input).toMatchObject({operation:"send",text:"hello",writerGeneration:1});expect(String(sent.input["submissionId"])).toMatch(/^[a-f0-9]{32}$/);await act(async()=>sent.reply(Response.json({...view,pending:{submissionId:sent.input["submissionId"],status:"unknown"}})));expect(renderer!.root.findByType("select").props.disabled).toBe(true);expect(renderer!.root.findAllByType("button").find(x=>x.props.children==="Send")!.props.disabled).toBe(true);});
test("closure aborts the read and ignores its late owner refusal",async()=>{await open();await act(async()=>{for(const tick of ticks.values())tick();});const read=calls.at(-1)!;await act(async()=>renderer!.unmount());renderer=undefined;expect(read.init?.signal?.aborted).toBe(true);expect(ticks.size).toBe(0);await act(async()=>read.reply(new Response(null,{status:401})));expect(ended).toBe(0);});

test("a new view never reuses a writer ID from copied tab storage",async()=>{
 window.sessionStorage.getItem=()=>"9".repeat(32);await open();expect(calls[1]!.input["writerId"]).not.toBe("9".repeat(32));
});

test("writer recovery requires confirmation and the observed generation",async()=>{
 const dialog=spyOn(dialogs,"ConfirmDialog").mockImplementation(()=>null!);
 try{await open({...view,status:"writer_busy",pending:{submissionId:"2".repeat(32),status:"unknown",canAcknowledge:false}});
 expect(renderer!.root.findByType("textarea").props.disabled).toBe(true);
 await act(async()=>renderer!.root.findAllByType("button").find(x=>x.props.children==="Recover writer")!.props.onClick());
 expect(calls).toHaveLength(2);
 const confirm=renderer!.root.findByType(dialogs.ConfirmDialog);
 await act(async()=>{void confirm.props.onConfirm();});
 expect(calls.at(-1)!.input).toMatchObject({operation:"recover",writerGeneration:1,conversationId:view.conversationId});
 await act(async()=>calls.at(-1)!.reply(Response.json({...view,writerGeneration:2})));
 expect(JSON.stringify(renderer!.toJSON())).not.toContain("Another view owns this conversation.");
 }finally{dialog.mockRestore();}
});
test("chat displays bounded live tool activity",async()=>{
 await open({...view,tools:[{name:"read_file",status:"active"}]});
 expect(JSON.stringify(renderer!.toJSON())).toContain("read_file");expect(JSON.stringify(renderer!.toJSON())).toContain("Tool active");
});
