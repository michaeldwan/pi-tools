import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = typeof thinkingLevels[number];
export interface AgentDefinition {
  name: string;
  prompt: string;
  model?: string;
  thinking?: Thinking;
  tools?: string[];
  requiredTools?: string[];
  readOnly?: boolean;
}

export function toolList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const values = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(values) || values.some((item) => typeof item !== "string")) {
    throw new Error("Agent tools must be a comma-separated string or string array");
  }
  return values.map((item) => item.trim()).filter(Boolean);
}

export function discoverAgents(cwd: string, projectTrusted: boolean, agentDir = getAgentDir()): Map<string, AgentDefinition> {
  const agents = new Map<string, AgentDefinition>([
    ["general-purpose", { name: "general-purpose", prompt: "" }],
    ["Explore", { name: "Explore", prompt: "Explore the requested code or question. Don't change files.",
      tools: ["read", "grep", "find", "ls"], readOnly: true }],
    ["Plan", { name: "Plan", prompt: "Develop the requested plan. Don't change files.",
      tools: ["read", "grep", "find", "ls"], readOnly: true }],
  ]);
  const dirs = [join(agentDir, "agents")];
  if (projectTrusted) {
    let directory = cwd;
    while (true) {
      const candidate = join(directory, ".pi", "agents");
      if (existsSync(candidate)) { dirs.push(candidate); break; }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  for (const directory of dirs) {
    if (!existsSync(directory)) continue;
    for (const file of readdirSync(directory).sort()) {
      if (!file.endsWith(".md")) continue;
      const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(readFileSync(join(directory, file), "utf8"));
      const name = typeof frontmatter.name === "string" ? frontmatter.name : file.slice(0, -3);
      const thinking = frontmatter.thinking ?? frontmatter.thinkingLevel;
      if (thinking !== undefined && !thinkingLevels.includes(thinking as Thinking)) {
        throw new Error(`Invalid thinking level in ${join(directory, file)}`);
      }
      agents.set(name, {
        name, prompt: body,
        model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
        thinking: thinking as Thinking | undefined,
        tools: toolList(frontmatter.tools), requiredTools: toolList(frontmatter.requiredTools),
      });
    }
  }
  return agents;
}

export function resolveModel(parentModel: string | undefined, parentThinking: Thinking | undefined,
  agent: AgentDefinition, model?: string, thinking?: Thinking): { model: string; thinking: Thinking } {
  let selected = model ?? agent.model ?? parentModel;
  if (!selected) throw new Error("No parent model is selected; supply an explicit provider/model");
  const suffix = selected.match(/:(off|minimal|low|medium|high|xhigh|max)$/);
  if (suffix) selected = selected.slice(0, -suffix[0].length);
  return { model: selected, thinking: thinking ?? suffix?.[1] as Thinking ?? agent.thinking ?? parentThinking ?? "off" };
}
