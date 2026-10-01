import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ActivityHistory, WorkerActivity, type ActivitySignal, type ActivityEntry } from "../../extensions/subagents/activity.ts";
import { Worker, type WorkerSummary } from "../../extensions/subagents/worker.ts";
import { Registry } from "../../extensions/subagents/registry.ts";
import type { RecordValue } from "../../extensions/subagents/rpc.ts";

const user = (text: string) => ({ role: "user", content: text });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
const update = (type: string, fields: RecordValue = {}) => ({ type: "message_update", assistantMessageEvent: { type, contentIndex: 0, ...fields } });
const messages = (entries: readonly ActivityEntry[]) => entries.filter((entry) => entry.kind === "message");
const tools = (entries: readonly ActivityEntry[]) => entries.filter((entry) => entry.kind === "tool");

const rows: RecordValue[] = [
  { type: "worker_attempt", attempt: 1, task: "first task", agent: "Explore" },
  { type: "message_start", message: user("first task") },
  { type: "message_end", message: user("first task") },
  { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } },
  update("text_start"), update("text_delta", { delta: "partial" }), update("text_end", { content: "authoritative" }),
  update("thinking_start", { contentIndex: 1 }), update("thinking_delta", { contentIndex: 1, delta: "thought" }),
  update("thinking_end", { contentIndex: 1, content: "final thought" }),
  update("toolcall_start", { contentIndex: 2, id: "call", toolName: "bash" }),
  update("toolcall_delta", { contentIndex: 2, delta: '{"command":' }),
  update("toolcall_end", { contentIndex: 2, toolCall: { type: "toolCall", id: "call", name: "bash", arguments: { command: "echo hi" } } }),
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final text" },
    { type: "thinking", thinking: "final thought" }, { type: "toolCall", id: "call", name: "bash", arguments: { command: "echo hi" } }], stopReason: "toolUse" } },
  { type: "tool_execution_start", toolCallId: "call", toolName: "bash", args: { command: "echo hi" } },
  { type: "tool_execution_start", toolCallId: "call/0", parentToolCallId: "call", toolName: "read", args: { path: "x" } },
  { type: "tool_execution_update", toolCallId: "call", toolName: "bash", partialResult: { content: [{ type: "text", text: "part" }] } },
  { type: "tool_execution_end", toolCallId: "call/0", parentToolCallId: "call", toolName: "read", result: { content: [] }, isError: true },
  { type: "tool_execution_end", toolCallId: "call", toolName: "bash", result: { content: [{ type: "text", text: "hi" }] }, isError: false },
  { type: "message_start", message: { role: "toolResult", toolCallId: "call", toolName: "bash", content: [] } },
  { type: "message_end", message: { role: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text: "hi" }], isError: false } },
  { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } },
  update("text_delta", { delta: "partial before interruption" }),
  { type: "worker_result", result: { attempt: 1, status: "interrupted" } },
  { type: "worker_attempt", attempt: 2, task: "continued", agent: "Explore" },
  { type: "message_end", message: user("continued") },
  { type: "tool_execution_start", toolCallId: "call", toolName: "bash", args: {} },
  { type: "message_end", message: assistant("x".repeat(40000)) },
  { type: "worker_result", result: { attempt: 2, status: "completed" } },
];

test("history and live records use one ordered projection with authoritative partial replacements", () => {
  const history = new ActivityHistory();
  rows.slice(0, 12).forEach((row) => history.apply(row));
  assert.equal(messages(history.entries)[1].message.content[2].argumentsText, '{"command":');
  history.apply(rows[12]);
  const partial = messages(history.entries)[1];
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.message.content, [{ type: "text", text: "authoritative" },
    { type: "thinking", thinking: "final thought" }, { type: "toolCall", id: "call", name: "bash", arguments: { command: "echo hi" } }]);
  const revision = partial.revision;
  rows.slice(13, 17).forEach((row) => history.apply(row));
  assert.equal(messages(history.entries)[1].message.content[0].text, "final text");
  assert(messages(history.entries)[1].revision > revision);
  assert.equal(tools(history.entries)[0].result?.content[0].text, "part");
  rows.slice(17).forEach((row) => history.apply(row));
  assert.equal(messages(history.entries).length, 5);
  assert.equal(messages(history.entries)[2].complete, false);
  assert.equal(messages(history.entries)[2].message.content[0].text, "partial before interruption");
  assert.equal(messages(history.entries).at(-1)?.message.content[0].text.length, 40000);
  assert.equal(tools(history.entries).length, 3);
  assert.equal(tools(history.entries)[0].result?.content[0].text, "hi");
  assert.equal(tools(history.entries)[1].parentToolCallId, "call");
  assert.equal(tools(history.entries)[1].isError, true);
  assert.equal(tools(history.entries)[2].attempt, 2);
  assert.equal(tools(history.entries)[2].complete, false);
  assert.deepEqual(history.entries.map((entry) => entry.id), history.entries.map((_, index) => index));
  const legacy = new ActivityHistory();
  rows.filter((row) => row.type !== "worker_attempt").forEach((row) => legacy.apply(row));
  assert.equal(messages(legacy.entries).at(-1)?.attempt, 2);
});

