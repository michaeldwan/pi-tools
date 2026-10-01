import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync, existsSync, realpathSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { Worker } from "./worker.ts";
import type { Invocation } from "./rpc.ts";
import { notify, type WorkerActivity, type ActivityChange } from "./activity.ts";

function sessionPath(path: string) {
  if (existsSync(path)) return realpathSync(path);
  let directory = dirname(resolve(path));
  let suffix = basename(path);
  while (!existsSync(directory)) {
    suffix = join(basename(directory), suffix);
    directory = dirname(directory);
  }
  return join(realpathSync(directory), suffix);
}

// Reload replaces modules, but not the process that owns these pipe handles.
// Never recreate live handles from disk or attach to a persisted worker PID.
const key = Symbol.for("pi-rpc-subagents.registries.v1");
const globals = globalThis as typeof globalThis & { [key]?: Map<string, Registry> };
const registries = globals[key] ??= new Map<string, Registry>();

export class Registry {
  readonly workers = new Map<string, Worker>();
  changed: (worker: Worker) => void = () => {};
  private lock: string;
  private closing?: Promise<void>;
  private detaching = false;
  private shuttingDown = false;
  private viewers = new Set<RegistryView>();
  readonly directory: string;
  private constructor(directory: string, invocation: Invocation) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lock = join(directory, "owner.json");
    try {
      writeFileSync(this.lock, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Serialize stale-lock removal, so competing restarts can't remove a
      // newly acquired owner's lock. Failure is conservative, never attachment.
      const recovery = join(directory, "recovering");
      try { mkdirSync(recovery, { mode: 0o700 }); } catch {
        throw new Error(`Worker registry recovery is locked at ${recovery}. Retry after the other startup finishes; if it crashed, remove only this empty directory.`);
      }
      try {
        const owner = JSON.parse(readFileSync(this.lock, "utf8"));
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error(`Invalid worker registry owner: ${this.lock}`);
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
        if (alive) throw new Error("Another parent process owns this session's workers. Close it before resuming here.");
        unlinkSync(this.lock);
        writeFileSync(this.lock, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
      } finally { rmdirSync(recovery); }
    }
    try {
      for (const name of readdirSync(directory)) {
        // No ID was returned before initial state was written. Keep an
        // unfinished directory as evidence without hiding valid workers.
        if (!name.startsWith("worker-") || !existsSync(join(directory, name, "state.json"))) continue;
        const worker = Worker.recover(join(directory, name), invocation);
        this.add(worker);
      }
    } catch (error) {
      unlinkSync(this.lock);
      throw error;
    }
  }

  static open(agentDir: string, session: string, invocation: Invocation, file?: string) {
    const identity = file ? sessionPath(file) : `ephemeral:${session}`;
    const directory = join(agentDir, "pi-rpc-subagents", createHash("sha256").update(identity).digest("hex"));
    const live = registries.get(directory);
    if (live) return { registry: live, live: true };
    const registry = new Registry(directory, invocation);
    registries.set(directory, registry);
    return { registry, live: false };
  }

  newDirectory() { return mkdtempSync(join(this.directory, "worker-")); }
  add(worker: Worker) {
    this.workers.set(worker.id, worker);
    worker.setChanged((current) => this.changed(current));
    worker.onActivity((event) => {
      if (event.kind === "summary") for (const view of [...this.viewers]) view.changed(worker.id);
    });
    for (const view of [...this.viewers]) view.changed(worker.id);
  }
  observe(listener: (change: RegistryChange) => void) {
    if (this.detaching || this.shuttingDown) throw new Error("Parent worker registry is detaching or closing");
    const view = new RegistryView(this, listener, () => { this.viewers.delete(view); });
    this.viewers.add(view);
    return view;
  }
  detach() {
    this.changed = () => {};
    this.detaching = true;
    try { for (const view of [...this.viewers]) view.dispose(); }
    finally { this.detaching = false; }
  }
  close(reason: string) {
    this.shuttingDown = true;
    return this.closing ??= (async () => {
      this.detach();
      await Promise.all([...this.workers.values()].map((worker) => worker.stop(reason)));
      unlinkSync(this.lock);
      registries.delete(this.directory);
    })();
  }
}

export type RegistryChange = { kind: "worker"; id: string } | { kind: "disposed" };

/** Captures one parent's registry; detach invalidates history and actions. */
export class RegistryView {
  disposed = false;
  private registry: Registry;
  private listener: (change: RegistryChange) => void;
  private release: () => void;
  private activities = new Set<WorkerActivity>();
  constructor(registry: Registry, listener: (change: RegistryChange) => void, release: () => void) {
    this.registry = registry;
    this.listener = listener;
    this.release = release;
  }
  summaries() {
    this.assertActive();
    return [...this.registry.workers.values()].map((worker) => worker.summary());
  }
  private assertActive() {
    if (this.disposed) throw new Error("Worker view belongs to a closed interaction or replaced parent session; reopen it");
  }
  private lookup(id: string) {
    this.assertActive();
    const worker = this.registry.workers.get(id);
    if (!worker) throw new Error(`Unknown worker ${id} in this parent session`);
    return worker;
  }
  activity(id: string, listener: (change: ActivityChange) => void) {
    const activity = this.lookup(id).observe((change) => {
      if (change.kind === "disposed") this.activities.delete(activity);
      listener(change);
    });
    this.activities.add(activity);
    return activity;
  }
  steer(id: string, message: string) { return this.lookup(id).steer(message); }
  stop(id: string) { return this.lookup(id).stop(); }
  changed(id: string) {
    if (!this.disposed) notify([this.listener], { kind: "worker", id });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.release();
    for (const activity of [...this.activities]) activity.dispose();
    notify([this.listener], { kind: "disposed" });
    this.listener = () => {};
  }
}
