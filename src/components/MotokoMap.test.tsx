import { afterEach,beforeEach,expect,it,spyOn } from "bun:test";
import { act,create,type ReactTestRenderer } from "react-test-renderer";
import { SettingsProvider, sanitizeSettings } from "../lib/settings.ts";
import { MotokoMap } from "./MotokoMap.tsx";
import type { RigMapModel, RigCatalog } from "../../shared/motoko-topology.ts";
const at=new Date().toISOString();
const known=<T,>(value:T)=>({state:"known" as const,value,observedAt:at});
const unknown={state:"unknown" as const,reason:"not_reported"};
const catalog:RigCatalog={source:"private-scope",completeFleet:false,rigs:["one","two"].map(key=>({key,id:key,name:key,label:key,ownerProfile:unknown,project:unknown}))};
function model(key="one"):RigMapModel {
 const source={value:unknown,source:"graph" as const,readAt:at};
 return {version:1,rig:{key,id:key,name:key,label:key},scope:{ownerProfile:unknown,project:unknown},graph:{state:"known",readStartedAt:at,readCompletedAt:at,staleAfterMs:30000,source:"OpenRig",captureRequested:false,pods:[{id:"pod",namespace:"team",label:"Team"}],seats:["a","b"].map(id=>({id,logicalId:`${key}.${id}`,podId:"pod",sessionName:unknown,role:source,runtime:source,model:source,agentProfile:source,sessionStatus:known("running"),startupStatus:known("attention_required"),context:{percent:known(55),fresh:false,availability:"known"}})),edges:[{id:"e",sourceId:"a",targetId:"b",kind:"delegates_to"}]},configuration:{state:"known",readStartedAt:at,readCompletedAt:at,snapshotId:"a".repeat(64),declared:["a","b"].map(id=>({logicalId:`${key}.${id}`,role:unknown,runtime:unknown,model:known("old"),agentProfile:known("default"),codexConfigProfile:unknown,restorePolicy:unknown})),effectiveRuntime:unknown,omitted:[],reason:null},consistency:"separate-reads",viewRevision:"rev",capabilities:{inspect:true,validateDraft:true,apply:false,hermesAdapter:false}};
}
let renderer:ReactTestRenderer|undefined,fetchSpy:ReturnType<typeof spyOn>;
const descriptors=new Map<string,PropertyDescriptor|undefined>();
let requests:{url:string;init?:RequestInit;reply:(r:Response)=>void}[],ticks:Map<number,()=>void>,visibility:()=>void,visible:string,ended:number,cleared:number,focused:string[];
beforeEach(()=>{
 requests=[];ticks=new Map();visible="visible";ended=0;cleared=0;focused=[];
 for(const k of ["window","document","navigator","IS_REACT_ACT_ENVIRONMENT"])descriptors.set(k,Object.getOwnPropertyDescriptor(globalThis,k));
 Object.defineProperty(globalThis,"IS_REACT_ACT_ENVIRONMENT",{configurable:true,value:true});
 Object.defineProperty(globalThis,"navigator",{configurable:true,value:{languages:["en-US"]}});
 Object.defineProperty(globalThis,"window",{configurable:true,value:{localStorage:{getItem:()=>null,setItem(){}},matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),addEventListener(){},removeEventListener(){},setInterval:(fn:()=>void)=>{const id=ticks.size+1;ticks.set(id,fn);return id;},clearInterval:(id:number)=>{ticks.delete(id);cleared++;}}});
 Object.defineProperty(globalThis,"document",{configurable:true,value:{visibilityState:visible,documentElement:{dataset:{},style:{setProperty(){},removeProperty(){}}},querySelector:()=>null,addEventListener:(_n:string,fn:()=>void)=>{visibility=fn;},removeEventListener(){}}});
 fetchSpy=spyOn(globalThis,"fetch").mockImplementation(Object.assign((url:RequestInfo|URL,init?:RequestInit)=>new Promise<Response>(reply=>requests.push({url:String(url),init,reply})),{preconnect:globalThis.fetch.preconnect}));
});
afterEach(async()=>{await act(async()=>renderer?.unmount());renderer=undefined;fetchSpy.mockRestore();for(const[k,d]of descriptors){if(d)Object.defineProperty(globalThis,k,d);else Reflect.deleteProperty(globalThis,k);}descriptors.clear();});
const view=(callback=()=>{ended++;})=><SettingsProvider><MotokoMap onSessionEnded={callback}/></SettingsProvider>;
async function open(){await act(async()=>{renderer=create(view(),{createNodeMock:e=>({clientWidth:380,focus:()=>focused.push(String((e.props as {"data-seat"?:string;children?:unknown})["data-seat"]??(e.props as {children?:unknown}).children)),scrollIntoView(){}})});});await act(async()=>requests[0]!.reply(Response.json(catalog)));}
async function loaded(){await open();await act(async()=>requests[1]!.reply(Response.json(model())));}
it("labels the saved model separately from the declared and current native models",async()=>{
 await loaded();await act(async()=>renderer!.root.findAllByType("button").find(n=>n.props["data-seat"]==="a")!.props.onClick());
 const text=JSON.stringify(renderer!.toJSON());expect(text).toContain("Saved next-resume model");expect(text).toContain("Current native model");expect(text).toContain("Declared export");
 expect(requests).toHaveLength(2);
});
it("keeps the active request across callback changes and uses the latest callback",async()=>{
 await open();const signal=requests[1]!.init?.signal;let newest=0;
 await act(async()=>renderer!.update(view(()=>{newest++;})));expect(requests).toHaveLength(2);expect(signal?.aborted).toBe(false);
 await act(async()=>requests[1]!.reply(new Response(null,{status:401})));expect(newest).toBe(1);expect(ended).toBe(0);
});
it("aborts the old rig and ignores late data after selection",async()=>{
 await open();const old=requests[1]!;
 const select=renderer!.root.findAllByType("select").find(e=>e.props["aria-label"]==="Rig")!;
 await act(async()=>select.props.onChange({target:{value:"two"}}));expect(old.init?.signal?.aborted).toBe(true);
 expect(requests[2]!.url).toEndWith("/two");await act(async()=>requests[2]!.reply(Response.json(model("two"))));
 await act(async()=>old.reply(Response.json(model("one"))));const text=JSON.stringify(renderer!.toJSON());expect(text).toContain("two.a");expect(text).not.toContain("one.a");
});
it("permits one pending read, stops refresh after closure and refuses late 401",async()=>{
 await open();await act(async()=>{for(const fn of ticks.values()){fn();fn();}});expect(requests).toHaveLength(2);
 const active=requests[1]!;await act(async()=>renderer!.unmount());renderer=undefined;
 expect(active.init?.signal?.aborted).toBe(true);expect(ticks.size).toBe(0);await act(async()=>active.reply(new Response(null,{status:401})));expect(ended).toBe(0);
});
it("shows direction, source freshness, declared limits and accessible controls",async()=>{
 await loaded();await act(async()=>renderer!.root.findAllByType("button").find(e=>e.props["data-seat"])!.props.onClick());const text=JSON.stringify(renderer!.toJSON());expect(text).toContain("one.a");expect(text).toContain("delegates_to");expect(text).toContain("attention_required");expect(text).toContain("Stale context");expect(text).toContain("Declared export");expect(text).toContain("Validation only");
 const labels=renderer!.root.findAllByType("button").map(e=>e.props["aria-label"]??e.props.children);for(const label of ["Zoom in","Zoom out","Fit","Refresh","List"])expect(labels).toContain(label);
 expect(renderer!.root.findAllByType("svg")[0]!.props["aria-hidden"]).toBe("true");
});
it("supports keyboard seat selection and shows validation preview without Apply",async()=>{
 await loaded();const seats=renderer!.root.findAllByType("button").filter(e=>e.props["data-seat"]);
 await act(async()=>seats[0]!.props.onKeyDown({key:"End",preventDefault(){}}));expect(focused.at(-1)).toBe("b");
 await act(async()=>seats[0]!.props.onClick());
 const input=renderer!.root.findAllByType("input").find(e=>e.props.name==="draft-value")!;await act(async()=>input.props.onChange({target:{value:"new-model"}}));
 const form=renderer!.root.findAllByType("form")[0]!;await act(async()=>form.props.onSubmit({preventDefault(){}}));
 expect(requests.at(-1)!.url).toEndWith("/one/validate");expect(JSON.parse(String(requests.at(-1)!.init?.body))).toMatchObject({changes:[{kind:"seat-model",seatId:"a",value:"new-model"}]});
 expect(renderer!.root.findAllByType("button").some(e=>e.props.children==="Apply")).toBe(false);
});
it("sanitizes saved presentation preferences",()=>{
 expect(sanitizeSettings({motokoMap:{rigKey:"http://evil",zoom:999,mode:"apply",podFilter:"/private"}}).motokoMap).toEqual({rigKey:null,zoom:1,mode:"map",podFilter:null});
 expect(sanitizeSettings({motokoMap:{rigKey:"one",zoom:1.5,mode:"list",podFilter:"team"}}).motokoMap).toEqual({rigKey:"one",zoom:1.5,mode:"list",podFilter:"team"});
});

