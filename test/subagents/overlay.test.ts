import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme, KeybindingsManager as HostKeys } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input, TuiMainScreen, TuiAltScreen, visibleWidth, type Terminal, type Component, type TUI } from "@earendil-works/pi-tui";
// The host exports this class as a type only; tests need its actual defaults.
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
import { ActivityHistory, type ActivityChange, type WorkerActivity } from "../../extensions/subagents/activity.ts";
import { Registry, type RegistryChange } from "../../extensions/subagents/registry.ts";
import { Worker, type WorkerSummary } from "../../extensions/subagents/worker.ts";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { RpcProcess } from "../../extensions/subagents/rpc.ts";
import { hostInvocation } from "./fixture-invocation.ts";
import { activityText, registerSubagentsUI, SubagentsOverlay } from "../../extensions/subagents/overlay.ts";

const theme = { fg: (_color: string, value: string) => value } as Theme;
const keys = new KeybindingsManager();
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const worker = (id: string, status: WorkerSummary["status"] = "running"): WorkerSummary => ({
  id, status, attempt: 1, task: `Task ${id}`, agent: "Explore", cwd: "/scratch/界", model: "fixture/model", thinking: "high", transcript: "/scratch/rpc.jsonl", stopping: false,
});

class TestTerminal implements Terminal {
  columns = 100;
  rows = 30;
  kittyProtocolActive = false;
  input = (_data: string) => {};
  resize = () => {};
  output = "";
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() {}
  async drainInput() {}
  write(data: string) { this.output += data; }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
}

function fixture(initial = [worker("one"), worker("two")], mode: "regular" | "fullscreen" = "regular") {
  const terminal = new TestTerminal();
  const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
  let changes = (_change: RegistryChange) => {};
  let disposed = false;
  let historyDisposals = 0;
  const historyOpens: string[] = [];
  let calls: { action: string; id: string; message?: string }[] = [];
  const histories = new Map<string, ActivityHistory>();
  const listeners = new Map<string, (change: ActivityChange) => void>();
  let steer: (id: string, message: string) => Promise<{ disposition: string }> = async () => ({ disposition: "queued" });
  let stop: (id: string) => Promise<void> = async () => {};
  const view = {
    get disposed() { return disposed; },
    summaries: () => initial.slice(),
    activity(id: string, listener: (change: ActivityChange) => void) {
      historyOpens.push(id);
      const history = histories.get(id) ?? new ActivityHistory();
      histories.set(id, history);
      listeners.set(id, listener);
      let disposed = false;
      return {
        entries: history.entries, loading: false, summary: () => initial.find((w) => w.id === id)!,
        ready: Promise.resolve(),
        dispose() { if (disposed) return; disposed = true; historyDisposals++; listeners.delete(id); listener({ kind: "disposed" }); },
      } as unknown as WorkerActivity;
    },
    steer(id: string, message: string) { calls.push({ action: "steer", id, message }); return steer(id, message); },
    stop(id: string) { calls.push({ action: "stop", id }); return stop(id); },
    dispose() { if (disposed) return; disposed = true; changes({ kind: "disposed" }); },
  };
  const registry = { observe(listener: (change: RegistryChange) => void) { changes = listener; return view; } } as unknown as Registry;
  let closed = 0;
  const overlay = new SubagentsOverlay(tui, theme, keys, registry, () => { closed++; });
  overlay.focused = true;
  const render = (width = terminal.columns) => overlay.render(width).join("\n");
  return { terminal, tui, registry, view, overlay, calls, render, histories, historyOpens, listeners,
    get historyDisposals() { return historyDisposals; }, get closed() { return closed; },
    setSteer: (value: typeof steer) => { steer = value; }, setStop: (value: typeof stop) => { stop = value; },
    changed: (id: string) => changes({ kind: "worker", id }),
    append(id: string, row: Record<string, unknown>) {
      const history = histories.get(id)!;
      const from = history.apply(row);
      listeners.get(id)?.({ kind: "history", from });
    },
  };
}

function populate(f: ReturnType<typeof fixture>, id = "one") {
  f.append(id, { type: "message_end", message: { role: "user", content: "Initial request" } });
  f.append(id, { type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [
    { type: "text", text: Array.from({ length: 45 }, (_, i) => `line-${i}`).join("\n") },
    { type: "thinking", thinking: "private thought text" },
    { type: "toolCall", id: "call", name: "bash", arguments: { command: "echo output" } },
  ] } });
  f.append(id, { type: "tool_execution_start", toolCallId: "call", toolName: "bash", args: { command: "echo output" } });
  f.append(id, { type: "tool_execution_end", toolCallId: "call", toolName: "bash", isError: false,
    result: { content: [{ type: "text", text: "expanded result evidence" }] } });
}

test("active list separates retained terminal history, preserves selection on additions, and back only disposes views", () => {
  const empty = fixture([]);
  assert.match(empty.render(), /No workers/);
  empty.overlay.handleInput("\r");
  empty.overlay.handleInput("\x03");
  assert.equal(empty.closed, 1);
  const list = [worker("one", "starting"), worker("two", "failed"), worker("three", "interrupted"), worker("four", "completed")];
  list[1].error = "startup failed";
  const f = fixture(list);
  assert.match(f.render(), /\[Active 1\] · History 3/);
  assert.match(f.render(), /starting/);
  assert.doesNotMatch(f.render(), /failed|interrupted|completed/);
  f.overlay.handleInput("\t");
  assert.match(f.render(), /Active 1 · \[History 3\]/);
  assert.match(f.render(), /failed/);
  assert.match(f.render(), /interrupted/);
  assert.match(f.render(), /completed/);
  list.unshift(worker("new"));
  f.changed("new");
  f.overlay.handleInput("\r");
  assert.match(f.render(), /two/);
  assert.match(f.render(), /startup failed/);
  f.overlay.handleInput("\x03");
  assert.equal(f.calls.length, 0);
  assert.match(f.render(), /already failed/);
  const disposals = f.historyDisposals;
  f.overlay.handleInput("\x1b");
  assert.equal(f.historyDisposals, disposals); // Back reuses the selected row's history.
  assert.equal(f.closed, 0);
  f.overlay.handleInput("\x1b");
  assert.equal(f.closed, 1);
  assert.equal(f.view.disposed, true);
  f.overlay.dispose();
  assert.equal(f.closed, 1);
});

