import { test,expect } from "bun:test";
import * as chat from "./motoko-chat.ts";
const context={ownerSessionId:"owner",allowedRigKeys:new Set<string>(),signal:new AbortController().signal,recheck(){}};
const post=(body:unknown)=>new Request("https://app.example/api/motoko/chat",{method:"POST",headers:{origin:"https://app.example","content-type":"application/json"},body:JSON.stringify(body)});
test("chat route refuses origin, unknown keys and oversized input before service calls",async()=>{
 let calls=0;const service={list(){calls++;return [];},async open(){calls++;throw Error("unexpected");},async act(){calls++;throw Error("unexpected");}};
 for(const request of [post({operation:"list",home:"/private"}),new Request("https://app.example/api/motoko/chat",{method:"POST",body:"{}"}),post({operation:"open",bindingId:"a".repeat(32),writerId:"b".repeat(32),extra:true}),post({text:"x".repeat(32769)})])expect((await chat.handleChatRequest(request,service,context,"https://app.example")).status).not.toBe(200);
 expect(calls).toBe(0);
 const response=await chat.handleChatRequest(post({operation:"list"}),service,context,"https://app.example");expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");expect(calls).toBe(1);
});
test("chat route rechecks authority after its await and omits raw errors",async()=>{
 let valid=true;const ctx={...context,recheck(){if(!valid)throw Error("private diagnostic");}};
 const service={list(){return [];},async open(){valid=false;return {} as never;},async act(){throw Error("private secret");}};
 const response=await chat.handleChatRequest(post({operation:"open",bindingId:"a".repeat(32),writerId:"b".repeat(32)}),service,ctx,"https://app.example");expect(response.status).toBe(401);expect(await response.text()).not.toContain("private");
});

test("owner revocation cancels an incomplete request body",async()=>{
 const controller=new AbortController();const ctx={...context,signal:controller.signal};let cancelled=false;
 const body=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});
 const request=new Request("https://app.example/api/motoko/chat",{method:"POST",headers:{origin:"https://app.example","content-type":"application/json"},body});
 const service={list(){throw Error("unexpected");},async open(){throw Error("unexpected");},async act(){throw Error("unexpected");}};
 const pending=chat.handleChatRequest(request,service,ctx,"https://app.example");controller.abort();
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{const response=await Promise.race([pending,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("body did not cancel")),100);})]);expect(response.status).toBe(401);expect(cancelled).toBe(true);}finally{clearTimeout(timer);}
});

test("writer recovery uses the closed owner route with no extra fields",async()=>{
 let received:unknown;const service={list(){return [];},async open(){throw Error("unexpected");},async act(...args:unknown[]){received=args;return {} as never;}};
 const input={operation:"recover",conversationId:"a".repeat(32),writerId:"b".repeat(32),writerGeneration:7};
 expect((await chat.handleChatRequest(post({...input,force:true}),service,context,"https://app.example")).status).toBe(400);expect(received).toBeUndefined();
 expect((await chat.handleChatRequest(post(input),service,context,"https://app.example")).status).toBe(200);expect(received).toEqual([context,input.conversationId,7,input.writerId,{operation:"recover"}]);
});

test("browser sends cannot supply model context or transport authority",async()=>{
 let calls=0;const service={list(){return [];},async open(){throw Error("unexpected");},async act(){calls++;return {} as never;}};
 for(const field of ["apiText","context","model","endpoint","profile","rigKey"]){
  const request=post({operation:"send",conversationId:"a".repeat(32),writerGeneration:1,writerId:"b".repeat(32),submissionId:"c".repeat(32),text:"hello",[field]:"override"});
  expect((await chat.handleChatRequest(request,service,context,"https://app.example")).status).toBe(400);
 }
 expect(calls).toBe(0);
});
