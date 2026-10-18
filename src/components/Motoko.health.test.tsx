import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { SettingsProvider } from "../lib/settings.ts";
import { Motoko } from "./Motoko.tsx";

let renderer: ReactTestRenderer | undefined;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
let tick: () => void, visibility: () => void, cleared: number, removed: number, ended: number;
let visible: string, requests: {signal?: AbortSignal | null}[], replies: ((response: Response) => void)[];
let fetchSpy: ReturnType<typeof spyOn>;
const sample = () => Response.json({sampledAt:new Date().toISOString(),staleAfterMs:15000,cpu:{state:"known",value:{percent:25,intervalMs:5000}},memory:{state:"known",value:{usedBytes:60,totalBytes:100}},uptime:{state:"known",value:1234}});
beforeEach(() => {
  cleared=0; removed=0; ended=0; requests=[]; replies=[]; visible="visible";
  for(const key of ["window","document","navigator","IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
  Object.defineProperty(globalThis,"navigator",{configurable:true,value:{languages:["en-US"]}});
  Object.defineProperty(globalThis,"IS_REACT_ACT_ENVIRONMENT",{configurable:true,value:true});
  Object.defineProperty(globalThis,"window",{configurable:true,value:{localStorage:{getItem:()=>null},addEventListener(){},removeEventListener(){},setInterval:(callback:()=>void)=>{tick=callback;return 12;},clearInterval:()=>{cleared++;}}});
  Object.defineProperty(globalThis,"document",{configurable:true,value:{documentElement:{dataset:{},style:{setProperty(){},removeProperty(){}}},querySelector:()=>null,get visibilityState(){return visible;},addEventListener:(_name:string,callback:()=>void)=>{visibility=callback;},removeEventListener:()=>{removed++;}}});
  fetchSpy=spyOn(globalThis,"fetch").mockImplementation(Object.assign((_url:RequestInfo|URL,init?:RequestInit)=>{
    requests.push({signal:init?.signal}); return new Promise<Response>(resolve=>replies.push(resolve));
  },{preconnect:globalThis.fetch.preconnect}));
});
afterEach(async()=>{
  await act(async()=>renderer?.unmount()); renderer=undefined; fetchSpy.mockRestore();
  for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);} descriptors.clear();
});
async function open(authenticated=true){await act(async()=>{renderer=create(<SettingsProvider><Motoko auth={{required:true,authenticated,via:"owner"}} request={{destination:"health"}} onClose={()=>{}} onSignOut={async()=>{}} onSessionEnded={()=>{ended++;}}/></SettingsProvider>,{createNodeMock:()=>({focus(){},scrollIntoView(){}})});});}
it("opens health, avoids overlapping reads, and aborts on closure",async()=>{
  await open(); expect(requests).toHaveLength(1);
  await act(async()=>{tick();tick();}); expect(requests).toHaveLength(1);
  await act(async()=>replies[0]!(sample()));
  expect(JSON.stringify(renderer!.toJSON())).toContain("25.0%");
  expect(JSON.stringify(renderer!.toJSON())).toContain("5000");
  await act(async()=>tick()); expect(requests).toHaveLength(2);
  const active=requests[1]!.signal; await act(async()=>renderer!.unmount()); renderer=undefined;
  expect(cleared).toBe(1); expect(removed).toBe(1); expect(active?.aborted).toBe(true);
  await act(async()=>replies[1]!(new Response(null,{status:401}))); expect(ended).toBe(0);
});
it("does not read while hidden and refreshes when visible",async()=>{
  visible="hidden"; await open(); expect(requests).toHaveLength(0);
  await act(async()=>tick()); expect(requests).toHaveLength(0);
  visible="visible"; await act(async()=>visibility()); expect(requests).toHaveLength(1);
  await act(async()=>replies[0]!(new Response(null,{status:401}))); expect(ended).toBe(1);
});
it("does not read for a signed-out owner",async()=>{await open(false);expect(requests).toHaveLength(0);});

async function changeCallback(onSessionEnded: () => void) {
  await act(async () => renderer!.update(<SettingsProvider><Motoko auth={{required:true,authenticated:true,via:"owner"}} request={{destination:"health"}} onClose={()=>{}} onSignOut={async()=>{}} onSessionEnded={onSessionEnded}/></SettingsProvider>));
}
it("keeps the request and refresh timer across parent callback changes", async () => {
  await open(); const first = requests[0]!.signal;
  await changeCallback(() => { ended++; });
  expect(requests).toHaveLength(1); expect(first?.aborted).toBe(false);
  expect(cleared).toBe(0); expect(removed).toBe(0);
  await act(async () => { tick(); tick(); }); expect(requests).toHaveLength(1);
  await act(async () => replies[0]!(sample()));
  await act(async () => tick()); expect(requests).toHaveLength(2);
});
it("calls the newest callback for a current unauthorized response", async () => {
  await open(); let latest = 0;
  await changeCallback(() => { latest++; });
  await act(async () => replies[0]!(new Response(null, {status:401})));
  expect(ended).toBe(0); expect(latest).toBe(1);
});
it("ignores a late unauthorized response after callback replacement and closure", async () => {
  await open(); let latest = 0;
  await changeCallback(() => { latest++; });
  await act(async () => renderer!.unmount()); renderer = undefined;
  expect(requests[0]!.signal?.aborted).toBe(true);
  await act(async () => replies[0]!(new Response(null, {status:401})));
  expect(ended).toBe(0); expect(latest).toBe(0);
});