test("new active workers are immediately discoverable behind many old workers; list selections are independent", () => {
  const list = ["completed", "stopped", "failed", "interrupted"].flatMap((status) =>
    Array.from({ length: 4 }, (_, i) => worker(`${status}-${i}`, status as WorkerSummary["status"])));
  list.push(worker("current", "starting"), worker("sibling"));
  const f = fixture(list);
  assert.match(f.render(), /\[Active 2\] · History 16/);
  assert.match(f.render(), /→ Explore · starting · current/);
  assert.match(f.render(), /Task current/);
  assert.doesNotMatch(f.render(), /completed-0|stopped-0|failed-0|interrupted-0/);
  f.overlay.handleInput("\x1b[B");
  f.overlay.handleInput("\t");
  for (let i = 0; i < 15; i++) f.overlay.handleInput("\x1b[B");
  assert.match(f.render(), /→ Explore · interrupted · interrupted-3/);
  f.overlay.handleInput("\x1b[Z"); // Shift+Tab uses the same two lists.
  assert.match(f.render(), /→ Explore · running · sibling/);
  list.push(worker("newest"));
  f.changed("newest");
  assert.match(f.render(), /→ Explore · running · sibling/);
  f.overlay.handleInput("\t");
  assert.match(f.render(), /→ Explore · interrupted · interrupted-3/);
  for (const width of [1, 2, 25, 80, 160]) for (const height of [2, 10, 30, 80]) {
    f.terminal.rows = height;
    const lines = f.overlay.render(width);
    assert(lines.length <= Math.max(1, Math.floor(height * 0.9)));
    assert(lines.every((line) => visibleWidth(line) <= width));
  }
  f.overlay.handleInput("\x03");
  assert.equal(f.closed, 1);
  assert.deepEqual(f.calls, []);
});

test("status changes keep identity or the nearest remaining row without switching lists unexpectedly", () => {
  const list = [worker("old", "completed"), worker("first", "starting"), worker("second"), worker("third")];
  const f = fixture(list);
  const selected = () => f.render().match(/→ Explore · [^\n│]+/)?.[0];
  f.overlay.handleInput("\x1b[B");
  assert.match(selected()!, /second/);
  list[1].status = "running";
  list[2].stopping = true;
  f.changed("first");
  assert.match(selected()!, /running · stopping · second/);
  list[1].status = "completed";
  f.changed("first");
  assert.match(selected()!, /second/);
  list[2].status = "stopped";
  f.changed("second");
  assert.match(selected()!, /third/);
  list[3].status = "failed";
  f.changed("third");
  assert.equal(selected(), undefined);
  assert.match(f.render(), /\[Active 0\] · History 4/);
  assert.match(f.render(), /No active workers. Tab opens retained history/);
  f.overlay.handleInput("\x1b[B");
  f.overlay.handleInput("\r");
  assert.equal(f.listeners.size, 0); // Empty active list retains no history subscriptions.
  list.push(worker("next", "starting"));
  f.changed("next");
  assert.match(selected()!, /next/);
  f.overlay.handleInput("\t");
  f.overlay.handleInput("\x1b[B");
  assert.match(selected()!, /first/);
  list[0].status = "starting"; // Resume before the selected history row.
  f.changed("old");
  assert.match(selected()!, /first/);
  list[1].status = "starting"; // Selected row resumes; choose its successor.
  f.changed("first");
  assert.match(selected()!, /second/);
  f.overlay.handleInput("\x1b[B");
  list[3].status = "starting"; // Last row resumes; clamp to the previous row.
  f.changed("third");
  assert.match(selected()!, /second/);
  list[2].status = "starting";
  f.changed("second");
  assert.match(f.render(), /No terminal workers yet/);
  f.overlay.handleInput("\t");
  assert.match(selected()!, /next/);
  f.overlay.dispose();
});

test("detail stays on its worker through settlement and resume; back follows that worker's current list", () => {
  const list = [worker("old", "completed"), worker("one"), worker("two")];
  const f = fixture(list);
  f.overlay.handleInput("\r");
  populate(f);
  list[1].status = "completed";
  f.changed("one");
  list.unshift(worker("new", "starting"));
  f.changed("new");
  assert.match(f.render(), /completed · attempt 1 · one/);
  assert.doesNotMatch(f.render(), /Task two|Task new/);
  f.overlay.handleInput("\x1b");
  assert.match(f.render(), /\[History 2\]/);
  assert.match(f.render(), /→ Explore · completed · one/);
  f.overlay.handleInput("\r");
  assert.match(f.render(), /line-44/);
  const one = list.find((item) => item.id === "one")!;
  one.status = "starting";
  one.attempt++;
  f.changed("one");
  assert.match(f.render(), /starting · attempt 2 · one/);
  f.overlay.handleInput("\x1b");
  assert.match(f.render(), /\[Active 3\]/);
  assert.match(f.render(), /→ Explore · starting · one/);
  assert(f.listeners.has("one")); // The selected history survives both detail visits.
  assert.deepEqual(f.calls, []);
  f.overlay.dispose();
});

test("transcript follows at bottom, stays at an entry-relative position during live output, and expands tools/thinking locally", () => {
  const f = fixture();
  f.overlay.handleInput("\r");
  populate(f);
  assert.match(f.render(), /following/);
  assert.match(f.render(), /expanded result evidence/);
  assert.doesNotMatch(f.render(), /private thought text/);
  f.overlay.handleInput("\x0f");
  assert.match(f.render(), /expanded result evidence/);
  f.overlay.handleInput("\x14");
  assert.match(f.render(), /private thought text/);
  f.overlay.handleInput("\x1b[H");
  const before = f.render();
  assert.match(before, /Initial request/);
  assert.match(before, /scrolled back/);
  f.append("one", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "new live tail" }] } });
  assert.match(f.render(), /Initial request/);
  assert.doesNotMatch(f.render(), /new live tail/);
  f.overlay.handleInput("\x1b[F");
  assert.match(f.render(), /new live tail/);
  assert.match(f.render(), /following/);
  f.overlay.handleInput("\x1b[5~");
  assert.match(f.render(), /scrolled back/);
  const retained = f.render().match(/line-\d+/)?.[0];
  f.append("one", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "another tail" }] } });
  assert.equal(f.render().match(/line-\d+/)?.[0], retained);
  f.overlay.handleInput("\x1b");
  f.overlay.handleInput("\r");
  assert.match(f.render(), /another tail/);
  assert.doesNotMatch(f.render(), /private thought text/);
  assert.match(f.render(), /expanded result evidence/);
  f.overlay.dispose();
});

