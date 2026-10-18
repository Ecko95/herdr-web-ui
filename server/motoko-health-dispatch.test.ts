import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript-api";
import { handleHealthRequest } from "./motoko-health.ts";

// Execute the actual dispatch branch with fake HTTP dependencies, without loading the full server.
const source=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
const start=source.indexOf('      if (pathname === "/api/motoko/health")');
const end=source.indexOf('      if (pathname.startsWith("/api/motoko/"))',start);
function dispatch(scope:Record<string,unknown>):Promise<Response>{
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  const branch=source.slice(start,end).replace('await import("./motoko-health.ts")','await loadHealth()');
  const js=ts.transpileModule(`async function dispatch() { ${branch} throw new Error("no health response"); }`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  return new Function(...Object.keys(scope),`${js}; return dispatch();`)(...Object.values(scope));
}
test("health dispatch ignores coordination and denies revocation during module load",async()=>{
  let valid=true,reads=0;
  const scope={pathname:"/api/motoko/health",request:new Request("http://localhost/api/motoko/health"),ownerSession:{id:"fake-owner"},
    owner:{current:()=>valid?{}:null,assertCurrent:()=>{if(!valid)throw Error("revoked");},denied:()=>new Response(null,{status:401})},
    loadHealth:async()=>({handleHealthRequest}), sampleHealth:()=>{reads++;return {sampledAt:"2026-10-18T00:00:00Z",staleAfterMs:15000,cpu:{state:"unknown",reason:"first"},memory:{state:"unknown",reason:"fake"},uptime:{state:"unknown",reason:"fake"}};}};
  const {pathname,request,ownerSession,owner,loadHealth,sampleHealth}=scope;
  expect((await dispatch({pathname,request,ownerSession,owner,loadHealth,sampleHealth})).status).toBe(200);
  expect(reads).toBe(1);
  expect((await dispatch({pathname,request,ownerSession,owner,sampleHealth,loadHealth:async()=>{valid=false;return {handleHealthRequest};}})).status).toBe(401);
  expect(reads).toBe(1);
});
