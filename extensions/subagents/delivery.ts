import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { Registry } from "./registry.ts";
import type { WorkerResult } from "./worker.ts";

export const readyType = "pi-rpc-subagent-ready";
const ledgerType = "pi-rpc-subagent-delivery";
const controlType = "pi-rpc-subagent-control";
type Usage = WorkerResult["usage"];
type Receipt = { id: string; attempt: number; total: Usage; delta: Usage };
type Reservation = { callId: string; reports: Receipt[] };
export type DeliveryState = {
  paused: boolean; canceled: boolean; notices: Set<string>; reservations: Reservation[];
};
export const newDeliveryState = (): DeliveryState => ({ paused: false, canceled: false, notices: new Set(), reservations: [] });
const key = (report: Pick<WorkerResult, "id" | "attempt">) => `${report.id}/${report.attempt}`;
const noticeKey = (report: WorkerResult) => key(report) + (report.usageOnly ? "/usage" : "");
const owed = (report: WorkerResult, total?: Usage) => report.usage.totalTokens > (total?.totalTokens ?? 0) || report.usage.cost.total > (total?.cost.total ?? 0);
const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
function maximum(a: Usage, b: Usage) {
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) a[field] = Math.max(a[field], b[field]);
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) a.cost[field] = Math.max(a.cost[field], b.cost[field]);
}
function increment(sum: Usage, total: Usage, previous: Usage) {
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) sum[field] += Math.max(0, total[field] - previous[field]);
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) sum.cost[field] += Math.max(0, total.cost[field] - previous.cost[field]);
}