test("list ticks without summary changes; detail previews are bounded, sanitized and explicitly expandable", () => {
  const f = fixture();
  let renders = 0;
  f.tui.requestRender = () => { renders++; };
  f.render();
  f.append("one", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Starting the command" }] } });
  assert.match(f.render(), /assistant: Starting the command/);
  f.append("one", { type: "message_start", message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }] } });
  assert.doesNotMatch(f.render(), /secret/);
  f.append("one", { type: "tool_execution_start", toolCallId: "ticker", toolName: "bash", args: { command: "ticking command" } });
  assert.match(f.render(), /bash · pending \/ partial · waiting for output/);
  const output = Array.from({ length: 30 }, (_, i) => `tick ${i + 1}/30`).join("\n");
  const update = (text: string) => f.append("one", { type: "tool_execution_update", toolCallId: "ticker", toolName: "bash",
    partialResult: { content: [{ type: "text", text }] } });
  const before = renders;
  update(output);
  assert(renders > before, "Tool updates must request rendering before settlement");
  assert.match(f.render(), /bash · pending \/ partial: tick 30\/30/);
  assert.doesNotMatch(f.render(), /tick 1\/30/);
  const opens = f.historyOpens.length;
  f.overlay.handleInput("\r");
  assert.equal(f.historyOpens.length, opens); // No second history read to enter detail.
  assert.match(f.render(), /tick 28\/30[\s\S]*tick 30\/30/);
  assert.match(f.render(), /output tail · expand tools for full result/);
  assert.doesNotMatch(f.render(), /tick 27\/30|secret/);
  f.overlay.handleInput("\x0f");
  f.overlay.handleInput("\x1b[H");
  assert.match(f.render(), /tick 1\/30/);
  f.overlay.handleInput("\x0f");
  f.overlay.handleInput("\x1b[F");
  update(output + "\n\x1b[2J\x07tick 31/30\n");
  assert.match(f.render(), /tick 31\/30/);
  assert(!f.render().includes("\x1b[2J"));
  assert(!f.render().includes("\x07"));
  f.overlay.handleInput("\x1b");
  assert.match(f.render(), /pending \/ partial: tick 31\/30/);
  f.overlay.dispose();
});

test("compact live previews read a bounded suffix without scanning earlier content blocks", () => {
  const f = fixture();
  f.render();
  let earlierReads = 0;
  const content = [
    { type: "text", get text() { earlierReads++; return "earlier output"; } },
    { type: "text", text: "old output\n".repeat(200000) + "\n\x1b[2J\x07latest large tick\n" },
  ];
  f.append("one", { type: "tool_execution_update", toolCallId: "large", toolName: "bash",
    partialResult: { content } });
  assert.match(f.render(), /latest large tick/);
  assert.equal(earlierReads, 0);
  f.overlay.handleInput("\r");
  assert.match(f.render(), /latest large tick/);
  assert.match(f.render(), /output tail/);
  assert.equal(earlierReads, 0);
  assert(!f.render().includes("\x1b[2J"));
  assert(!f.render().includes("\x07"));
  f.overlay.dispose();
});

test("the list follows the latest update when parallel tools change earlier entries", () => {
  const f = fixture();
  f.render();
  for (const [toolCallId, toolName] of [["ticker", "bash"], ["later", "read"]]) {
    f.append("one", { type: "tool_execution_start", toolCallId, toolName, args: {} });
  }
  f.append("one", { type: "tool_execution_end", toolCallId: "later", toolName: "read", isError: false,
    result: { content: [{ type: "text", text: "read finished" }] } });
  assert.match(f.render(), /read · done: read finished/);
  f.append("one", { type: "tool_execution_update", toolCallId: "ticker", toolName: "bash",
    partialResult: { content: [{ type: "text", text: "latest tick" }] } });
  assert.match(f.render(), /bash · pending \/ partial: latest tick/);
  f.append("one", { type: "queue_update", steering: [], followUp: [] });
  assert.match(f.render(), /bash · pending \/ partial: latest tick/);
  f.overlay.dispose();
});

for (const status of ["completed", "failed", "stopped", "interrupted"] as const) test(`history list and detail retain useful ${status} tool output without expansion`, () => {
  const summary = worker("retained", status);
  const f = fixture([summary]);
  const history = new ActivityHistory();
  history.apply({ type: "tool_execution_start", toolCallId: "retained-call", toolName: "bash", args: {} });
  history.apply({ type: "tool_execution_update", toolCallId: "retained-call", toolName: "bash",
    partialResult: { content: [{ type: "text", text: "retained partial tick" }] } });
  if (status === "completed" || status === "failed") history.apply({ type: "tool_execution_end", toolCallId: "retained-call", toolName: "bash",
    result: { content: [{ type: "text", text: "retained final tick" }] }, isError: status === "failed" });
  history.apply({ type: "worker_result", result: { attempt: 1, status } });
  f.histories.set("retained", history);
  f.overlay.handleInput("\t");
  assert.match(f.render(), /retained (partial|final) tick/);
  f.overlay.handleInput("\r");
  assert.match(f.render(), /retained (partial|final) tick/);
  assert.match(f.render(), status === "failed" ? /bash · error/ : status === "completed" ? /bash · done/ : /bash · pending \/ partial/);
  f.overlay.handleInput("\x1b");
  summary.attempt++;
  summary.status = "starting";
  f.append("retained", { type: "worker_attempt", attempt: 2, agent: "Explore", task: "resumed" });
  f.changed("retained");
  f.overlay.handleInput("\t");
  assert.doesNotMatch(f.render(), /retained (partial|final) tick/);
  assert.match(f.render(), /Waiting for output/);
  f.overlay.dispose();
});

