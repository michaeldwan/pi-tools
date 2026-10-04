import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcProcess, type RecordValue } from "../../extensions/subagents/rpc.ts";
import { hostInvocation } from "./fixture-invocation.ts";

export const provider = `
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {Type} from 'typebox';
import {existsSync,watch,writeFileSync,appendFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
export default function(pi) {
 let sequence=0;
 pi.registerCommand('fixture-reload',{description:'Reload bridge',handler:async(_args,ctx)=>{await ctx.reload();}});
 pi.registerCommand('fixture-legacy',{description:'Create a previous-version completion with the public API',handler:async(args)=>{
  const report=JSON.parse(args);pi.sendMessage({customType:'pi-rpc-subagent-completion',content:'Previously handled report',details:report,display:false});
 }});
 pi.registerTool({name:'fixture_other',label:'Other',description:'Unrelated tool with its own attempt details',parameters:Type.Object({}),async execute(){
  return {content:[{type:'text',text:'Other tool result'}],details:{id:'not-a-worker',attempt:1,status:'done'}};
 }});
 pi.registerTool({name:'fixture_gate',label:'Gate',description:'Deterministic fixture gate',parameters:Type.Object({gate:Type.String()}),
  async execute(_id,{gate},signal,_update,ctx) {
   const path=join(ctx.cwd,gate);
   writeFileSync(path+'.started','started');
   if(!existsSync(path)) await new Promise((resolve,reject)=>{
    const close=()=>{observer.close();signal?.removeEventListener('abort',abort);};
    const abort=()=>{close();reject(new Error('gate aborted'));};
    const observer=watch(ctx.cwd,()=>{if(existsSync(path)){close();resolve();}});
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted) abort();else if(existsSync(path)){close();resolve();}
   });
   return {content:[{type:'text',text:'Gate released'}],details:{gate}};
  }
 });
 pi.on('tool_result',async(e,ctx)=>{
  if(['wait_for_subagents','get_subagent_result'].includes(e.toolName) && e.usage && existsSync(join(ctx.cwd,'crash-on-collect'))) {
   writeFileSync(join(ctx.cwd,'collection-reserved'),'reserved');await new Promise(()=>{});
  }
 });
 pi.on('agent_before_settle',async(_event,ctx)=>{
  const flag=join(ctx.cwd,'near-settle-request');
  if(!process.env.PI_RPC_SUBAGENT_CHILD && existsSync(flag)) {
   unlinkSync(flag);writeFileSync(join(ctx.cwd,'near-settle.started'),'started');
   await new Promise(resolve=>{
    const observer=watch(ctx.cwd,()=>{if(existsSync(join(ctx.cwd,'near-settle'))){observer.close();resolve();}});
    if(existsSync(join(ctx.cwd,'near-settle'))){observer.close();resolve();}
   });
  }
 });
 pi.registerProvider('delivery-fixture',{
  api:'delivery-fixture-api',baseUrl:'https://fixture.invalid',apiKey:'fixture',
  models:[{id:'model',name:'model',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:64000}],
  streamSimple(model,context,options) {
   appendFileSync(join(process.cwd(),'requests-'+process.pid+'.jsonl'),JSON.stringify(context.messages)+'\\n');
   const stream=createAssistantMessageEventStream();
   const usage={input:2,output:3,cacheRead:0,cacheWrite:0,totalTokens:5,cost:{input:0.02,output:0.03,cacheRead:0,cacheWrite:0,total:0.05}};
   const output={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content:[],usage,stopReason:'stop'};
   queueMicrotask(()=>{
    stream.push({type:'start',partial:output});
    const text=m=>typeof m?.content==='string'?m.content:m?.content?.filter(p=>p.type==='text').map(p=>p.text).join('');
    const last=context.messages.at(-1);
    const prompt=text(last)??'';
    let spec;
    if(last?.role==='user' && prompt.startsWith('{')) spec=JSON.parse(prompt);
    let calls;
    if(spec?.stall) {
     const abort=()=>{output.stopReason='aborted';output.errorMessage='fixture aborted';stream.push({type:'error',reason:'aborted',error:output});stream.end();};
     if(options.signal?.aborted) abort();else options.signal?.addEventListener('abort',abort,{once:true});return;
    }
    if(spec?.calls) calls=spec.calls;
    else if(spec?.name) calls=[{name:spec.name,args:spec.args}];
    else if(spec?.worker && spec.gate) calls=[{name:'fixture_gate',args:{gate:spec.gate}}];
    else if(last?.role==='toolResult' && ['subagent','codemode'].includes(last.toolName) &&
      context.messages.some(m=>m.role==='user' && (text(m)??'').includes('"waitAfterLaunch":true'))) calls=[{name:'wait_for_subagents',args:{}}];
    else if(last?.role==='user' && prompt.includes('Subagent results are ready.')) calls=[{name:'wait_for_subagents',args:{}}];
    const summarizing=context.messages.some(m=>m.role==='system' && (text(m)??'').includes('You are a context summarization assistant.'));
    if(calls && !summarizing) {
     output.stopReason='toolUse';output.content=calls.map(c=>({type:'toolCall',id:c.id??'delivery-'+(++sequence),name:c.name,arguments:c.args}));
     output.content.forEach((toolCall,contentIndex)=>{stream.push({type:'toolcall_start',contentIndex,partial:output});stream.push({type:'toolcall_end',contentIndex,toolCall,partial:output});});
    } else {
     const users=context.messages.filter(m=>m.role==='user').map(text);
     const task=users.filter(p=>p?.startsWith('{"worker"')).at(-1);
     const value=spec?.worker?'Report '+spec.worker:task?'Report '+JSON.parse(task).worker:'Final handoff';
     if(task && JSON.parse(task).worker==='legacy-failed') {
      output.stopReason='error';output.errorMessage='already-refuted failure';stream.push({type:'error',reason:'error',error:output});stream.end();return;
     }
     output.content=[{type:'text',text:value}];
     stream.push({type:'text_start',contentIndex:0,partial:output});stream.push({type:'text_delta',contentIndex:0,delta:value,partial:output});stream.push({type:'text_end',contentIndex:0,content:value,partial:output});
    }
    stream.push({type:'done',reason:output.stopReason,message:output});stream.end();
   });return stream;
  }
 });
}
`;

