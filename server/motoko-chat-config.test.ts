import { test, expect } from "bun:test";
import * as config from "./motoko-config.ts";
const rigId="01ARZ3NDEKTSV4RRFFQ69G5FAV";
const row={id:"a".repeat(32),revision:1,rigKey:"alpha",rigId,label:"Alpha",profile:"alpha",home:"/fiction/profiles/alpha",bank:"alpha",workspace:"/fiction/workspace",endpoint:"http://127.0.0.1:7434",runtime:"/fiction/runtime",python:"/fiction/runtime/.venv/bin/python",revisionSha:"b".repeat(40)};
const scope={rigs:[{key:"alpha",rigId,rigName:"alpha",label:"Alpha",ownerProfileKey:null,projectKey:null}],ownerProfiles:[],projects:[]};
const parse=(rows:unknown)=>config.chatBindings(JSON.stringify(rows),scope,(p:string)=>p);
test("chat remains unconfigured without an explicit owner mapping",()=>{expect(config.chatBindings(undefined,scope, p=>p)).toEqual([]);});
test("chat validates fixed private binding records",()=>{expect(parse([row])).toEqual([row]);});
test("chat refuses unknown keys, aliases, duplicate mappings and scope expansion",()=>{
 for(const rows of [[{...row,apiKey:"secret"}],[{...row,home:"relative"}],[{...row,endpoint:"http://example.com:7434"}],[{...row,rigId:"other"}],[row,row],[{...row,revision:0}],[{...row,profile:"../beta"}]]) expect(()=>parse(rows)).toThrow("invalid_chat_binding");
 expect(()=>config.chatBindings(JSON.stringify([row]),scope,p=>p===row.home?"/different":p)).toThrow("invalid_chat_binding");
 expect(()=>parse("x".repeat(65537))).toThrow("invalid_chat_binding");
});
test("bridge environment excludes inherited credentials and remote overrides",()=>{
 const env=config.chatBridgeEnvironment(row);
 expect(env).toEqual({PATH:"/usr/bin:/bin",HOME:row.home,HERMES_HOME:row.home,HERMES_PROFILE_NAME:"alpha",PYTHONDONTWRITEBYTECODE:"1",PYTHONNOUSERSITE:"1",PYTHONPATH:row.runtime});
});

test("an approved virtualenv executable keeps its launch path",()=>{expect(config.chatBindings(JSON.stringify([row]),scope,p=>p===row.python?"/usr/bin/python3":p)[0]?.python).toBe(row.python);});
