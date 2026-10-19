import { expect, it, spyOn } from "bun:test";
import { mapScope } from "./motoko-config.ts";
import { createRigModelReader, ownerRigTools, handleRigMapRequest } from "./motoko-topology.ts";

const rigId = "01AAAAAAAAAAAAAAAAAAAAAAAA";
const seatA = "01BBBBBBBBBBBBBBBBBBBBBBBB", seatB = "01CCCCCCCCCCCCCCCCCCCCCCCC";
const podId = "01DDDDDDDDDDDDDDDDDDDDDDDD";
const scope = () => mapScope({ rigs:[{key:"main",rigId,rigName:"test-rig",label:"Test rig",ownerProfileKey:null,projectKey:null}],ownerProfiles:[],projects:[] }, null)!;
function graph() {
  const data = {rigId,podId,podNamespace:"team",role:null,runtime:"codex",model:"gpt-6.1-sol",profile:null,status:"running",startupStatus:"attention_required",contextUsedPercentage:44,contextFresh:false,contextAvailability:"known"};
  return {nodes:[{id:`pod-${podId}`,type:"podGroup",data:{...data,logicalId:"team",podLabel:"Team"}},
    {id:seatA,type:"rigNode",parentId:`pod-${podId}`,data:{...data,logicalId:"team.a",canonicalSessionName:"team-a@test-rig"}},
    {id:seatB,type:"rigNode",parentId:`pod-${podId}`,data:{...data,logicalId:"team.b",canonicalSessionName:"team-b@test-rig"}}],
    edges:[{id:"edge-a",source:seatA,target:seatB,label:"delegates_to"},{id:"edge-b",source:seatB,target:seatA,label:"can_observe"},{id:"edge-c",source:seatA,target:seatA,label:"collaborates_with"},{id:"edge-d",source:seatA,target:seatB,label:"escalates_to"}]};
}
function spec() { return {version:"0.2",name:"test-rig",pods:[{id:"team",label:"Team",members:[{id:"a",agent_ref:"agent",profile:"default",runtime:"codex",cwd:"/private",model:"old"},{id:"b",agent_ref:"agent",profile:"default",runtime:"codex",cwd:"/private"}],edges:[{from:"a",to:"b",kind:"delegates_to"},{from:"b",to:"a",kind:"can_observe"},{from:"a",to:"a",kind:"collaborates_with"},{from:"a",to:"b",kind:"escalates_to"}]}],edges:[]}; }
function fixture() {
  let rawGraph: unknown = graph(), rawSpec: unknown = spec();
  let revoked = false, valid = true; const controller = new AbortController();
  const calls: {url:string;body?:string;signal?:AbortSignal|null}[] = [];
  const owner = {ownerSessionId:"owner",allowedRigKeys:new Set(["main"]),signal:controller.signal,recheck(){if(revoked)throw new Error("owner_required");}};
  const reader = createRigModelReader(scope(), {now:()=>100_000, transport:async(url,init)=>{
    calls.push({url,body:typeof init?.body === "string"?init.body:undefined,signal:init?.signal});
    if(url.endsWith("/graph")) return Response.json(rawGraph);
    if(url.endsWith("/spec")) return new Response(JSON.stringify(rawSpec));
    if(url.endsWith("/import/validate")) return Response.json({valid,errors:valid?[]:["private instruction /secret sk-do-not-leak"]});
    throw new Error("unexpected route");
  }});
  return {reader,owner,calls,setGraph:(g:unknown)=>{rawGraph=g;},setSpec:(s:unknown)=>{rawSpec=s;},setValid:()=>{valid=false;},revoke:()=>{revoked=true;controller.abort();}};
}
it("validates explicit scope and retains compatible single-rig unknown mappings", () => {
  const target={rigId,rigName:"test-rig",sourceSession:"owner@external",humanId:"owner",destinationSession:"team@test-rig"};
  expect(mapScope(undefined,target)?.rigs).toHaveLength(1); expect(mapScope(undefined,null)).toBeNull();
  for(const raw of [null,{}, {rigs:[],ownerProfiles:[],projects:[]}, {...scope(),rigs:[...scope().rigs,...scope().rigs]}, {...scope(),rigs:[{...scope().rigs[0],rigId:"http://evil"}]}]) expect(()=>mapScope(raw,target)).toThrow();
});
it("projects real directions, cycles, parallel links, self-links and separate freshness",async()=>{
 const f=fixture();const model=await f.reader.readRigModel(f.owner,"main");
 expect(model.graph.edges.map(e=>[e.sourceId,e.targetId])).toEqual([[seatA,seatB],[seatB,seatA],[seatA,seatA],[seatA,seatB]]);
 expect(model.graph.seats[0]!.context.fresh).toBe(false);expect(model.graph.seats[0]!.startupStatus).toMatchObject({value:"attention_required"});
 expect(model.configuration.effectiveRuntime.state).toBe("unknown");expect(model.scope.project.state).toBe("unknown");
 expect(model.graph.seats[0]!.agentProfile.value.state).toBe("unknown");
 expect(model.configuration.declared[0]!.agentProfile).toMatchObject({value:"default"});
 expect(f.calls.map(c=>c.url)).toEqual([`http://127.0.0.1:7433/api/rigs/${rigId}/graph`,`http://127.0.0.1:7433/api/rigs/${rigId}/spec`]);
 expect(model.capabilities).toMatchObject({apply:false,hermesAdapter:false});
});
it("omits private canaries from graph, configuration, tools and errors",async()=>{
 const f=fixture(); const g=graph(); Object.assign(g.nodes[1]!.data,{binding:"CANARY_BINDING",resumeToken:"CANARY_RESUME",agentActivity:{text:"CANARY_ACTIVITY"},currentQitems:[{body:"CANARY_WORK"}],hooks:"CANARY_HOOK",credentials:"CANARY_CREDENTIAL",instructions:"CANARY_INSTRUCTION"});f.setGraph(g);
 const s=spec();Object.assign(s,{instructions:"CANARY_SPEC",hooks:{run:"CANARY_HOOK"}});f.setSpec(s);
 const tools=ownerRigTools(f.reader,f.owner); const model=await tools.read_rig_model({rigKey:"main"});
 expect(JSON.stringify(model)).not.toContain("CANARY");expect(JSON.stringify(model)).not.toContain("/private");expect(Object.keys(tools)).toEqual(["list_managed_rigs","read_rig_model"]);
 f.setValid();const result=await f.reader.validateDraft(f.owner,"main",{snapshotId:model.configuration.snapshotId!,changes:[{kind:"seat-model",seatId:seatA,value:"new-model"}]});
 expect(result.valid).toBe(false);expect(JSON.stringify(result)).not.toContain("private instruction");
});
it("rejects invalid identity, graph structure and unsupported kinds without partial graphs",async()=>{
 const variants: unknown[]=[];
 let g=graph();g.nodes.push(g.nodes[1]!);variants.push(g);
 g=graph();g.edges[0]!.target="missing";variants.push(g);
 g=graph();g.edges[0]!.label="invented";variants.push(g);
 g=graph();g.nodes[1]!.data.rigId="foreign";variants.push(g);
 g=graph();g.nodes[1]!.parentId="pod-missing";variants.push(g);
 g=graph();g.nodes[1]!.data.logicalId="https://evil";variants.push(g);
 g=graph();g.nodes[1]!.data.model="sk-abcdefghijklmnopqrstuvwxyz123456";variants.push(g);
 for(const raw of variants){const f=fixture();f.setGraph(raw);await expect(f.reader.readRigModel(f.owner,"main")).rejects.toThrow();}
 const f=fixture();g=graph();g.edges=[];f.setGraph(g);expect((await f.reader.readRigModel(f.owner,"main")).graph.edges).toEqual([]);
});
it("keeps a valid graph when configuration fails or its join changes",async()=>{
 const f=fixture();f.setSpec({name:"test-rig",pods:[]});const m=await f.reader.readRigModel(f.owner,"main");
 expect(m.graph.seats).toHaveLength(2);expect(m.configuration.state).toBe("unknown");expect(m.capabilities.validateDraft).toBe(false);
});
it("validates a typed draft against the canonical export without an operational call",async()=>{
 const f=fixture();const m=await f.reader.readRigModel(f.owner,"main");
 const result=await f.reader.validateDraft(f.owner,"main",{snapshotId:m.configuration.snapshotId!,changes:[{kind:"seat-model",seatId:seatA,value:"new-model"},{kind:"edge-remove",edgeId:"edge-d"},{kind:"seat-profile",seatId:seatB,value:"review"},{kind:"edge-add",sourceId:seatB,targetId:seatB,edgeKind:"spawned_by"}]});
 expect(result).toMatchObject({valid:true,applied:false});expect(result.effects.map(x=>x.operation)).toEqual(["stored-model-only","unsupported-edge-edit","unsupported-profile-edit","unsupported-edge-edit"]);
 const call=f.calls.find(c=>c.url.endsWith("/import/validate"))!; const draft=JSON.parse(call.body!);
 expect(draft.pods[0].members[0].model).toBe("new-model");expect(draft.pods[0].members[1].profile).toBe("review");expect(draft.pods[0].members[0].agent_ref).toBe("agent");
 expect(f.calls.every(c=>c.url.endsWith("/graph")||c.url.endsWith("/spec")||c.url.endsWith("/import/validate"))).toBe(true);
});
it("refuses stale snapshots, untyped changes and foreign scope before validation",async()=>{
 const f=fixture();const m=await f.reader.readRigModel(f.owner,"main");
 for(const changes of [[{kind:"seat-model",seatId:seatA,value:"../private"}],[{kind:"seat-model",seatId:"foreign",value:"ok"}],[{kind:"apply",value:"x"}],[{kind:"seat-model",seatId:seatA,value:"ok",path:"/secret"}]]) await expect(f.reader.validateDraft(f.owner,"main",{snapshotId:m.configuration.snapshotId!,changes})).rejects.toThrow();
 const s=spec();s.pods[0]!.members[0]!.model="changed";f.setSpec(s);await expect(f.reader.validateDraft(f.owner,"main",{snapshotId:m.configuration.snapshotId!,changes:[]})).rejects.toThrow("snapshot_changed");
 await expect(f.reader.readRigModel(f.owner,"http://evil")).rejects.toThrow();expect(f.calls.some(c=>c.url.endsWith("/import/validate"))).toBe(false);
});
it("checks owner scope before reads and again before delivery",async()=>{
 const f=fixture();f.owner.allowedRigKeys.clear();await expect(f.reader.readRigModel(f.owner,"main")).rejects.toThrow();expect(f.calls).toHaveLength(0);
 const other=fixture();other.revoke();await expect(other.reader.readRigModel(other.owner,"main")).rejects.toThrow();expect(other.calls).toHaveLength(0);
 let revoked=false;const controller=new AbortController();const owner={ownerSessionId:"owner",allowedRigKeys:new Set(["main"]),signal:controller.signal,recheck(){if(revoked)throw new Error("owner_required");}};
 const reader=createRigModelReader(scope(),{transport:async()=>{revoked=true;controller.abort();return Response.json(graph());}});
 await expect(reader.readRigModel(owner,"main")).rejects.toThrow();
});
it("bounds streams and times out even when the transport ignores abort",async()=>{
 const f=fixture();
 const big=createRigModelReader(scope(),{transport:async()=>new Response("x".repeat(262145))});await expect(big.readRigModel(f.owner,"main")).rejects.toThrow("source_too_large");
 const slow=createRigModelReader(scope(),{timeoutMs:5,transport:()=>new Promise(()=>{})});await expect(slow.readRigModel(f.owner,"main")).rejects.toThrow("source_timeout");
});
it("keeps legacy mode and unknown map routes closed",async()=>{
 const f=fixture();let r=await handleRigMapRequest(new Request("http://app/api/motoko/map/rigs"),f.reader,null);expect(r.status).toBe(404);expect(f.calls).toHaveLength(0);
 r=await handleRigMapRequest(new Request("http://app/api/motoko/map/rigs/main?url=http://evil"),f.reader,f.owner);expect(r.status).toBe(400);expect(f.calls).toHaveLength(0);
 r=await handleRigMapRequest(new Request("http://app/api/motoko/map/rigs"),f.reader,f.owner);expect(r.headers.get("cache-control")).toBe("no-store");expect((await r.json()).rigs).toHaveLength(1);
});

