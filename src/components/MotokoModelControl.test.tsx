import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { SettingsProvider } from "../lib/settings.ts";
const implementation=await import("./MotokoModelControl.tsx").catch(()=>null);
let renderer:ReactTestRenderer|undefined,fetchSpy:ReturnType<typeof spyOn>;
let calls:{url:string;init?:RequestInit;resolve:(r:Response)=>void;reject:(e:Error)=>void}[];
const descriptors=new Map<string,PropertyDescriptor|undefined>();
const props={rigKey:"main",rigId:"rig-id",rigName:"Test rig",seatId:"seat-id",logicalId:"team.a",savedModel:"old",stale:false,onSessionEnded:()=>{}};
beforeEach(()=>{
 calls=[];for(const k of ["IS_REACT_ACT_ENVIRONMENT","navigator","window","document"])descriptors.set(k,Object.getOwnPropertyDescriptor(globalThis,k));
 Object.defineProperty(globalThis,"IS_REACT_ACT_ENVIRONMENT",{configurable:true,value:true});
 Object.defineProperty(globalThis,"navigator",{configurable:true,value:{languages:["en-US"]}});
 Object.defineProperty(globalThis,"window",{configurable:true,value:{localStorage:{getItem:()=>null,setItem(){}},matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),addEventListener(){},removeEventListener(){}}});
 Object.defineProperty(globalThis,"document",{configurable:true,value:{documentElement:{dataset:{},style:{setProperty(){},removeProperty(){}}},querySelector:()=>null}});
 fetchSpy=spyOn(globalThis,"fetch").mockImplementation(Object.assign((url:RequestInfo|URL,init?:RequestInit)=>new Promise<Response>((resolve,reject)=>calls.push({url:String(url),init,resolve,reject})),{preconnect:globalThis.fetch.preconnect}));
});
afterEach(async()=>{await act(async()=>renderer?.unmount());renderer=undefined;fetchSpy.mockRestore();for(const[k,v]of descriptors){if(v)Object.defineProperty(globalThis,k,v);else Reflect.deleteProperty(globalThis,k);}descriptors.clear();});
async function open(){expect(implementation?.MotokoModelControl).toBeFunction();const Component=implementation!.MotokoModelControl;await act(async()=>{renderer=create(<SettingsProvider><Component {...props}/></SettingsProvider>);});}
async function fill(){for(const[name,value]of [["model-target","new"],["model-reason","Owner selects a model"]])await act(async()=>renderer!.root.findAllByType("input").find(n=>n.props.name===name)!.props.onChange({target:{value}}));}
async function submit(){await act(async()=>renderer!.root.findByType("form").props.onSubmit({preventDefault(){}}));}
const text=()=>JSON.stringify(renderer!.toJSON());
it("shows exact rig, seat and target before explicit Save",async()=>{
 await open();await fill();expect(calls).toHaveLength(0);expect(text()).toContain("Test rig");expect(text()).toContain("team.a");expect(text()).toContain("new");
 await submit();expect(calls).toHaveLength(1);expect(calls[0]!.url).toBe("/api/motoko/map/rigs/main/model");
 expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({seatId:"seat-id",logicalId:"team.a",expectedModel:"old",model:"new",reason:"Owner selects a model"});
 await act(async()=>calls[0]!.resolve(Response.json({outcome:"saved",rigId:"rig-id",seatId:"seat-id",logicalId:"team.a",targetModel:"new",savedModel:"new",readback:"known",changed:true})));
 expect(text()).toContain("Saved for the next managed resume.");
});
it("does not turn an ambiguous reply into success or retry automatically",async()=>{
 await open();await fill();await submit();await act(async()=>calls[0]!.reject(Error("network")));
 expect(text()).toContain("The save result is Unknown.");expect(calls).toHaveLength(1);
 await submit();expect(calls).toHaveLength(1);
});
it("ignores a late reply after the selected seat changes",async()=>{
 await open();await fill();await submit();const Component=implementation!.MotokoModelControl;
 await act(async()=>renderer!.update(<SettingsProvider><Component {...props} seatId="other-seat" logicalId="team.b"/></SettingsProvider>));
 await act(async()=>calls[0]!.resolve(Response.json({outcome:"saved",rigId:"rig-id",seatId:"seat-id",logicalId:"team.a",targetModel:"new",savedModel:"new",readback:"known",changed:true})));
 expect(text()).not.toContain("Saved for the next managed resume.");expect(text()).toContain("team.b");expect(calls).toHaveLength(1);
});
it("uses the latest owner callback after an uncertain write",async()=>{
 await open();await fill();await submit();let ended=0;const Component=implementation!.MotokoModelControl;
 await act(async()=>renderer!.update(<SettingsProvider><Component {...props} onSessionEnded={()=>{ended++;}}/></SettingsProvider>));
 await act(async()=>calls[0]!.resolve(new Response(null,{status:401})));expect(ended).toBe(1);expect(text()).toContain("The save result is Unknown.");
});
it("keeps conflicting readback explicit",async()=>{
 await open();await fill();await submit();
 await act(async()=>calls[0]!.resolve(Response.json({outcome:"conflict",rigId:"rig-id",seatId:"seat-id",logicalId:"team.a",targetModel:"new",savedModel:"other",readback:"known",changed:true})));
 expect(text()).toContain("The model state conflicts with this request.");expect(text()).toContain("other");expect(text()).not.toContain("Saved for the next managed resume.");
});
it("ignores a late reply after the rig changes",async()=>{
 await open();await fill();await submit();const Component=implementation!.MotokoModelControl;
 await act(async()=>renderer!.update(<SettingsProvider><Component {...props} rigKey="other" rigId="other-rig"/></SettingsProvider>));
 await act(async()=>calls[0]!.resolve(Response.json({outcome:"saved",rigId:"rig-id",seatId:"seat-id",logicalId:"team.a",targetModel:"new",savedModel:"new",readback:"known",changed:true})));
 expect(text()).not.toContain("Saved for the next managed resume.");expect(text()).toContain("other-rig");
});
it("requires a target, a bounded reason and a fresh known saved model",async()=>{
 await open();await submit();expect(calls).toHaveLength(0);await fill();const Component=implementation!.MotokoModelControl;
 await act(async()=>renderer!.update(<SettingsProvider><Component {...props} stale/></SettingsProvider>));await submit();expect(calls).toHaveLength(0);
});
it("keeps pending input and an Unknown result through refreshes until explicit recovery",async()=>{
 await open();await fill();const Component=implementation!.MotokoModelControl;
 const update=async(refreshVersion:number,selectionVersion:number)=>{await act(async()=>renderer!.update(<SettingsProvider><Component {...props} refreshVersion={refreshVersion} selectionVersion={selectionVersion}/></SettingsProvider>));};
 const target=()=>renderer!.root.findAllByType("input").find(n=>n.props.name==="model-target")!;
 await update(0,0);expect(target().props.value).toBe("new");
 await submit();await update(1,1);expect(target().props.disabled).toBe(true);expect(target().props.value).toBe("new");expect(calls).toHaveLength(1);
 await act(async()=>calls[0]!.reject(Error("uncertain")));
 await update(1,2);expect(text()).toContain("The save result is Unknown.");expect(target().props.disabled).toBe(true);
 // A periodic sample does not advance the explicit Refresh version.
 await update(1,2);expect(text()).toContain("The save result is Unknown.");expect(target().props.value).toBe("new");
 await update(2,2);expect(text()).toContain("The save result is Unknown.");expect(target().props.disabled).toBe(true);
 await update(2,3);expect(target().props.disabled).toBe(false);expect(target().props.value).toBe("");expect(calls).toHaveLength(1);
});
