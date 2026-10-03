import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parent, eventually, receipts, childUsage } from "./delivery-fixture.ts";

async function usageIsExact(p: Awaited<ReturnType<typeof parent>>, expected: number) {
  const entries = await p.entries();
  assert.equal(childUsage(entries), expected);
  const stats = (await p.rpc.send({ type: "get_session_stats" })).data;
  const own = entries.filter(entry => entry.message?.role === "assistant").reduce((sum, entry) => sum + entry.message.usage.totalTokens, 0);
  assert.equal(stats.tokens.input + stats.tokens.output + stats.tokens.cacheRead + stats.tokens.cacheWrite, own + expected);
}

test("five-worker review batches ready results after parent tools and before the next model request", async () => {
  const p = await parent();
  try {
    const workers: Awaited<ReturnType<typeof p.launch>>[] = [];
    for (let index = 0; index < 5; index++) workers.push(await p.launch("review-" + index, "worker-" + index));
    await Promise.all(workers.map((_worker, index) => p.gateStarted("worker-" + index)));
    const held = p.call("fixture_gate", { gate: "parent" });
    await p.gateStarted("parent");
    workers.forEach((_worker, index) => p.release("worker-" + index));
    await eventually(() => workers.every(worker => p.snapshot(worker).status === "completed"), "five reviews finish");
    assert(!p.rows.some(row => row.type === "tool_execution_start" && row.toolName === "wait_for_subagents"));
    p.release("parent");
    await held;
    const entries = await p.entries();
    const ready = entries.filter(entry => entry.customType === "pi-rpc-subagent-ready");
    assert.equal(ready.length, 1);
    assert.equal(ready[0].display, false);
    assert.equal(ready[0].details.reports.length, 5);
    assert(!ready[0].content.includes("Report review"));
    assert.equal(receipts(entries).length, 5);
    const collection = entries.find(entry => entry.message?.toolName === "wait_for_subagents");
    assert(collection);
    assert.equal(collection.message.details.reports.length, 5);
    assert.equal(collection.message.usage.totalTokens, 50);
    const requests = readFileSync(join(p.cwd, "requests-" + p.rpc.child.pid + ".jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const afterParentTool = requests.find((messages: any[]) => messages.at(-1)?.content?.some?.((part: any) => part.text?.includes("Subagent results are ready.")));
    assert(afterParentTool, "Ready notification must reach the next provider request");
    assert(afterParentTool.some((message: any) => message.role === "toolResult" && message.toolName === "fixture_gate"));
    const lastAssistant = entries.filter(entry => entry.message?.role === "assistant").at(-1);
    assert(lastAssistant);
    const final = entries.indexOf(lastAssistant);
    assert.equal(entries[final].message.content[0].text, "Final handoff");
    assert(!entries.slice(final + 1).some(entry => entry.customType === "pi-rpc-subagent-ready"));
    await usageIsExact(p, 50);
    console.log(`Five-worker RPC evidence: ${p.cwd}`);
  } finally { await p.rpc.close(); }
});

test("direct and codemode terminal retrieval acknowledge the same report and don't leave a final-handoff continuation", async () => {
  for (const nested of [false, true]) {
    const p = await parent();
    try {
      const worker = await p.launch(nested ? "nested" : "direct", "worker");
      await p.gateStarted("worker");
      const retrieving = nested ? p.call("codemode", { code: `await tools.fixture_gate({gate:'parent'}); return await tools.get_subagent_result({id:${JSON.stringify(worker.id)}});` }) :
        p.call("get_subagent_result", { id: worker.id, wait: true, timeoutMs: 30_000 });
      if (nested) await p.gateStarted("parent");
      else await eventually(() => p.rows.some(row => row.type === "tool_execution_start" && row.toolName === "get_subagent_result"));
      p.release("worker");
      await eventually(() => p.snapshot(worker).status === "completed");
      if (nested) p.release("parent");
      await retrieving;
      const entries = await p.entries();
      assert.equal(receipts(entries).filter(key => key === worker.id + "/1").length, 1);
      assert(!entries.some(entry => entry.customType === "pi-rpc-subagent-ready"));
      assert(!entries.some(entry => entry.message?.toolName === "wait_for_subagents"));
      const result = entries.find(entry => entry.message?.toolName === (nested ? "codemode" : "get_subagent_result"));
      assert(result);
      assert.equal(result.message.usage.totalTokens, 10);
      if (nested) assert(!result.message.details.id);
      await p.command("/fixture-reload");
      assert.equal((await p.call("get_subagent_result", { id: worker.id })).usage, undefined);
      await usageIsExact(p, 10);
    } finally { await p.rpc.close(); }
  }
});

test("unrelated tool attempt details don't become worker receipts or break collection", async () => {
  const p = await parent();
  try {
    await p.call("fixture_other");
    const result = await p.call("wait_for_subagents");
    assert.equal(result.isError, undefined);
    assert.equal(result.details.waiting, false);
    assert(!p.rows.some(row => row.type === "extension_error"));
  } finally { await p.rpc.close(); }
});

test("model-issued IDs containing slashes commit nested receipts against the actual outer result", async () => {
  const p = await parent();
  try {
    const worker = await p.launch("slash-id", "worker");
    await p.gateStarted("worker");
    await p.command("/subagents pause");
    p.release("worker");
    await eventually(() => p.snapshot(worker).status === "completed");
    await p.rpc.run(JSON.stringify({ calls: [{ id: "outer/call", name: "codemode",
      args: { code: `return await tools.get_subagent_result({id:${JSON.stringify(worker.id)}});` } }] }));
    assert.equal(receipts(await p.entries()).filter(key => key === worker.id + "/1").length, 1);
    await p.command("/fixture-reload");
    await p.command("/subagents resume");
    assert(!(await p.entries()).some(entry => entry.customType === "pi-rpc-subagent-ready"));
    await usageIsExact(p, 10);
  } finally { await p.rpc.close(); }
});

test("previously handled failed reports collect owed usage without replaying old errors", async () => {
  const p = await parent();
  try {
    const worker = await p.launch("legacy-failed", "worker");
    await p.gateStarted("worker");
    await p.command("/subagents pause");
    p.release("worker");
    await eventually(() => p.snapshot(worker).status === "failed");
    await p.command("/fixture-legacy " + JSON.stringify(p.snapshot(worker)));
    await p.command("/subagents resume");
    await p.collected(worker.id);
    const collection = (await p.entries()).find(entry => entry.message?.toolName === "wait_for_subagents");
    assert(collection);
    assert.equal(collection.message.details.reports[0].usageOnly, true);
    assert(!JSON.stringify(collection.message.content).includes("already-refuted failure"));
    assert(!JSON.stringify(collection.message.details.reports[0]).includes("already-refuted failure"));
    assert(p.snapshot(worker).error.includes("already-refuted failure"), "Saved diagnosis must remain intact");
    await usageIsExact(p, 10);
  } finally { await p.rpc.close(); }
});

test("a crash after collection reserves usage but before the parent commits recovers the report and accounts it once", async () => {
  const p = await parent();
  let reopened: Awaited<ReturnType<typeof parent>> | undefined;
  try {
    const worker = await p.launch("recover", "worker");
    await p.gateStarted("worker");
    writeFileSync(join(p.cwd, "crash-on-collect"), "pause");
    p.release("worker");
    await eventually(() => existsSync(join(p.cwd, "collection-reserved")), "collection reservation");
    const entries = await p.entries();
    assert(entries.some(entry => entry.customType === "pi-rpc-subagent-delivery"));
    assert(!entries.some(entry => entry.message?.toolName === "wait_for_subagents"));
    p.rpc.child.kill("SIGKILL");
    await p.rpc.close();
    unlinkSync(join(p.cwd, "crash-on-collect"));
    reopened = await parent({ cwd: p.cwd, session: p.session });
    await reopened.collected(worker.id);
    await eventually(() => reopened!.rows.some(row => row.type === "agent_settled"));
    assert.equal(receipts(await reopened.entries()).filter(key => key === worker.id + "/1").length, 1);
    await usageIsExact(reopened, 10);
    console.log(`Crash recovery RPC evidence: ${p.cwd}`);
  } finally { await p.rpc.close(); await reopened?.rpc.close(); }
});
