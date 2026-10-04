import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { RpcProcess, type RecordValue } from "../../extensions/subagents/rpc.ts";
import { Worker } from "../../extensions/subagents/worker.ts";
import { hostInvocation } from "./fixture-invocation.ts";

// Runs the registered tools through Pi's real model/tool/event pipeline. Only
// the provider is deterministic; the worker CLI, steering, bash and abort are real.
const provider = `
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { writeFileSync } from 'node:fs';
export default function(pi) {
 let attempts=0;
 pi.registerProvider('fixture', {
  api:'fixture-api',baseUrl:'https://fixture.invalid',apiKey:'fixture',models:[{id:'control',name:'control',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:64000}],
  streamSimple(model,context,options) {
   const stream=createAssistantMessageEventStream();
   const output={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:'pending',usage:{input:1,output:2,cacheRead:0,cacheWrite:0,totalTokens:3,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
   setTimeout(()=>{
    const last=context.messages.at(-1);
    const users=context.messages.filter(m=>m.role==='user');
    const content=users.at(-1)?.content;
    const prompt=typeof content==='string'?content:content?.filter(p=>p.type==='text').map(p=>p.text).join('');
    stream.push({type:'start',partial:output});
    function text(value) {
     output.content=[{type:'text',text:value}];
     stream.push({type:'text_start',contentIndex:0,partial:output});
     stream.push({type:'text_delta',contentIndex:0,delta:value,partial:output});
     stream.push({type:'text_end',contentIndex:0,content:value,partial:output});
    }
    function tool(name,args) {
     output.stopReason='toolUse'; output.content=[{type:'toolCall',id:'fixture-'+Date.now(),name,arguments:args}];
     stream.push({type:'toolcall_start',contentIndex:0,partial:output});
     stream.push({type:'toolcall_end',contentIndex:0,toolCall:output.content[0],partial:output});
    }
    if(last?.role==='user' && typeof prompt==='string' && prompt.startsWith('{')) {
     const call=JSON.parse(prompt);
     if(call.race) {
      output.stopReason='toolUse'; output.content=[0,1].map(i=>({type:'toolCall',id:'race-'+Date.now()+'-'+i,name:'subagent',arguments:call.race}));
      output.content.forEach((toolCall,contentIndex)=>{stream.push({type:'toolcall_start',contentIndex,partial:output});stream.push({type:'toolcall_end',contentIndex,toolCall,partial:output});});
     } else tool(call.name,call.args);
    } else if(prompt==='freeze') {
     writeFileSync('frozen.pid',String(process.pid));
     const end=Date.now()+7000;while(Date.now()<end){};
     text('finished freeze');output.stopReason='stop';
    } else if(prompt==='stall') {
     text('partial before stall'); const timer=setInterval(()=>{},1000);
     options.signal?.addEventListener('abort',()=>{clearInterval(timer);output.stopReason='aborted';output.errorMessage='fixture aborted';stream.push({type:'error',reason:'aborted',error:output});stream.end();},{once:true});return;
    } else if(prompt==='error' || prompt==='abort' || (prompt==='retry' && attempts++===0)) {
     text('partial provider output'); output.stopReason=prompt==='abort'?'aborted':'error';
     output.errorMessage=prompt==='retry'?'429 overloaded fixture':'fixture invalid API key';
     stream.push({type:'error',reason:output.stopReason,error:output}); stream.end(); return;
    } else if((prompt==='slow' || prompt==='held') && !context.messages.some(m=>m.role==='toolResult')) {
     tool('bash',{command:prompt==='held'?'set -euo pipefail; echo $$ > owned-shell.pid; while :; do sleep 1; done':'echo $$ > owned-shell.pid; sleep 6'});
    } else if(prompt==='steered' && !context.messages.some(m=>m.role==='toolResult' && m.toolName==='write')) {
     tool('write',{path:'steered.txt',content:'changed output\\n'});
    } else {
     text(prompt==='large'?'x'.repeat(40000):prompt==='retry'?'retry succeeded':prompt==='memory'?JSON.stringify(users):'finished'); output.stopReason='stop';
    }
    stream.push({type:'done',reason:output.stopReason,message:output});stream.end();
   },5);
   return stream;
  }
 });
}
`;

