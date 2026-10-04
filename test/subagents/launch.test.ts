import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { discoverAgents, resolveModel, toolList } from "../../extensions/subagents/agents.ts";
import { childConfigKey } from "../../extensions/subagents/guard.ts";
import { JsonLines, RpcProcess } from "../../extensions/subagents/rpc.ts";
import { preflight, runWorker, workerLeasePath } from "../../extensions/subagents/worker.ts";
import { hostInvocation } from "./fixture-invocation.ts";

function isolated() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rpc-test-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir);
  return { cwd, agentDir, env: { ...process.env, PI_RPC_SUBAGENT_CHILD: "", PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } };
}

function fake(script: string) {
  const fixture = isolated();
  const file = join(fixture.cwd, "fake.cjs");
  writeFileSync(file, `const readline = require('node:readline');
const fs = require('node:fs');
function emit(row) { process.stdout.write(JSON.stringify(row)+'\\n'); }
function response(c,data) { emit({type:'response',id:c.id,success:true,data}); }
readline.createInterface({input:process.stdin}).on('line',line=>{
const c=JSON.parse(line); ${script}
});`);
  return { ...fixture, invocation: { command: process.execPath, args: [file] } };
}

const workerProtocol = `
if(c.type==='get_state') response(c,{model:{provider:'test',id:'model'},thinkingLevel:'high'});
else if(c.type==='prompt' && c.message==='/pi-rpc-worker-inspect') {
 emit({type:'extension_ui_request',method:'notify',message:'pi-rpc-worker:'+JSON.stringify({cwd:process.cwd(),callable:['read'],active:['read']})});
 response(c,{disposition:'handled'});
} else if(c.type==='prompt') {
 fs.writeFileSync('prompt-sent',c.message); response(c,{disposition:'started'});
 emit({type:'agent_end'}); setTimeout(()=>{
 process.settled=true;
 emit({type:'message_end',message:{role:'assistant',stopReason:process.env.STOP_REASON||'stop',content:[{type:'text',text:'finished'}],usage:{input:1,output:2,cacheRead:0,cacheWrite:0,totalTokens:3,cost:{input:0.1,output:0.2,cacheRead:0,cacheWrite:0,total:0.3}}}});
 emit({type:'agent_settled'});
 },40);
} else if(c.type==='get_messages') response(c,{messages:[{role:'assistant',stopReason:process.settled?(process.env.STOP_REASON||'stop'):'error',content:[{type:'text',text:'finished'}],errorMessage:process.env.ERROR_MESSAGE}]});
else if(c.type==='get_session_stats') response(c,{sessionFile:'fixture-session.jsonl',tokens:{input:1,output:2}});
`;

// Every spawned process gets its own PI_CODING_AGENT_DIR, including fake RPC peers.
test("JSONL preserves Unicode separators and split UTF-8, and rejects partial records", () => {
  const rows: unknown[] = [];
  const reader = new JsonLines((row) => rows.push(row));
  const bytes = Buffer.from(JSON.stringify({ text: "x\u2028y\u2029z😀" }) + "\r\n");
  for (const byte of bytes) reader.push(Buffer.from([byte]));
  reader.end();
  assert.deepEqual(rows, [{ text: "x\u2028y\u2029z😀" }]);
  const partial = new JsonLines(() => {});
  partial.push(Buffer.from('{"type":"response"}'));
  assert.throws(() => partial.end(), /incomplete JSONL/);
});