test("an async transcript prefix plus concurrent live records has no gaps or duplicates; reopening rebuilds it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-activity-prefix-"));
  const path = join(directory, "rpc.jsonl");
  const listeners = new Set<(event: ActivitySignal) => void>();
  const summary = () => ({ id: "worker", task: "first task", agent: "Explore" } as WorkerSummary);
  const subscribe = (listener: (event: ActivitySignal) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const emit = (row: RecordValue) => {
    appendFileSync(path, JSON.stringify(row) + "\n");
    for (const listener of listeners) listener({ kind: "record", row });
  };
  writeFileSync(path, rows.slice(0, 6).map((row) => JSON.stringify(row)).join("\n") + "\n");
  let changed = 0;
  const view = new WorkerActivity(path, summary, subscribe, () => { changed++; });
  try {
    assert(view.loading);
    rows.slice(6).forEach(emit);
    await view.ready;
    assert.equal(view.loading, false);
    const expected = new ActivityHistory();
    rows.forEach((row) => expected.apply(row));
    assert.deepEqual(view.entries, expected.entries);
    const preserved = structuredClone(view.entries);
    const transcript = readFileSync(path, "utf8");
    writeFileSync(path, "invalid history now");
    for (let i = 0; i < 20; i++) assert.deepEqual(view.entries, preserved);
    writeFileSync(path, transcript);
    view.dispose();
    view.dispose();
    assert.equal(listeners.size, 0);
    const afterDispose = changed;
    emit({ type: "stderr", text: "more output" });
    assert.equal(changed, afterDispose);
    const reopened = new WorkerActivity(path, summary, subscribe, () => {});
    await reopened.ready;
    assert.deepEqual(reopened.entries.slice(0, -1), preserved);
    assert.equal(reopened.entries.at(-1)?.kind, "event");
    reopened.dispose();
    // Cancel while the history read is pending. No late render notification.
    const canceled = new WorkerActivity(path, summary, subscribe, () => { changed++; });
    canceled.dispose();
    const beforeReady = changed;
    await canceled.ready;
    assert.equal(changed, beforeReady);
    assert.equal(canceled.entries.length, 0);
    assert.equal(listeners.size, 0);
  } finally { view.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test("damaged or unavailable history reports an error without dropping readable output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-activity-damaged-"));
  const path = join(directory, "rpc.jsonl");
  const summary = () => ({} as WorkerSummary);
  const subscribe = () => () => {};
  writeFileSync(path, JSON.stringify({ type: "message_end", message: user("x\u2028y\u2029😀") }) + '\r\n{broken}\n{"type":"message');
  const view = new WorkerActivity(path, summary, subscribe, () => { throw new Error("bad UI"); });
  const missing = new WorkerActivity(join(directory, "missing"), summary, subscribe, () => {});
  try {
    await Promise.all([view.ready, missing.ready]);
    assert.equal(messages(view.entries)[0].message.content, "x\u2028y\u2029😀");
    assert.match(view.historyError!, /incomplete record/);
    assert.match(missing.historyError!, /ENOENT/);
  } finally { view.dispose(); missing.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

// A deterministic RPC peer keeps the worker active until a steer command. It
// records real usage through Worker, without a model or the parent's tools.
function fixture(directory: string) {
  const script = join(directory, "peer.cjs");
  const session = join(directory, "session.jsonl");
  writeFileSync(session, "");
  writeFileSync(script, `const readline=require('node:readline');
const emit=row=>process.stdout.write(JSON.stringify(row)+'\\n');
const response=(c,data)=>emit({type:'response',id:c.id,success:true,data});
const usage={input:1,output:2,cacheRead:0,cacheWrite:0,totalTokens:3,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line);
 if(c.type==='get_state') response(c,{model:{provider:'fixture',id:'model'},thinkingLevel:'high',sessionFile:${JSON.stringify(session)}});
 else if(c.type==='prompt'&&c.message==='/pi-rpc-worker-inspect') {
  emit({type:'extension_ui_request',method:'notify',message:'pi-rpc-worker:'+JSON.stringify({cwd:process.cwd(),callable:[]})});response(c,{disposition:'handled'});
 } else if(c.type==='prompt') {
  response(c,{disposition:'started'});
  emit({type:'message_start',message:{role:'user',content:c.message}});
  emit({type:'message_end',message:{role:'user',content:c.message}});
  emit({type:'message_start',message:{role:'assistant',content:[],stopReason:'pending'}});
  emit({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'live partial'}});
 } else if(c.type==='steer') {
  response(c,{disposition:'queued'});
  emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'finished'}],stopReason:'stop',usage}});
  emit({type:'agent_settled'});
 } else if(c.type==='get_session_stats') response(c,{sessionFile:${JSON.stringify(session)}});
 else if(c.type==='abort') { response(c,{});emit({type:'agent_settled'}); }
 else response(c,{});
});`);
  return { command: process.execPath, args: [script] };
}

test("startup failure retains identity and error history without acknowledging completion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-activity-failure-"));
  const worker = new Worker({ cwd: directory, task: "never launched", agent: { name: "Plan", prompt: "" },
    model: "fixture/model", thinking: "high", invocation: { command: join(directory, "missing-pi"), args: [] },
    env: { PI_CODING_AGENT_DIR: directory, PI_OFFLINE: "1" } });
  const activity = worker.observe(() => {});
  try {
    assert.equal(activity.summary().status, "starting");
    await Promise.all([activity.ready, worker.done]);
    assert.equal(activity.summary().status, "failed");
    assert.equal(activity.summary().agent, "Plan");
    assert.equal(activity.summary().task, "never launched");
    assert.match(activity.summary().error!, /ENOENT/);
    assert.equal(activity.entries[0].kind, "event");
    const final = activity.entries.at(-1);
    assert(final?.kind === "event");
    assert.equal(final.event.type, "worker_result");
    assert.equal(final.event.result.status, "failed");
    assert.equal(worker.notifiedAttempt, 0);
    assert.equal(worker.reportedUsage.totalTokens, 0);
  } finally { activity.dispose(); rmSync(worker.directory, { recursive: true, force: true }); rmSync(directory, { recursive: true, force: true }); }
});

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert(Date.now() < deadline, "Fixture didn't reach expected state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("scoped viewers track starting/running/resumed history and dispose on reload without consuming ledgers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-activity-worker-"));
  const invocation = fixture(directory);
  const registry = Registry.open(directory, "parent", invocation).registry;
  let callbacks = 0;
  const list = registry.observe(() => { callbacks++; });
  const worker = new Worker({ cwd: directory, directory: registry.newDirectory(), task: "initial task", agent: { name: "Explore", prompt: "" },
    model: "fixture/model", thinking: "high", invocation, env: { PI_CODING_AGENT_DIR: directory, PI_OFFLINE: "1" } });
  let runtimeChanges = 0;
  registry.changed = () => { runtimeChanges++; };
  registry.add(worker);
  worker.background = true;
  // A broken UI callback must not fail a run or replace registry.changed.
  const faulty = registry.observe(() => { throw new Error("render failed"); });
  const activity = list.activity(worker.id, () => { callbacks++; });
  try {
    assert.equal(list.summaries()[0].status, "starting");
    assert.equal(list.summaries()[0].agent, "Explore");
    assert.equal(list.summaries()[0].task, "initial task");
    await activity.ready;
    await until(() => messages(activity.entries).some((entry) => entry.message.content?.[0]?.text === "live partial"));
    assert.equal(activity.summary().status, "running");
    assert.equal(runtimeChanges, 1);
    const pid = worker.snapshot().pid;
    const live = structuredClone(activity.entries);
    registry.detach();
    assert(activity.disposed);
    assert(list.disposed);
    assert(faulty.disposed);
    assert.throws(() => list.stop(worker.id), /replaced parent session/);
    const previousCallbacks = callbacks;
    registry.changed = () => { runtimeChanges++; };
    const reloaded = Registry.open(directory, "parent", invocation);
    assert.equal(reloaded.live, true);
    assert.equal(reloaded.registry.workers.get(worker.id)?.snapshot().pid, pid);
    const second = registry.observe(() => {});
    const detail = second.activity(worker.id, () => {});
    await detail.ready;
    assert.deepEqual(detail.entries, live);
    await second.steer(worker.id, "finish");
    await worker.done;
    assert.equal(worker.summary().status, "completed");
    assert.equal(callbacks, previousCallbacks);
    assert.equal(runtimeChanges, 2);
    assert.equal(worker.notifiedAttempt, 0);
    assert.equal(worker.reportedUsage.totalTokens, 0);
    const persisted = readFileSync(join(worker.directory, "state.json"), "utf8");
    for (let i = 0; i < 20; i++) { second.summaries(); detail.summary(); void detail.entries; }
    assert.equal(readFileSync(join(worker.directory, "state.json"), "utf8"), persisted);
    worker.resume("second task", {});
    assert.equal(second.summaries()[0].attempt, 2);
    assert.equal(second.summaries()[0].task, "second task");
    await until(() => messages(detail.entries).some((entry) => entry.attempt === 2 && entry.message.content?.[0]?.text === "live partial"));
    await second.steer(worker.id, "finish again");
    await worker.done;
    assert.equal(messages(detail.entries).filter((entry) => entry.message.role === "user").length, 2);
    assert.equal(worker.notifiedAttempt, 0);
    assert.equal(worker.reportedUsage.totalTokens, 0);
    assert.equal(worker.takeUsage()?.totalTokens, 6);
    assert.equal(worker.takeUsage(), undefined);
    second.dispose();
    assert(detail.disposed);
    assert.equal(worker.snapshot().status, "completed");
  } finally { await registry.close("Parent session quit"); rmSync(directory, { recursive: true, force: true }); }
});

