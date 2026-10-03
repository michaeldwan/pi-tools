import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parent, eventually, receipts, verifyUsage } from "./delivery-fixture.ts";

const settled = (p: Awaited<ReturnType<typeof parent>>, from = 0) => eventually(() =>
  p.rows.slice(from).some(row => row.type === "agent_settled"), "parent settlement");

test("quiet yield has no waiting reply, accepts immediate parent input and leaves worker steering queued behind its tool", async () => {
  const p = await parent();
  try {
    const worker = await p.launch("original", "worker");
    await p.gateStarted("worker");
    const start = p.rows.length;
    const waiting = await p.call("wait_for_subagents");
    assert.equal(waiting.terminate, true);
    assert.equal(waiting.details.waiting, true);
    assert.equal(p.rows.slice(start).filter(row => row.type === "message_end" && row.message?.role === "assistant").length, 1);
    assert.equal((await p.rpc.send({ type: "get_state" })).data.isStreaming, false);
    const inputStart = Date.now();
    await p.rpc.run("new parent input");
    assert(Date.now() - inputStart < 2000);
    assert.equal(p.snapshot(worker).status, "running");
    const steering = await p.call("steer_subagent", { id: worker.id, message: JSON.stringify({ worker: "steered" }) });
    assert.equal(steering.details.disposition, "queued");
    assert.equal(p.snapshot(worker).status, "running");
    p.release("worker");
    await p.collected(worker.id);
    await settled(p, start);
    await eventually(() => (p.rows.at(-1)?.type === "agent_settled" || p.rows.some(row => row.type === "tool_execution_end" && row.toolName === "wait_for_subagents" && row.result.details.reports.length)));
    assert.equal(p.snapshot(worker).text, "Report steered");
    assert.equal(receipts(await p.entries()).filter(key => key === worker.id + "/1").length, 1);
    await verifyUsage(p, 10);
  } finally { await p.rpc.close(); }
});

test("wait is model-only, returns normally with no workers, and doesn't terminate a mixed parallel tool batch", async () => {
  const p = await parent();
  try {
    assert.equal((await p.call("wait_for_subagents")).terminate, false);
    const nested = await p.call("codemode", { code: "return await tools.wait_for_subagents({});" });
    assert(nested.isError || JSON.stringify(nested.content).includes("Script failed"));
    const worker = await p.launch("parallel", "worker");
    await p.gateStarted("worker");
    const start = p.rows.length;
    const run = p.rpc.run(JSON.stringify({ calls: [{ name: "wait_for_subagents", args: {} }, { name: "fixture_gate", args: { gate: "parent" } }] }));
    await p.gateStarted("parent");
    p.release("parent");
    await run;
    assert.equal(p.rows.slice(start).filter(row => row.type === "message_end" && row.message?.role === "assistant").length, 2);
    p.release("worker");
    await p.collected(worker.id);
  } finally { await p.rpc.close(); }
});

test("explicit pause retains live workers and pending reports across ordinary input, reload and restart until explicit resume", async () => {
  const p = await parent();
  let reopened: Awaited<ReturnType<typeof parent>> | undefined;
  try {
    const first = await p.launch("inspect", "first");
    const second = await p.launch("retain", "second");
    await Promise.all([p.gateStarted("first"), p.gateStarted("second")]);
    await p.command("/subagents pause");
    assert.equal(p.snapshot(first).status, "running");
    const start = p.rows.length;
    p.release("first"); p.release("second");
    await eventually(() => [first, second].every(worker => p.snapshot(worker).status === "completed"));
    assert(!p.rows.slice(start).some(row => row.type === "agent_start"));
    await p.rpc.run("ordinary input doesn't undo pause");
    assert(!(await p.entries()).some(entry => entry.customType === "pi-rpc-subagent-ready"));
    assert.equal((await p.call("get_subagent_result", { id: first.id })).usage.totalTokens, 10);
    await p.command("/subagents");
    await p.command("/fixture-reload");
    await p.rpc.run("still paused after reload");
    assert(!(await p.entries()).some(entry => entry.message?.toolName === "wait_for_subagents"));
    await p.rpc.close();
    reopened = await parent({ cwd: p.cwd, session: p.session });
    assert(!reopened.rows.some(row => row.type === "agent_start"));
    await reopened.rpc.run("still paused after restart");
    const beforeResume = reopened.rows.length;
    await reopened.command("/subagents resume");
    await reopened.collected(second.id);
    await settled(reopened, beforeResume);
    const entries = await reopened.entries();
    assert.equal(receipts(entries).filter(key => key === first.id + "/1").length, 1);
    assert.equal(receipts(entries).filter(key => key === second.id + "/1").length, 1);
    const automatic = entries.filter(entry => entry.message?.toolName === "wait_for_subagents");
    assert.equal(automatic.length, 1);
    assert.equal(automatic[0].message.details.reports[0].id, second.id);
    await verifyUsage(reopened, 20);
    console.log(`Persisted pause/resume RPC evidence: ${p.cwd}`);
  } finally { await p.rpc.close(); await reopened?.rpc.close(); }
});