test("compact tool arguments are clipped while streaming and after execution starts; expansion keeps them whole", () => {
  const history = new ActivityHistory();
  const content = "\x1b[2Jfile line\n".repeat(20000) + "last line";
  history.apply({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "large", toolName: "write" } });
  history.apply({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0,
    delta: JSON.stringify({ path: "big.txt", content }) } });
  const streaming = activityText(history.entries[0], false, false);
  assert.equal(streaming.length, 2); // Role and one request line.
  assert(streaming[1].length < 700);
  assert.match(streaming[1], /write · request \/ partial · \{"path":"big.txt".*…$/);
  assert(!streaming[1].includes("\x1b"));
  assert.match(activityText(history.entries[0], true, false).join("\n"), /last line/);
  history.apply({ type: "tool_execution_start", toolCallId: "large", toolName: "write", args: { path: "big.txt", content } });
  const tool = history.entries.find((entry) => entry.kind === "tool")!;
  const title = activityText(tool, false, false)[0];
  assert(title.length < 700);
  assert.match(title, /write · pending \/ partial · \{"path":"big.txt","content":".*file line.*…$/);
  assert.doesNotMatch(title, /last line/);
  assert.match(activityText(tool, true, false).join("\n"), /last line/);
});

test("compact tool layout bounds long single lines and keeps full results for expansion", () => {
  const history = new ActivityHistory();
  const text = "begin\n" + "界😀".repeat(20000) + "latest end\n";
  history.apply({ type: "tool_execution_end", toolCallId: "large", toolName: "read", isError: true,
    result: { content: [{ type: "text", text }] } });
  const entry = history.entries[0];
  const compact = activityText(entry, false, false);
  assert.equal(compact.length, 3); // Title, clipping notice, bounded tail.
  assert(compact.at(-1)!.length <= 600);
  assert.match(compact.join("\n"), /error[\s\S]*latest end/);
  assert.doesNotMatch(compact.join("\n"), /begin/);
  assert.equal(activityText(entry, true, false).at(-1), text);
  const f = fixture();
  f.histories.set("one", history);
  assert.match(f.render(25), /latest end/);
  f.overlay.handleInput("\r");
  assert.match(f.render(25), /latest end/);
  assert(f.overlay.render(25).every((line) => visibleWidth(line) <= 25));
  f.overlay.dispose();
});

test("only visible list rows load history; detail reuses it and viewport changes release subscriptions", () => {
  const f = fixture([...Array.from({ length: 20 }, (_, i) => worker(`active-${i}`)), worker("old", "completed")]);
  f.render();
  const capacity = f.listeners.size;
  assert.equal(capacity, 5);
  assert.equal(f.historyOpens.length, capacity);
  assert(!f.listeners.has("old"));
  for (let i = 0; i < 10; i++) f.render();
  assert.equal(f.historyOpens.length, capacity);
  f.overlay.handleInput("\r");
  assert.equal(f.listeners.size, 1);
  assert.equal(f.historyOpens.length, capacity);
  f.overlay.handleInput("\x1b");
  f.render();
  assert.equal(f.listeners.size, capacity);
  assert.equal(f.historyOpens.filter((id) => id === "active-0").length, 1);
  f.overlay.handleInput("\x1b[B");
  f.render();
  assert(!f.listeners.has("active-0"));
  assert(f.listeners.has("active-5"));
  f.overlay.handleInput("\t");
  f.render();
  assert.deepEqual([...f.listeners.keys()], ["old"]);
  f.overlay.close();
  assert.equal(f.listeners.size, 0);
  f.changed("old");
  assert.equal(f.closed, 1);
  assert.equal(f.view.disposed, true);
  assert.equal(f.render(), ""); // A late render can't reopen disposed histories.
});

for (const mode of ["regular", "fullscreen"] as const) test(`steering cursor matches focus and Tab preserves draft/cursor in ${mode}`, async () => {
  const f = fixture(undefined, mode);
  const noCursor = () => {
    const rendered = f.render();
    assert(!rendered.includes(CURSOR_MARKER), "Inactive input mustn't position the hardware cursor");
    assert(!rendered.includes("\x1b[7m"), "Inactive input mustn't draw an inverse-video cursor");
    return rendered;
  };
  f.tui.start();
  f.tui.showOverlay(f.overlay, { width: "90%", maxHeight: "90%" });
  try {
    f.terminal.input("\r");
    populate(f);
    assert.match(noCursor(), /\[Output focus\]/);
    assert.match(noCursor(), /Steer \(Tab to edit\):/);
    assert.doesNotMatch(noCursor(), /Steer >/);
    f.terminal.input("ignored while reading");
    f.terminal.input("\r");
    assert.deepEqual(f.calls, []);
    f.terminal.input("\x1b[5~");
    assert.match(noCursor(), /scrolled back/);
    const position = f.render().match(/line-\d+/)?.[0];
    f.terminal.input("\t");
    assert.match(f.render(), /\[Steering focus\]/);
    assert(f.render().includes(CURSOR_MARKER));
    assert(f.render().includes("\x1b[7m"));
    f.terminal.input("draft");
    f.terminal.input("\x1b[D");
    f.terminal.input("\t");
    assert.match(noCursor(), /Steer \(Tab to edit\): draft/);
    assert.equal(f.render().match(/line-\d+/)?.[0], position);
    f.terminal.input("ignored again");
    f.terminal.input("\r");
    assert.deepEqual(f.calls, []);
    f.terminal.input("\x1b[Z");
    f.terminal.input("X");
    assert.match(f.render(), /drafX/); // Cursor before the final t survived both switches.
    f.overlay.focused = false;
    assert.match(noCursor(), /\[Focus elsewhere\]/);
    f.overlay.focused = true;
    f.terminal.input("\r");
    await tick();
    assert.deepEqual(f.calls, [{ action: "steer", id: "one", message: "drafXt" }]);
    assert.match(f.render(), /Queued -- not delivery/);
    f.terminal.input("\x1b[Z");
    assert.match(noCursor(), /\[Output focus\]/);
    f.terminal.input("\x1b[F");
    assert.match(noCursor(), /following/);
    f.terminal.input("\x1b");
    f.terminal.input("\r");
    assert.match(noCursor(), /\[Output focus\]/);
    assert.doesNotMatch(noCursor(), /drafXt|ignored/);
  } finally { f.overlay.dispose(); f.tui.stop(); }
});

test("Tab steering sends directly to the selected worker, retains failed input, and rejects starting/terminal state", async () => {
  const f = fixture();
  f.overlay.handleInput("\x1b[B");
  f.overlay.handleInput("\r");
  f.overlay.handleInput("\t");
  assert(f.render().includes(CURSOR_MARKER));
  f.overlay.focused = false;
  assert(!f.render().includes(CURSOR_MARKER));
  f.overlay.focused = true;
  let resolve!: (response: { disposition: string }) => void;
  f.setSteer(() => new Promise((done) => { resolve = done; }));
  f.overlay.handleInput("change direction");
  f.overlay.handleInput("\r");
  assert.match(f.render(), /Sending steering/);
  f.overlay.handleInput("\r");
  assert.deepEqual(f.calls, [{ action: "steer", id: "two", message: "change direction" }]);
  resolve({ disposition: "queued" });
  await tick();
  assert.match(f.render(), /Queued -- not delivery/);
  f.setSteer(async () => { throw new Error("Worker settled; launch more work"); });
  f.overlay.handleInput("retain me");
  f.overlay.handleInput("\r");
  await tick();
  assert.match(f.render(), /Steering failed/);
  assert.match(f.render(), /retain me/);
  const item = f.view.summaries()[1];
  item.status = "completed";
  f.overlay.handleInput("\r");
  assert.equal(f.calls.length, 2);
  assert.match(f.render(), /requires a running worker/);
  item.status = "starting";
  f.overlay.handleInput("\r");
  assert.equal(f.calls.length, 2);
  f.overlay.dispose();
});

test("Ctrl+C stops only the detail worker, shows pending/settled/error feedback, and late responses can't alter another detail", async () => {
  const f = fixture();
  f.overlay.handleInput("\r");
  let finish!: () => void;
  f.setStop(() => new Promise((resolve) => { finish = resolve; }));
  f.overlay.handleInput("\t");
  f.overlay.handleInput("\x03");
  assert.match(f.render(), /Stopping this worker/);
  assert.deepEqual(f.calls, [{ action: "stop", id: "one" }]);
  f.overlay.handleInput("\x03");
  assert.equal(f.calls.length, 1);
  f.view.summaries()[0].status = "stopped";
  finish();
  await tick();
  assert.match(f.render(), /Worker stopped/);
  f.overlay.handleInput("\x1b");
  assert.match(f.render(), /\[History 1\]/);
  f.overlay.handleInput("\t");
  f.overlay.handleInput("\r");
  f.setStop(async () => { throw new Error("fixture stop refused"); });
  f.overlay.handleInput("\x03");
  await tick();
  assert.match(f.render(), /Stop failed: fixture stop refused/);
  let reject!: (error: Error) => void;
  f.setSteer(() => new Promise((_resolve, fail) => { reject = fail; }));
  f.overlay.handleInput("\t");
  f.overlay.handleInput("pending input");
  f.overlay.handleInput("\r");
  f.overlay.handleInput("\x1b");
  f.overlay.handleInput("\t");
  f.overlay.handleInput("\r");
  reject(new Error("late error from two"));
  await tick();
  assert.doesNotMatch(f.render(), /late error|pending input/);
  assert.equal(f.closed, 0);
  f.view.dispose();
  assert.equal(f.closed, 1);
  f.overlay.handleInput("\x03");
  assert.equal(f.calls.length, 3);
});

test("settlement during a pending control keeps feedback scoped to its detail and rejects later controls", async () => {
  const f = fixture();
  f.overlay.handleInput("\r");
  f.overlay.handleInput("\t");
  let reject!: (error: Error) => void;
  f.setSteer(() => new Promise((_resolve, fail) => { reject = fail; }));
  f.overlay.handleInput("late instruction");
  f.overlay.handleInput("\r");
  f.view.summaries()[0].status = "completed";
  f.changed("one");
  reject(new Error("Worker settled before steering was delivered"));
  await tick();
  assert.match(f.render(), /Steering failed: Worker settled/);
  assert.match(f.render(), /late instruction/);
  f.overlay.handleInput("\r");
  f.overlay.handleInput("\x03");
  assert.equal(f.calls.length, 1);
  assert.match(f.render(), /already completed/);
  f.overlay.handleInput("\x1b");
  f.overlay.handleInput("\t");
  f.overlay.handleInput("\r");
  let finish!: () => void;
  f.setStop(() => new Promise((resolve) => { finish = resolve; }));
  f.overlay.handleInput("\x03");
  f.overlay.handleInput("\x1b");
  f.overlay.handleInput("\t");
  f.overlay.handleInput("\r");
  finish();
  await tick();
  assert.doesNotMatch(f.render(), /Stopping|Files aren't undone|Worker stopped/);
  assert.deepEqual(f.calls, [{ action: "steer", id: "one", message: "late instruction" }, { action: "stop", id: "two" }]);
  f.overlay.dispose();
});

test("rendering fits narrow/wide terminals and resize; tool partial/error, redacted thinking, images and control bytes are honest", () => {
  const f = fixture();
  f.overlay.handleInput("\r");
  populate(f);
  f.view.summaries()[0].task = "A task with\nmultiple lines";
  f.view.summaries()[0].agent = "Unsafe\x1b[2J\x07\x1b]8;;https://untrusted.invalid\x07agent\x1b]8;;\x07";
  const header = f.overlay.render(100)[1];
  assert.match(header, /Unsafeagent/);
  assert(!header.includes("\x1b"));
  assert(!header.includes("\x07"));
  assert.match(f.render(), /fixture\/model/);
  assert.match(f.render(), /cwd: \/scratch/);
  assert.match(f.render(), /Ctrl\+C stop worker · Esc back/);
  f.append("one", { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "界😀é\x1b[2J\x07\npartial" }] } });
  for (const width of [1, 2, 10, 25, 80, 160]) for (const height of [2, 10, 30, 80]) {
    f.terminal.rows = height;
    const lines = f.overlay.render(width);
    assert(lines.length <= Math.max(1, Math.floor(height * 0.9)));
    for (const line of lines) { assert(visibleWidth(line) <= width, `overflow at ${width}: ${JSON.stringify(line)}`); assert(!line.includes("\n")); }
  }
  f.terminal.rows = 30;
  assert.match(f.render(), /partial/);
  assert(!f.render().includes("\x1b[2J"));
  const history = new ActivityHistory();
  history.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", redacted: true }] } });
  assert.match(activityText(history.entries[0], false, true).join("\n"), /redacted/);
  history.apply({ type: "tool_execution_start", toolName: "read", toolCallId: "nested", parentToolCallId: "call" });
  assert.match(activityText(history.entries[1], false, false)[0], /↳ read · pending \/ partial/);
  history.apply({ type: "tool_execution_end", toolName: "read", toolCallId: "nested", isError: true, result: { content: [{ type: "image", mimeType: "image/png", data: "not-rendered" }] } });
  assert.match(activityText(history.entries[1], true, false).join("\n"), /error[\s\S]*image\/png/);
  f.overlay.dispose();
});

