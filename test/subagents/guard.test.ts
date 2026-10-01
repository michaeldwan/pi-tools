import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import guard, { childConfigKey } from "../../extensions/subagents/guard.ts";

test("worker restrictions cover recursive and nested MCP calls without disabling MCP", async () => {
  const prior = process.env[childConfigKey];
  process.env[childConfigKey] = JSON.stringify({ tools: ["read", "codemode", "mcp__fixture__show"], readOnly: true });
  const handlers: Record<string, (...args: any[]) => any> = {};
  let active = ["read", "bash", "codemode", "subagent"];
  const api = {
    on: (name: string, handler: (...args: any[]) => any) => { handlers[name] = handler; },
    registerCommand: () => {},
    getActiveTools: () => active,
    setActiveTools: (tools: string[]) => { active = tools; },
    getAllTools: () => [
      { name: "mcp__fixture__show", annotations: { readOnlyHint: true } },
      { name: "mcp__fixture__update", annotations: { readOnlyHint: false } },
    ],
  } as unknown as ExtensionAPI;
  try { guard(api); }
  finally {
    if (prior === undefined) delete process.env[childConfigKey];
    else process.env[childConfigKey] = prior;
  }
  handlers.session_start();
  assert.deepEqual(active, ["read", "codemode"]);
  assert.equal(handlers.tool_call({ toolName: "codemode" }), undefined);
  assert.equal(handlers.tool_call({ toolName: "mcp__fixture__show", parentToolCallId: "codemode/1" }), undefined);
  for (const name of ["subagent", "get_subagent_result", "steer_subagent", "stop_subagent", "bash", "mcp__fixture__update"]) {
    assert.equal(handlers.tool_call({ toolName: name, parentToolCallId: "codemode/1" })?.block, true);
  }
  // A project extension can't restore recursive delegation by activating it.
  active.push("subagent");
  handlers.before_agent_start();
  assert.deepEqual(active, ["read", "codemode"]);
});
