import { test,expect } from "bun:test";
import * as chat from "./motoko-chat.ts";
test("bridge transport preserves reply IDs and closes pending calls as unknown",async()=>{
 let frames!:ReadableStreamDefaultController<Uint8Array>;const writes:string[]=[];const enc=new TextEncoder();
 const child={stdout:new ReadableStream<Uint8Array>({start(c){frames=c;}}),stdin:{write(value:string){writes.push(value);return value.length;},flush(){return 0;},end(){return 0;}}};
 const opening=chat.attachChatBridge(child,{binding:{},subject:"fiction",ownedSessions:[]},()=>{});
 frames.enqueue(enc.encode('{"kind":"ready","memory":"uninitialized"}\n'));
 const bridge=await opening;const pending=bridge.command({operation:"memory",sessionId:"session-one"});
 await Promise.resolve();const sent=JSON.parse(writes[1]!);expect(sent.command.operation).toBe("memory");
 frames.enqueue(enc.encode(JSON.stringify({kind:"result",id:sent.id,result:{state:"ready"}})+'\n'));
 expect(await pending).toEqual({state:"ready"});
 const unknown=bridge.command({operation:"submit"});bridge.close();await expect(unknown).rejects.toThrow("outcome_unknown");
 expect(writes).toHaveLength(3);
});
test("bridge transport refuses oversized frames without private diagnostics",async()=>{
 let frames!:ReadableStreamDefaultController<Uint8Array>;
 const child={stdout:new ReadableStream<Uint8Array>({start(c){frames=c;}}),stdin:{write(){return 0;},flush(){return 0;},end(){return 0;}}};
 const opening=chat.attachChatBridge(child,{},()=>{});frames.enqueue(new Uint8Array(8*1024*1024+1).fill(120));
 await expect(opening).rejects.toThrow("outcome_unknown");
});

test("an old runtime returns an explicit incompatible result before commands",async()=>{
 let frames!:ReadableStreamDefaultController<Uint8Array>;const writes:string[]=[];
 const child={stdout:new ReadableStream<Uint8Array>({start(c){frames=c;}}),stdin:{write(s:string){writes.push(s);return s.length;},flush(){return 0;},end(){return 0;}}};
 const opening=chat.attachChatBridge(child,{},()=>{});frames.enqueue(new TextEncoder().encode('{"kind":"error","code":"incompatible_runtime"}\n'));await expect(opening).rejects.toThrow("incompatible_runtime");expect(writes).toHaveLength(1);
});

test("split frames preserve Unicode and a foreign reply fails pending work as unknown",async()=>{
 let frames!:ReadableStreamDefaultController<Uint8Array>;const writes:string[]=[];const enc=new TextEncoder();
 const child={stdout:new ReadableStream<Uint8Array>({start(c){frames=c;}}),stdin:{write(value:string){writes.push(value);return value.length;},flush(){return 0;},end(){return 0;}}};
 const opening=chat.attachChatBridge(child,{},()=>{});frames.enqueue(enc.encode('{"kind":"ready"}\n'));const bridge=await opening;
 try{const pending=bridge.command({operation:"resume"});await Promise.resolve();const id=JSON.parse(writes[1]!).id;
 const line=enc.encode(JSON.stringify({kind:"result",id,result:{text:"漢字"}})+'\n');
 for(const byte of line)frames.enqueue(new Uint8Array([byte]));expect(await pending).toEqual({text:"漢字"});
 const unknown=bridge.command({operation:"submit"});frames.enqueue(enc.encode('{"kind":"result","id":"foreign","result":{}}\n'));await expect(unknown).rejects.toThrow("outcome_unknown");
 expect(writes.filter(line=>line.includes('"operation":"submit"'))).toHaveLength(1);
 }finally{bridge.close();}
});

test("private submit frames use the final escaped byte count and other commands keep their limit",async()=>{
 let frames!:ReadableStreamDefaultController<Uint8Array>;const writes:string[]=[];const enc=new TextEncoder();
 const child={stdout:new ReadableStream<Uint8Array>({start(c){frames=c;}}),stdin:{write(s:string){writes.push(s);return s.length;},flush(){return 0;},end(){return 0;}}};
 const opening=chat.attachChatBridge(child,{},()=>{});frames.enqueue(enc.encode('{"kind":"ready"}\n'));const bridge=await opening;
 try{
  const input={operation:"submit",apiText:"漢字".repeat(12000)};const pending=bridge.command(input);await Promise.resolve();
  expect(writes).toHaveLength(2);const sent=JSON.parse(writes[1]!);
  frames.enqueue(enc.encode(JSON.stringify({kind:"result",id:sent.id,result:{ok:true}})+"\n"));expect(await pending).toEqual({ok:true});
  await expect(bridge.command({operation:"memory",text:"x".repeat(32768)})).rejects.toThrow("input_too_large");
  await expect(bridge.command({operation:"submit",apiText:'"'.repeat(524288)})).rejects.toThrow("input_too_large");
  expect(writes).toHaveLength(2);
  const base=Buffer.byteLength(JSON.stringify({id:"4",command:{operation:"submit",apiText:""}})+"\n");
  const edge=bridge.command({operation:"submit",apiText:"x".repeat(1048576-base)});await Promise.resolve();
  expect(Buffer.byteLength(writes[2]!)).toBe(1048576);const last=JSON.parse(writes[2]!);
  frames.enqueue(enc.encode(JSON.stringify({kind:"result",id:last.id,result:{ok:true}})+"\n"));expect(await edge).toEqual({ok:true});
  await expect(bridge.command({operation:"submit",apiText:"x".repeat(1048577-base)})).rejects.toThrow("input_too_large");
  expect(writes).toHaveLength(3);
 }finally{bridge.close();}
});