test("stop feedback and recovered interruption retain partial output; old session views can't target a new parent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-activity-stop-"));
  const invocation = fixture(directory);
  const registry = Registry.open(directory, "parent", invocation).registry;
  const view = registry.observe(() => {});
  const worker = new Worker({ cwd: directory, directory: registry.newDirectory(), task: "stop task", agent: { name: "test", prompt: "" },
    model: "fixture/model", thinking: "high", invocation, env: { PI_CODING_AGENT_DIR: directory, PI_OFFLINE: "1" } });
  registry.add(worker);
  const detail = view.activity(worker.id, () => {});
  try {
    await detail.ready;
    await until(() => messages(detail.entries).some((entry) => entry.message.content?.[0]?.text === "live partial"));
    const stopping = view.stop(worker.id);
    assert.equal(detail.summary().stopping, true);
    await stopping;
    assert.equal(detail.summary().stopping, false);
    assert.equal(detail.summary().status, "stopped");
    assert.equal(messages(detail.entries).at(-1)?.complete, false);
    // Reproduce disk-only running state left by parent death, without a PID.
    const statePath = join(worker.directory, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.result.status = "running";
    writeFileSync(statePath, JSON.stringify(state));
    const recovered = Worker.recover(worker.directory, invocation);
    const history = recovered.observe(() => {});
    await history.ready;
    assert.equal(history.summary().task, "stop task");
    assert.equal(history.summary().status, "interrupted");
    assert.equal(history.summary().pid, undefined);
    assert.match(history.summary().error!, /no PID was reattached/);
    assert.equal(messages(history.entries).at(-1)?.message.content[0].text, "live partial");
    assert.equal(recovered.notifiedAttempt, worker.notifiedAttempt);
    assert.deepEqual(recovered.reportedUsage, worker.reportedUsage);
    history.dispose();
    await registry.close("Parent session replaced (new)");
    assert(detail.disposed);
    const next = Registry.open(directory, "new-parent", invocation).registry;
    const nextView = next.observe(() => {});
    assert.deepEqual(nextView.summaries(), []);
    assert.throws(() => view.steer(worker.id, "wrong session"), /replaced parent session/);
    assert.throws(() => nextView.stop(worker.id), /Unknown worker/);
    await next.close("Parent session quit");
  } finally { await registry.close("Parent session quit"); rmSync(directory, { recursive: true, force: true }); }
});
