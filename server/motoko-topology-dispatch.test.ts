import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { handleRigMapRequest } from "./motoko-topology.ts";
import { handleModelControlRequest } from "./motoko-model-control.ts";
const source=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
const start=source.indexOf('      if (pathname.startsWith("/api/motoko/map/"))');
const end=source.indexOf('      if (pathname.startsWith("/api/motoko/"))',start);
function dispatch(scope:Record<string,unknown>):Promise<Response>{
 expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
 const branch=source.slice(start,end).replace('await import("./motoko-topology.ts")','await loadMap()').replace('await import("./motoko-model-control.ts")','await loadControl()');
 const js=new Bun.Transpiler({loader:"ts",target:"bun"}).transformSync(`async function dispatch(){${branch}throw Error("no map response");}`);
 return new Function(...Object.keys(scope),`${js};return dispatch();`)(...Object.values(scope));
}
test("map dispatch avoids coordination and rechecks after module load",async()=>{
 let valid=true,reads=0;const controller=new AbortController();
 const owner={current:()=>valid?{}:null,assertCurrent:()=>{if(!valid)throw Error("revoked");},signal:()=>controller.signal,denied:()=>new Response(null,{status:401})};
 const mapReader={listAllowedRigs:async()=>{reads++;return {rigs:[],source:"private-scope",completeFleet:false};}};
 const scope={pathname:"/api/motoko/map/rigs",request:new Request("http://app/api/motoko/map/rigs"),ownerSession:{id:"fake-owner"},owner,mapReader,mapRigKeys:new Set(["main"]),loadMap:async()=>({handleRigMapRequest})};
 expect((await dispatch(scope)).status).toBe(200);expect(reads).toBe(1);
 expect((await dispatch({...scope,loadMap:async()=>{valid=false;return {handleRigMapRequest};}})).status).toBe(401);expect(reads).toBe(1);
});
test("model Save dispatch binds owner Origin and rechecks after module load",async()=>{
 let valid=true,saves=0;const controller=new AbortController();
 const owner={config:{origin:"https://owner.example"},current:()=>valid?{}:null,assertCurrent:()=>{if(!valid)throw Error("revoked");},signal:()=>controller.signal,denied:()=>new Response(null,{status:401})};
 const modelControl={save:async()=>{saves++;return {outcome:"no-op"};}};
 const pathname="/api/motoko/map/rigs/main/model";
 const request=new Request(`https://owner.example${pathname}`,{method:"POST",headers:{origin:owner.config.origin,"content-type":"application/json"},body:"{}"});
 const scope={pathname,request,ownerSession:{id:"fake-owner"},owner,modelControl,mapReader:{},mapRigKeys:new Set(["main"]),loadMap:async()=>({handleRigMapRequest}),loadControl:async()=>({handleModelControlRequest})};
 expect((await dispatch(scope)).status).toBe(200);expect(saves).toBe(1);
 expect((await dispatch({...scope,loadControl:async()=>{valid=false;return {handleModelControlRequest};}})).status).toBe(401);expect(saves).toBe(1);
});
test("map validation does not touch the owner idle deadline or prebuffer an unbounded body",()=>{
 expect(source).toContain('const ownerTouch = mutating && !pathname.startsWith("/api/motoko/map/")');
 expect(source).toContain('owner.match(request, ownerTouch)');
 expect(source).toContain('&& !pathname.startsWith("/api/motoko/map/") && request.headers.get("content-type")');
});