test("Markdown agents keep prompts, inherit models, and use trusted project overrides", () => {
  const { cwd, agentDir } = isolated();
  mkdirSync(join(agentDir, "agents"));
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(join(agentDir, "agents", "worker.md"), "---\nname: worker\ntools: [read, codemode]\n---\nUser instructions.");
  writeFileSync(join(cwd, ".pi", "agents", "worker.md"), "---\nname: worker\nmodel: test/override\nthinking: low\nrequiredTools: read, codemode\n---\nProject instructions.");
  const user = discoverAgents(cwd, false, agentDir).get("worker")!;
  assert.equal(user.prompt, "User instructions.");
  assert.deepEqual(resolveModel("test/parent", "high", user), { model: "test/parent", thinking: "high" });
  const project = discoverAgents(cwd, true, agentDir).get("worker")!;
  assert.equal(project.prompt, "Project instructions.");
  assert.deepEqual(resolveModel("test/parent", "high", project), { model: "test/override", thinking: "low" });
  assert.deepEqual(resolveModel("test/parent", "high", project, "test/call:medium", "xhigh"), { model: "test/call", thinking: "xhigh" });
  assert.deepEqual(project.requiredTools, ["read", "codemode"]);
  for (const name of ["general-purpose", "Explore", "Plan"]) assert.equal(discoverAgents(cwd, false, agentDir).get(name)?.model, undefined);
  assert.equal(discoverAgents(cwd, false, agentDir).get("Explore")?.readOnly, true);
  assert.deepEqual(toolList([]), []);
  assert.throws(() => toolList([2]), /string array/);
  assert.throws(() => resolveModel(undefined, "high", user), /No parent model/);
});

test("RPC correlates concurrent responses and rejects an unexpected process exit", async () => {
  const f = fake(`if(c.type==='die') process.exit(0); else setTimeout(()=>response(c,{echo:c.type}),c.type==='first'?50:0);`);
  const rpc = new RpcProcess(f.invocation, f.cwd, [], f.env);
  try {
    const [first, second] = await Promise.all([rpc.send({ type: "first" }), rpc.send({ type: "second" })]);
    assert.equal(first.data.echo, "first");
    assert.equal(second.data.echo, "second");
    await assert.rejects(rpc.send({ type: "die" }), /exited/);
  } finally { await rpc.close(); }
});

test("startup waits for delayed capabilities without sending a task", async () => {
  const f = fake(`const ready = Date.now()-started>200;
 emit({type:'extension_ui_request',method:'notify',message:'pi-rpc-worker:'+JSON.stringify({cwd:process.cwd(),callable:ready?['codemode','mcp__fixture__show']:[]})}); response(c,{disposition:'handled'});`);
  // This peer represents MCP's asynchronous session_start connection.
  const script = f.invocation.args[0];
  writeFileSync(script, "const started=Date.now();\n" + readFileSync(script, "utf8"));
  const rpc = new RpcProcess(f.invocation, f.cwd, [], f.env);
  try {
    const snapshot = await preflight(rpc, f.cwd, ["codemode", "mcp__fixture__show"], 3000);
    assert.deepEqual(snapshot.callable, ["codemode", "mcp__fixture__show"]);
  } finally { await rpc.close(); }
});

test("missing required tools refuse work and leave diagnostics", async () => {
  const f = fake(workerProtocol);
  await assert.rejects(runWorker({ ...f, task: "must not run", agent: { name: "test", prompt: "" },
    model: "test/model", thinking: "high", requiredTools: ["mcp__fixture__show"], startupTimeoutMs: 500 }), /required tools unavailable.*mcp__fixture__show[\s\S]*No task prompt was sent/);
  assert.throws(() => readFileSync(join(f.cwd, "prompt-sent")), /ENOENT/);
});

test("a final capability poll timeout retains the missing-tools refusal", async () => {
  const f = fake(`
if(c.type==='prompt' && c.message==='/pi-rpc-worker-inspect') {
 const reply=()=>{emit({type:'extension_ui_request',method:'notify',message:'pi-rpc-worker:'+JSON.stringify({cwd:process.cwd(),callable:[]})});response(c,{disposition:'handled'});};
 if(process.inspected) setTimeout(reply,1000); else {process.inspected=true;reply();}
} else { ${workerProtocol} }
`);
  const rpc = new RpcProcess(f.invocation, f.cwd, [], f.env);
  try {
    await assert.rejects(preflight(rpc, f.cwd, ["mcp__missing__show"], 500),
      /required tools unavailable.*mcp__missing__show[\s\S]*No task prompt was sent/);
  } finally { await rpc.close(); }
});