/** Reports stay on disk; only committed parent tool results acknowledge them. */
export class Delivery {
  private handled = new Set<string>();
  private totals = new Map<string, Usage>();
  private detached = false;
  private pi: ExtensionAPI;
  private registry: Registry;
  private ctx: ExtensionContext;
  constructor(pi: ExtensionAPI, registry: Registry, ctx: ExtensionContext, live: boolean) {
    this.pi = pi;
    this.registry = registry;
    this.ctx = ctx;
    if (!live) {
      registry.deliveryState = newDeliveryState();
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "custom" && entry.customType === controlType) {
          const state = entry.data as { paused: boolean; canceled: boolean };
          registry.deliveryState.paused = state.paused;
          registry.deliveryState.canceled = state.canceled;
        }
      }
    }
    this.refresh();
  }
  get paused() { return this.registry.deliveryState.paused; }
  private get state() { return this.registry.deliveryState; }
  detach() { this.detached = true; }
  refresh(endOfTurn = false) {
    this.handled.clear();
    this.totals.clear();
    const entries = this.ctx.sessionManager.getEntries();
    const committed = new Set(entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId] : []));
    const accept = (receipt: Receipt) => {
      this.handled.add(key(receipt));
      const total = this.totals.get(receipt.id) ?? emptyUsage();
      increment(total, receipt.delta, emptyUsage());
      this.totals.set(receipt.id, total);
    };
    const ledgerCalls = new Set(entries.flatMap(entry => entry.type === "custom" && entry.customType === ledgerType ? [(entry.data as Reservation).callId] : []));
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === ledgerType) {
        const ledger = entry.data as Reservation;
        if (committed.has(ledger.callId)) for (const receipt of ledger.reports) accept(receipt);
      }
      // Accept receipts from the previous extension version, including nested retrieval.
      if (entry.type === "custom" && entry.customType === "pi-rpc-subagent-usage") {
        const ledger = entry.data as { id: string; callId: string; total: Usage };
        if (committed.has(ledger.callId)) {
          const total = this.totals.get(ledger.id) ?? emptyUsage();
          maximum(total, ledger.total);
          this.totals.set(ledger.id, total);
        }
      }
      if (entry.type === "message" && entry.message.role === "toolResult") {
        const report = entry.message.details as WorkerResult | undefined;
        if (report?.id && report.attempt && !["starting", "running"].includes(report.status) && !ledgerCalls.has(entry.message.toolCallId)) {
          this.handled.add(key(report));
          const total = this.totals.get(report.id) ?? emptyUsage();
          maximum(total, report.usage);
          this.totals.set(report.id, total);
        }
      }
      if (entry.type === "custom_message" && entry.customType === "pi-rpc-subagent-completion") {
        const report = entry.details as WorkerResult;
        this.handled.add(key(report));
      }
    }
    this.state.reservations = this.state.reservations.filter(item => !committed.has(item.callId) && !endOfTurn);
    for (const worker of this.registry.workers.values()) {
      const attempts = worker.reports.filter(item => this.handled.has(key(item.result))).map(item => item.result.attempt);
      worker.reconcile(Math.max(0, ...attempts), this.totals.get(worker.id));
    }
  }
  pending() {
    this.refresh();
    const reserved = new Set(this.state.reservations.flatMap(item => item.reports.map(key)));
    return [...this.registry.workers.values()].flatMap(worker => worker.reports
      .filter(item => item.background && (!this.handled.has(key(item.result)) || owed(item.result, this.totals.get(worker.id))) && !reserved.has(key(item.result)))
      .map(item => ({ ...structuredClone(item.result), ...(this.handled.has(key(item.result)) ? { text: "", usageOnly: true } : {}) })));
  }
  reserve(reports: WorkerResult[], callId: string) {
    this.refresh();
    const usage = emptyUsage();
    const reserved = new Map(this.totals);
    for (const reservation of this.state.reservations) for (const receipt of reservation.reports) {
      const total = structuredClone(reserved.get(receipt.id) ?? emptyUsage());
      maximum(total, receipt.total);
      reserved.set(receipt.id, total);
    }
    const receipts: Receipt[] = [];
    for (const report of reports) {
      const total = structuredClone(reserved.get(report.id) ?? emptyUsage());
      const delta = emptyUsage();
      increment(delta, report.usage, total);
      increment(usage, delta, emptyUsage());
      maximum(total, report.usage);
      reserved.set(report.id, total);
      if (!this.handled.has(key(report)) || delta.totalTokens || delta.cost.total) receipts.push({ id: report.id, attempt: report.attempt, total, delta });
    }
    if (receipts.length) {
      const reservation = { callId: callId.split("/")[0], reports: receipts };
      this.state.reservations.push(reservation);
      this.pi.appendEntry(ledgerType, reservation);
    }
    return usage.totalTokens || usage.cost.total ? usage : undefined;
  }
  private notice() {
    const reports = this.pending().filter(report => !this.state.notices.has(noticeKey(report)));
    if (!reports.length) return undefined;
    for (const report of reports) this.state.notices.add(noticeKey(report));
    return { customType: readyType, display: false,
      content: "Subagent results are ready. Call wait_for_subagents once to collect all available reports and account their usage. " +
        "Use the reports for the task; don't emit acknowledgment-only replies. Already handled reports won't be repeated.",
      details: { reports: reports.map(report => ({ id: report.id, attempt: report.attempt })) } };
  }
  boundary(outcome: string) {
    this.refresh(true);
    if (outcome === "aborted") this.cancel();
    if (this.detached || this.paused || this.state.canceled) return undefined;
    const notice = this.notice();
    return notice ? { entries: [{ type: "custom_message", ...notice } satisfies SessionBoundaryDraft], continue: true } : undefined;
  }
  wake() {
    if (this.detached || this.paused || this.state.canceled || !this.ctx.isIdle()) return;
    const notice = this.notice();
    if (notice) this.pi.sendMessage(notice, { triggerTurn: true });
  }
  private saveControl() { this.pi.appendEntry(controlType, { paused: this.paused, canceled: this.state.canceled }); }
  cancel() {
    if (this.detached || this.state.canceled) return;
    this.state.canceled = true;
    this.state.notices.clear();
    this.saveControl();
  }
  input() {
    if (this.state.canceled) { this.state.canceled = false; this.state.notices.clear(); this.saveControl(); }
  }
  pause() { this.state.paused = true; this.saveControl(); }
  resume() { this.state.paused = false; this.state.canceled = false; this.state.notices.clear(); this.saveControl(); this.wake(); }
}