for (const mode of ["regular", "fullscreen"] as const) test(`real TUI ${mode} overlay input never reaches the parent and preserves draft cursor`, async () => {
  const f = fixture([worker("old", "completed"), worker("one"), worker("two")], mode);
  const parent = new Input();
  parent.handleInput("parent draft");
  parent.handleInput("\x1b[D");
  let parentInput = 0;
  const editor: Component & { focused: boolean } = {
    focused: false, render: (width) => parent.render(width), invalidate: () => {},
    handleInput(data) { parentInput++; parent.handleInput(data); },
  };
  f.tui.addChild(editor);
  f.tui.setFocus(editor);
  f.tui.start();
  f.tui.showOverlay(f.overlay, { width: "90%", maxHeight: "90%" });
  try {
    await tick();
    f.terminal.input("\t");
    assert.match(f.render(), /→ Explore · completed · old/);
    f.terminal.input("\r");
    assert.match(f.render(), /completed · attempt 1 · old/);
    f.terminal.input("\x1b");
    f.terminal.input("\x1b[Z");
    assert.match(f.render(), /→ Explore · running · one/);
    f.terminal.input("\r");
    f.terminal.input("\t");
    f.terminal.input("worker text");
    f.terminal.input("\x04"); // Input-owned delete, never parent exit.
    f.terminal.input("\x03");
    await tick();
    assert.deepEqual(f.calls, [{ action: "stop", id: "one" }]);
    f.terminal.input("\x1b");
    assert.equal(parentInput, 0);
    assert.equal(parent.getValue(), "parent draft");
    f.tui.hideOverlay();
    f.terminal.input("X");
    assert.equal(parent.getValue(), "parent drafXt");
    assert.equal(parentInput, 1);
  } finally { f.overlay.dispose(); f.tui.stop(); }
});

