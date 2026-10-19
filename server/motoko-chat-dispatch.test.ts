import { test,expect } from "bun:test";
import { readFileSync } from "node:fs";
const source=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
test("normal dispatch exposes chat only through the current owner and bounded handler",async()=>{
 const start=source.indexOf('      if (pathname === "/api/motoko/chat")');const end=source.indexOf('      if (pathname.startsWith("/api/motoko/map/"))',start);expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
 const branch=source.slice(start,end).replace('await import("./motoko-chat.ts")','await loadChat()');
 const js=new Bun.Transpiler({loader:"ts",target:"bun"}).transformSync(`async function dispatch(){${branch}throw Error("missing response");}`);
 let valid=true,calls=0;const signal=new AbortController().signal;
 const scope={pathname:"/api/motoko/chat",request:new Request("https://app.example/api/motoko/chat"),ownerSession:{id:"owner"},owner:{current:()=>valid?{}:null,assertCurrent(){if(!valid)throw Error("revoked");},signal:()=>signal,config:{origin:"https://app.example"},denied:()=>new Response(null,{status:401})},chat:null,mapRigKeys:new Set(["alpha"]),loadChat:async()=>({ChatError:class extends Error{},handleChatRequest:async()=>{calls++;return new Response(null,{status:200});}})};
 const run=()=>new Function(...Object.keys(scope),`${js};return dispatch();`)(...Object.values(scope));expect((await run()).status).toBe(200);valid=false;expect((await run()).status).toBe(401);expect(calls).toBe(1);
 expect(source).toContain('&& !pathname.startsWith("/api/motoko/chat") && !pathname.startsWith("/api/motoko/map/") && request.headers.get("content-type")');
});
