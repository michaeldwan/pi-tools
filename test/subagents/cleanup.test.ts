import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { RpcProcess, type RecordValue } from "../../extensions/subagents/rpc.ts";
import { Worker, workerLeasePath } from "../../extensions/subagents/worker.ts";
import { childConfigKey } from "../../extensions/subagents/guard.ts";
import { hostInvocation } from "./fixture-invocation.ts";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const agent = { name: "fixture", prompt: "" };

function peer(mode: string) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rpc-cleanup-"));
  const script = join(cwd, "peer.mjs");
  writeFileSync(script, `
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
const emit = row => process.stdout.write(JSON.stringify(row)+'\\n');
const mode = ${JSON.stringify(mode)};
if(mode==='unkillable') process.on('SIGTERM',()=>{});
createInterface({input:process.stdin}).on('line',line=>{
 const command=JSON.parse(line);
 const response=data=>emit({type:'response',id:command.id,command:command.type,success:true,data});
 if(command.type==='get_state') response({model:{provider:'fixture',id:'model'},thinkingLevel:'off',sessionFile:'session.jsonl'});
 else if(command.type==='prompt' && command.message==='/pi-rpc-worker-inspect') {
  emit({type:'extension_ui_request',method:'notify',message:'pi-rpc-worker:'+JSON.stringify({cwd:process.cwd(),active:[],callable:[]})});
  response({disposition:'handled'});
 } else if(command.type==='prompt') {
  if(mode==='stall') return;
  response({disposition:'started'});
  emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'finished'}],stopReason:'stop',usage:{input:1,output:2,totalTokens:3}}});
  emit({type:'agent_settled'});
 } else if(command.type==='get_session_stats') {
  if(mode==='inherited' || mode==='escaped') {
   const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),12000)'],{stdio:['ignore',1,2],detached:mode==='escaped'});
   writeFileSync('descendant.pid',String(child.pid));
  }
  response({});
 } else response({});
}).on('close',()=>{
 process.stderr.write('shutdown diagnostic\\n');
 if(mode!=='unkillable') process.exit(0);
});
setTimeout(()=>process.exit(0),14000);
`);
  const worker = new Worker({ task: "finish", cwd, agent, model: "fixture/model", thinking: "off",
    invocation: { command: process.execPath, args: [script] }, startupTimeoutMs: 1000, runTimeoutMs: 100 });
  return { cwd, worker };
}

async function killOwned(worker: Worker, cwd: string) {
  const pid = worker.snapshot().pid;
  if (pid && alive(pid)) process.kill(pid, "SIGKILL");
  const file = join(cwd, "descendant.pid");
  if (existsSync(file)) {
    const descendant = Number(readFileSync(file, "utf8"));
    if (alive(descendant)) process.kill(descendant, "SIGKILL");
  }
  await worker.done;
}

test("RPC exit with an inherited pipe cleans owned descendants and settles the worker", { timeout: 12_000, skip: process.platform === "win32" }, async () => {
  const { cwd, worker } = peer("inherited");
  try {
    const started = Date.now();
    await worker.done;
    assert(Date.now() - started < 8000);
    const result = worker.snapshot();
    assert.equal(result.status, "completed", result.error);
    assert.equal(result.usage.totalTokens, 3);
    assert.equal(alive(result.pid!), false);
    assert.equal(alive(Number(readFileSync(join(cwd, "descendant.pid"), "utf8"))), false);
    assert.match(readFileSync(result.transcript, "utf8"), /shutdown diagnostic/);
  } finally { await killOwned(worker, cwd); }
});

test("escaped inherited pipes cannot hold completion forever or hide shutdown diagnostics", { timeout: 12_000, skip: process.platform === "win32" }, async () => {
  const { cwd, worker } = peer("escaped");
  try {
    const started = Date.now();
    await worker.done;
    assert(Date.now() - started < 8000);
    const result = worker.snapshot();
    assert.equal(result.status, "failed");
    assert.match(result.error!, /shutdown.*open pipes/);
    assert.match(result.error!, /shutdown diagnostic/);
    assert.equal(alive(result.pid!), false);
    assert.equal(result.usage.totalTokens, 3);
    assert.equal(worker.takeUsage()?.totalTokens, 3);
    assert.equal(worker.takeUsage(), undefined);
  } finally { await killOwned(worker, cwd); }
});

