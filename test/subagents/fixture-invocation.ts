import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Invocation } from "../../extensions/subagents/rpc.ts";

export function hostInvocation(): Invocation {
  if (process.env.PI_TEST_HOST) return { command: process.env.PI_TEST_HOST, args: [] };
  const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
  return { command: process.execPath, args: [cli] };
}
