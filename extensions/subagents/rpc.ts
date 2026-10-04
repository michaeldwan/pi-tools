import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { createConnection } from "node:net";

// A live socket refuses a new attempt while a previous child is still exiting.
// This checks ownership only; it never attaches to an old RPC process or PID.
export async function assertSessionAvailable(path: string) {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve();
      socket.destroy();
    };
    socket.setTimeout(1000);
    socket.once("connect", () => finish(new Error("A previous child still owns this worker session. Retry resume after it exits.")));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(["ENOENT", "ECONNREFUSED"].includes(error.code ?? "") ? undefined : error);
    });
    socket.once("timeout", () => finish(new Error("Worker session ownership check timed out; refusing resume")));
  });
}

export interface Invocation { command: string; args: string[] }
export type RecordValue = Record<string, any>;

// RpcClient starts `node <cliPath>`; pi's installed standalone binary needs
// direct execution instead. Keep both forms, like pi's subprocess example.
export function piInvocation(): Invocation {
  const script = process.argv[1];
  if (/^(node|bun)(\.exe)?$/i.test(basename(process.execPath))) {
    if (script && !script.startsWith("/$bunfs/") && existsSync(script)) {
      return { command: process.execPath, args: [script] };
    }
    return { command: "pi", args: [] };
  }
  return { command: process.execPath, args: [] };
}

export class JsonLines {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private receive: (record: RecordValue) => void;
  constructor(receive: (record: RecordValue) => void) { this.receive = receive; }
  push(chunk: Buffer) {
    this.buffer += this.decoder.write(chunk);
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, "");
      this.buffer = this.buffer.slice(end + 1);
      if (line) this.receive(JSON.parse(line));
    }
  }
  end() {
    this.buffer += this.decoder.end();
    if (this.buffer.trim()) throw new Error("RPC stdout ended with an incomplete JSONL record");
  }
}

