import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcProcess, type RecordValue } from "../../extensions/subagents/rpc.ts";

// This probes host capabilities independently of the subagent implementation.
// It uses only public extension APIs and an isolated deterministic provider.
const fixture = `
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
export default function(pi) {
 let calls=0, events=[], captured;
 const usage={input:1,output:2,cacheRead:0,cacheWrite:0,totalTokens:3,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
 for(const name of ['input','before_agent_start','agent_start','turn_start','message_start','message_update','message_end','tool_call','tool_result','tool_execution_start','tool_execution_end','turn_end','agent_end','agent_before_settle','agent_settled']) {
  pi.on(name,(event,ctx)=>{events.push({type:event.type,outcome:event.outcome,signal:ctx.signal?.aborted});});
 }
 pi.registerCommand('probe-state',{description:'Inspect public host state',handler:async(_args,ctx)=>{
  ctx.ui.notify('probe:'+JSON.stringify({calls,events,idle:ctx.isIdle(),signal:ctx.signal?.aborted,captured:captured?.aborted}));
 }});
 pi.registerCommand('probe-wake',{description:'Emulate an event-driven result-ready wake',handler:async()=>{
  pi.sendMessage({customType:'probe-ready',content:'Collect the ready result once.',display:false},{triggerTurn:true});
 }});
 pi.registerTool({name:'probe_yield',label:'Yield',description:'Quiet host probe',exposure:'model-only',parameters:Type.Object({}),async execute(_id,_args,signal){
  captured=signal;return {content:[{type:'text',text:'Waiting'}],details:{waiting:true},terminate:true};
 }});
 pi.registerTool({name:'probe_collect',label:'Collect',description:'Account child usage through a tool',parameters:Type.Object({}),async execute(){
  return {content:[{type:'text',text:'Worker report'}],details:{report:true},usage:{...usage,input:7,output:11,totalTokens:18}};
 }});
 pi.registerProvider('host-probe',{
  api:'host-probe-api',baseUrl:'https://fixture.invalid',apiKey:'fixture',
  models:[{id:'model',name:'probe',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:64000}],
  streamSimple(model,context){
   calls++;
   const stream=createAssistantMessageEventStream();
   const last=context.messages.at(-1);
   const output={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),usage,stopReason:'stop',content:[]};
   queueMicrotask(()=>{
    stream.push({type:'start',partial:output});
    if(last?.role==='user' || last?.content?.some?.(p=>p.type==='text' && p.text.includes('Collect the ready'))) {
     const prompt=JSON.stringify(last.content);
     const name=prompt.includes('Collect the ready')?'probe_collect':prompt.includes('nested')?'codemode':'probe_yield';
     const args=name==='codemode'?{code:'return await tools.probe_collect({});'}:{};
     output.stopReason='toolUse';output.content=[{type:'toolCall',id:'probe-'+calls,name,arguments:args}];
     stream.push({type:'toolcall_start',contentIndex:0,partial:output});stream.push({type:'toolcall_end',contentIndex:0,toolCall:output.content[0],partial:output});
    } else {
     output.content=[{type:'text',text:'Final handoff'}];
     stream.push({type:'text_start',contentIndex:0,partial:output});stream.push({type:'text_delta',contentIndex:0,delta:'Final handoff',partial:output});stream.push({type:'text_end',contentIndex:0,content:'Final handoff',partial:output});
    }
    stream.push({type:'done',reason:output.stopReason,message:output});stream.end();
   });return stream;
  }
 });
}
`;

async function probe() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-host-probe-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off", defaultTools: ["+codemode"] }));
  const extension = join(cwd, "probe.ts");
  writeFileSync(extension, fixture);
  const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
  const invocation = process.env.PI_TEST_HOST ? { command: process.env.PI_TEST_HOST, args: [] } : { command: process.execPath, args: [cli] };
  const rows: RecordValue[] = [];
  const rpc = new RpcProcess(invocation, cwd,
    ["--model", "host-probe/model", "--thinking", "off", "--extension", extension, "--session-dir", join(cwd, "sessions")],
    { ...process.env, PI_RPC_SUBAGENT_CHILD: "", PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, row => rows.push(row));
  try { await rpc.send({ type: "get_state" }); }
  catch (error) { await rpc.close(); throw error; }
  async function wake() {
    let unsubscribe = () => {};
    let timer: NodeJS.Timeout | undefined;
    const settled = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Wake didn't settle: ${cwd}`)), 10_000);
      unsubscribe = rpc.onRecord(row => {
        if (row.type === "agent_settled") resolve();
        if (row.type === "transport_error") reject(new Error(row.error));
      });
    });
    try { await Promise.all([rpc.send({ type: "prompt", message: "/probe-wake" }), settled]); }
    finally { clearTimeout(timer); unsubscribe(); }
  }
  async function state() {
    const start = rows.length;
    await rpc.send({ type: "prompt", message: "/probe-state" });
    const row = rows.slice(start).find(row => row.method === "notify" && row.message?.startsWith("probe:"));
    assert(row, `Missing probe state: ${cwd}`);
    return JSON.parse(row.message.slice(6));
  }
  return { cwd, rows, rpc, state, wake };
}

test("Pi 1.0.0 quiet yield leaves idle abort unobservable to public extension hooks", async () => {
  const p = await probe();
  try {
    await p.rpc.run("yield");
    const before = await p.state();
    assert.equal(before.idle, true);
    assert.equal(before.calls, 1);
    assert.equal(before.signal, undefined);
    assert.equal(before.captured, false);
    assert.equal(p.rows.filter(row => row.type === "message_end" && row.message?.role === "assistant").length, 1);
    const start = p.rows.length;
    await p.rpc.send({ type: "abort" });
    const after = await p.state();
    assert.deepEqual(after, before, "Pi 1.0.0 has no public idle-abort notification; explicit pause controls automatic wakes");
    assert(!p.rows.slice(start).some(row => ["agent_start", "agent_end", "agent_before_settle", "agent_settled"].includes(row.type)));
    // A supported wake still runs after the abort. The extension received no
    // information with which to suppress it while retaining normal idle wakes.
    await p.wake();
    const entries = (await p.rpc.send({ type: "get_entries" })).data.entries;
    assert(entries.some((entry: RecordValue) => entry.customType === "probe-ready" && entry.display === false));
    const collected = entries.find((entry: RecordValue) => entry.message?.toolName === "probe_collect");
    assert.equal(collected?.message.usage?.totalTokens, 18, JSON.stringify(p.rows));
    assert.equal((await p.state()).calls, 3);
    const stats = (await p.rpc.send({ type: "get_session_stats" })).data;
    assert.equal(stats.tokens.input, 10);
    assert.equal(stats.tokens.output, 17);
    console.log(`Host probe evidence: ${p.cwd}`);
  } finally { await p.rpc.close(); }
});

test("Pi 1.0.0 codemode collection persists nested child usage on the outer tool result", async () => {
  const p = await probe();
  try {
    await p.rpc.run("nested");
    const entries = (await p.rpc.send({ type: "get_entries" })).data.entries;
    const outer = entries.find((entry: RecordValue) => entry.message?.toolName === "codemode");
    assert.equal(outer?.message.usage?.totalTokens, 18, JSON.stringify(p.rows));
    assert(!entries.some((entry: RecordValue) => entry.message?.toolName === "probe_collect"));
    assert.equal((await p.rpc.send({ type: "get_session_stats" })).data.tokens.input, 9);
    console.log(`Nested accounting evidence: ${p.cwd}`);
  } finally { await p.rpc.close(); }
});