it("waits while hidden and refreshes when visible",async()=>{
 Object.defineProperty(document,"visibilityState",{configurable:true,get:()=>visible});visible="hidden";
 await open();expect(requests).toHaveLength(1);await act(async()=>{for(const fn of ticks.values())fn();});expect(requests).toHaveLength(1);
 visible="visible";await act(async()=>visibility());expect(requests).toHaveLength(2);
});
it("keeps a failed prior graph stale instead of showing zero links",async()=>{
 await loaded();await act(async()=>{for(const fn of ticks.values())fn();});await act(async()=>requests.at(-1)!.reply(new Response(null,{status:503})));
 const text=JSON.stringify(renderer!.toJSON());expect(text).toContain("Stale map");expect(text).toContain("delegates_to");expect(text).not.toContain("No relationship links reported");
});

it("fits the map to the available width without a topology request",async()=>{
 await loaded();const before=requests.length;const fit=renderer!.root.findAllByType("button").find(b=>b.props["aria-label"]==="Fit")!;
 await act(async()=>fit.props.onClick());expect(requests).toHaveLength(before);
 const canvas=renderer!.root.findAllByType("div").find(e=>String(e.props.className).includes("motoko-map-canvas"))!;expect(canvas.props.style["--map-zoom"]).toBe(0.5);
});