export class RpcProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (value: RecordValue) => void; reject: (error: Error) => void }>();
  private listeners = new Set<(record: RecordValue) => void>();
  private sequence = 0;
  private failure?: Error;
  private stderr = "";
  private closed: Promise<void>;
  private exited: Promise<void>;
  private didClose = false;
  private didExit = false;
  private spawned = false;
  private closing?: Promise<void>;

  constructor(invocation: Invocation, cwd: string, args: string[], env: NodeJS.ProcessEnv,
    record: (row: RecordValue) => void = () => {}) {
    this.child = spawn(invocation.command, [...invocation.args, "--mode", "rpc", ...args], {
      cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false,
      // A separate group lets us signal descendants that inherited RPC pipes,
      // without touching the caller's process group.
      detached: process.platform !== "win32",
    });
    const reader = new JsonLines((row) => {
      record(row);
      if (row.type === "response" && this.pending.has(row.id)) {
        const request = this.pending.get(row.id)!;
        this.pending.delete(row.id);
        if (row.success) request.resolve(row);
        else request.reject(new Error(row.error || `RPC ${row.command} failed`));
      } else {
        for (const listener of this.listeners) listener(row);
      }
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      try { reader.push(chunk); } catch (error) { this.fail(error as Error); }
    });
    this.child.stdout.on("end", () => {
      try { reader.end(); } catch (error) { this.fail(error as Error); }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      record({ type: "stderr", text: chunk.toString() });
      this.stderr = (this.stderr + chunk.toString()).slice(-8192);
    });
    this.child.once("spawn", () => { this.spawned = true; });
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.exited = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.didExit = true;
        this.fail(new Error(`Pi RPC exited (code=${code}, signal=${signal}). ${this.stderr}`));
        resolve();
      });
      this.child.once("error", () => { if (!this.spawned) resolve(); });
    });
    this.closed = new Promise((resolve) => this.child.once("close", (code, signal) => {
      this.didClose = true;
      this.fail(new Error(`Pi RPC exited (code=${code}, signal=${signal}). ${this.stderr}`));
      resolve();
    }));
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    for (const listener of this.listeners) listener({ type: "transport_error", error: error.message });
  }

  onRecord(listener: (record: RecordValue) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async send(command: RecordValue, timeoutMs = 30_000): Promise<RecordValue> {
    if (this.failure) throw this.failure;
    if (this.closing) throw new Error("Pi RPC is closing; refusing new commands");
    const id = `worker-${++this.sequence}`;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<RecordValue>((resolve, reject) => {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Pi RPC ${command.type} timed out after ${timeoutMs}ms. ${this.stderr}`));
        }, timeoutMs);
        this.pending.set(id, { resolve, reject });
        // The callback waits for buffered data to flush, including backpressure.
        this.child.stdin.write(JSON.stringify({ ...command, id }) + "\n", (error) => {
          if (error) this.fail(error);
        });
      });
    } finally { clearTimeout(timer); }
  }

  async inspect(timeoutMs: number): Promise<RecordValue> {
    let snapshot: RecordValue | undefined;
    const unsubscribe = this.onRecord((row) => {
      if (row.type === "extension_ui_request" && row.method === "notify" &&
          row.message.startsWith("pi-rpc-worker:")) {
        snapshot = JSON.parse(row.message.slice("pi-rpc-worker:".length));
      }
    });
    try {
      const response = await this.send({ type: "prompt", message: "/pi-rpc-worker-inspect" }, timeoutMs);
      if (response.data?.disposition !== "handled" || !snapshot) {
        throw new Error("Pi worker inspection command wasn't handled; refusing to send work");
      }
      return snapshot;
    } finally { unsubscribe(); }
  }

  async run(task: string, signal?: AbortSignal, timeoutMs = 600_000): Promise<void> {
    if (signal?.aborted) throw new Error("Subagent launch aborted");
    let unsubscribe = () => {};
    let timer: NodeJS.Timeout | undefined;
    let abort = () => {};
    let handled = () => {};
    const settled = new Promise<void>((resolve, reject) => {
      handled = resolve;
      timer = setTimeout(() => reject(new Error(`Pi worker didn't settle within ${timeoutMs}ms`)), timeoutMs);
      abort = () => reject(new Error("Subagent run aborted"));
      signal?.addEventListener("abort", abort, { once: true });
      unsubscribe = this.onRecord((row) => {
        if (row.type === "agent_settled") resolve();
        if (row.type === "transport_error") reject(new Error(row.error));
      });
    });
    // Attach a rejection handler before the command response can fail.
    const acceptance = this.send({ type: "prompt", message: task }, Math.min(30_000, timeoutMs)).then((response) => {
      if (response.data?.disposition === "handled") handled();
    });
    try { await Promise.all([acceptance, settled]); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      unsubscribe();
    }
  }

  async cancel(): Promise<void> {
    // Abort alone can continue queued steering/follow-up work.
    await this.send({ type: "clear_queue" }, 1500);
    await this.send({ type: "abort" }, 3000);
  }

  close(): Promise<void> {
    return this.closing ??= this.shutdown();
  }

  private async waitFor(promise: Promise<void>, timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([promise, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
    } finally { clearTimeout(timer); }
  }

  private signal(signal: NodeJS.Signals) {
    if (!this.spawned || !this.child.pid) return;
    try {
      if (process.platform === "win32") {
        if (!this.didExit) this.child.kill(signal);
      } else process.kill(-this.child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        this.fail(new Error(`Pi RPC ${signal} failed: ${String(error)}. ${this.stderr}`));
      }
    }
  }

  private async shutdown(): Promise<void> {
    if (this.didClose) return;
    const started = Date.now();
    this.child.stdin.end();
    // exit tracks the direct process; close also waits for inherited pipes.
    // Neither pipe lifetime nor a failed kill may hold cleanup indefinitely.
    await this.waitFor(this.exited, 1500);
    if (!this.didClose) {
      this.signal("SIGTERM");
      await this.waitFor(this.closed, Math.max(0, 5000 - (Date.now() - started)));
    }
    if (!this.didClose) {
      this.signal("SIGKILL");
      await this.waitFor(this.closed, 1000);
    }
    if (!this.didClose) {
      const diagnostic = `Pi RPC shutdown left open pipes; closing transport (pid=${this.child.pid}, exited=${this.didExit}). ${this.stderr}`;
      this.fail(new Error(diagnostic));
      for (const listener of this.listeners) listener({ type: "shutdown_error", error: diagnostic });
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      await this.waitFor(this.closed, 100);
      if (this.spawned && !this.didExit) {
        throw new Error(`Pi RPC shutdown did not terminate process ${this.child.pid}. ${this.stderr}`);
      }
      throw new Error(diagnostic);
    }
    if (this.spawned && !this.didExit) {
      throw new Error(`Pi RPC shutdown did not terminate process ${this.child.pid}. ${this.stderr}`);
    }
  }
}
