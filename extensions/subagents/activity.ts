import { createReadStream, statSync, type ReadStream } from "node:fs";
import type { RecordValue } from "./rpc.ts";
import type { WorkerSummary } from "./worker.ts";

type ActivityContent =
  | { kind: "message"; message: RecordValue; complete: boolean }
  | { kind: "tool"; toolCallId: string; parentToolCallId?: string; name: string; args?: RecordValue;
      result?: RecordValue; complete: boolean; isError?: boolean }
  | { kind: "event"; event: RecordValue };
export type ActivityEntry = Readonly<{ id: number; revision: number; attempt: number } & ActivityContent>;
export type ActivitySignal = { kind: "record"; row: RecordValue } | { kind: "summary" };
export type ActivityChange = { kind: "history" | "summary" | "disposed"; from?: number };

// A viewer's callback must never fail the RPC reader or runtime settlement.
export function notify<T>(listeners: Iterable<(event: T) => void>, event: T) {
  for (const listener of [...listeners]) {
    try { listener(event); } catch { /* UI failures don't own the worker. */ }
  }
}

// Reduces the same wire records for history and live output. Entries keep their
// position; only changed entries get a new revision for renderer caches.
export class ActivityHistory {
  readonly entries: ActivityEntry[] = [];
  private attempt = 1;
  private messageIndex?: number;
  private tools = new Map<string, number>();

  private append(entry: ActivityContent) {
    const index = this.entries.length;
    this.entries.push({ ...entry, id: index, revision: 1, attempt: this.attempt });
    return index;
  }
  private replace(index: number, fields: RecordValue) {
    const entry = this.entries[index];
    this.entries[index] = { ...entry, ...fields, revision: entry.revision + 1 };
    return index;
  }
  private message(message: RecordValue, complete: boolean) {
    const index = this.messageIndex;
    if (index !== undefined && this.entries[index].kind === "message" &&
        this.entries[index].message.role === message.role) {
      this.replace(index, { message, complete });
      if (complete) this.messageIndex = undefined;
      return index;
    }
    const added = this.append({ kind: "message", message, complete });
    this.messageIndex = complete ? undefined : added;
    return added;
  }
  private tool(row: RecordValue) {
    const key = `${this.attempt}:${row.toolCallId}`;
    let index = this.tools.get(key);
    if (index === undefined) {
      index = this.append({ kind: "tool", toolCallId: row.toolCallId, name: row.toolName,
        parentToolCallId: row.parentToolCallId, complete: false });
      this.tools.set(key, index);
    }
    return this.replace(index, {
      ...(row.args !== undefined ? { args: row.args } : {}),
      ...(row.partialResult !== undefined ? { result: row.partialResult } : {}),
      ...(row.result !== undefined ? { result: row.result } : {}),
      ...(row.type === "tool_execution_end" ? { complete: true, isError: row.isError } : {}),
    });
  }

  apply(row: RecordValue): number | undefined {
    if (row.type === "worker_attempt") {
      this.attempt = row.attempt;
      this.messageIndex = undefined;
      return this.append({ kind: "event", event: row });
    }
    if (row.type === "worker_result") {
      this.attempt = row.result.attempt;
      this.messageIndex = undefined;
      const index = this.append({ kind: "event", event: row });
      // Old transcripts have settlement markers but no starting markers.
      this.attempt++;
      return index;
    }
    if (row.type === "message_start") {
      if (row.message.role === "toolResult") return;
      this.messageIndex = undefined;
      return this.message(row.message, false);
    }
    if (row.type === "message_end") {
      if (row.message.role === "toolResult") {
        this.messageIndex = undefined;
        return this.tool({ type: "tool_execution_end", toolCallId: row.message.toolCallId,
          toolName: row.message.toolName, result: row.message, isError: row.message.isError });
      }
      return this.message(row.message, true);
    }
    if (row.type === "message_update") {
      const update = row.assistantMessageEvent;
      if (!update || update.contentIndex === undefined) return;
      let index = this.messageIndex;
      const current = index === undefined ? undefined : this.entries[index];
      if (!current || current.kind !== "message" || current.message.role !== "assistant") {
        index = this.message({ role: "assistant", content: [], stopReason: "pending" }, false);
      }
      if (index === undefined) return;
      const entry = this.entries[index];
      if (entry.kind !== "message") return;
      const content = [...entry.message.content];
      const part = { ...content[update.contentIndex] };
      const type = update.type;
      if (type.startsWith("text_")) {
        part.type = "text";
        part.text = type === "text_end" ? update.content : (part.text ?? "") + (update.delta ?? "");
      } else if (type.startsWith("thinking_")) {
        part.type = "thinking";
        part.thinking = type === "thinking_end" ? update.content : (part.thinking ?? "") + (update.delta ?? "");
      } else if (type.startsWith("toolcall_")) {
        part.type = "toolCall";
        if (type === "toolcall_start") Object.assign(part, { id: update.id, name: update.toolName, argumentsText: "" });
        if (type === "toolcall_delta") part.argumentsText = (part.argumentsText ?? "") + update.delta;
        if (type === "toolcall_end") {
          content[update.contentIndex] = update.toolCall;
          return this.replace(index, { message: { ...entry.message, content } });
        }
      } else return;
      content[update.contentIndex] = part;
      return this.replace(index, { message: { ...entry.message, content } });
    }
    if (row.type.startsWith("tool_execution_")) return this.tool(row);
    // Tool result start/end refers to the execution entry, not a second message.
    if (row.type === "response" || row.type === "extension_ui_request") return;
    return this.append({ kind: "event", event: row });
  }
}