async function parent(existing?: { cwd: string; session: string }) {
  const cwd = existing?.cwd ?? mkdtempSync(join(tmpdir(), "pi-rpc-control-test-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: true, baseDelayMs: 10, maxRetries: 1 }, cacheWarming: "off", compaction: { keepRecentTokens: 0 } }));
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "extensions", "provider.ts"), provider);
  writeFileSync(join(cwd, ".pi", "extensions", "reload.ts"), `export default function(pi) {
    pi.registerCommand('test-reload', {description:'Test-only RPC reload bridge', handler: async (_args, ctx) => { await ctx.reload(); }});
  }`);
  writeFileSync(join(cwd, ".pi", "extensions", "slow-shutdown.ts"), `import {existsSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
    export default function(pi) { pi.on('session_start',(_event,ctx)=> {
      if(process.env.PI_RPC_SUBAGENT_CHILD && existsSync(join(ctx.cwd,'slow-child-shutdown'))) {
        pi.on('session_shutdown',async event=>{if(event.reason==='quit'){writeFileSync(join(ctx.cwd,'child-shutdown.pid'),String(process.pid));await new Promise(resolve=>setTimeout(resolve,5000));}});
      }
    }); }
  `);
  writeFileSync(join(cwd, ".pi", "extensions", "relay.ts"), `import {Type} from 'typebox';
    export default function(pi) { pi.registerTool({name:'relay',label:'relay',description:'Test-only nested result retrieval',
      parameters:Type.Object({id:Type.String()}),async execute(_id,args,_signal,_update,ctx) {
        const result=await ctx.executeTool('get_subagent_result',args);
        return {content:result.result.content,details:{delivered:true}};
      }}); }
  `);
  writeFileSync(join(cwd, ".pi", "extensions", "pause.ts"), `import {existsSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
    export default function(pi) { pi.on('tool_result', async(e,ctx)=> {
      if(e.toolName==='get_subagent_result' && e.usage && existsSync(join(ctx.cwd,'pause-usage'))) {
        writeFileSync(join(ctx.cwd,'usage-return-paused'),'paused'); await new Promise(()=>{});
      }
    }); }
  `);
  const rows: RecordValue[] = [];
  const rpc = new RpcProcess(hostInvocation(), cwd,
    ["--approve", "--model", "fixture/control", "--thinking", "high", "--extension", fileURLToPath(new URL("../..", import.meta.url)),
      "--session-dir", join(cwd, "sessions"), ...(existing ? ["--session", existing.session] : [])],
    { ...process.env, PI_RPC_SUBAGENT_CHILD: "", PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, (row) => rows.push(row));
  try { await rpc.send({ type: "get_state" }); }
  catch (error) { await rpc.close(); throw error; }
  async function call(name: string, args: RecordValue) {
    const start = rows.length;
    let timer: NodeJS.Timeout | undefined;
    let unsubscribe = () => {};
    const finished = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Tool ${name} didn't finish. Evidence: ${cwd}`)), 30_000);
      unsubscribe = rpc.onRecord((row) => {
        if (row.type === "transport_error") reject(new Error(row.error));
        if (row.type === "agent_settled" && rows.slice(start).some((row) => row.type === "tool_execution_end" && row.toolName === name)) resolve();
      });
    });
    try {
      await Promise.all([rpc.send({ type: "prompt", message: JSON.stringify({ name, args }), streamingBehavior: "followUp" }), finished]);
    } finally { clearTimeout(timer); unsubscribe(); }
    const end = rows.slice(start).find((row) => row.type === "tool_execution_end" && row.toolName === name);
    writeFileSync(join(cwd, "parent-rpc.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    assert(end, `Missing ${name} result. Evidence: ${cwd}`);
    const committed = rows.slice(start).find((row) => row.type === "message_end" &&
      row.message?.role === "toolResult" && row.message.toolCallId === end.toolCallId);
    return { ...end.result, usage: committed?.message.usage ?? end.result.usage };
  }
  async function launch(task: string, extra: RecordValue = {}) {
    return call("subagent", { task, cwd, background: true, approveProject: true, ...extra });
  }
  async function until(id: string, predicate: (result: RecordValue) => boolean) {
    const deadline = Date.now() + 20_000;
    do {
      const outcome = await call("get_subagent_result", { id, wait: true, timeoutMs: 50 });
      if (predicate(outcome.details)) return outcome;
    } while (Date.now() < deadline);
    throw new Error(`Worker ${id} didn't reach expected state. Evidence: ${cwd}`);
  }
  return { cwd, rpc, rows, call, launch, until,
    session: (await rpc.send({ type: "get_state" })).data.sessionFile,
    reload: () => rpc.send({ type: "prompt", message: "/test-reload" }),
  };
}

test("terminal retrieval suppresses trailing automatic completion and redundant replies", async () => {
  const p = await parent();
  try {
    const worker = (await p.launch("slow")).details;
    const result = await p.call("get_subagent_result", { id: worker.id, wait: true, timeoutMs: 30_000 });
    assert.equal(result.details.status, "completed");
    const entries = (await p.rpc.send({ type: "get_entries" })).data.entries;
    const retrieval = entries.findIndex((entry: RecordValue) => entry.message?.toolName === "get_subagent_result" && entry.message.details?.status === "completed");
    const completion = entries.findIndex((entry: RecordValue) => entry.customType === "pi-rpc-subagent-completion" && entry.details.id === worker.id);
    assert(retrieval >= 0);
    assert.equal(completion, -1);
    assert.equal(entries.slice(retrieval + 1).filter((entry: RecordValue) => entry.message?.role === "assistant").length, 1);
    assert(!entries.slice(retrieval + 1).some((entry: RecordValue) => entry.customType === "pi-rpc-subagent-ready"));
    console.log(`Trailing completion evidence: ${p.cwd}`);
  } finally { await p.rpc.close(); }
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function toolStarted(path: string) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    assert(Date.now() < deadline, `Tool didn't start: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("registered background tools start promptly, finish independently, steer and stop real workers", async () => {
  const p = await parent();
  try {
    const started = Date.now();
    const slow = (await p.launch("slow")).details;
    assert(Date.now() - started < 2000);
    assert.equal(slow.status, "starting");
    assert(slow.id);
    const fast = (await p.launch("large")).details;
    await toolStarted(join(p.cwd, "owned-shell.pid"));
    const shellPid = Number(readFileSync(join(p.cwd, "owned-shell.pid"), "utf8"));
    const completed = await p.until(fast.id, (result) => result.status === "completed");
    assert.equal(completed.details.text.length, 16384);
    assert.equal(completed.details.truncated, true);
    assert.equal(completed.details.usage.totalTokens, 3);
    assert(!alive(completed.details.pid));
    assert(readFileSync(completed.details.transcript, "utf8").includes("x".repeat(40000)));
    const active = (await p.call("get_subagent_result", { id: slow.id })).details;
    assert.equal(active.status, "running");
    assert(alive(active.pid));
    const steering = await p.call("steer_subagent", { id: slow.id, message: "steered" });
    assert.equal(steering.details.disposition, "queued");
    // Stop clears steering instead of running it after abort.
    const stopped = await p.call("stop_subagent", { id: slow.id });
    assert.equal(stopped.details.status, "stopped");
    assert.equal(stopped.isError, true);
    assert(!alive(stopped.details.pid));
    assert(!alive(shellPid));
    assert(!existsSync(join(p.cwd, "steered.txt")));
    assert.equal((await p.call("get_subagent_result", { id: fast.id })).usage, undefined);
    const again = await p.call("stop_subagent", { id: slow.id });
    assert.equal(again.details.status, "stopped");
    const notifications = p.rows.filter((row) => row.type === "message_end" && row.message?.customType === "pi-rpc-subagent-completion");
    assert.equal(notifications.length, 0);
  } finally { await p.rpc.close(); }
});

test("registered steering changes the worker's actual output before settlement", async () => {
  const p = await parent();
  try {
    const worker = (await p.launch("slow")).details;
    await toolStarted(join(p.cwd, "owned-shell.pid"));
    await p.call("steer_subagent", { id: worker.id, message: "steered" });
    const outcome = await p.until(worker.id, (result) => result.status === "completed");
    assert.equal(readFileSync(join(p.cwd, "steered.txt"), "utf8"), "changed output\n");
    const transcript = readFileSync(outcome.details.transcript, "utf8");
    assert(transcript.split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .some((row) => row.type === "message_end" && row.message?.role === "user" && JSON.stringify(row.message.content).includes("steered")));
    assert.match(transcript, /agent_settled/);
    const rejected = await p.call("steer_subagent", { id: worker.id, message: "late" });
    assert.match(rejected.content[0].text, /steering requires a running worker/);
  } finally { await p.rpc.close(); }
});

test("registered tools report provider abort/errors, startup failure, deadlines and successful retries honestly", async () => {
  const p = await parent();
  try {
    for (const task of ["error", "abort", "retry", "stall"]) {
      const worker = (await p.launch(task, task === "stall" ? { runTimeoutMs: 500 } : {})).details;
      const outcome = await p.until(worker.id, (result) => !["starting", "running"].includes(result.status));
      assert.equal(outcome.details.status, task === "retry" ? "completed" : "failed");
      assert.equal(outcome.isError, task !== "retry");
      assert(!alive(outcome.details.pid));
      assert(outcome.details.sessionFile);
      assert.equal(JSON.parse(readFileSync(outcome.details.resultPath, "utf8")).id, worker.id);
      if (task === "retry") {
        assert.equal(outcome.details.text, "retry succeeded");
        assert.equal(outcome.details.stopReason, "stop");
        const transcript = readFileSync(outcome.details.transcript, "utf8");
        assert.match(transcript, /auto_retry_start/);
        assert.equal(transcript.match(/"type":"agent_settled"/g)?.length, 1);
      } else {
        assert.match(outcome.details.text, /partial/);
        assert.match(outcome.details.error, task === "stall" ? /didn't settle/ : /fixture invalid API key/);
      }
    }
    for (const extra of [{ model: "missing-provider/missing-model" }, { requiredTools: ["mcp__missing__show"], startupTimeoutMs: 500 }]) {
      const worker = (await p.launch("must not run", extra)).details;
      const outcome = await p.until(worker.id, (result) => result.status === "failed");
      assert.equal(outcome.isError, true);
      assert.match(outcome.details.error, /startup failed/);
      assert(!alive(outcome.details.pid));
      assert(!readFileSync(outcome.details.transcript, "utf8").includes('"content":"must not run"'));
    }
    const unknown = await p.call("get_subagent_result", { id: "no-such-worker" });
    assert.match(unknown.content[0].text, /Unknown worker/);
  } finally { await p.rpc.close(); }
});

test("parent quit cleans up an active worker and its tool process", async () => {
  const p = await parent();
  try {
    const worker = (await p.launch("slow")).details;
    await toolStarted(join(p.cwd, "owned-shell.pid"));
    const running = (await p.call("get_subagent_result", { id: worker.id })).details;
    const shellPid = Number(readFileSync(join(p.cwd, "owned-shell.pid"), "utf8"));
    await p.rpc.close();
    assert(!alive(running.pid));
    assert(!alive(shellPid));
    const final = JSON.parse(readFileSync(worker.resultPath, "utf8"));
    assert.equal(final.status, "interrupted");
    assert.equal(final.error, "Parent session quit");
  } finally { await p.rpc.close(); }
});

test("canceling a result wait keeps its worker alive; foreground cancellation stops only its worker", async () => {
  const p = await parent();
  try {
    // Keep work active until stop, regardless of subprocess startup speed.
    const background = (await p.launch("held")).details;
    await toolStarted(join(p.cwd, "owned-shell.pid"));
    const start = p.rows.length;
    const waiting = p.call("get_subagent_result", { id: background.id, wait: true, timeoutMs: 60_000 });
    while (!p.rows.slice(start).some((row) => row.type === "tool_execution_start" && row.toolName === "get_subagent_result")) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await p.rpc.send({ type: "abort" });
    const canceled = await waiting;
    assert.match(canceled.content[0].text, /Result wait aborted; worker continues/);
    const active = (await p.call("get_subagent_result", { id: background.id })).details;
    assert.equal(active.status, "running");
    assert(alive(active.pid));

    // The foreground worker shares the parent's operation signal, not the
    // background worker's signal or lifetime.
    const foreground = p.call("subagent", { task: "held", cwd: p.cwd, approveProject: true });
    const deadline = Date.now() + 10_000;
    let shellPid = Number(readFileSync(join(p.cwd, "owned-shell.pid"), "utf8"));
    while (shellPid === Number(readFileSync(join(p.cwd, "owned-shell.pid"), "utf8"))) {
      assert(Date.now() < deadline, "Foreground worker didn't enter its tool");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    shellPid = Number(readFileSync(join(p.cwd, "owned-shell.pid"), "utf8"));
    await p.rpc.send({ type: "abort" });
    const stopped = await foreground;
    assert.equal(stopped.details.status, "stopped");
    assert(!alive(stopped.details.pid));
    assert(!alive(shellPid));
    assert.equal((await p.call("get_subagent_result", { id: background.id })).details.status, "running");
    await p.call("stop_subagent", { id: background.id });
  } finally { await p.rpc.close(); }
});

test("registered stop during startup refuses work and closes the process", async () => {
  const p = await parent();
  try {
    const starting = (await p.launch("must not run", { requiredTools: ["mcp__missing__show"] })).details;
    const stopped = await p.call("stop_subagent", { id: starting.id });
    assert.equal(stopped.details.status, "stopped");
    if (stopped.details.pid) assert(!alive(stopped.details.pid));
    assert(!readFileSync(stopped.details.transcript, "utf8").includes('"text":"must not run"'));
  } finally { await p.rpc.close(); }
});

test("process startup failure retains an inspectable identity and evidence", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rpc-startup-test-"));
  const worker = new Worker({ cwd, task: "work", agent: { name: "general-purpose", prompt: "" }, model: "fixture/control", thinking: "high",
    invocation: { command: join(cwd, "missing-pi"), args: [] }, env: { PI_CODING_AGENT_DIR: cwd, PI_OFFLINE: "1" } });
  const id = worker.id;
  await worker.done;
  const result = worker.snapshot();
  assert.equal(result.id, id);
  assert.equal(result.status, "failed");
  assert.match(result.error!, /startup failed.*ENOENT/);
  assert.equal(JSON.parse(readFileSync(result.resultPath, "utf8")).status, "failed");
});

test("actual compaction and ctx.reload retain active ownership and deduplicate completion/usage", async () => {
  const p = await parent();
  try {
    const started = (await p.launch("slow")).details;
    await toolStarted(join(p.cwd, "owned-shell.pid"));
    const active = (await p.call("get_subagent_result", { id: started.id })).details;
    const compact = await p.rpc.send({ type: "compact" });
    assert(compact.success);
    assert(p.rows.some((row) => row.type === "compaction_end" && row.result));
    await p.reload();
    const reloaded = (await p.call("get_subagent_result", { id: started.id })).details;
    assert.equal(reloaded.pid, active.pid);
    assert.equal(reloaded.sessionFile, active.sessionFile);
    const completed = await p.until(started.id, (result) => result.status === "completed");
    assert(completed.usage);
    await p.reload();
    const list = await p.call("get_subagent_result", {});
    assert.equal(list.details.workers[0].id, started.id);
    assert.equal((await p.call("get_subagent_result", { id: started.id })).usage, undefined);
    const notifications = p.rows.filter((row) => row.type === "message_end" && row.message?.customType === "pi-rpc-subagent-completion");
    assert.equal(notifications.length, 0);
    assert(!alive(active.pid));
  } finally { await p.rpc.close(); }
});

test("stop/resume uses the same persisted conversation and preserves restrictions and usage", async () => {
  const p = await parent();
  try {
    const started = (await p.launch("slow", { tools: ["read", "bash"], requiredTools: ["bash"] })).details;
    await toolStarted(join(p.cwd, "owned-shell.pid"));
    const stopped = await p.call("stop_subagent", { id: started.id });
    assert.equal(stopped.details.status, "stopped");
    const session = stopped.details.sessionFile;
    const before = stopped.details.usage.totalTokens;
    await p.reload();
    for (const extra of [{ cwd: dirname(p.cwd) }, { tools: ["write"] }, { agent: "general-purpose" }]) {
      const refused = await p.launch("memory", { resume: started.id, ...extra });
      assert.match(refused.content[0].text, /Resume can't|Resume retains/);
    }
    await p.rpc.send({ type: "set_thinking_level", level: "low" });
    const resumed = (await p.launch("memory", { resume: started.id })).details;
    assert.equal(resumed.id, started.id);
    assert.equal(resumed.attempt, 2);
    const completed = await p.until(started.id, (result) => result.status === "completed");
    assert.equal(completed.details.sessionFile, session);
    assert.match(completed.details.text, /slow/);
    assert.equal(completed.usage.totalTokens, completed.details.usage.totalTokens - before);
    assert.equal(completed.details.model, stopped.details.model);
    assert.equal(completed.details.thinking, stopped.details.thinking);
    const preflight = JSON.parse(readFileSync(completed.details.preflight, "utf8"));
    assert.deepEqual(preflight.active.sort(), ["bash", "read"]);
    assert(!preflight.callable.includes("write"));
    await p.reload();
    assert.equal((await p.call("get_subagent_result", { id: started.id })).usage, undefined);
    // Allow real CLI startup under the concurrent project check, then prove
    // the retained bash requirement refuses the narrowed allowlist.
    await p.launch("must not run", { resume: started.id, tools: ["read"], requiredTools: [], startupTimeoutMs: 5000 });
    const failed = await p.until(started.id, (result) => result.status === "failed");
    assert.match(failed.details.error, /required tools unavailable.*bash/);
    assert(!readFileSync(failed.details.transcript, "utf8").includes('"content":"must not run"'));
  } finally { await p.rpc.close(); }
});

test("session replacement stops owned processes, and quit/reopen reports interruption without PID reattachment", async () => {
  const p = await parent();
  let reopened: Awaited<ReturnType<typeof parent>> | undefined;
  try {
    const started = (await p.launch("slow")).details;
    await toolStarted(join(p.cwd, "owned-shell.pid"));
    const active = (await p.call("get_subagent_result", { id: started.id })).details;
    const shellPid = Number(readFileSync(join(p.cwd, "owned-shell.pid"), "utf8"));
    await p.rpc.send({ type: "new_session" });
    assert(!alive(active.pid));
    assert(!alive(shellPid));
    assert.equal((await p.call("get_subagent_result", {})).details.workers.length, 0);
    await p.rpc.send({ type: "switch_session", sessionPath: p.session });
    const interrupted = (await p.call("get_subagent_result", { id: started.id })).details;
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.pid, undefined);
    await p.rpc.close();
    reopened = await parent({ cwd: p.cwd, session: p.session });
    assert.equal((await reopened.call("get_subagent_result", { id: started.id })).details.status, "interrupted");
    const start = reopened.rows.length;
    await reopened.rpc.run(JSON.stringify({ race: { task: "slow", cwd: reopened.cwd, resume: started.id, background: true } }));
    const calls = reopened.rows.slice(start).filter((row) => row.type === "tool_execution_end" && row.toolName === "subagent");
    assert.equal(calls.length, 2);
    assert.equal(calls.filter((row) => row.result.details?.id === started.id).length, 1);
    assert(calls.some((row) => /overlapping resume is refused/.test(row.result.content[0].text)));
    const stopped = await reopened.call("stop_subagent", { id: started.id });
    assert.equal(stopped.details.sessionFile, active.sessionFile);
    assert.equal(stopped.details.status, "stopped");
  } finally { await p.rpc.close(); await reopened?.rpc.close(); }
});

test("parent death cleans orphaned tools; restart marks disk-only running state interrupted and resumes explicitly", async () => {
  const p = await parent();
  let reopened: Awaited<ReturnType<typeof parent>> | undefined;
  try {
    const started = (await p.launch("slow")).details;
    await toolStarted(join(p.cwd, "owned-shell.pid"));
    const active = (await p.call("get_subagent_result", { id: started.id })).details;
    const shellPid = Number(readFileSync(join(p.cwd, "owned-shell.pid"), "utf8"));
    p.rpc.child.kill("SIGKILL");
    await p.rpc.close();
    const deadline = Date.now() + 8000;
    while (alive(active.pid) || alive(shellPid)) {
      assert(Date.now() < deadline, "Orphaned worker/tool survived parent death");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    mkdirSync(join(dirname(active.resultPath), "..", "worker-incomplete"), { recursive: true });
    reopened = await parent({ cwd: p.cwd, session: p.session });
    const interrupted = (await reopened.call("get_subagent_result", { id: started.id })).details;
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.pid, undefined);
    assert.match(interrupted.error, /no PID was reattached/);
    await reopened.launch("memory", { resume: started.id });
    const completed = await reopened.until(started.id, (result) => result.status === "completed");
    assert.equal(completed.details.sessionFile, active.sessionFile);
    assert.match(completed.details.text, /slow/);
  } finally { await p.rpc.close(); await reopened?.rpc.close(); }
});

test("failed resume model override doesn't replace the last confirmed defaults after restart", async () => {
  const p = await parent();
  let reopened: Awaited<ReturnType<typeof parent>> | undefined;
  try {
    const started = (await p.launch("memory")).details;
    const first = await p.until(started.id, (result) => result.status === "completed");
    await p.launch("memory", { resume: started.id, model: "missing-provider/not-a-model", thinking: "low", startupTimeoutMs: 5000 });
    const failed = await p.until(started.id, (result) => result.status === "failed");
    assert.match(failed.details.error, /startup failed/);
    await p.rpc.close();
    reopened = await parent({ cwd: p.cwd, session: p.session });
    await reopened.launch("memory", { resume: started.id });
    const retried = await reopened.until(started.id, (result) => result.status !== "starting" && result.status !== "running");
    assert.equal(retried.details.status, "completed", retried.details.error);
    assert.equal(retried.details.model, "fixture/control");
    assert.equal(retried.details.thinking, "high");
    assert.equal(retried.details.sessionFile, first.details.sessionFile);
  } finally { await p.rpc.close(); await reopened?.rpc.close(); }
});

test("a second live parent can't control or resume the same persisted workers", async () => {
  const p = await parent();
  let second: Awaited<ReturnType<typeof parent>> | undefined;
  try {
    const started = (await p.launch("held")).details;
    await toolStarted(join(p.cwd, "owned-shell.pid"));
    const running = (await p.call("get_subagent_result", { id: started.id })).details;
    second = await parent({ cwd: p.cwd, session: p.session });
    assert(second.rows.some((row) => row.type === "extension_error" && /Another parent process owns/.test(row.error)));
    const refused = await second.call("get_subagent_result", {});
    assert.match(refused.content[0].text, /registry isn't available/);
    await second.rpc.close();
    assert(alive(running.pid));
    assert.equal((await p.call("get_subagent_result", { id: started.id })).details.pid, running.pid);
    await p.call("stop_subagent", { id: started.id });
  } finally { await p.rpc.close(); await second?.rpc.close(); }
});

test("nested retrieval accounts usage once across reload and restart without worker details on the outer result", async () => {
  const p = await parent();
  let reopened: Awaited<ReturnType<typeof parent>> | undefined;
  try {
    const started = (await p.launch("large")).details;
    const deadline = Date.now() + 10_000;
    while (JSON.parse(readFileSync(started.resultPath, "utf8")).status !== "completed") {
      assert(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const first = await p.call("relay", { id: started.id });
    assert.equal(first.usage.totalTokens, 3);
    assert.deepEqual(first.details, { delivered: true });
    await p.reload();
    assert.equal((await p.call("relay", { id: started.id })).usage, undefined);
    await p.rpc.close();
    reopened = await parent({ cwd: p.cwd, session: p.session });
    assert.equal((await reopened.call("relay", { id: started.id })).usage, undefined);
  } finally { await p.rpc.close(); await reopened?.rpc.close(); }
});

test("restart refuses a resumed attempt while the orphaned child still owns its session", async () => {
  const p = await parent();
  let reopened: Awaited<ReturnType<typeof parent>> | undefined;
  try {
    const started = (await p.launch("slow")).details;
    await toolStarted(join(p.cwd, "owned-shell.pid"));
    await p.call("steer_subagent", { id: started.id, message: "freeze" });
    await toolStarted(join(p.cwd, "frozen.pid"));
    const childPid = Number(readFileSync(join(p.cwd, "frozen.pid"), "utf8"));
    p.rpc.child.kill("SIGKILL");
    await p.rpc.close();
    reopened = await parent({ cwd: p.cwd, session: p.session });
    assert(alive(childPid));
    await reopened.launch("memory", { resume: started.id });
    const refused = await reopened.until(started.id, (result) => result.status === "failed");
    assert.match(refused.details.error, /previous child still owns this worker session/);
    const deadline = Date.now() + 12_000;
    while (alive(childPid)) {
      assert(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await reopened.launch("memory", { resume: started.id });
    const completed = await reopened.until(started.id, (result) => result.status === "completed");
    assert.equal(completed.details.sessionFile, refused.details.sessionFile);
    assert.match(completed.details.text, /slow/);
  } finally { await p.rpc.close(); await reopened?.rpc.close(); }
});

test("child ownership lasts through asynchronous shutdown handlers, not only session_shutdown dispatch", async () => {
  const p = await parent();
  let reopened: Awaited<ReturnType<typeof parent>> | undefined;
  try {
    writeFileSync(join(p.cwd, "slow-child-shutdown"), "delay");
    const started = (await p.launch("slow")).details;
    await toolStarted(join(p.cwd, "owned-shell.pid"));
    p.rpc.child.kill("SIGKILL");
    await p.rpc.close();
    await toolStarted(join(p.cwd, "child-shutdown.pid"));
    const childPid = Number(readFileSync(join(p.cwd, "child-shutdown.pid"), "utf8"));
    reopened = await parent({ cwd: p.cwd, session: p.session });
    assert(alive(childPid));
    await reopened.launch("memory", { resume: started.id });
    const refused = await reopened.until(started.id, (result) => result.status === "failed");
    assert.match(refused.details.error, /previous child still owns this worker session/);
    const deadline = Date.now() + 8000;
    while (alive(childPid)) {
      assert(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    unlinkSync(join(p.cwd, "slow-child-shutdown"));
    await reopened.launch("memory", { resume: started.id });
    assert.equal((await reopened.until(started.id, (result) => result.status === "completed")).details.sessionFile, refused.details.sessionFile);
  } finally { await p.rpc.close(); await reopened?.rpc.close(); }
});

test("reload during streaming doesn't duplicate a completion already queued in the live parent", async () => {
  const p = await parent();
  try {
    const started = (await p.launch("slow")).details;
    await p.rpc.send({ type: "prompt", message: "stall" });
    const deadline = Date.now() + 15_000;
    while (JSON.parse(readFileSync(started.resultPath, "utf8")).status !== "completed") {
      assert(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await p.reload();
    await p.rpc.send({ type: "abort" });
    await p.call("get_subagent_result", { id: started.id });
    const entries = (await p.rpc.send({ type: "get_entries" })).data.entries;
    assert.equal(entries.filter((entry: RecordValue) => entry.customType === "pi-rpc-subagent-completion").length, 0);
  } finally { await p.rpc.close(); }
});

test("restart delivers completion queued during streaming but never persisted", async () => {
  const p = await parent();
  let reopened: Awaited<ReturnType<typeof parent>> | undefined;
  try {
    const started = (await p.launch("slow")).details;
    await p.rpc.send({ type: "prompt", message: "stall" });
    const deadline = Date.now() + 15_000;
    let final;
    do {
      final = JSON.parse(readFileSync(started.resultPath, "utf8"));
      assert(Date.now() < deadline, "Worker didn't finish during parent stream");
      if (final.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (true);
    const entries = (await p.rpc.send({ type: "get_entries" })).data.entries;
    assert(!entries.some((entry: RecordValue) => entry.customType === "pi-rpc-subagent-completion"));
    p.rpc.child.kill("SIGKILL");
    await p.rpc.close();
    reopened = await parent({ cwd: p.cwd, session: p.session });
    await reopened.call("get_subagent_result", { id: started.id });
    await reopened.reload();
    await reopened.call("get_subagent_result", { id: started.id });
    const persisted = (await reopened.rpc.send({ type: "get_entries" })).data.entries;
    assert.equal(persisted.filter((entry: RecordValue) => entry.customType === "pi-rpc-subagent-completion").length, 0);
  } finally { await p.rpc.close(); await reopened?.rpc.close(); }
});

test("restart reports usage reserved before a tool result but not committed to the parent", async () => {
  const p = await parent();
  let reopened: Awaited<ReturnType<typeof parent>> | undefined;
  try {
    const started = (await p.launch("large")).details;
    const deadline = Date.now() + 10_000;
    while (JSON.parse(readFileSync(started.resultPath, "utf8")).status !== "completed") {
      assert(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    writeFileSync(join(p.cwd, "pause-usage"), "pause");
    await p.rpc.send({ type: "prompt", message: JSON.stringify({ name: "get_subagent_result", args: { id: started.id } }), streamingBehavior: "followUp" });
    await toolStarted(join(p.cwd, "usage-return-paused"));
    const entries = (await p.rpc.send({ type: "get_entries" })).data.entries;
    assert(entries.some((entry: RecordValue) => entry.customType === "pi-rpc-subagent-delivery"));
    assert(!entries.some((entry: RecordValue) => entry.message?.role === "toolResult" && entry.message.toolName === "get_subagent_result"));
    p.rpc.child.kill("SIGKILL");
    await p.rpc.close();
    unlinkSync(join(p.cwd, "pause-usage"));
    reopened = await parent({ cwd: p.cwd, session: p.session });
    const retrieved = await reopened.call("get_subagent_result", { id: started.id });
    assert.equal(retrieved.usage.totalTokens, retrieved.details.usage.totalTokens);
    await reopened.reload();
    assert.equal((await reopened.call("get_subagent_result", { id: started.id })).usage, undefined);
  } finally { await p.rpc.close(); await reopened?.rpc.close(); }
});