it("rechecks owner authority at the tool delivery boundary",async()=>{
 const f=fixture();const model=await f.reader.readRigModel(f.owner,"main");
 const reader={...f.reader,readRigModel:async()=>{f.revoke();return model;}};
 await expect(ownerRigTools(reader,f.owner).read_rig_model({rigKey:"main"})).rejects.toThrow("owner_required");
});
it("rejects duplicate edges, all size limits and invalid source percentages",async()=>{
 const cases:unknown[]=[];let g=graph();g.edges.push(g.edges[0]!);cases.push(g);
 cases.push({nodes:Array(233).fill(null),edges:[]});cases.push({nodes:[],edges:Array(1001).fill(null)});
 for(const raw of cases){const f=fixture();f.setGraph(raw);await expect(f.reader.readRigModel(f.owner,"main")).rejects.toThrow();}
 const f=fixture();g=graph();g.nodes[1]!.data.contextUsedPercentage=101;f.setGraph(g);expect((await f.reader.readRigModel(f.owner,"main")).graph.seats[0]!.context.percent.state).toBe("unknown");
});
it("denies owner revocation during validation and scope removal before tool delivery",async()=>{
 const f=fixture();const model=await f.reader.readRigModel(f.owner,"main");
 const reader=createRigModelReader(scope(),{transport:async(url)=>{
  if(url.endsWith("/graph"))return Response.json(graph());if(url.endsWith("/spec"))return new Response(JSON.stringify(spec()));f.revoke();return Response.json({valid:true});
 },now:()=>100_000});
 await expect(reader.validateDraft(f.owner,"main",{snapshotId:model.configuration.snapshotId!,changes:[]})).rejects.toThrow("owner_required");
 const second=fixture();const tools=ownerRigTools({...second.reader,readRigModel:async()=>{second.owner.allowedRigKeys.clear();return model;}},second.owner);
 await expect(tools.read_rig_model({rigKey:"main"})).rejects.toThrow("rig_not_allowed");
});
it("supports the canonical legacy node join without a pod claim",async()=>{
 const f=fixture();const g=graph();g.nodes=g.nodes.slice(1);for(const n of g.nodes){n.parentId=undefined;Object.assign(n.data,{podId:null});}f.setGraph(g);
 f.setSpec({schema_version:1,name:"test-rig",version:"0.1.0",nodes:[{id:"team.a",runtime:"codex",model:"old"},{id:"team.b",runtime:"codex"}],edges:[]});
 const m=await f.reader.readRigModel(f.owner,"main");expect(m.configuration.state).toBe("known");expect(m.graph.pods).toEqual([]);expect(m.configuration.declared[0]!.agentProfile.state).toBe("unknown");
});

it("refuses a duplicate edge removal instead of removing a second parallel edge",async()=>{
 const f=fixture();const m=await f.reader.readRigModel(f.owner,"main");
 await expect(f.reader.validateDraft(f.owner,"main",{snapshotId:m.configuration.snapshotId!,changes:[{kind:"edge-remove",edgeId:"edge-a"},{kind:"edge-remove",edgeId:"edge-a"}]})).rejects.toThrow("unsupported_operation");
});

it("bypasses environment proxies for fixed loopback reads",async()=>{
 const f=fixture();const calls:RequestInit[]=[];
 const mock=spyOn(globalThis,"fetch").mockImplementation(Object.assign(async(url:RequestInfo|URL,init?:RequestInit)=>{calls.push(init??{});return String(url).endsWith("/graph")?Response.json(graph()):new Response(JSON.stringify(spec()));},{preconnect:globalThis.fetch.preconnect}));
 try{await createRigModelReader(scope()).readRigModel(f.owner,"main");expect(calls).toHaveLength(2);for(const init of calls)expect(init).toMatchObject({proxy:false,redirect:"error"});}finally{mock.mockRestore();}
});