test("capability timeout preserves the confirmed refusal when the wall clock moves back", async () => {
  const f = fake(`
if(c.type==='prompt' && c.message==='/pi-rpc-worker-inspect') {
 if(!process.inspected) {
  process.inspected=true;
  emit({type:'extension_ui_request',method:'notify',message:'pi-rpc-worker:'+JSON.stringify({cwd:process.cwd(),callable:[]})});
  response(c,{disposition:'handled'});
 }
} else { ${workerProtocol} }
`);
  const rpc = new RpcProcess(f.invocation, f.cwd, [], f.env);
  const now = Date.now;
  const inspect = rpc.inspect.bind(rpc);
  let polls = 0;
  rpc.inspect = (timeoutMs) => {
    if (++polls === 2) Date.now = () => now() - 1000;
    return inspect(timeoutMs);
  };
  try {
    await assert.rejects(preflight(rpc, f.cwd, ["mcp__missing__show"], 1000),
      /required tools unavailable.*mcp__missing__show[\s\S]*No task prompt was sent/);
    assert.equal(polls, 2);
  } finally { Date.now = now; await rpc.close(); }
});

test("worker returns settlement evidence and usage, not process exit success", async () => {
  const f = fake(workerProtocol);
  const result = await runWorker({ ...f, task: "work", agent: { name: "test", prompt: "" },
    model: "test/model", thinking: "high", requiredTools: ["read"] });
  assert.equal(result.text, "finished");
  assert.deepEqual(result.stats!.tokens, { input: 1, output: 2 });
  assert.deepEqual(result.usage, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } });
  assert.match(readFileSync(result.transcript, "utf8"), /agent_settled/);
  assert.equal(readFileSync(join(f.cwd, "prompt-sent"), "utf8"), "work");
  for (const reason of ["error", "aborted", "length"]) {
    await assert.rejects(runWorker({ ...f, env: { ...f.env, STOP_REASON: reason }, task: "work",
      agent: { name: "test", prompt: "" }, model: "test/model", thinking: "high" }), /settled without a complete response/);
  }
});

test("model mismatch refuses work", async () => {
  const f = fake(workerProtocol);
  await assert.rejects(runWorker({ ...f, task: "must not run", agent: { name: "test", prompt: "" },
    model: "test/wrong", thinking: "high" }), /not requested model/);
  assert.throws(() => readFileSync(join(f.cwd, "prompt-sent")), /ENOENT/);
});

test("worker lease defaults stay short even with a long or multibyte TMPDIR", () => {
  const id = "12345678-1234-1234-1234-123456789012";
  if (process.platform === "win32") {
    assert.equal(workerLeasePath(id), `\\\\.\\pipe\\pi-rpc-${id}`);
    return;
  }
  assert.equal(workerLeasePath(id, "/tmp"), `/tmp/pi-rpc-${id}.sock`);
  for (const directory of ["/tmp/" + "a".repeat(100), "/tmp/" + "界".repeat(30)]) {
    const path = workerLeasePath(id, directory);
    assert.equal(path, `/tmp/pi-rpc-${id}.sock`);
    assert(Buffer.byteLength(path) <= 100);
  }
});

test("explicit cwd is mandatory", async () => {
  const f = fake(workerProtocol);
  await assert.rejects(runWorker({ ...f, cwd: ".", task: "must not run", agent: { name: "test", prompt: "" },
    model: "test/model", thinking: "high" }), /absolute directory/);
});