test("pause doesn't cancel an in-flight parent tool and resume collects retained results once", async () => {
  const p = await parent();
  try {
    const worker = await p.launch("paused", "worker");
    await p.gateStarted("worker");
    const held = p.call("fixture_gate", { gate: "parent" });
    await p.gateStarted("parent");
    await p.command("/subagents pause");
    assert.equal((await p.rpc.send({ type: "get_state" })).data.isStreaming, true);
    p.release("worker");
    await eventually(() => p.snapshot(worker).status === "completed");
    p.release("parent");
    assert.equal((await held).isError, undefined);
    assert(!(await p.entries()).some(entry => entry.customType === "pi-rpc-subagent-ready"));
    const start = p.rows.length;
    await p.command("/subagents resume");
    await p.collected(worker.id);
    await settled(p, start);
    await verifyUsage(p, 10);
  } finally { await p.rpc.close(); }
});

test("active provider/tool cancellation prevents result-driven revival, including a reload, until new ordinary input", async () => {
  for (const tool of [false, true]) {
    const p = await parent();
    try {
      const worker = await p.launch("after-cancel", "worker");
      await p.gateStarted("worker");
      const start = p.rows.length;
      let held: Promise<any> | undefined;
      if (tool) {
        held = p.call("fixture_gate", { gate: "parent" });
        await p.gateStarted("parent");
      } else {
        await p.rpc.send({ type: "prompt", message: JSON.stringify({ stall: true }) });
        await eventually(() => p.rows.slice(start).some(row => row.type === "message_start" && row.message?.role === "assistant"));
        await p.command("/fixture-reload");
      }
      await p.rpc.send({ type: "abort" });
      await held;
      await settled(p, start);
      const afterAbort = p.rows.length;
      p.release("worker");
      await eventually(() => p.snapshot(worker).status === "completed");
      assert(!p.rows.slice(afterAbort).some(row => row.type === "agent_start"));
      assert(!(await p.entries()).some(entry => entry.customType === "pi-rpc-subagent-ready"));
      await p.rpc.run("continue after active cancellation");
      await p.collected(worker.id);
      assert.equal(receipts(await p.entries()).filter(key => key === worker.id + "/1").length, 1);
      await verifyUsage(p, 10);
    } finally { await p.rpc.close(); }
  }
});

test("near-settlement arrivals wake once even when they arrive after a boundary handler", async () => {
  const p = await parent();
  try {
    const worker = await p.launch("near-settle", "worker");
    await p.gateStarted("worker");
    writeFileSync(join(p.cwd, "near-settle-request"), "pause");
    const run = p.rpc.run("finish independent work");
    await p.gateStarted("near-settle");
    p.release("worker");
    await eventually(() => p.snapshot(worker).status === "completed");
    p.release("near-settle");
    await run;
    await p.collected(worker.id);
    const entries = await p.entries();
    assert.equal(receipts(entries).filter(key => key === worker.id + "/1").length, 1);
    assert.equal(entries.filter(entry => entry.customType === "pi-rpc-subagent-ready").length, 1);
    await verifyUsage(p, 10);
  } finally { await p.rpc.close(); }
});