/** One disposable history/live view. No timers, RPC commands or ledger reads. */
export class WorkerActivity {
  readonly ready: Promise<void>;
  loading = true;
  disposed = false;
  historyError?: string;
  private history = new ActivityHistory();
  private pending: RecordValue[] = [];
  private stream?: ReadStream;
  private unsubscribe: () => void;
  private listener: (change: ActivityChange) => void;
  private getSummary: () => WorkerSummary;

  constructor(path: string, summary: () => WorkerSummary,
    subscribe: (listener: (event: ActivitySignal) => void) => () => void,
    listener: (change: ActivityChange) => void) {
    this.listener = listener;
    this.getSummary = summary;
    // Capture the prefix and subscribe without yielding. Live records after
    // this byte boundary are buffered while the prefix is read asynchronously.
    let bytes = 0;
    try { bytes = statSync(path).size; } catch (error) { this.historyError = String(error); }
    this.unsubscribe = subscribe((event) => {
      if (this.disposed) return;
      if (event.kind === "summary") this.emit({ kind: "summary" });
      else if (this.loading) this.pending.push(structuredClone(event.row));
      else this.apply(structuredClone(event.row));
    });
    this.ready = this.load(path, bytes);
  }
  get entries(): readonly ActivityEntry[] { return this.history.entries; }
  summary() { return this.getSummary(); }
  private emit(change: ActivityChange) { notify([this.listener], change); }
  private apply(row: RecordValue) {
    const from = this.history.apply(row);
    if (from !== undefined) this.emit({ kind: "history", from });
  }
  private async load(path: string, bytes: number) {
    try {
      if (bytes) {
        this.stream = createReadStream(path, { start: 0, end: bytes - 1, encoding: "utf8" });
        let buffer = "";
        for await (const chunk of this.stream) {
          if (this.disposed) return;
          buffer += chunk;
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end).replace(/\r$/, "");
            buffer = buffer.slice(end + 1);
            if (!line) continue;
            try { this.history.apply(JSON.parse(line)); }
            catch (error) { this.historyError = `Couldn't read a transcript record: ${error}`; }
          }
        }
        if (buffer.trim()) this.historyError = "Transcript ends with an incomplete record; earlier output is retained.";
      }
    } catch (error) {
      if (!this.disposed) this.historyError = `Couldn't read worker history: ${error}`;
    } finally {
      this.stream = undefined;
      if (!this.disposed) {
        for (const row of this.pending) this.history.apply(row);
        this.pending = [];
        this.loading = false;
        // Even an empty transcript resolves asynchronously, after construction.
        await Promise.resolve();
        if (!this.disposed) this.emit({ kind: "history", from: 0 });
      }
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.loading = false;
    this.unsubscribe();
    this.stream?.destroy();
    this.pending = [];
    this.history = new ActivityHistory();
    this.emit({ kind: "disposed" });
    this.listener = () => {};
  }
}