test("command and shortcut share one TUI-only interaction; shutdown/reload disposes it without editor or model calls", async () => {
  const f = fixture();
  f.overlay.dispose();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const shortcuts = new Map<string, { handler: (ctx: ExtensionContext) => Promise<void> }>();
  const events = new Map<string, () => void>();
  const api = { registerCommand: (name: string, spec: never) => commands.set(name, spec),
    registerShortcut: (name: string, spec: never) => shortcuts.set(name, spec), on: (name: string, callback: () => void) => events.set(name, callback),
  } as unknown as ExtensionAPI;
  registerSubagentsUI(api, () => f.registry);
  let dialogs = 0;
  let component: SubagentsOverlay | undefined;
  const notices: string[] = [];
  const ctx = { mode: "rpc", ui: { notify: (message: string) => notices.push(message),
    custom: (factory: (tui: TUI, theme: Theme, keys: HostKeys, done: () => void) => SubagentsOverlay) => {
      dialogs++;
      return new Promise<void>((resolve) => { component = factory(f.tui, theme, keys, resolve); });
    },
  } } as unknown as ExtensionContext;
  for (const mode of ["rpc", "json", "print"] as const) {
    ctx.mode = mode;
    await commands.get("subagents")!.handler("", ctx);
    assert.equal(dialogs, 0);
  }
  assert.equal(notices.length, 3);
  ctx.mode = "tui";
  const first = shortcuts.get("ctrl+alt+s")!.handler(ctx);
  const duplicate = commands.get("subagents")!.handler("", ctx);
  await duplicate;
  assert.equal(dialogs, 1);
  events.get("session_shutdown")!();
  await first;
  assert.equal(f.view.disposed, true);
  assert.deepEqual(f.calls, []);
  assert(component);
  component.handleInput("\x03");
  assert.deepEqual(f.calls, []);
});


test("real pi RPC handles /subagents without a custom UI or model call", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-overlay-rpc-"));
  const records: Record<string, any>[] = [];
  const rpc = new RpcProcess(hostInvocation(), directory,
    ["--no-session", "--extension", fileURLToPath(new URL("../..", import.meta.url))],
    { ...process.env, PI_RPC_SUBAGENT_CHILD: "", PI_CODING_AGENT_DIR: directory, PI_OFFLINE: "1" }, (row) => records.push(row));
  try {
    await rpc.send({ type: "get_state" });
    const commands = (await rpc.send({ type: "get_commands" })).data.commands;
    assert(commands.some((command: { name: string }) => command.name === "subagents"));
    const response = await rpc.send({ type: "prompt", message: "/subagents" });
    assert.equal(response.data.disposition, "handled");
    assert(records.some((row) => row.type === "extension_ui_request" && row.method === "notify" && row.message.includes("requires interactive TUI")));
    assert(!records.some((row) => row.type === "agent_start" || row.type === "extension_error"));
    assert.deepEqual((await rpc.send({ type: "get_messages" })).data.messages, []);
  } finally { await rpc.close(); rmSync(directory, { recursive: true, force: true }); }
});

async function until(predicate: () => boolean) {
  // Real pi startup competes with Go/frontend checks in mise run check.
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    assert(Date.now() < deadline, "Fixture didn't reach the expected state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("real pi ticking bash output is visible in list and unexpanded detail before settlement, including reload", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-overlay-ticking-"));
  const agentDir = join(directory, "agent");
  const extensions = join(directory, ".pi", "extensions");
  mkdirSync(agentDir);
  mkdirSync(extensions, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off" }));
  const command = "set -euo pipefail; for i in {1..30}; do printf 'older line %s\\n' \"$i\"; done; " +
    "for i in {1..3}; do printf 'alpha: tick %s/3\\n' \"$i\"; while [[ ! -f release-$i ]]; do sleep 0.01; done; done";
  writeFileSync(join(extensions, "provider.ts"), `
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
export default function(pi) {
 pi.registerProvider('fixture',{api:'fixture-api',baseUrl:'https://fixture.invalid',apiKey:'fixture',
  models:[{id:'ticking',name:'ticking',reasoning:true,input:['text'],contextWindow:200000,maxTokens:64000,
   cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
  streamSimple(model,context) {
   const called=context.messages.some(m=>m.role==='toolResult');
   const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),
    usage:{input:1,output:2,cacheRead:0,cacheWrite:0,totalTokens:3,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
    content:called?[{type:'text',text:'alpha finished'}]:[
     {type:'text',text:Array.from({length:45},(_,i)=>'Earlier assistant line '+i).join('\\n')},
     {type:'thinking',thinking:'hidden ticking thought'},
     {type:'toolCall',id:'ticker',name:'bash',arguments:{command:${JSON.stringify(command)}}}],
    stopReason:called?'stop':'toolUse'};
   const stream=createAssistantMessageEventStream();
   queueMicrotask(()=>{stream.push({type:'done',reason:message.stopReason,message});stream.end();});
   return stream;
  }});
}`);
  const invocation = hostInvocation();
  const registry = Registry.open(agentDir, "ticking-parent", invocation).registry;
  const child = new Worker({ cwd: directory, directory: registry.newDirectory(), task: "ticking request",
    agent: { name: "general-purpose", prompt: "" }, model: "fixture/ticking", thinking: "high", invocation,
    approveProject: true, env: { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } });
  registry.add(child);
  const terminal = new TestTerminal();
  const tui = new TuiMainScreen(terminal);
  let closes = 0;
  let overlay = new SubagentsOverlay(tui, theme, keys, registry, () => { closes++; });
  const render = () => overlay.render(100).join("\n");
  const frames: Record<string, string> = {};
  tui.start();
  tui.showOverlay(overlay, { width: "90%", maxHeight: "90%" });
  try {
    await until(() => render().includes("alpha: tick 1/3"));
    frames.listTick1 = render();
    assert.equal(child.summary().status, "running");
    assert.match(frames.listTick1, /bash · pending \/ partial: alpha: tick 1\/3/);
    writeFileSync(join(directory, "release-1"), "release");
    await until(() => render().includes("alpha: tick 2/3"));
    frames.listTick2 = render();
    assert.equal(child.summary().status, "running");
    assert.notEqual(frames.listTick1, frames.listTick2);
    terminal.input("\r");
    frames.detailTick2 = render();
    assert.match(frames.detailTick2, /alpha: tick 2\/3/);
    assert.match(frames.detailTick2, /output tail/);
    assert.doesNotMatch(frames.detailTick2, /older line 1\b|hidden ticking thought/);
    assert(!frames.detailTick2.includes(CURSOR_MARKER));
    terminal.input("\x1b[H");
    const scrolled = render();
    assert.match(scrolled, /Attempt 1 · general-purpose: ticking request/);
    writeFileSync(join(directory, "release-2"), "release");
    await until(() => readFileSync(child.snapshot().transcript, "utf8").includes("alpha: tick 3/3"));
    frames.scrolledTick3 = render();
    assert.equal(frames.scrolledTick3, scrolled);
    terminal.input("\x1b[F");
    frames.detailTick3 = render();
    assert.match(frames.detailTick3, /alpha: tick 3\/3/);
    assert.equal(child.summary().status, "running");
    // Reload closes both detail and list subscriptions, not the running child.
    registry.detach();
    assert.equal(closes, 1);
    assert.equal(render(), "");
    tui.hideOverlay();
    overlay = new SubagentsOverlay(tui, theme, keys, registry, () => {});
    tui.showOverlay(overlay, { width: "90%", maxHeight: "90%" });
    await until(() => render().includes("alpha: tick 3/3"));
    frames.reloadedList = render();
    writeFileSync(join(directory, "release-3"), "release");
    await child.done;
    assert.equal(child.summary().status, "completed", child.snapshot().error);
    assert.match(render(), /\[Active 0\] · History 1/);
    terminal.input("\t");
    await until(() => render().includes("assistant: alpha finished"));
    frames.terminalList = render();
    terminal.input("\r");
    frames.terminalDetail = render();
    assert.match(frames.terminalDetail, /alpha: tick 3\/3[\s\S]*alpha finished/);
    assert.doesNotMatch(frames.terminalDetail, /hidden ticking thought/);
    terminal.input("\x0f");
    terminal.input("\x1b[H");
    for (let i = 0; i < 100 && !/older line 1\b/.test(render()); i++) terminal.input("\x1b[B");
    assert.match(render(), /older line 1\b/);
    assert.equal(child.reportedUsage.totalTokens, 0);
    assert.equal(child.notifiedAttempt, 0);
    const rows = readFileSync(child.snapshot().transcript, "utf8").trim().split("\n").map((row) => JSON.parse(row));
    assert(rows.filter((row) => row.type === "tool_execution_update" && row.toolName === "bash").length >= 3);
    writeFileSync(join(directory, "ticking-renders.json"), JSON.stringify(frames, null, 2));
    t.diagnostic(`Ticking renders and real bash RPC transcript retained at ${directory}`);
  } finally { overlay.dispose(); tui.stop(); await registry.close("Parent session quit"); }
});