test("real pi worker reaches a trusted project MCP server through codemode", async () => {
  const f = isolated();
  mkdirSync(join(f.cwd, ".pi", "extensions"), { recursive: true });
  const server = join(f.cwd, "mcp.cjs");
  writeFileSync(server, `const readline = require('node:readline');
const fs = require('node:fs');
readline.createInterface({input:process.stdin}).on('line',line=>{
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = {protocolVersion:request.params.protocolVersion,
    capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
  else if (request.method === 'tools/list') result = {tools:[{name:'inspect',description:'Inspect the scratch fixture',
    inputSchema:{type:'object',properties:{}}}]};
  else if (request.method === 'tools/call') {
    fs.writeFileSync('mcp-called', request.params.name);
    result = {content:[{type:'text',text:'MCP fixture reached'}]};
  } else if (request.method === 'ping') result = {};
  else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Unknown method'}})+'\\n');return;}
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
});`);
  writeFileSync(join(f.cwd, ".pi", "mcp.json"), JSON.stringify({
    mcpServers: { fixture: { command: process.execPath, args: [server], cwd: f.cwd } },
  }));
  writeFileSync(join(f.cwd, ".pi", "extensions", "provider.ts"), `
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
export default function(pi) {
  pi.registerProvider('fixture', {api:'fixture-api',baseUrl:'https://fixture.invalid',apiKey:'fixture',
    models:[{id:'mcp',name:'mcp',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:64000}],
    streamSimple(model,context) {
      const stream=createAssistantMessageEventStream();
      const called=context.messages.some(message=>message.role==='toolResult');
      const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),
        stopReason:called?'stop':'toolUse',content:called?[{type:'text',text:'MCP checked'}]:
          [{type:'toolCall',id:'mcp-probe',name:'codemode',arguments:{code:'text(await tools.mcp__fixture__inspect({}));'}}],
        usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      queueMicrotask(()=>{stream.push({type:'done',reason:message.stopReason,message});stream.end();});
      return stream;
    }
  });
}`);
  const result = await runWorker({ ...f, invocation: hostInvocation(),
    task: "Check the MCP fixture", agent: { name: "test", prompt: "" }, model: "fixture/mcp", thinking: "high",
    approveProject: true, tools: ["codemode", "mcp__fixture__inspect"],
    requiredTools: ["codemode", "mcp__fixture__inspect"] });
  const snapshot = JSON.parse(readFileSync(result.preflight, "utf8"));
  assert(snapshot.trusted);
  assert.equal(realpathSync(snapshot.cwd), realpathSync(f.cwd));
  assert(snapshot.callable.includes("mcp__fixture__inspect"));
  assert(!snapshot.callable.includes("bash"));
  assert(!snapshot.callable.includes("subagent"));
  assert.equal(result.text, "MCP checked");
  assert.equal(readFileSync(join(f.cwd, "mcp-called"), "utf8"), "inspect");
  const records = readFileSync(result.transcript, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert(records.some((row) => row.type === "tool_execution_end" &&
    row.toolName === "mcp__fixture__inspect" && row.isError === false));
});

test("real pi loads local package and keeps ordinary project resources", async () => {
  const f = isolated();
  mkdirSync(join(f.cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(f.cwd, ".pi", "extensions", "fixture.ts"), `export default function(pi) {
    pi.registerCommand('project-resource', {handler:async()=>{}});
    pi.registerTool({name:'subagent',label:'fixture',description:'fixture',parameters:{type:'object',properties:{}},execute:async()=>({content:[],details:undefined})});
  }`);
  const rpc = new RpcProcess(hostInvocation(), f.cwd,
    ["--approve", "--no-session", "--extension", fileURLToPath(new URL("../..", import.meta.url)),
      "--extension", fileURLToPath(new URL("../../extensions/subagents/guard.ts", import.meta.url))],
    { ...f.env, [childConfigKey]: JSON.stringify({ tools: ["read", "codemode"] }) });
  try {
    const commands = (await rpc.send({ type: "get_commands" })).data.commands;
    assert(commands.some((command: { name: string }) => command.name === "project-resource"));
    const snapshot = await rpc.inspect(10_000);
    assert(snapshot.active.includes("read"));
    assert(!snapshot.active.includes("bash"));
    assert(!snapshot.active.includes("subagent"));
    assert(!snapshot.callable.includes("subagent"));
    assert(snapshot.trusted);
    assert.equal(realpathSync(snapshot.cwd), realpathSync(f.cwd));
    await assert.rejects(preflight(rpc, f.cwd, ["mcp__missing__show"], 400), /required tools unavailable.*mcp__missing__show/);
    assert.deepEqual((await rpc.send({ type: "get_messages" })).data.messages, []);
  } finally { await rpc.close(); }
});
