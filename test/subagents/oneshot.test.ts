import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { eventually, provider } from "./delivery-fixture.ts";
import { hostInvocation } from "./fixture-invocation.ts";

type Mode = "print" | "json";
function launch(mode: Mode, options: { explicit: boolean; nested: boolean; count: number; timeoutMs?: number }) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-oneshot-test-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir);
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off", defaultTools: ["+codemode"], retry: { enabled: false } }));
  writeFileSync(join(cwd, ".pi", "extensions", "provider.ts"), provider);
  writeFileSync(join(cwd, ".pi", "extensions", "final-marker.ts"), `import {writeFileSync} from 'node:fs';
export default function(pi) {
 if(process.env.PI_RPC_SUBAGENT_CHILD) return;
 pi.on('message_end', event => {
  if(event.message.role==='assistant' && event.message.stopReason==='stop') writeFileSync('parent-final-sent','sent');
 });
}`);
  const workers = Array.from({ length: options.count }, (_, index) => ({
    cwd, task: JSON.stringify({ worker: "one-shot-" + index, gate: "worker-" + index }),
    background: true, approveProject: true, runTimeoutMs: options.timeoutMs ?? 10_000,
  }));
  const calls = options.nested ? [{ name: "codemode", args: {
    code: `text(await Promise.all(${JSON.stringify(workers)}.map(args => tools.subagent(args))));`,
  } }] : workers.map(args => ({ name: "subagent", args }));
  const invocation = hostInvocation();
  const child = spawn(invocation.command, [...invocation.args,
    ...(mode === "json" ? ["--mode", "json"] : ["--print"]),
    "--approve", "--model", "delivery-fixture/model", "--thinking", "off",
    "--extension", fileURLToPath(new URL("../..", import.meta.url)), "--session-dir", join(cwd, "sessions"),
    JSON.stringify({ calls, waitAfterLaunch: options.explicit }),
  ], { cwd, env: { ...process.env, PI_RPC_SUBAGENT_CHILD: "", PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", closed = false;
  child.stdout.on("data", data => { stdout += data; appendFileSync(join(cwd, "stdout.log"), data); });
  child.stderr.on("data", data => { stderr += data; appendFileSync(join(cwd, "stderr.log"), data); });
  const term = setTimeout(() => child.kill("SIGTERM"), 20_000);
  const kill = setTimeout(() => child.kill("SIGKILL"), 25_000);
  const done = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => { closed = true; clearTimeout(term); clearTimeout(kill); resolve(code); });
  });
  done.catch(() => {});
  const results = () => readdirSync(agentDir, { recursive: true, encoding: "utf8" }).filter(name => name.endsWith("/result.json"))
    .map(name => JSON.parse(readFileSync(join(agentDir, name), "utf8")));
  return { cwd, child, done, results, get closed() { return closed; }, get stdout() { return stdout; }, get stderr() { return stderr; },
    release: (index: number) => writeFileSync(join(cwd, "worker-" + index), "released"),
    async ready() {
      await eventually(() => {
        assert(!closed, `One-shot exited before workers started: ${cwd}\n${stderr}\n${stdout.slice(-2000)}`);
        return workers.every((_worker, index) => existsSync(join(cwd, "worker-" + index + ".started")));
      }, `one-shot worker gates: ${cwd}`);
    },
    async close() { if (!closed) child.kill("SIGTERM"); await done; },
  };
}

for (const mode of ["print", "json"] as const) {
  for (const explicit of [false, true]) {
    for (const nested of [false, true]) {
      test(`${mode} keeps background workers alive through ${explicit ? "explicit wait" : "final settlement"} and ${nested ? "codemode" : "direct"} launch`, { timeout: 35_000 }, async () => {
        const run = launch(mode, { explicit, nested, count: 3 });
        try {
          await run.ready();
          run.release(0);
          await eventually(() => run.results().some(result => result.status === "completed"), `first worker completion: ${run.cwd}`);
          assert.equal(run.closed, false, "A partial batch must not end the one-shot parent");
          run.release(1); run.release(2);
          assert.equal(await run.done, 0, run.stderr);
          const results = run.results();
          assert.equal(results.length, 3);
          assert(results.every(result => result.status === "completed"), JSON.stringify(results));
          if (mode === "print") assert.match(run.stdout, /Final handoff/);
          else {
            const rows = run.stdout.trim().split("\n").map(line => JSON.parse(line));
            const collected = rows.filter(row => row.type === "tool_execution_end" && row.toolName === "wait_for_subagents")
              .flatMap(row => row.result.details.reports);
            assert.equal(collected.length, 3);
            assert.equal(new Set(collected.map(report => report.id + "/" + report.attempt)).size, 3);
            assert(collected.every(report => report.status === "completed"));
            const messages = rows.filter(row => row.type === "message_end").map(row => row.message);
            assert.equal(messages.filter(message => message.role === "toolResult")
              .reduce((sum, message) => sum + (message.usage?.totalTokens ?? 0), 0), 30);
            assert(messages.at(-1).content.some((part: any) => part.text === "Final handoff"));
          }
        } finally { await run.close(); }
      });
    }
  }
  for (const explicit of [false, true]) {
    test(`${mode} cancellation during ${explicit ? "explicit waiting" : "final settlement"} shuts down its worker`, { timeout: 35_000 }, async () => {
      const run = launch(mode, { explicit, nested: false, count: 1 });
      try {
        await run.ready();
        if (!explicit) await eventually(() => existsSync(join(run.cwd, "parent-final-sent")), `parent final response: ${run.cwd}`);
        run.child.kill("SIGTERM");
        assert.notEqual(await run.done, 0);
        const results = run.results();
        assert.equal(results.length, 1);
        assert.equal(results[0].status, "interrupted");
        assert.throws(() => process.kill(results[0].pid, 0), { code: "ESRCH" });
      } finally { await run.close(); }
    });
  }
  test(`${mode} delivers a worker deadline failure before final settlement`, { timeout: 35_000 }, async () => {
    const run = launch(mode, { explicit: true, nested: false, count: 1, timeoutMs: 1500 });
    try {
      assert.equal(await run.done, 0, run.stderr);
      const results = run.results();
      assert.equal(results.length, 1);
      assert.equal(results[0].status, "failed");
      assert.match(results[0].error, /didn't settle within 1500ms/);
      if (mode === "print") assert.match(run.stdout, /Final handoff/);
      else {
        const rows = run.stdout.trim().split("\n").map(line => JSON.parse(line));
        const reports = rows.filter(row => row.type === "tool_execution_end" && row.toolName === "wait_for_subagents")
          .flatMap(row => row.result.details.reports);
        assert.equal(reports.length, 1);
        assert.equal(reports[0].status, "failed");
      }
    } finally { await run.close(); }
  });
}