test("focus typing/submission reaches a real pi worker transcript after its current tool", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-overlay-focus-"));
  const agentDir = join(directory, "agent");
  const extensions = join(directory, ".pi", "extensions");
  mkdirSync(agentDir);
  mkdirSync(extensions, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off" }));
  writeFileSync(join(extensions, "provider.ts"), `
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {existsSync,writeFileSync} from 'node:fs';
import {Type} from 'typebox';
export default function(pi) {
 pi.registerTool({name:'focus_wait',label:'wait',description:'Wait for the test to release this tool',
  parameters:Type.Object({}),async execute(_id,_args,signal) {
   writeFileSync('tool-started','ready');
   while(!existsSync('release-tool')) {
    signal?.throwIfAborted(); await new Promise(resolve=>setTimeout(resolve,5));
   }
   return {content:[{type:'text',text:'tool released'}],details:undefined};
  }});
 pi.registerProvider('fixture',{api:'fixture-api',baseUrl:'https://fixture.invalid',apiKey:'fixture',
  models:[{id:'focus',name:'focus',reasoning:true,input:['text'],contextWindow:200000,maxTokens:64000,
   cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
  streamSimple(model,context) {
   const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),
    usage:{input:1,output:2,cacheRead:0,cacheWrite:0,totalTokens:3,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
   const last=context.messages.filter(m=>m.role==='user').at(-1)?.content;
   const text=typeof last==='string'?last:last?.filter(p=>p.type==='text').map(p=>p.text).join('');
   const called=context.messages.some(m=>m.role==='toolResult');
   message.content=called?[{type:'text',text:'Received: '+text}]:
    [{type:'toolCall',id:'focus-gate',name:'focus_wait',arguments:{}}];
   message.stopReason=called?'stop':'toolUse';
   const stream=createAssistantMessageEventStream();
   queueMicrotask(()=>{stream.push({type:'done',reason:message.stopReason,message});stream.end();});
   return stream;
  }});
}`);
  const invocation = hostInvocation();
  const registry = Registry.open(agentDir, "focus-parent", invocation).registry;
  const worker = new Worker({ cwd: directory, directory: registry.newDirectory(), task: "initial request",
    agent: { name: "Explore", prompt: "" }, model: "fixture/focus", thinking: "high", invocation,
    approveProject: true, env: { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } });
  registry.add(worker);
  const terminal = new TestTerminal();
  const tui = new TuiMainScreen(terminal);
  const overlay = new SubagentsOverlay(tui, theme, keys, registry, () => {});
  const render = () => overlay.render(100).join("\n");
  const transcript = () => readFileSync(worker.snapshot().transcript, "utf8").trim().split("\n").map((row) => JSON.parse(row));
  tui.start();
  tui.showOverlay(overlay, { width: "90%", maxHeight: "90%" });
  try {
    terminal.input("\r");
    await until(() => render().includes("focus_wait · pending"));
    const outputRender = render();
    assert.match(outputRender, /\[Output focus\]/);
    assert(!outputRender.includes("\x1b[7m"));
    terminal.input("not an instruction");
    terminal.input("\r");
    assert(!transcript().some((row) => JSON.stringify(row).includes("not an instruction")));
    terminal.input("\t");
    terminal.input("change direction");
    terminal.input("\t");
    const draftRender = render();
    assert.match(draftRender, /Steer \(Tab to edit\): change direction/);
    assert(!draftRender.includes("\x1b[7m"));
    terminal.input("\x1b[Z");
    const steeringRender = render();
    assert(steeringRender.includes(CURSOR_MARKER));
    terminal.input("\r");
    await until(() => render().includes("Queued -- not delivery"));
    assert.equal(worker.summary().status, "running");
    assert(!transcript().some((row) => row.type === "message_end" && row.message?.role === "user" &&
      JSON.stringify(row.message.content).includes("change direction")), "Queued steering must wait for the current tool");
    writeFileSync(join(directory, "release-tool"), "release");
    await worker.done;
    await until(() => render().includes("Received: change direction"));
    assert.equal(worker.summary().status, "completed", worker.snapshot().error);
    const rows = transcript();
    const toolEnd = rows.findIndex((row) => row.type === "tool_execution_end" && row.toolName === "focus_wait");
    const delivered = rows.findIndex((row) => row.type === "message_end" && row.message?.role === "user" &&
      JSON.stringify(row.message.content).includes("change direction"));
    assert(toolEnd >= 0 && delivered > toolEnd);
    assert.equal(rows.filter((row) => row.type === "message_end" && row.message?.role === "user").length, 2);
    assert.equal(worker.reportedUsage.totalTokens, 0);
    assert.equal(worker.notifiedAttempt, 0);
    writeFileSync(join(directory, "focus-renders.json"), JSON.stringify({ outputRender, draftRender, steeringRender, deliveredRender: render() }, null, 2));
    t.diagnostic(`Focus renders and worker transcript retained at ${directory}`);
  } finally { overlay.dispose(); tui.stop(); await registry.close("Parent session quit"); }
});

