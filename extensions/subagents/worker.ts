import { appendFileSync, mkdtempSync, realpathSync, writeFileSync, renameSync, readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { childConfigKey, delegationTools } from "./guard.ts";
import { RpcProcess, assertSessionAvailable, type Invocation, type RecordValue } from "./rpc.ts";
import type { AgentDefinition, Thinking } from "./agents.ts";
import { WorkerActivity, notify, type ActivitySignal, type ActivityChange } from "./activity.ts";

export interface WorkerOptions {
  task: string;
  cwd: string;
  agent: AgentDefinition;
  model: string;
  thinking: Thinking;
  tools?: string[];
  requiredTools?: string[];
  approveProject?: boolean;
  startupTimeoutMs?: number;
  runTimeoutMs?: number;
  invocation: Invocation;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  directory?: string;
  leasePath?: string;
}

export async function preflight(rpc: RpcProcess, cwd: string, required: string[], timeoutMs: number,
  signal?: AbortSignal): Promise<RecordValue> {
  const deadline = Date.now() + timeoutMs;
  let snapshot: RecordValue | undefined;
  do {
    signal?.throwIfAborted();
    try {
      snapshot = await rpc.inspect(Math.max(1, deadline - Date.now()));
    } catch (error) {
      // The RPC timeout ends the final poll. Keep the confirmed missing-tools
      // diagnostic even if the wall clock moved before its timer fired.
      if (snapshot && error instanceof Error && error.message.startsWith("Pi RPC prompt timed out")) break;
      throw error;
    }
    if (realpathSync(snapshot.cwd) !== realpathSync(cwd)) throw new Error(`Pi worker cwd mismatch: ${snapshot.cwd}, expected ${cwd}`);
    const missing = required.filter((tool) => !snapshot!.callable.includes(tool));
    if (!missing.length) return snapshot;
    if (Date.now() >= deadline) break;
    await delay(Math.min(100, deadline - Date.now()), undefined, { signal });
  } while (Date.now() < deadline);
  const missing = required.filter((tool) => !snapshot?.callable.includes(tool));
  throw new Error(`Pi worker required tools unavailable after ${timeoutMs}ms: ${missing.join(", ")}. Check project trust, MCP connections and tool restrictions. No task prompt was sent.`);
}

export function workerLeasePath(id: string, directory = tmpdir()) {
  if (process.platform === "win32") return `\\\\.\\pipe\\pi-rpc-${id}`;
  const name = `pi-rpc-${id}.sock`;
  const path = join(directory, name);
  // TMPDIR can be longer than a Unix socket pathname permits. Keep the
  // default short without changing a lease already saved for a worker.
  return Buffer.byteLength(path) <= 100 ? path : join("/tmp", name);
}

export const resultLimit = 16_384;
const bounded = (text: string) => text.slice(0, resultLimit);
const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
export type WorkerStatus = "starting" | "running" | "completed" | "failed" | "stopped" | "interrupted";
export type WorkerResult = {
  id: string;
  attempt: number;
  status: WorkerStatus;
  cwd: string;
  model: string;
  thinking: Thinking;
  pid?: number;
  sessionFile?: string;
  transcript: string;
  preflight: string;
  resultPath: string;
  text: string;
  truncated: boolean;
  error?: string;
  stopReason?: string;
  usage: ReturnType<typeof emptyUsage>;
  usageOnly?: boolean;
  stats?: RecordValue;
}

export type WorkerSummary = Pick<WorkerResult, "id" | "attempt" | "status" | "cwd" | "model" | "thinking" |
  "pid" | "sessionFile" | "transcript" | "error" | "stopReason"> & { task: string; agent: string; stopping: boolean };

export class Worker {
  readonly id: string;
  readonly directory: string;
  done: Promise<void>;
  background = false;
  reports: { result: WorkerResult; background: boolean }[] = [];
  notifiedAttempt = 0;
  reportedUsage = emptyUsage();
  private result: WorkerResult;
  private rpc?: RpcProcess;
  private stopped?: string;
  private stopping?: Promise<void>;
  private controller = new AbortController();
  private assistant?: RecordValue;
  private textLength = 0;
  private observers = new Set<(event: ActivitySignal) => void>();

  private options: WorkerOptions;
  private confirmedSelection?: Pick<WorkerOptions, "model" | "thinking">;
  private changed: (worker: Worker) => void;

  constructor(options: WorkerOptions, changed: (worker: Worker) => void = () => {}, saved?: WorkerResult) {
    this.options = { ...options, cwd: saved ? options.cwd : realpathSync(options.cwd) };
    this.changed = changed;
    if (!isAbsolute(options.cwd)) throw new Error("subagent cwd must be an explicit absolute directory");
    if (!saved) realpathSync(options.cwd);
    this.id = saved?.id ?? randomUUID();
    this.options.leasePath ??= workerLeasePath(this.id);
    this.directory = options.directory ?? mkdtempSync(join(tmpdir(), "pi-rpc-worker-"));
    this.result = saved ?? { id: this.id, attempt: 1, status: "starting", cwd: options.cwd, model: options.model,
      thinking: options.thinking, transcript: join(this.directory, "rpc.jsonl"),
      preflight: join(this.directory, "preflight.json"), resultPath: join(this.directory, "result.json"),
      text: "", truncated: false, usage: emptyUsage() };
    if (!saved) writeFileSync(this.result.transcript, "", { mode: 0o600 });
    if (!saved) {
      this.save();
      this.recordAttempt();
    }
    // Let the caller register the identity before startup or completion callbacks.
    this.done = saved ? Promise.resolve() : Promise.resolve().then(() => this.execute());
  }

  get terminal() { return !["starting", "running"].includes(this.result.status); }
  snapshot(): WorkerResult { return structuredClone(this.result); }
  setChanged(changed: (worker: Worker) => void) { this.changed = changed; }
  summary(): WorkerSummary {
    const { id, attempt, status, cwd, model, thinking, pid, sessionFile, transcript, error, stopReason } = this.result;
    return { id, attempt, status, cwd, model, thinking, pid, sessionFile, transcript, error, stopReason,
      task: this.options.task, agent: this.options.agent.name, stopping: !this.terminal && this.stopped !== undefined };
  }
  onActivity(listener: (event: ActivitySignal) => void) {
    this.observers.add(listener);
    return () => { this.observers.delete(listener); };
  }
  observe(listener: (change: ActivityChange) => void) {
    return new WorkerActivity(this.result.transcript, () => this.summary(), (listener) => this.onActivity(listener), listener);
  }
  private recordAttempt() {
    this.record({ type: "worker_attempt", ...this.summary() });
  }

  static recover(directory: string, invocation: Invocation) {
    const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
    const result: WorkerResult = state.result;
    if (["starting", "running"].includes(result.status)) {
      result.status = "interrupted";
      result.error = "Parent process ended before recording settlement. Explicit resume is required; no PID was reattached.";
    }
    delete result.pid;
    const worker = new Worker({ ...state.options, directory, invocation }, undefined, result);
    worker.background = state.background;
    worker.reports = state.reports ?? [];
    worker.notifiedAttempt = state.notifiedAttempt;
    worker.reportedUsage = state.reportedUsage;
    worker.confirmedSelection = state.confirmedSelection;
    worker.save();
    return worker;
  }

  resumeDefaults() {
    return this.confirmedSelection ?? { model: this.result.model, thinking: this.result.thinking };
  }

  resume(task: string, overrides: Partial<WorkerOptions>, signal?: AbortSignal) {
    if (!this.terminal) throw new Error(`Worker ${this.id} already has an active attempt; overlapping resume is refused`);
    const session = this.result.sessionFile;
    if (!session || !existsSync(session)) throw new Error(`Worker ${this.id} has no persisted child session to resume`);
    if (overrides.agent && overrides.agent.name !== this.options.agent.name) throw new Error("Resume can't change the worker's agent");
    if (overrides.cwd && realpathSync(overrides.cwd) !== this.options.cwd) throw new Error("Resume can't change the worker's cwd");
    const previousTools = this.options.tools ?? this.options.agent.tools;
    if (overrides.tools && previousTools && overrides.tools.some((tool) => !previousTools.includes(tool))) {
      throw new Error("Resume can't broaden the worker's tool restrictions");
    }
    this.options = { ...this.options, ...this.resumeDefaults(), ...overrides, task, cwd: this.options.cwd, agent: this.options.agent, signal,
      requiredTools: [...new Set([...(this.options.requiredTools ?? []), ...(overrides.requiredTools ?? [])])] };
    this.result.attempt++;
    this.result.status = "starting";
    this.result.model = this.options.model;
    this.result.thinking = this.options.thinking;
    this.result.text = "";
    this.result.truncated = false;
    delete this.result.error;
    delete this.result.stopReason;
    delete this.result.stats;
    delete this.result.pid;
    this.assistant = undefined;
    this.rpc = undefined;
    this.stopped = undefined;
    this.stopping = undefined;
    this.controller = new AbortController();
    this.save();
    this.recordAttempt();
    this.done = Promise.resolve().then(() => this.execute(session));
  }

  save() {
    const { signal: _signal, env: _env, invocation: _invocation, directory: _directory, ...options } = this.options;
    if (this.terminal && !this.reports.some(item => item.result.attempt === this.result.attempt)) {
      this.reports.push({ result: this.snapshot(), background: this.background });
    }
    for (const [path, value] of [[join(this.directory, "state.json"),
      { version: 1, options, result: this.result, background: this.background, notifiedAttempt: this.notifiedAttempt,
        reportedUsage: this.reportedUsage, confirmedSelection: this.confirmedSelection, reports: this.reports }], [this.result.resultPath, this.result]] as const) {
      writeFileSync(path + ".tmp", JSON.stringify(value, null, 2), { mode: 0o600 });
      renameSync(path + ".tmp", path);
    }
    notify(this.observers, { kind: "summary" });
  }

  reconcile(notifiedAttempt: number, reportedUsage?: WorkerResult["usage"]) {
    this.notifiedAttempt = notifiedAttempt;
    this.reportedUsage = structuredClone(reportedUsage ?? emptyUsage());
    this.save();
  }

  takeUsage() {
    if (!this.terminal) return undefined;
    const usage = structuredClone(this.result.usage);
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[key] -= this.reportedUsage[key];
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[key] -= this.reportedUsage.cost[key];
    this.reportedUsage = structuredClone(this.result.usage);
    this.save();
    return usage.totalTokens || usage.cost.total ? usage : undefined;
  }
  private addUsage(increment?: RecordValue) {
    if (!increment) return;
    const usage = this.result.usage;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[key] += increment[key] ?? 0;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[key] += increment.cost?.[key] ?? 0;
  }
  private record(row: RecordValue) {
    appendFileSync(this.result.transcript, JSON.stringify(row) + "\n", { mode: 0o600 });
    notify(this.observers, { kind: "record", row });
    if (row.type === "message_start" && row.message?.role === "assistant") {
      this.result.text = "";
      this.textLength = 0;
      this.result.truncated = false;
    }
    if (row.type === "message_update" && row.assistantMessageEvent?.type === "text_delta") {
      const delta = row.assistantMessageEvent.delta;
      this.textLength += delta.length;
      this.result.text = bounded(this.result.text + delta);
      this.result.truncated = this.textLength > resultLimit;
    }
    if (row.type === "message_end") {
      this.addUsage(row.message?.usage);
      if (row.message?.role === "assistant") {
        // Replace errors from earlier attempts -- a later successful retry wins.
        this.assistant = { stopReason: row.message.stopReason, errorMessage: row.message.errorMessage };
        const text = row.message.content.filter((part: RecordValue) => part.type === "text")
          .map((part: RecordValue) => part.text).join("\n");
        if (text) {
          this.result.text = bounded(text);
          this.result.truncated = text.length > resultLimit;
        }
      }
    }
    if (row.type === "compaction_end") this.addUsage(row.result?.usage);
    if (row.type === "message_end" || row.type === "compaction_end") this.save();
  }

  async steer(message: string) {
    if (this.result.status !== "running" || this.stopped) throw new Error(`Worker ${this.id} is ${this.result.status}; steering requires a running worker`);
    const response = await this.rpc!.send({ type: "steer", message });
    if (this.terminal) throw new Error(`Worker ${this.id} settled before steering was delivered; start a new worker for more work`);
    return response.data;
  }

  stop(reason = "Stopped by parent"): Promise<void> {
    if (this.terminal) return this.done;
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.stopped = reason;
      this.controller.abort();
      if (this.rpc) {
        if (this.result.status === "running") {
          try { await this.rpc.cancel(); } catch { /* close escalates if RPC is stalled */ }
        }
        try { await this.rpc.close(); } catch { /* execute records shutdown failures */ }
      }
      await this.done;
    })();
    notify(this.observers, { kind: "summary" });
    return this.stopping;
  }

  private async execute(session?: string) {
    const options = this.options;
    let stage = "startup";
    let outcome: WorkerStatus = "failed";
    const abort = () => { void this.stop("Parent foreground call aborted"); };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (options.signal?.aborted) abort();
      this.controller.signal.throwIfAborted();
      if (session) await assertSessionAvailable(options.leasePath!);
      this.controller.signal.throwIfAborted();
      const args = ["--model", options.model, "--thinking", options.thinking,
        "--session-dir", join(this.directory, "sessions"),
        "--extension", fileURLToPath(new URL("./guard.ts", import.meta.url)),
        "--exclude-tools", delegationTools.join(",")];
      if (session) args.push("--session", session);
      if (options.approveProject) args.push("--approve");
      const tools = options.tools ?? options.agent.tools;
      if (tools) args.push("--tools", tools.join(","));
      if (options.agent.prompt.trim()) {
        const prompt = join(this.directory, "agent.md");
        writeFileSync(prompt, options.agent.prompt, { mode: 0o600 });
        args.push("--append-system-prompt", prompt);
      }
      this.rpc = new RpcProcess(options.invocation, options.cwd, args, {
        ...process.env, ...options.env,
        [childConfigKey]: JSON.stringify({ tools, readOnly: options.agent.readOnly, parentPid: process.pid, leasePath: options.leasePath }),
      }, (row) => this.record(row));
      this.result.pid = this.rpc.child.pid;
      this.save();
      const timeout = options.startupTimeoutMs ?? 20_000;
      const deadline = Date.now() + timeout;
      const state = (await this.rpc.send({ type: "get_state" }, timeout)).data;
      if (session && realpathSync(state.sessionFile) !== realpathSync(session)) throw new Error("Pi resumed a different child session");
      this.result.sessionFile = state.sessionFile;
      this.save();
      const actualModel = state.model && `${state.model.provider}/${state.model.id}`;
      if (actualModel !== options.model && state.model?.id !== options.model) throw new Error(`Pi selected ${actualModel}, not requested model ${options.model}`);
      if (state.thinkingLevel !== options.thinking) throw new Error(`Pi selected thinking ${state.thinkingLevel}, not requested ${options.thinking}`);
      this.result.model = actualModel;
      this.options.model = actualModel;
      this.confirmedSelection = { model: actualModel, thinking: state.thinkingLevel };
      this.save();
      const capabilities = await preflight(this.rpc, options.cwd,
        [...new Set([...(options.agent.requiredTools ?? []), ...(options.requiredTools ?? [])])],
        Math.max(1, deadline - Date.now()), this.controller.signal);
      writeFileSync(this.result.preflight, JSON.stringify({ model: actualModel,
        thinking: state.thinkingLevel, sessionFile: state.sessionFile, ...capabilities }, null, 2), { mode: 0o600 });
      this.controller.signal.throwIfAborted();
      stage = "run";
      this.result.status = "running";
      this.save();
      this.changed(this);
      await this.rpc.run(options.task, undefined, options.runTimeoutMs ?? 600_000);
      this.result.stopReason = this.assistant?.stopReason;
      if (!this.assistant || this.assistant.stopReason !== "stop") {
        throw new Error(this.assistant?.errorMessage || `Pi worker settled without a complete response (${this.assistant?.stopReason ?? "no assistant message"})`);
      }
      const stats = (await this.rpc.send({ type: "get_session_stats" })).data;
      this.result.sessionFile = stats.sessionFile ?? state.sessionFile;
      this.result.stats = { tokens: stats.tokens, cost: stats.cost, toolCalls: stats.toolCalls, assistantMessages: stats.assistantMessages };
      outcome = "completed";
    } catch (error) {
      this.result.stopReason = this.assistant?.stopReason;
      this.result.error = bounded(this.stopped ?? `Pi worker ${stage} failed: ${error instanceof Error ? error.message : String(error)}. Check the transcript and model/provider configuration.`);
    } finally {
      let shutdownError: string | undefined;
      try { await this.rpc?.close(); }
      catch (error) {
        shutdownError = `Pi worker shutdown failed: ${error instanceof Error ? error.message : String(error)}`;
        outcome = "failed";
        this.record({ type: "shutdown_error", error: shutdownError });
      }
      options.signal?.removeEventListener("abort", abort);
      this.result.status = this.stopped ? (this.stopped.startsWith("Parent session ") ? "interrupted" : "stopped") : outcome;
      if (shutdownError) this.result.status = "failed";
      if (this.stopped) this.result.error = this.stopped;
      if (shutdownError) this.result.error = bounded([this.result.error, shutdownError].filter(Boolean).join("\n"));
      this.record({ type: "worker_result", result: this.result });
      this.save();
      this.changed(this);
    }
  }
}

// Foreground helper retained for callers that want a rejected promise on failure.
export async function runWorker(options: WorkerOptions) {
  const worker = new Worker(options);
  await worker.done;
  const result = worker.snapshot();
  if (result.status !== "completed") throw new Error(`${result.error}\nWorker evidence: ${worker.directory}`);
  return result;
}