test("nine reports across five reviewers and four resumed verifications don't replay already-refuted findings after the final handoff", async () => {
  const p = await parent();
  try {
    const workers: Awaited<ReturnType<typeof p.launch>>[] = [];
    for (let index = 0; index < 5; index++) workers.push(await p.launch("review-refuted-" + index, "review-" + index));
    await Promise.all(workers.map((_worker, index) => p.gateStarted("review-" + index)));
    const review = p.call("fixture_gate", { gate: "parent-review" });
    await p.gateStarted("parent-review");
    workers.forEach((_worker, index) => p.release("review-" + index));
    await eventually(() => workers.every(worker => p.snapshot(worker).status === "completed"));
    p.release("parent-review"); await review;
    for (let index = 0; index < 4; index++) {
      await p.launch("verified-fixed-" + index, "verify-" + index, { resume: workers[index].id });
      await p.gateStarted("verify-" + index);
    }
    const verification = p.call("fixture_gate", { gate: "parent-verification" });
    await p.gateStarted("parent-verification");
    workers.slice(0, 4).forEach((_worker, index) => p.release("verify-" + index));
    await eventually(() => workers.slice(0, 4).every(worker => p.snapshot(worker).status === "completed" && p.snapshot(worker).attempt === 2));
    p.release("parent-verification"); await verification;
    const entries = await p.entries();
    assert.equal(receipts(entries).length, 9);
    assert.equal(new Set(receipts(entries)).size, 9);
    const batches = entries.filter(entry => entry.message?.toolName === "wait_for_subagents");
    assert.equal(batches.length, 2);
    assert.equal(batches[0].message.details.reports.length, 5);
    assert.equal(batches[1].message.details.reports.length, 4);
    assert(batches[1].message.details.reports.every((report: any) => report.text.includes("verified-fixed") && !report.text.includes("review-refuted")));
    await p.command("/fixture-reload");
    assert.equal(receipts(await p.entries()).length, 9);
    await verifyUsage(p, 90);
    console.log(`Nine-report resumed-verification RPC evidence: ${p.cwd}`);
  } finally { await p.rpc.close(); }
});

test("actual compaction, live reload and parent restart preserve receipts and don't replay collected reports", async () => {
  const p = await parent();
  let reopened: Awaited<ReturnType<typeof parent>> | undefined;
  try {
    const worker = await p.launch("compact", "worker");
    await p.gateStarted("worker");
    const pid = p.snapshot(worker).pid;
    await p.rpc.send({ type: "compact" });
    await p.command("/fixture-reload");
    assert.equal(p.snapshot(worker).pid, pid);
    p.release("worker");
    await p.collected(worker.id);
    await settled(p);
    await p.rpc.send({ type: "compact" });
    await p.command("/fixture-reload");
    assert.equal((await p.call("get_subagent_result", { id: worker.id })).usage, undefined);
    await p.rpc.close();
    reopened = await parent({ cwd: p.cwd, session: p.session });
    assert(!reopened.rows.some(row => row.type === "agent_start"));
    assert.equal((await reopened.call("get_subagent_result", { id: worker.id })).usage, undefined);
    assert.equal(receipts(await reopened.entries()).filter(key => key === worker.id + "/1").length, 1);
    await verifyUsage(reopened, 10);
  } finally { await p.rpc.close(); await reopened?.rpc.close(); }
});

test("a report completed during a killed parent stream is recovered before delivery without PID reattachment", async () => {
  const p = await parent();
  let reopened: Awaited<ReturnType<typeof parent>> | undefined;
  try {
    const worker = await p.launch("undelivered", "worker");
    await p.gateStarted("worker");
    await p.rpc.send({ type: "prompt", message: JSON.stringify({ stall: true }) });
    p.release("worker");
    await eventually(() => p.snapshot(worker).status === "completed");
    assert(!(await p.entries()).some(entry => entry.customType === "pi-rpc-subagent-ready"));
    p.rpc.child.kill("SIGKILL"); await p.rpc.close();
    reopened = await parent({ cwd: p.cwd, session: p.session });
    await reopened.collected(worker.id);
    await settled(reopened);
    const report = (await reopened.entries()).find(entry => entry.message?.toolName === "wait_for_subagents");
    assert(report);
    assert.equal(report.message.details.reports[0].status, "completed");
    assert.equal((await reopened.call("get_subagent_result", { id: worker.id })).details.pid, undefined);
    assert.equal(receipts(await reopened.entries()).filter(key => key === worker.id + "/1").length, 1);
    await verifyUsage(reopened, 10);
  } finally { await p.rpc.close(); await reopened?.rpc.close(); }
});