test("a prompt acceptance stall respects the run deadline", { timeout: 5000 }, async () => {
  const { cwd, worker } = peer("stall");
  try {
    const started = Date.now();
    await worker.done;
    assert(Date.now() - started < 2000);
    assert.equal(worker.snapshot().status, "failed");
    assert.match(worker.snapshot().error!, /settle|timed out/);
  } finally { await killOwned(worker, cwd); }
});

test("failed process termination settles with failure instead of completed", { timeout: 12_000, skip: process.platform === "win32" }, async () => {
  const { cwd, worker } = peer("unkillable");
  const kill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === -worker.snapshot().pid! && (signal === "SIGTERM" || signal === "SIGKILL")) return true;
    return kill(pid, signal);
  }) as typeof process.kill;
  try {
    await worker.done;
    assert.equal(worker.snapshot().status, "failed");
    assert.match(worker.snapshot().error!, /did not terminate process/);
    assert(alive(worker.snapshot().pid!));
  } finally { process.kill = kill; await killOwned(worker, cwd); }
});

const host = hostInvocation();

test("real host keeps worker ownership during delayed shutdown and repeated resume checks", { timeout: 20_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rpc-lease-cleanup-"));
  const leasePath = workerLeasePath(`cleanup-${process.pid}`, cwd);
  const marker = join(cwd, "shutdown");
  const fixture = join(cwd, "fixture.ts");
  const rpcModule = fileURLToPath(new URL("../../extensions/subagents/rpc.ts", import.meta.url));
  writeFileSync(fixture, `import {writeFileSync} from 'node:fs';
import {assertSessionAvailable} from ${JSON.stringify(rpcModule)};
export default function(pi) {
 pi.on('session_shutdown',async()=>{writeFileSync(${JSON.stringify(marker)},String(process.pid));await new Promise(resolve=>setTimeout(resolve,5000));});
 pi.registerCommand('probe',{description:'Test lease',handler:async(path,ctx)=>{
  const outcomes=[];
  for(let i=0;i<20;i++) {
   await new Promise(resolve=>setTimeout(resolve,5));
   const check=assertSessionAvailable(path);
   // Let the owner accept while this host is still doing synchronous work.
   const end=Date.now()+10;while(Date.now()<end) {};
   try {await check;outcomes.push('available');}
   catch(error) {outcomes.push(error.message);}
  }
  ctx.ui.notify('probe:'+JSON.stringify(outcomes));
 }});
}`);
  const args = ["--no-session", "--no-skills", "--extension", fixture];
  const env = { ...process.env, PI_CODING_AGENT_DIR: cwd, PI_OFFLINE: "1" };
  const owner = new RpcProcess(host, cwd, [...args, "--extension", fileURLToPath(new URL("../../extensions/subagents/guard.ts", import.meta.url))],
    { ...env, [childConfigKey]: JSON.stringify({ leasePath }) });
  const rows: RecordValue[] = [];
  let probe: RpcProcess | undefined;
  try {
    await owner.inspect(5000);
    owner.child.stdin.end();
    const deadline = Date.now() + 2000;
    while (!existsSync(marker)) { assert(Date.now() < deadline); await delay(10); }
    probe = new RpcProcess(host, cwd, args, { ...env, [childConfigKey]: "" }, row => rows.push(row));
    await probe.send({ type: "prompt", message: `/probe ${leasePath}` }, 5000);
    const notification = rows.find(row => row.message?.startsWith("probe:"));
    assert(notification, JSON.stringify(rows));
    const outcomes = JSON.parse(notification.message.slice(6));
    assert.equal(outcomes.length, 20);
    assert(outcomes.every((outcome: string) => /previous child still owns/.test(outcome)), JSON.stringify(outcomes));
    assert(alive(owner.child.pid!));
  } finally { await Promise.all([owner.close(), probe?.close()]); }
});
