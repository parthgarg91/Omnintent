// The tester agent: plays each sample utterance to a model that sees the
// app's tools the way a host would, and records which action it chose and
// with which arguments. Results are compared with the manifest's examples.

import type { Manifest } from "../../manifest.js";
import type { AgentModel, ModelMessage, ResponseBlock, TextBlock, ToolResultBlock, ToolUseBlock } from "../claude.js";
import type { AgentCase, Platform } from "./cases.js";
import { compareArguments, type ArgumentDiff } from "./compare.js";
import type { Surface, SurfaceTool } from "./surfaces.js";

export type Verdict =
  /** Right action, right arguments (or, for an action the platform hides, no write at all). */
  | "pass"
  | "wrong_tool"
  | "wrong_args"
  /** The agent answered in words and called nothing. */
  | "no_action"
  /** A platform hides the action and the agent called a different write action instead. */
  | "unsafe_call"
  | "error";

export interface Step {
  tool: string;
  arguments: Record<string, unknown>;
  /** "lookup": a read the tester answered; "decision": the call that was scored. */
  role: "lookup" | "decision";
}

export interface Attempt {
  verdict: Verdict;
  /** The action the agent decided on (manifest name), or null. */
  chosenTool: string | null;
  chosenArguments?: Record<string, unknown>;
  diffs: ArgumentDiff[];
  steps: Step[];
  /** Times the agent replied in words and the tester answered "Yes, go ahead." */
  followUps: number;
  /** The agent's last words, when it ended without a decision. */
  text?: string;
  error?: string;
}

export interface CaseResult {
  case: AgentCase;
  attempts: Attempt[];
  passes: number;
}

export interface AgentTestReport {
  /** What played the agent: a model ID, or an imported agent such as "Siri". */
  agent: string;
  surface: string;
  platform: Platform;
  runs: number;
  results: CaseResult[];
  notes: string[];
  passes: number;
  total: number;
  passRate: number;
}

export interface RunOptions {
  /** Attempts per case. Models are not deterministic; 3 or more gives a steadier score. */
  runs?: number;
  /** Model turns per attempt, lookups included. */
  maxTurns?: number;
  /** How often the tester answers "Yes, go ahead." when the agent asks instead of acting. */
  maxFollowUps?: number;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

const FOLLOW_UP = "Yes, go ahead.";

export function systemPrompt(manifest: Manifest, surface: Surface): string {
  return [
    `You are an assistant that can act in the app "${manifest.app.name}" through the tools provided.`,
    "Help the user with their request. Use the tools when they fit the request.",
    surface.instructions ? `\nThe app describes itself and its tools as follows:\n<app_instructions>\n${surface.instructions}\n</app_instructions>` : "",
  ].join("\n");
}

function textOf(blocks: ResponseBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function score(c: AgentCase, manifest: Manifest, chosen: string | null, args: Record<string, unknown> | undefined, writes: boolean): Pick<Attempt, "verdict" | "diffs"> {
  if (!c.exposed) return { verdict: writes ? "unsafe_call" : "pass", diffs: [] };
  if (chosen === null) return { verdict: "no_action", diffs: [] };
  if (chosen !== c.expectedTool) return { verdict: "wrong_tool", diffs: [] };
  if (!c.checkArguments) return { verdict: "pass", diffs: [] };
  const action = manifest.actions.find((a) => a.name === chosen);
  const diffs = compareArguments(c.expectedArguments, args, action?.inputSchema);
  return { verdict: diffs.length ? "wrong_args" : "pass", diffs };
}

/** One attempt at one case. Never throws: failures become an "error" verdict. */
export async function runAttempt(c: AgentCase, manifest: Manifest, surface: Surface, model: AgentModel, opts: RunOptions = {}): Promise<Attempt> {
  const maxTurns = opts.maxTurns ?? 6;
  const maxFollowUps = opts.maxFollowUps ?? 1;
  const tools = surface.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const byName = new Map(surface.tools.map((t) => [t.name, t]));
  const system = systemPrompt(manifest, surface);
  const messages: ModelMessage[] = [{ role: "user", content: c.utterance }];
  const steps: Step[] = [];
  let followUps = 0;
  let lastText = "";

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      const response = await model.respond({ system, tools, messages });
      if (response.stop_reason === "refusal") {
        return { verdict: "error", chosenTool: null, diffs: [], steps, followUps, error: "the model refused the request" };
      }
      messages.push({ role: "assistant", content: response.content });
      const uses = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      if (!uses.length) {
        lastText = textOf(response.content);
        if (followUps < maxFollowUps) {
          followUps++;
          messages.push({ role: "user", content: FOLLOW_UP });
          continue;
        }
        break;
      }
      const results: ToolResultBlock[] = [];
      for (const use of uses) {
        const tool: SurfaceTool | undefined = byName.get(use.name);
        const input = use.input ?? {};
        const action = tool?.action ?? use.name;
        const decisive = !tool || !tool.readOnly || action === c.expectedTool;
        if (decisive) {
          steps.push({ tool: action, arguments: input, role: "decision" });
          const writes = !tool || !tool.readOnly;
          return { ...score(c, manifest, action, input, writes), chosenTool: action, chosenArguments: input, steps, followUps };
        }
        steps.push({ tool: action, arguments: input, role: "lookup" });
        const answer = await surface.callRead(tool, input);
        results.push({ type: "tool_result", tool_use_id: use.id, content: answer.content, ...(answer.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (err) {
    return { verdict: "error", chosenTool: null, diffs: [], steps, followUps, error: err instanceof Error ? err.message : String(err) };
  }
  // The agent ended without a decision. Lookups alone count as no action.
  const lookups = steps.filter((s) => s.role === "lookup");
  const last = lookups.at(-1);
  const verdict = score(c, manifest, null, undefined, false).verdict;
  return {
    verdict: c.exposed && last && verdict === "no_action" ? "wrong_tool" : verdict,
    chosenTool: c.exposed && last ? last.tool : null,
    chosenArguments: c.exposed && last ? last.arguments : undefined,
    diffs: [],
    steps,
    followUps,
    text: lastText || undefined,
  };
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

export function summarize(agent: string, surface: string, platform: Platform, runs: number, results: CaseResult[], notes: string[]): AgentTestReport {
  const passes = results.reduce((n, r) => n + r.passes, 0);
  const total = results.reduce((n, r) => n + r.attempts.length, 0);
  return { agent, surface, platform, runs, results, notes, passes, total, passRate: total ? passes / total : 0 };
}

export async function runAgentTest(manifest: Manifest, cases: AgentCase[], surface: Surface, model: AgentModel, opts: RunOptions = {}): Promise<AgentTestReport> {
  const runs = Math.max(1, opts.runs ?? 1);
  const results: CaseResult[] = cases.map((c) => ({ case: c, attempts: [], passes: 0 }));
  const jobs = results.flatMap((r) => Array.from({ length: runs }, () => r));
  let done = 0;
  await pool(jobs, opts.concurrency ?? 4, async (r) => {
    const attempt = await runAttempt(r.case, manifest, surface, model, opts);
    r.attempts.push(attempt);
    if (attempt.verdict === "pass") r.passes++;
    opts.onProgress?.(++done, jobs.length);
  });
  return summarize(model.label, surface.label, surface.platform, runs, results, [...surface.notes]);
}
