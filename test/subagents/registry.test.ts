import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Registry } from "../../extensions/subagents/registry.ts";

test("custom parent IDs stay separate by session file, and path aliases keep the same live registry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-rpc-registry-test-"));
  const agentDir = join(directory, "agent");
  const invocation = { command: "unused", args: [] };
  const firstFile = join(directory, "sessions", "first.jsonl");
  const secondFile = join(directory, "other-sessions", "second.jsonl");
  const first = Registry.open(agentDir, "custom-id", invocation, firstFile);
  const second = Registry.open(agentDir, "custom-id", invocation, secondFile);
  try {
    assert.notEqual(first.registry.directory, second.registry.directory);
    mkdirSync(join(directory, "sessions"));
    writeFileSync(firstFile, "");
    symlinkSync(join(directory, "sessions"), join(directory, "alias"), "dir");
    const resumed = Registry.open(agentDir, "custom-id", invocation, join(directory, "alias", "first.jsonl"));
    assert.equal(resumed.live, true);
    assert.equal(resumed.registry, first.registry);
  } finally {
    await first.registry.close("Parent session quit");
    await first.registry.close("Parent session quit");
    await second.registry.close("Parent session quit");
    rmSync(directory, { recursive: true, force: true });
  }
});