test("overlay controls real RPC peers without consuming ledgers; detach/reopen retains history and sibling ownership", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-overlay-runtime-"));
  const script = join(directory, "peer.cjs");
  writeFileSync(script, `const readline=require('node:readline');
const emit=row=>process.stdout.write(JSON.stringify(row)+'\\n');
const response=(c,data)=>emit({type:'response',id:c.id,success:true,data});
const usage={input:1,output:2,cacheRead:0,cacheWrite:0,totalTokens:3,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line);
 if(c.type==='get_state') response(c,{model:{provider:'fixture',id:'model'},thinkingLevel:'high'});
 else if(c.type==='prompt'&&c.message==='/pi-rpc-worker-inspect') {
  emit({type:'extension_ui_request',method:'notify',message:'pi-rpc-worker:'+JSON.stringify({cwd:process.cwd(),callable:[]})});response(c,{disposition:'handled'});
 } else if(c.type==='prompt') {
  response(c,{disposition:'started'});
  emit({type:'message_end',message:{role:'user',content:c.message}});
  emit({type:'message_start',message:{role:'assistant',content:[],stopReason:'pending'}});
  emit({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'partial output'}});
 } else if(c.type==='steer') {
  response(c,{disposition:'queued'});
  emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'finished: '+c.message}],stopReason:'stop',usage}});
  emit({type:'agent_settled'});
 } else if(c.type==='abort') { response(c,{}); emit({type:'agent_settled'}); }
 else response(c,{});
});`);
  const invocation = { command: process.execPath, args: [script] };
  const registry = Registry.open(directory, "parent", invocation).registry;
  let runtimeChanges = 0;
  registry.changed = () => { runtimeChanges++; };
  const workers = ["first", "sibling"].map((task) => {
    const worker = new Worker({ cwd: directory, directory: registry.newDirectory(), task,
      agent: { name: "Explore", prompt: "" }, model: "fixture/model", thinking: "high", invocation,
      env: { PI_CODING_AGENT_DIR: directory, PI_OFFLINE: "1" } });
    registry.add(worker);
    return worker;
  });
  const terminal = new TestTerminal();
  const tui = new TuiMainScreen(terminal);
  let closed = 0;
  const overlay = new SubagentsOverlay(tui, theme, keys, registry, () => { closed++; });
  let reopened: SubagentsOverlay | undefined;
  let recoveredRegistry: Registry | undefined;
  try {
    overlay.handleInput("\r");
    await until(() => workers.every((worker) => worker.summary().status === "running") && overlay.render(100).join("\n").includes("partial output"));
    const siblingPid = workers[1].snapshot().pid!;
    overlay.handleInput("\x03");
    assert.match(overlay.render(100).join("\n"), /stopping|Stopping/);
    await workers[0].done;
    assert.equal(workers[0].summary().status, "stopped");
    assert.equal(workers[1].summary().status, "running");
    process.kill(siblingPid, 0);
    overlay.handleInput("\x1b");
    assert.match(overlay.render(100).join("\n"), /\[History 1\]/);
    overlay.handleInput("\t");
    overlay.handleInput("\r");
    await until(() => overlay.render(100).join("\n").includes("partial output"));
    registry.detach();
    assert.equal(closed, 1);
    assert.equal(workers[1].snapshot().pid, siblingPid);
    assert.equal(Registry.open(directory, "parent", invocation).registry, registry);
    registry.changed = () => { runtimeChanges++; };
    reopened = new SubagentsOverlay(tui, theme, keys, registry, () => {});
    assert.match(reopened.render(100).join("\n"), /\[Active 1\] · History 1/);
    assert.doesNotMatch(reopened.render(100).join("\n"), /stopped/);
    reopened.handleInput("\t");
    assert.match(reopened.render(100).join("\n"), /stopped/);
    reopened.handleInput("\r");
    await until(() => reopened!.render(100).join("\n").includes("partial output"));
    reopened.handleInput("\x1b");
    reopened.handleInput("\t");
    reopened.handleInput("\r");
    await until(() => reopened!.render(100).join("\n").includes("partial output"));
    reopened.handleInput("\t");
    reopened.handleInput("new instruction");
    reopened.handleInput("\r");
    await workers[1].done;
    await tick();
    assert.match(reopened.render(100).join("\n"), /finished: new instruction/);
    assert.equal(workers[1].snapshot().usage.totalTokens, 3);
    assert.equal(workers[1].reportedUsage.totalTokens, 0);
    assert.equal(workers[1].notifiedAttempt, 0);
    assert.equal(runtimeChanges, 4);
    const settled = workers[1].snapshot();
    const terminalView = registry.observe(() => {});
    await assert.rejects(terminalView.steer(workers[1].id, "too late"), /steering requires a running worker/);
    await Promise.all([terminalView.stop(workers[1].id), terminalView.stop(workers[1].id)]);
    assert.deepEqual(workers[1].snapshot(), settled);
    assert.equal(runtimeChanges, 4);
    assert.equal(workers[1].reportedUsage.totalTokens, 0);
    assert.equal(workers[1].notifiedAttempt, 0);
    terminalView.dispose();
    reopened.close();
    assert.equal(workers[1].takeUsage()?.totalTokens, 3);
    assert.equal(workers[1].takeUsage(), undefined);
    await registry.close("Parent session quit");
    recoveredRegistry = Registry.open(directory, "parent", invocation).registry;
    const retained = [...recoveredRegistry.workers.values()];
    assert.equal(retained.length, 2);
    const files = retained.flatMap((worker) => [worker.snapshot().transcript, join(worker.directory, "state.json")]);
    const beforeViewing = files.map((path) => readFileSync(path, "utf8"));
    reopened = new SubagentsOverlay(tui, theme, keys, recoveredRegistry, () => {});
    assert.match(reopened.render(100).join("\n"), /\[Active 0\] · History 2/);
    reopened.handleInput("\t");
    for (const worker of retained) {
      reopened.handleInput("\r");
      await until(() => reopened!.render(100).join("\n").includes(worker.summary().status === "stopped" ? "partial output" : "finished: new instruction"));
      assert.match(reopened.render(100).join("\n"), new RegExp(worker.id));
      reopened.handleInput("\x1b");
      reopened.handleInput("\x1b[B");
    }
    reopened.close();
    assert.deepEqual(files.map((path) => readFileSync(path, "utf8")), beforeViewing);
    assert.equal(runtimeChanges, 4);
  } finally {
    overlay.dispose();
    reopened?.dispose();
    await recoveredRegistry?.close("Parent session quit");
    await registry.close("Parent session quit");
    rmSync(directory, { recursive: true, force: true });
  }
});