it("restores the same-seat form after explicit Refresh and allows a second explicit Save",async()=>{
 await open();const before=model();for(const seat of before.graph.seats)seat.model={...seat.model,value:known("old")};
 await act(async()=>requests[1]!.reply(Response.json(before)));
 const select=()=>renderer!.root.findAllByType("button").find(n=>n.props["data-seat"]==="a")!.props.onClick();
 const input=(name:string)=>renderer!.root.findAllByType("input").find(n=>n.props.name===name)!;
 const fill=async(target:string)=>{for(const[name,value]of [["model-target",target],["model-reason","Owner test"]] as const)await act(async()=>input(name).props.onChange({target:{value}}));};
 const save=async()=>{await act(async()=>renderer!.root.findAllByType("form")[1]!.props.onSubmit({preventDefault(){}}));};
 await act(async()=>select());await fill("new");await save();expect(requests).toHaveLength(3);
 await act(async()=>requests[2]!.reply(Response.json({outcome:"saved",rigId:"one",seatId:"a",logicalId:"one.a",targetModel:"new",savedModel:"new",readback:"known",changed:true})));
 await act(async()=>renderer!.root.findAllByType("button").find(n=>n.props["aria-label"]==="Refresh")!.props.onClick());
 const after=model();for(const seat of after.graph.seats)seat.model={...seat.model,value:known("new")};
 await act(async()=>requests[3]!.reply(Response.json(after)));await act(async()=>select());
 expect(input("model-target").props.disabled).toBe(false);await fill("next");expect(requests).toHaveLength(4);await save();
 expect(requests).toHaveLength(5);expect(JSON.parse(String(requests[4]!.init?.body))).toMatchObject({expectedModel:"new",model:"next"});
});
it("preserves input, a pending Save and an Unknown result through periodic map samples",async()=>{
 await open();const sample=()=>{const next=model();for(const seat of next.graph.seats)seat.model={...seat.model,value:known("old")};return next;};
 await act(async()=>requests[1]!.reply(Response.json(sample())));
 await act(async()=>renderer!.root.findAllByType("button").find(n=>n.props["data-seat"]==="a")!.props.onClick());
 const target=()=>renderer!.root.findAllByType("input").find(n=>n.props.name==="model-target")!;
 for(const[name,value]of [["model-target","new"],["model-reason","Owner test"]])await act(async()=>renderer!.root.findAllByType("input").find(n=>n.props.name===name)!.props.onChange({target:{value}}));
 const tick=async()=>{await act(async()=>{for(const fn of ticks.values())fn();});await act(async()=>requests.at(-1)!.reply(Response.json(sample())));};
 await tick();expect(target().props.value).toBe("new");expect(target().props.disabled).toBe(false);
 await act(async()=>renderer!.root.findAllByType("form")[1]!.props.onSubmit({preventDefault(){}}));const write=requests.at(-1)!;
 await tick();expect(target().props.value).toBe("new");expect(target().props.disabled).toBe(true);
 await act(async()=>write.reply(Response.json({outcome:"unknown",rigId:"one",seatId:"a",logicalId:"one.a",targetModel:"new",savedModel:null,readback:"unknown",changed:null})));
 await tick();expect(JSON.stringify(renderer!.toJSON())).toContain("The save result is Unknown.");expect(target().props.disabled).toBe(true);expect(target().props.value).toBe("new");
 expect(requests.filter(r=>r.url.endsWith("/model"))).toHaveLength(1);
});
