import assert from "node:assert/strict";
import { test } from "node:test";
import subagents, { resultText } from "../../extensions/subagents/index.ts";
import { childConfigKey } from "../../extensions/subagents/guard.ts";

// This Node test process only captures declarations; it never starts an agent.
test("model descriptions agree on automatic completion and the collection renderer hides raw reports", () => {
  const tools: any[] = [];
  const prior = process.env[childConfigKey];
  process.env[childConfigKey] = "";
  try {
    subagents({ registerTool: (tool: any) => tools.push(tool), on: () => {}, registerCommand: () => {}, registerShortcut: () => {} } as any);
  } finally {
    if (prior === undefined) delete process.env[childConfigKey]; else process.env[childConfigKey] = prior;
  }
  const launch = tools.find(tool => tool.name === "subagent");
  const wait = tools.find(tool => tool.name === "wait_for_subagents");
  const inspect = tools.find(tool => tool.name === "get_subagent_result");
  assert.match(launch.description, /completion is automatic/);
  assert.match(launch.description, /Don't poll/);
  assert.match(inspect.description, /explicit inspection/);
  assert.equal(wait.exposure, "model-only");
  const rendered = wait.renderResult({ details: { reports: [{ text: "raw report must stay hidden" }], waiting: false, paused: false } }, {},
    { fg: (_color: string, text: string) => text }).render(100).join("\n");
  assert.match(rendered, /1 worker report collected/);
  assert(!rendered.includes("raw report"));
  const report = { id: "worker", attempt: 2, status: "completed", text: "useful report", truncated: false,
    transcript: "/private/transcript", sessionFile: "/private/session", resultPath: "/private/result" } as any;
  assert(!resultText(report).includes("/private"));
  assert(resultText(report, true).includes("/private/transcript"));
  assert(resultText({ ...report, truncated: true }).includes("/private/transcript"));
  assert(resultText({ ...report, error: "failed" }).includes("/private/transcript"));
});
