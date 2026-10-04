import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { assertSessionAvailable } from "./rpc.ts";

export const childConfigKey = "PI_RPC_SUBAGENT_CHILD";
export const delegationTools = ["subagent", "get_subagent_result", "steer_subagent", "stop_subagent", "wait_for_subagents"];
export interface ChildConfig { tools?: string[]; readOnly?: boolean; parentPid?: number; leasePath?: string }

export default function guard(pi: ExtensionAPI) {
  const raw = process.env[childConfigKey];
  if (!raw) return;
  const config: ChildConfig = JSON.parse(raw);
  const permitted = (name: string) => {
    if (delegationTools.includes(name)) return false;
    if (config.tools && !config.tools.includes(name)) return false;
    if (config.readOnly && !["read", "grep", "find", "ls", "codemode", "tool_search"].includes(name)) {
      return pi.getAllTools().find((tool) => tool.name === name)?.annotations?.readOnlyHint === true;
    }
    return true;
  };
  const restrict = () => pi.setActiveTools(pi.getActiveTools().filter(permitted));
  let watchdog: NodeJS.Timeout | undefined;
  const leaseKey = Symbol.for("pi-rpc-subagent.session-owner.v1");
  const globalLease = globalThis as typeof globalThis & { [leaseKey]?: Server };
  let lease = globalLease[leaseKey];
  let leaseError: unknown;
  pi.on("session_start", async (_event, ctx) => {
    restrict();
    if (config.leasePath && !lease) {
      try {
        await assertSessionAvailable(config.leasePath);
        if (existsSync(config.leasePath)) unlinkSync(config.leasePath);
        lease = createServer((socket) => {
          // Let the client close after observing connect. Immediate EOF can
          // appear as ECONNREFUSED in the standalone host before connect fires.
          socket.on("error", () => socket.destroy());
          socket.setTimeout(5000, () => socket.destroy());
          socket.unref();
          socket.resume();
        });
        await new Promise<void>((resolve, reject) => {
          lease!.once("error", reject);
          lease!.listen(config.leasePath, resolve);
        });
        lease.unref();
        globalLease[leaseKey] = lease;
      } catch (error) { leaseError = error; }
    }
    if (config.parentPid) {
      watchdog = setInterval(() => {
        if (process.ppid === config.parentPid) return;
        clearInterval(watchdog);
        ctx.abort();
        ctx.shutdown();
      }, 250);
      watchdog.unref();
    }
  });
  pi.on("session_shutdown", () => {
    clearInterval(watchdog);
    // Shutdown handlers can still be running. Keep process ownership until
    // exit; an unreferenced socket doesn't hold pi open and survives reload.
  });
  pi.on("before_agent_start", () => { restrict(); });
  // Active tool selection alone doesn't restrict nested codemode calls.
  pi.on("tool_call", (event) => {
    if (!permitted(event.toolName)) {
      return { block: true, reason: `Tool ${event.toolName} isn't permitted in this worker` };
    }
  });
  pi.registerCommand("pi-rpc-worker-inspect", {
    description: "Inspect an RPC worker before submitting work",
    handler: async (_args, ctx) => {
      if (leaseError) throw leaseError;
      restrict();
      const active = pi.getActiveTools();
      const tools = pi.getAllTools().filter((tool) => permitted(tool.name) && tool.exposure !== "hidden");
      const callable = tools.filter((tool) => active.includes(tool.name) ||
        (["codemode", "deferred"].includes(tool.exposure ?? "direct") &&
          (active.includes("codemode") || active.includes("tool_search")))).map((tool) => tool.name);
      ctx.ui.notify("pi-rpc-worker:" + JSON.stringify({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted(), active, callable }));
    },
  });
}