export async function eventually(predicate: () => boolean, label = "fixture event", timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert(Date.now() < deadline, `Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

export async function parent(existing?: { cwd: string; session: string }) {
  const cwd = existing?.cwd ?? mkdtempSync(join(tmpdir(), "pi-delivery-test-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off", defaultTools: ["+codemode"], compaction: { keepRecentTokens: 0 } }));
  writeFileSync(join(cwd, ".pi", "extensions", "provider.ts"), provider);
  const rows: RecordValue[] = [];
  const invocation = hostInvocation();
  const rpc = new RpcProcess(invocation, cwd,
    ["--approve", "--model", "delivery-fixture/model", "--thinking", "off", "--extension", fileURLToPath(new URL("../..", import.meta.url)),
      "--session-dir", join(cwd, "sessions"), ...(existing ? ["--session", existing.session] : [])],
    { ...process.env, PI_RPC_SUBAGENT_CHILD: "", PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, row => rows.push(row));
  let session: string;
  try { session = (await rpc.send({ type: "get_state" })).data.sessionFile; }
  catch (error) { await rpc.close(); throw error; }
  const call = async (name: string, args: RecordValue = {}) => {
    const start = rows.length;
    await rpc.run(JSON.stringify({ name, args }), undefined, 30_000);
    const result = rows.slice(start).find(row => row.type === "tool_execution_end" && row.toolName === name);
    assert(result, `No ${name} result: ${cwd}`);
    return result.result;
  };
  const launch = async (worker: string, gate?: string, extra: RecordValue = {}) =>
    (await call("subagent", { task: JSON.stringify({ worker, gate }), cwd, background: true, approveProject: true, ...extra })).details;
  const snapshot = (report: RecordValue) => JSON.parse(readFileSync(report.resultPath, "utf8"));
  const entries = async () => (await rpc.send({ type: "get_entries" })).data.entries as RecordValue[];
  const gateStarted = (gate: string) => eventually(() => existsSync(join(cwd, gate + ".started")), gate);
  const release = (gate: string) => writeFileSync(join(cwd, gate), "released");
  const collected = async (id: string, attempt = 1) => {
    const matches = (row: RecordValue) => row.type === "tool_execution_end" && row.toolName === "wait_for_subagents" &&
      row.result.details?.reports?.some((report: RecordValue) => report.id === id && report.attempt === attempt);
    await eventually(() => rows.some(matches), `collection ${id}/${attempt}`);
    const index = rows.findIndex(matches);
    await eventually(() => rows.slice(index + 1).some(row => row.type === "agent_settled"), "collection settlement");
  };
  const command = (message: string) => rpc.send({ type: "prompt", message });
  return { cwd, rpc, rows, session, call, launch, snapshot, entries, gateStarted, release, collected, command };
}

export function receipts(entries: RecordValue[]) {
  const committed = new Set(entries.filter(entry => entry.message?.role === "toolResult").map(entry => entry.message.toolCallId));
  return entries.filter(entry => entry.customType === "pi-rpc-subagent-delivery" && committed.has(entry.data.callId))
    .flatMap(entry => entry.data.reports.map((report: RecordValue) => `${report.id}/${report.attempt}`));
}
export async function verifyUsage(p: Awaited<ReturnType<typeof parent>>, expected: number) {
  const entries = await p.entries();
  assert.equal(childUsage(entries), expected);
  const stats = (await p.rpc.send({ type: "get_session_stats" })).data;
  const own = entries.reduce((sum, entry) => sum + (entry.message?.role === "assistant" ? entry.message.usage.totalTokens : entry.usage?.totalTokens ?? 0), 0);
  assert.equal(stats.tokens.input + stats.tokens.output + stats.tokens.cacheRead + stats.tokens.cacheWrite, own + expected);
  const costs = entries.reduce((sum, entry) => sum + (entry.message?.usage?.cost?.total ?? entry.usage?.cost?.total ?? 0), 0);
  assert(Math.abs(stats.cost - costs) < 1e-8);
}

export function childUsage(entries: RecordValue[]) {
  return entries.filter(entry => entry.message?.role === "toolResult").reduce((sum, entry) => sum + (entry.message.usage?.totalTokens ?? 0), 0);
}
