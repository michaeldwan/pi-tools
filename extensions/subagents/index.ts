import { getAgentDir, ProjectTrustStore, type ExtensionAPI, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { isAbsolute } from "node:path";
import { realpathSync } from "node:fs";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { discoverAgents, resolveModel, thinkingLevels, type Thinking } from "./agents.ts";
import { childConfigKey } from "./guard.ts";
import { piInvocation } from "./rpc.ts";
import { Worker, type WorkerResult } from "./worker.ts";
import { Registry } from "./registry.ts";
import { Delivery } from "./delivery.ts";
import { registerSubagentsUI } from "./overlay.ts";

const resultSchema = Type.Object({
  id: Type.String(), attempt: Type.Number(), status: Type.Union(["starting", "running", "completed", "failed", "stopped", "interrupted"].map((status) => Type.Literal(status))),
  cwd: Type.String(), model: Type.String(), thinking: Type.String(), pid: Type.Optional(Type.Number()),
  sessionFile: Type.Optional(Type.String()), transcript: Type.String(), preflight: Type.String(), resultPath: Type.String(),
  text: Type.String(), truncated: Type.Boolean(), error: Type.Optional(Type.String()), stopReason: Type.Optional(Type.String()),
  usage: Type.Object({ input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(), totalTokens: Type.Number(),
    cost: Type.Object({ input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(), total: Type.Number() }) }),
  usageOnly: Type.Optional(Type.Boolean()),
  stats: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const summarySchema = Type.Object({ id: Type.String(), attempt: Type.Number(), status: Type.String(),
  cwd: Type.String(), model: Type.String(), thinking: Type.String() });
const launchSchema = Type.Intersect([summarySchema, Type.Object({ completion: Type.Literal("automatic"), guidance: Type.String() })]);
const summary = (result: WorkerResult) => ({ id: result.id, attempt: result.attempt, status: result.status,
  cwd: result.cwd, model: result.model, thinking: result.thinking });

export function resultText(result: WorkerResult, inspect = false) {
  if (result.usageOnly && !inspect) return `Worker ${result.id} attempt ${result.attempt}: usage only; report already handled.`;
  return `Worker ${result.id} attempt ${result.attempt}: ${result.status}${result.error ? `\n${result.error}` : ""}` +
    `${result.text ? `\n\n${result.text}` : ""}${result.truncated ? "\n[Output truncated]" : ""}` +
    (inspect || result.error || result.truncated ?
      `\n\nWorker transcript: ${result.transcript}\nSession: ${result.sessionFile ?? "not created"}\nResult: ${result.resultPath}` : "");
}

async function wait(worker: Worker, timeoutMs: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  let timer: NodeJS.Timeout | undefined;
  let abort = () => {};
  try {
    await Promise.race([worker.done, new Promise<void>((resolve, reject) => {
      timer = setTimeout(resolve, timeoutMs);
      abort = () => reject(new Error("Result wait aborted; worker continues. Use stop_subagent to cancel it."));
      signal?.addEventListener("abort", abort, { once: true });
    })]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export default function subagents(pi: ExtensionAPI) {
  if (process.env[childConfigKey]) return;
  let registry: Registry | undefined;
  let delivery: Delivery | undefined;
  let quitting = false;
  let updateStatus = () => {};
  registerSubagentsUI(pi, () => registry, action => {
    if (!delivery) throw new Error("Parent worker registry isn't available");
    if (action === "pause") delivery.pause(); else delivery.resume();
    updateStatus();
  });
  pi.on("session_start", (event, ctx) => {
    quitting = false;
    const opened = Registry.open(getAgentDir(), ctx.sessionManager.getSessionId(), piInvocation(), ctx.sessionManager.getSessionFile());
    registry = opened.registry;
    delivery = new Delivery(pi, registry, ctx, event.reason === "reload" && opened.live);
    delivery.observeSignal(ctx.signal);
    updateStatus = () => {
      const active = [...registry!.workers.values()].filter(item => !item.terminal).length;
      const status = [active ? `${active} worker${active === 1 ? "" : "s"} active` : "", delivery?.paused ? "results paused" : ""].filter(Boolean).join(" · ");
      ctx.ui.setStatus("pi-rpc-subagents", status || undefined);
    };
    registry.changed = () => { updateStatus(); delivery?.wake(); };
    updateStatus();
    delivery.wake();
  });
  pi.on("input", event => { if (event.source !== "extension") delivery?.input(); });
  pi.on("turn_start", (_event, ctx) => delivery?.observeSignal(ctx.signal));
  pi.on("tool_call", event => { delivery?.trackCall(event.toolCallId, event.parentToolCallId); });
  pi.on("turn_end", event => delivery?.boundary(event.outcome));
  pi.on("agent_before_settle", event => delivery?.boundary(event.outcome));
  pi.on("agent_settled", () => delivery?.wake());
  const lookup = (id: string) => {
    const worker = registry?.workers.get(id);
    if (!worker) throw new Error(`Unknown worker ${id}. Use the ID returned by subagent in this parent session.`);
    return worker;
  };
  const launched = (worker: Worker) => {
    const snapshot = worker.snapshot();
    const data = { ...summary(snapshot), completion: "automatic" as const,
      guidance: "Continue independent work, then call wait_for_subagents to yield quietly. Don't poll or emit acknowledgment-only replies." };
    return { content: [{ type: "text" as const, text: `Worker ${snapshot.id} attempt ${snapshot.attempt}: ${snapshot.status}. Completion is automatic. ${data.guidance}` }],
      details: snapshot, structuredContent: data };
  };
  const result = (worker: Worker, callId: string, inspect = true) => {
    const snapshot = worker.snapshot();
    const usage = worker.terminal ? delivery!.reserve([snapshot], callId) : undefined;
    return { content: [{ type: "text" as const, text: resultText(snapshot, inspect) }], details: snapshot,
      structuredContent: snapshot, isError: ["failed", "stopped", "interrupted"].includes(snapshot.status), usage };
  };
  pi.on("session_shutdown", async (event) => {
    delivery?.detach();
    registry?.detach();
    if (event.reason === "reload") return;
    quitting = true;
    await registry?.close(event.reason === "quit" ? "Parent session quit" : `Parent session replaced (${event.reason})`);
    registry = undefined;
  });
  pi.registerTool({
    name: "subagent", label: "Subagent",
    description: "Start one fresh pi RPC worker in an explicit absolute cwd. background:true returns a stable ID before startup completes; " +
      "otherwise waits for settlement. Background completion is automatic: continue independent work, then use wait_for_subagents to yield quietly. " +
      "Don't poll or read full transcripts to wait; don't emit acknowledgment-only replies. Workers run independently. Inherits provider/model and thinking unless overridden. " +
      "Loads normal child resources, blocks recursive delegation and checks required tools before work. " +
      "Default agent: general-purpose; read-only defaults: Explore and Plan. resume:<worker ID> explicitly continues the same " +
      "persisted conversation after settlement, stop or interruption. Resume retains cwd, agent, model, thinking and restrictions unless " +
      "explicitly overridden; it can't change cwd/agent, broaden tool restrictions or overlap an active attempt.",
    parameters: Type.Object({
      task: Type.String({ minLength: 1 }),
      resume: Type.Optional(Type.String({ description: "Worker ID to resume in its original persisted session" })),
      cwd: Type.String({ description: "Explicit absolute worker directory" }),
      background: Type.Optional(Type.Boolean({ default: false })),
      agent: Type.Optional(Type.String()),
      model: Type.Optional(Type.String({ description: "Exact provider/model or model ID" })),
      thinking: Type.Optional(Type.Union(thinkingLevels.map((level) => Type.Literal(level)))),
      tools: Type.Optional(Type.Array(Type.String(), { description: "Exact allowlist, including nested MCP calls" })),
      requiredTools: Type.Optional(Type.Array(Type.String(), { description: "Exact tool names required before work starts" })),
      approveProject: Type.Optional(Type.Boolean({ description: "Trust this cwd's project resources for this child process" })),
      startupTimeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 120_000, default: 20_000 })),
      runTimeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 86_400_000, default: 600_000,
        description: "Hard settlement deadline; stalled work fails and its process is closed" })),
    }),
    outputSchema: Type.Union([launchSchema, resultSchema]),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (quitting || !registry) throw new Error("Parent worker registry isn't available; can't launch workers");
      signal?.throwIfAborted();
      if (!isAbsolute(params.cwd)) throw new Error("subagent cwd must be an explicit absolute directory");
      if (params.resume) {
        const worker = lookup(params.resume);
        const snapshot = worker.snapshot();
        if (realpathSync(params.cwd) !== snapshot.cwd) throw new Error("Resume can't change the worker's cwd");
        if (params.agent) throw new Error("Resume retains its saved agent; omit agent");
        const defaults = worker.resumeDefaults();
        const selected = resolveModel(defaults.model, defaults.thinking, { name: "saved", prompt: "" }, params.model, params.thinking);
        const overrides = { cwd: params.cwd, ...selected,
          ...(params.tools ? { tools: params.tools } : {}), ...(params.requiredTools ? { requiredTools: params.requiredTools } : {}),
          ...(params.approveProject !== undefined ? { approveProject: params.approveProject } : {}),
          ...(params.startupTimeoutMs ? { startupTimeoutMs: params.startupTimeoutMs } : {}),
          ...(params.runTimeoutMs ? { runTimeoutMs: params.runTimeoutMs } : {}) };
        worker.resume(params.task, overrides, params.background ? undefined : signal);
        worker.background = params.background === true;
        worker.save();
        if (!params.background) await worker.done;
        return params.background ? launched(worker) : result(worker, _id, false);
      }
      const sameProject = realpathSync(params.cwd) === realpathSync(ctx.cwd);
      const approveProject = params.approveProject === true || (sameProject && ctx.isProjectTrusted());
      const projectTrusted = approveProject || new ProjectTrustStore(getAgentDir()).get(params.cwd) === true;
      const agents = discoverAgents(params.cwd, projectTrusted);
      const agent = agents.get(params.agent ?? "general-purpose");
      if (!agent) throw new Error(`Unknown agent ${params.agent}. Available: ${[...agents.keys()].join(", ")}`);
      const selected = resolveModel(ctx.model && `${ctx.model.provider}/${ctx.model.id}`,
        ctx.thinkingLevel as Thinking | undefined, agent, params.model, params.thinking);
      const worker = new Worker({ ...params, cwd: realpathSync(params.cwd), approveProject, agent, ...selected,
        directory: registry.newDirectory(), signal: params.background ? undefined : signal, invocation: piInvocation() });
      registry.add(worker);
      worker.background = params.background === true;
      worker.save();
      if (!params.background) await worker.done;
      return params.background ? launched(worker) : result(worker, _id, false);
    },
  });
  pi.registerTool({
    name: "wait_for_subagents", label: "Wait for subagents", exposure: "model-only",
    description: "Collect unhandled reports now, or quietly end this run while workers remain live. New results resume the idle parent automatically. " +
      "Continue independent work first; don't poll, read worker transcripts to wait, or emit waiting/acknowledgment-only replies. " +
      "Parent input remains available. Explicit /subagents pause suppresses automatic processing until /subagents resume; idle Esc doesn't pause arrivals.",
    parameters: Type.Object({}),
    outputSchema: Type.Object({ reports: Type.Array(resultSchema), waiting: Type.Boolean(), paused: Type.Boolean() }),
    async execute(callId) {
      if (!delivery || !registry) throw new Error("Parent worker registry isn't available");
      const reports = delivery.paused ? [] : delivery.pending();
      const usage = delivery.reserve(reports, callId);
      const waiting = !reports.length && [...registry.workers.values()].some(worker => !worker.terminal);
      const data = { reports, waiting, paused: delivery.paused };
      return { content: [{ type: "text" as const, text: reports.length ? reports.map(report => resultText(report)).join("\n\n") :
        delivery.paused ? "Automatic results are paused. Use /subagents resume; explicit get_subagent_result remains available." :
        waiting ? "Quietly waiting for workers. Parent input remains available; results resume processing automatically." : "No live workers or unhandled reports." }],
        details: data, structuredContent: data, usage, terminate: !reports.length && (waiting || delivery.paused) };
    },
    renderResult(result, _options, theme) {
      const data = result.details;
      return new Text(theme.fg("muted", data ? data.reports.length ? `${data.reports.length} worker report${data.reports.length === 1 ? "" : "s"} collected` :
        data.paused ? "Automatic results paused" : data.waiting ? "Waiting quietly for workers" : "No pending workers" : "Result collection failed; inspect /subagents."), 0, 0);
    },
  });
  pi.registerTool({
    name: "get_subagent_result", label: "Subagent result",
    description: "Inspect one worker by ID, or omit id to list this parent's persisted worker IDs and statuses after compaction/reload. " +
      "This is explicit inspection, not the background completion path. Use wait_for_subagents to await automatic results; don't poll. " +
      "Legacy diagnostic wait:true waits up to timeoutMs for one worker; timeout/cancellation leaves it running. Explicit results include bounded text and full evidence paths.",
    parameters: Type.Object({ id: Type.Optional(Type.String()), wait: Type.Optional(Type.Boolean({ default: false })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60_000, default: 30_000 })) }),
    outputSchema: Type.Union([resultSchema, Type.Object({ workers: Type.Array(summarySchema) })]),
    async execute(_id, params, signal): Promise<AgentToolResult<WorkerResult | { workers: ReturnType<typeof summary>[] }>> {
      if (!registry) throw new Error("Parent worker registry isn't available; check extension startup errors");
      if (!params.id) {
        const data = { workers: [...(registry?.workers.values() ?? [])].map(worker => summary(worker.snapshot())) };
        return { content: [{ type: "text", text: JSON.stringify(data) }], details: data, structuredContent: data };
      }
      const worker = lookup(params.id);
      if (params.wait) await wait(worker, params.timeoutMs ?? 30_000, signal);
      return result(worker, _id);
    },
  });
  pi.registerTool({
    name: "steer_subagent", label: "Steer subagent",
    description: "Queue a message for a running worker, delivered after its current tool calls and before its next model call. " +
      "Doesn't interrupt a tool or restart a completed worker. A queued response isn't proof of delivery; inspect the transcript/result.",
    parameters: Type.Object({ id: Type.String(), message: Type.String({ minLength: 1 }) }),
    outputSchema: Type.Object({ id: Type.String(), disposition: Type.String() }),
    async execute(_id, params) {
      const response = await lookup(params.id).steer(params.message);
      const data = { id: params.id, disposition: response.disposition };
      return { content: [{ type: "text", text: JSON.stringify(data) }], details: data, structuredContent: data };
    },
  });
  pi.registerTool({
    name: "stop_subagent", label: "Stop subagent",
    description: "Stop one worker by ID. Clears queued work, aborts the active run and closes its owned process, escalating if stalled. " +
      "Returns stopped status and partial output; terminal workers are unchanged. Siblings aren't affected.",
    parameters: Type.Object({ id: Type.String() }), outputSchema: resultSchema,
    async execute(_id, params) {
      const worker = lookup(params.id);
      await worker.stop();
      return result(worker, _id);
    },
  });
}
