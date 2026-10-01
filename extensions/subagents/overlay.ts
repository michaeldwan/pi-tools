import type { ExtensionAPI, ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, ScrollView, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { ActivityEntry, WorkerActivity } from "./activity.ts";
import type { Registry, RegistryView } from "./registry.ts";
import type { WorkerSummary } from "./worker.ts";
import type { RecordValue } from "./rpc.ts";

// Worker output is data, not terminal commands. Keep line breaks for wrapping.
const plain = (value: unknown) => stripVTControlCharacters(String(value ?? "")).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const json = (value: unknown) => plain(JSON.stringify(value, null, 2));
const status = (worker: WorkerSummary) => worker.stopping ? `${worker.status} · stopping` : worker.status;
const active = (worker: WorkerSummary) => ["starting", "running"].includes(worker.status);
const contentText = (content: unknown): string => typeof content === "string" ? plain(content) :
  Array.isArray(content) ? content.map((part) => part?.type === "text" ? plain(part.text) :
    part?.type === "image" ? `[image: ${plain(part.mimeType)}]` : "").filter(Boolean).join("\n") : "";

// Keep the newest output visible without laying out an unbounded tool result.
function outputTail(text: string, lines = 3, chars = 600) {
  const trimmed = text.trimEnd();
  const tail = trimmed.slice(-chars).split("\n").slice(-lines).join("\n");
  return { text: tail, clipped: tail.length < trimmed.length };
}
// Bound raw text before sanitizing: partial tool results can be cumulative.
function contentTail(content: unknown, lines = 3, chars = 600) {
  const budget = 4096;
  let suffix = "";
  let clipped = false;
  const append = (text: string) => {
    if (!text) return;
    const remaining = Math.max(0, budget - suffix.length - (suffix ? 1 : 0));
    clipped ||= text.length > remaining;
    suffix = (remaining ? text.slice(-remaining) : "") + (suffix ? "\n" + suffix : "");
  };
  if (typeof content === "string") append(content);
  else if (Array.isArray(content)) {
    for (let i = content.length - 1; i >= 0; i--) {
      if (suffix.length >= budget) { clipped = true; break; }
      const part = content[i];
      if (part?.type === "text") append(String(part.text ?? ""));
      else if (part?.type === "image") append(`[image: ${String(part.mimeType ?? "")}]`);
    }
  }
  const tail = outputTail(plain(suffix), lines, chars);
  return { text: tail.text, clipped: clipped || tail.clipped };
}
// Tool arguments can hold a whole file, and stream in as text: clip strings before
// serializing so the compact title line doesn't re-escape all of it on each update.
function argsHead(value: unknown, chars = 600) {
  const raw = typeof value === "string" ? value.slice(0, chars + 1) :
    JSON.stringify(value, (_key, field) => typeof field === "string" && field.length > chars ? field.slice(0, chars) + "…" : field) ?? "";
  const head = plain(raw.slice(0, chars)).replace(/\s+/g, " ");
  return raw.length > chars ? head + "…" : head;
}
function clipOutputLine(line: string, width: number) {
  const columns = visibleWidth(line);
  return columns > width ? truncateToWidth("…" + sliceByColumn(line, columns - width + 1, columns), width) : line;
}
const toolState = (entry: Extract<ActivityEntry, { kind: "tool" }>) =>
  entry.complete ? entry.isError ? "error" : "done" : "pending / partial";

function entryPreview(entry: ActivityEntry): string | undefined {
  if (entry.kind === "tool") {
    const text = contentTail(entry.result?.content, 1, 200).text;
    return `${plain(entry.name)} · ${toolState(entry)}${text ? `: ${text}` : " · waiting for output"}`;
  }
  if (entry.kind === "message" && entry.message.role === "assistant") {
    const text = contentTail(entry.message.content, 1, 200).text;
    if (text) return `assistant: ${text}`;
  }
}
function latestActivity(activity: WorkerActivity, lastChanged?: number): string {
  const attempt = activity.summary().attempt;
  const changed = lastChanged === undefined ? undefined : activity.entries[lastChanged];
  // Parallel tools can update an earlier entry after a later tool has finished.
  if (changed?.attempt === attempt) {
    const text = entryPreview(changed);
    if (text) return text;
  }
  for (let i = activity.entries.length - 1; i >= 0; i--) {
    const entry = activity.entries[i];
    if (entry.attempt !== attempt) continue;
    const text = entryPreview(entry);
    if (text) return text;
  }
  return activity.loading ? "Loading activity..." : activity.historyError ? "Activity unavailable; Enter for details" :
    activity.summary().error ? plain(activity.summary().error) : "Waiting for output";
}

export function activityText(entry: ActivityEntry, toolsExpanded: boolean, thinkingExpanded: boolean,
  executions: ReadonlySet<string> = new Set()): string[] {
  if (entry.kind === "tool") {
    const title = `${entry.parentToolCallId ? "  ↳" : "▶"} ${plain(entry.name)} · ${toolState(entry)}`;
    if (toolsExpanded) return [title, json(entry.args), contentText(entry.result?.content) || "[no text result]"];
    const tail = contentTail(entry.result?.content);
    return [`${title} · ${argsHead(entry.args)}`,
      ...(tail.clipped ? ["[output tail · expand tools for full result]"] : []),
      ...(tail.text ? tail.text.split("\n") : [entry.complete ? "[no text result]" : "[waiting for output]"])];
  }
  if (entry.kind === "message") {
    const message = entry.message;
    const parts = typeof message.content === "string" ? [plain(message.content)] :
      (message.content ?? []).flatMap((part: RecordValue) => {
        if (part.type === "thinking") return [thinkingExpanded ? `Thinking:\n${plain(part.thinking) || "[redacted]"}` : "[thinking collapsed]"];
        // Execution entries carry tool requests and results together. Avoid duplicates.
        if (part.type === "toolCall") return executions.has(`${entry.attempt}:${part.id}`) ? [] :
          [`▶ ${plain(part.name)} · request / partial · ${toolsExpanded ? json(part.arguments ?? part.argumentsText) :
            argsHead(part.arguments ?? part.argumentsText)}`];
        return [contentText([part])];
      });
    return [`${plain(message.role)}${entry.complete ? "" : " · partial"}${message.stopReason && message.stopReason !== "pending" ? ` · ${plain(message.stopReason)}` : ""}`,
      ...parts, ...(message.errorMessage ? [`Error: ${plain(message.errorMessage)}`] : [])];
  }
  const event = entry.event;
  switch (event.type) {
    case "worker_attempt": return [`Attempt ${entry.attempt} · ${plain(event.agent)}: ${plain(event.task)}`];
    case "worker_result": return [`Attempt ${entry.attempt} · ${plain(event.result.status)}${event.result.error ? `: ${plain(event.result.error)}` : ""}`];
    case "stderr": return [`stderr: ${plain(event.text)}`];
    case "queue_update": return [`Queue · steering ${event.steering?.length ?? 0}, follow-up ${event.followUp?.length ?? 0}`];
    case "auto_retry_start": return [`Retry ${event.attempt}: ${plain(event.errorMessage)}`];
    case "auto_retry_end": return [`Retry ${event.success ? "succeeded" : `failed: ${plain(event.finalError)}`}`];
    case "compaction_start": return [`Compacting · ${plain(event.reason)}`];
    case "compaction_end": return [`Compaction ${event.errorMessage ? `failed: ${plain(event.errorMessage)}` : event.aborted ? "aborted" : "finished"}`];
    case "extension_error": return [`Extension error: ${plain(event.error)}`];
    default: return [];
  }
}

/** Cached, wrapped transcript with entry-relative positions when layout changes. */
class Transcript implements Component {
  private cache = new Map<number, { revision: number; lines: string[] }>();
  private width = 0;
  private dirty = true;
  private rows: { entry: number; line: number; text: string }[] = [];
  toolsExpanded = false;
  thinkingExpanded = false;
  private activity: WorkerActivity;
  private executions = new Set<string>();
  constructor(activity: WorkerActivity) { this.activity = activity; }
  changed() { this.dirty = true; }
  invalidate() { this.cache.clear(); this.dirty = true; }
  render(width: number) {
    if (width !== this.width) { this.width = width; this.invalidate(); }
    if (this.dirty) {
      const executions = new Set(this.activity.entries.filter((entry) => entry.kind === "tool")
        .map((entry) => `${entry.attempt}:${entry.toolCallId}`));
      if (executions.size !== this.executions.size) this.cache.clear();
      this.executions = executions;
      this.rows = this.activity.entries.flatMap((entry) => {
        let cached = this.cache.get(entry.id);
        if (!cached || cached.revision !== entry.revision) {
          const text = activityText(entry, this.toolsExpanded, this.thinkingExpanded, executions).filter(Boolean)
            .map((line, index) => entry.kind === "tool" && !this.toolsExpanded ?
              index === 0 || line === "[output tail · expand tools for full result]" ? truncateToWidth(line, width) :
                clipOutputLine(line, width) : line).join("\n");
          cached = { revision: entry.revision, lines: text ? [...wrapTextWithAnsi(text, width), ""] : [] };
          this.cache.set(entry.id, cached);
        }
        return cached.lines.map((text, line) => ({ entry: entry.id, line, text }));
      });
      this.dirty = false;
    }
    return this.rows.map((row) => row.text);
  }
  anchor(top: number) { return this.rows[top]; }
  position(anchor: { entry: number; line: number }) {
    const start = this.rows.findIndex((row) => row.entry === anchor.entry);
    if (start < 0) return 0;
    let end = start;
    while (end + 1 < this.rows.length && this.rows[end + 1].entry === anchor.entry) end++;
    return Math.min(end, start + anchor.line);
  }
}

export class SubagentsOverlay implements Component {
  private view: RegistryView;
  private allWorkers: WorkerSummary[] = [];
  private workers: WorkerSummary[] = [];
  private list: "active" | "history" = "active";
  private selected = 0;
  private selections = new Map<"active" | "history", { id?: string; index: number }>();
  private activity?: WorkerActivity;
  private previews = new Map<string, { activity: WorkerActivity; text: string; loaded: boolean; lastChanged?: number }>();
  private transcript?: Transcript;
  private scroll?: ScrollView;
  private input = new Input({ prompt: "Steer > ", placeholder: "message to this worker" });
  private inputFocus = false;
  private hasFocus = false;
  private closed = false;
  private feedback = "";
  private steering = false;
  private stopping = false;
  private detailGeneration = 0;

  private tui: TUI;
  private theme: Theme;
  private keys: KeybindingsManager;
  private done: () => void;
  constructor(tui: TUI, theme: Theme, keys: KeybindingsManager, registry: Registry, done: () => void) {
    this.tui = tui;
    this.theme = theme;
    this.keys = keys;
    this.done = done;
    this.view = registry.observe((change) => {
      if (change.kind === "disposed") this.close();
      else { this.refreshWorkers(); this.requestRender(); }
    });
    this.refreshWorkers();
  }
  get focused() { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; this.input.focused = value && this.inputFocus; }
  private requestRender = () => { if (!this.closed) this.tui.requestRender(); };
  private refreshWorkers(selection: { id?: string; index: number } = { id: this.workers[this.selected]?.id, index: this.selected }) {
    this.allWorkers = this.view.summaries();
    this.workers = this.allWorkers.filter((worker) => active(worker) === (this.list === "active"));
    const index = this.workers.findIndex((worker) => worker.id === selection.id);
    // Keep identity across updates; if it leaves this list, select the nearest row.
    this.selected = index >= 0 ? index : Math.max(0, Math.min(selection.index, this.workers.length - 1));
  }
  private switchList() {
    this.selections.set(this.list, { id: this.workers[this.selected]?.id, index: this.selected });
    this.list = this.list === "active" ? "history" : "active";
    this.refreshWorkers(this.selections.get(this.list) ?? { id: undefined, index: 0 });
  }
  private syncPreviews(workers: WorkerSummary[]) {
    const visible = new Set(workers.map((worker) => worker.id));
    for (const [id, preview] of this.previews) {
      if (!visible.has(id)) {
        this.previews.delete(id);
        preview.activity.dispose();
      }
    }
    for (const worker of workers) {
      if (this.previews.has(worker.id)) continue;
      const activity = this.view.activity(worker.id, (change) => {
        if (this.closed) return;
        const preview = this.previews.get(worker.id);
        // Ignore callbacks from a row that has left the viewport.
        if (!preview || preview.activity !== activity) return;
        if (change.kind === "disposed") this.close();
        else {
          if (preview.loaded && change.kind === "history" && change.from !== undefined &&
              entryPreview(activity.entries[change.from])) preview.lastChanged = change.from;
          preview.loaded = !activity.loading;
          preview.text = latestActivity(activity, preview.lastChanged);
          if (change.kind === "history" && this.activity === activity) this.transcript?.changed();
          this.requestRender();
        }
      });
      this.previews.set(worker.id, { activity, text: latestActivity(activity), loaded: !activity.loading });
    }
  }
  private openDetail() {
    const worker = this.workers[this.selected];
    if (!worker) return;
    // Reuse the selected row's captured prefix/live subscription, not a second read.
    this.syncPreviews([worker]);
    this.activity = this.previews.get(worker.id)!.activity;
    this.transcript = new Transcript(this.activity);
    this.scroll = new ScrollView(this.transcript, { follow: "end", overscroll: "contain" });
  }
  private leaveDetail() {
    const worker = this.activity?.summary();
    if (worker && !this.closed) {
      // Settlement/resume can move the worker while its detail stays open.
      this.selections.set(this.list, { id: this.workers[this.selected]?.id, index: this.selected });
      this.list = active(worker) ? "active" : "history";
      this.refreshWorkers({ id: worker.id, index: this.selected });
    }
    this.detailGeneration++;
    this.activity = undefined;
    this.transcript = undefined;
    this.scroll = undefined;
    this.inputFocus = false;
    this.input.focused = false;
    this.input.setValue("");
    this.feedback = "";
    this.steering = false;
    this.stopping = false;
  }
  close() {
    if (this.closed) return;
    this.dispose();
    this.done();
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.leaveDetail();
    this.syncPreviews([]);
    this.view.dispose();
  }
  invalidate() { this.transcript?.invalidate(); this.input.invalidate(); }

  private async steer() {
    const activity = this.activity;
    if (!activity || this.steering) return;
    const worker = activity.summary();
    const message = this.input.getValue();
    if (!message.trim()) { this.feedback = "Enter a steering message first."; return; }
    if (worker.status !== "running" || worker.stopping || this.stopping) {
      this.feedback = `Can't steer: worker is ${status(worker)}. Steering requires a running worker.`;
      return;
    }
    const generation = this.detailGeneration;
    this.steering = true;
    this.feedback = "Sending steering...";
    this.requestRender();
    try {
      const response = await this.view.steer(worker.id, message);
      if (this.closed || generation !== this.detailGeneration) return;
      this.feedback = response.disposition === "queued" ? "Queued -- not delivery. Waits for current tools; check the transcript." :
        `Steering ${plain(response.disposition)} -- check the transcript for delivery.`;
      this.input.setValue("");
    } catch (error) {
      if (this.closed || generation !== this.detailGeneration) return;
      this.feedback = `Steering failed: ${plain(error instanceof Error ? error.message : error)}`;
    } finally {
      if (!this.closed && generation === this.detailGeneration) { this.steering = false; this.requestRender(); }
    }
  }
  private async stop() {
    const worker = this.activity?.summary();
    if (!worker || this.stopping) return;
    if (!active(worker)) { this.feedback = `Worker is already ${worker.status}; nothing stopped.`; return; }
    const generation = this.detailGeneration;
    this.stopping = true;
    this.feedback = "Stopping this worker... Files aren't undone.";
    this.requestRender();
    try {
      await this.view.stop(worker.id);
      if (this.closed || generation !== this.detailGeneration) return;
      this.feedback = `Worker ${this.activity!.summary().status}. Files aren't undone.`;
    } catch (error) {
      if (this.closed || generation !== this.detailGeneration) return;
      this.feedback = `Stop failed: ${plain(error instanceof Error ? error.message : error)}`;
    } finally {
      if (!this.closed && generation === this.detailGeneration) { this.stopping = false; this.requestRender(); }
    }
  }
  handleInput(data: string) {
    if (this.closed) return;
    // These keys belong to the overlay, never the parent's abort/clear/exit handlers.
    if (matchesKey(data, "escape")) {
      if (this.activity) this.leaveDetail(); else this.close();
    } else if (matchesKey(data, "ctrl+c")) {
      if (this.activity) void this.stop(); else this.close();
    } else if (!this.activity) {
      if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) this.switchList();
      else if (this.keys.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
      else if (this.keys.matches(data, "tui.select.down")) this.selected = Math.max(0, Math.min(this.workers.length - 1, this.selected + 1));
      else if (this.keys.matches(data, "tui.select.confirm")) this.openDetail();
    } else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.inputFocus = !this.inputFocus;
      this.input.focused = this.focused && this.inputFocus;
    } else if (this.inputFocus) {
      if (this.keys.matches(data, "tui.input.submit")) void this.steer();
      else if (!this.steering) this.input.handleInput(data);
    } else if (this.keys.matches(data, "app.tools.expand")) {
      this.transcript!.toolsExpanded = !this.transcript!.toolsExpanded;
      this.transcript!.invalidate();
    } else if (this.keys.matches(data, "app.thinking.toggle")) {
      this.transcript!.thinkingExpanded = !this.transcript!.thinkingExpanded;
      this.transcript!.invalidate();
    } else if (this.keys.matches(data, "tui.editor.cursorUp")) this.scroll!.scrollBy(-1);
    else if (this.keys.matches(data, "tui.editor.cursorDown")) this.scroll!.scrollBy(1);
    else if (this.keys.matches(data, "tui.editor.pageUp")) this.scroll!.scrollBy(-this.scroll!.viewportHeight);
    else if (this.keys.matches(data, "tui.editor.pageDown")) this.scroll!.scrollBy(this.scroll!.viewportHeight);
    else if (matchesKey(data, "home")) this.scroll!.scrollTo(0, { disableFollow: true });
    else if (matchesKey(data, "end")) this.scroll!.scrollToEnd();
    this.requestRender();
  }

  render(width: number): string[] {
    if (this.closed) return [];
    const height = Math.max(1, Math.floor(this.tui.terminal.rows * 0.9));
    const inner = Math.max(1, width - 2);
    const border = (text: string) => this.theme.fg("border", text);
    const muted = (text: string) => this.theme.fg("muted", text);
    const rows: string[] = [];
    if (this.activity && this.transcript && this.scroll) {
      const worker = this.activity.summary();
      rows.push(this.theme.fg("accent", plain(`${worker.agent} · ${status(worker)} · attempt ${worker.attempt} · ${worker.id}`)),
        plain(`${worker.model} · thinking ${worker.thinking}`), plain(`cwd: ${worker.cwd}`), plain(worker.task));
      const notices = [this.feedback, worker.error, this.activity.historyError, this.activity.loading ? "Loading history..." : ""].filter(Boolean).join(" | ");
      rows.push(notices ? this.theme.fg(worker.error || this.activity.historyError ? "error" : "warning", plain(notices)) :
        muted("Steering waits for tools. Ctrl+C stops only this worker; files aren't undone."));
      const viewportHeight = Math.max(1, height - 11);
      const anchor = this.scroll.isFollowingEnd ? undefined : this.transcript.anchor(this.scroll.scrollTop);
      const output = this.scroll.render(inner);
      this.scroll.updateLayout(output.length, viewportHeight, this.requestRender);
      if (anchor) this.scroll.scrollTo(this.transcript.position(anchor), { disableFollow: true });
      const visible = output.slice(this.scroll.scrollTop, this.scroll.scrollTop + viewportHeight);
      rows.push(...visible, ...Array(Math.max(0, viewportHeight - visible.length)).fill(""));
      const focus = this.focused ? `${this.inputFocus ? "Steering" : "Output"} focus` : "Focus elsewhere";
      rows.push(this.theme.fg(this.focused ? "accent" : "muted", `[${focus}]`) +
        muted(` · ${this.scroll.isFollowingEnd ? "following" : "scrolled back"} · ${output.length ? this.scroll.scrollTop + 1 : 0}/${output.length}`));
      // Input.render draws its inverse-video cursor even when focused=false.
      // Keep the editor state, but render inactive steering as plain text.
      rows.push(...(this.input.focused ? this.input.render(inner) :
        [muted(`Steer (Tab to edit): ${plain(this.input.getValue()) || "message to this worker"}`)]));
      const toolKeys = this.keys.getKeys("app.tools.expand").join("/") || "unbound";
      const thinkingKeys = this.keys.getKeys("app.thinking.toggle").join("/") || "unbound";
      rows.push(muted(`Tab to ${this.inputFocus ? "output" : "steer"} · ${this.inputFocus ? "Enter send · " : ""}Ctrl+C stop worker · Esc back`),
        muted(`↑↓/PgUp/PgDn scroll · Home/End · ${toolKeys} tools preview/full · ${thinkingKeys} thinking`));
    } else {
      const activeCount = this.allWorkers.filter(active).length;
      const tabs = [`Active ${activeCount}`, `History ${this.allWorkers.length - activeCount}`];
      rows.push(this.theme.fg("accent", "Subagents") + " · " + tabs.map((tab, index) =>
        (index === 0 ? this.list === "active" : this.list === "history") ? this.theme.fg("accent", `[${tab}]`) : muted(tab)).join(" · "));
      const capacity = Math.max(1, Math.floor((height - 5) / 4));
      const start = Math.max(0, Math.min(this.selected, this.workers.length - capacity));
      const visible = this.workers.slice(start, start + capacity);
      this.syncPreviews(visible);
      if (!this.allWorkers.length) rows.push(muted("No workers in this parent session."));
      else if (!this.workers.length) rows.push(muted(this.list === "active" ?
        "No active workers. Tab opens retained history." : "No terminal workers yet. Tab returns to active workers."));
      for (const [index, worker] of visible.entries()) {
        rows.push(this.theme.fg(index + start === this.selected ? "accent" : "text", plain(`${index + start === this.selected ? "→" : " "} ${worker.agent} · ${status(worker)} · ${worker.id}`)),
          plain(`  ${worker.task}`).replace(/\s+/g, " "), muted(plain(`  ${worker.model}`)),
          this.theme.fg("toolOutput", `  ${clipOutputLine(this.previews.get(worker.id)!.text, Math.max(1, inner - 2))}`));
      }
      rows.push(muted("Tab Active / History · ↑↓ select · Enter detail"),
        muted("Esc / Ctrl+C close (workers keep running)"));
    }
    // Tiny terminals still have a keyboard path; never emit over-width lines.
    if (width < 3 || height < 3) return rows.slice(0, height).map((line) => truncateToWidth(line.replace(/[\r\n]/g, " "), width));
    return [border(`╭${"─".repeat(inner)}╮`),
      ...rows.slice(0, height - 2).map((line) => border("│") + truncateToWidth(line.replace(/[\r\n]/g, " "), inner, "…", true) + border("│")),
      border(`╰${"─".repeat(inner)}╯`)];
  }
}

/** One interaction per runtime; registry disposal closes it on reload/replacement. */
export function registerSubagentsUI(pi: ExtensionAPI, registry: () => Registry | undefined) {
  let current: SubagentsOverlay | undefined;
  let opening = false;
  const open = async (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") { ctx.ui.notify("/subagents requires interactive TUI mode. Use get_subagent_result in RPC mode.", "warning"); return; }
    if (opening) return;
    const parent = registry();
    if (!parent) { ctx.ui.notify("Worker registry isn't available; check extension startup errors.", "error"); return; }
    opening = true;
    try {
      await ctx.ui.custom<void>((tui, theme, keys, done) => {
        current = new SubagentsOverlay(tui, theme, keys, parent, done);
        return current;
      }, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%" } });
    } finally { current?.dispose(); current = undefined; opening = false; }
  };
  pi.registerCommand("subagents", { description: "Inspect, steer or stop this parent's workers", handler: async (_args, ctx) => open(ctx) });
  pi.registerShortcut("ctrl+alt+s", { description: "Open subagent workers", handler: open });
  pi.on("session_shutdown", () => { current?.close(); });
}
