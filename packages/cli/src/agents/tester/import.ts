// Results from agents the tester cannot drive itself (Siri through Xcode's
// evaluation report, the AppFunctions testing agent, Gemini). The plan writes
// a results.json template per platform; the developer fills in what the agent
// did, and `omnintent agent-test --import` scores it like a live run.

import { readFileSync } from "node:fs";
import type { Manifest } from "../../manifest.js";
import { camelCase, pascalCase } from "../../naming.js";
import { exampleCases, type AgentCase, type Platform } from "./cases.js";
import { compareArguments } from "./compare.js";
import { summarize, type AgentTestReport, type Attempt, type CaseResult } from "./run.js";

export interface ImportedResult {
  case: string;
  utterance: string;
  expectedTool: string;
  expectedArguments: Record<string, unknown>;
  /**
   * What the agent called: an action name, a Kotlin function name or a Siri
   * intent type. "none" when it called nothing. Leave null for "not run yet".
   */
  chosenTool: string | null;
  chosenArguments?: Record<string, unknown> | null;
  notes?: string;
}

export interface ResultsFile {
  platform: Platform;
  /** Which agent produced the results, e.g. "Siri (iOS 27.3)" or "AppFunctions testing agent". */
  agent: string;
  results: ImportedResult[];
}

export function resultsTemplate(manifest: Manifest, platform: Platform, agent: string): ResultsFile {
  return {
    platform,
    agent,
    results: exampleCases(manifest, platform).map((c) => ({
      case: c.id,
      utterance: c.utterance,
      expectedTool: c.exposed ? c.expectedTool : "none",
      expectedArguments: c.exposed ? c.expectedArguments : {},
      chosenTool: null,
      chosenArguments: null,
      notes: "",
    })),
  };
}

/** Maps a name the agent used (add_item, addItem, AddItemIntent) to the manifest action. */
export function resolveActionName(manifest: Manifest, name: string): string | null {
  const n = name.trim();
  if (!n || n.toLowerCase() === "none") return null;
  for (const a of manifest.actions) {
    if (n === a.name || n === camelCase(a.name) || n === `${pascalCase(a.name)}Intent` || n === pascalCase(a.name)) return a.name;
    if (n.endsWith(`#${camelCase(a.name)}`)) return a.name;
  }
  return n;
}

export function importResults(manifest: Manifest, file: ResultsFile): AgentTestReport {
  const cases = new Map(exampleCases(manifest, file.platform).map((c) => [c.id, c]));
  const results: CaseResult[] = [];
  let skipped = 0;
  for (const r of file.results) {
    if (r.chosenTool === null || r.chosenTool === undefined) {
      skipped++;
      continue;
    }
    const c: AgentCase =
      cases.get(r.case) ??
      ({
        id: r.case,
        utterance: r.utterance,
        expectedTool: r.expectedTool,
        expectedArguments: r.expectedArguments ?? {},
        safety: manifest.actions.find((a) => a.name === r.expectedTool)?.safety ?? "write",
        source: "example",
        exposed: r.expectedTool !== "none",
        checkArguments: true,
      } satisfies AgentCase);
    const chosen = resolveActionName(manifest, r.chosenTool);
    const action = manifest.actions.find((a) => a.name === chosen);
    const args = r.chosenArguments ?? {};
    let attempt: Attempt;
    if (!c.exposed) {
      const writes = chosen !== null && action?.safety !== "read";
      attempt = { verdict: writes ? "unsafe_call" : "pass", chosenTool: chosen, chosenArguments: args, diffs: [], steps: [], followUps: 0 };
    } else if (chosen === null) {
      attempt = { verdict: "no_action", chosenTool: null, diffs: [], steps: [], followUps: 0, text: r.notes || undefined };
    } else if (chosen !== c.expectedTool) {
      attempt = { verdict: "wrong_tool", chosenTool: chosen, chosenArguments: args, diffs: [], steps: [], followUps: 0 };
    } else {
      // Siri and some agents only show the arguments they resolved; null means "not recorded".
      const diffs = r.chosenArguments === null || r.chosenArguments === undefined ? [] : compareArguments(c.expectedArguments, args, action?.inputSchema);
      attempt = { verdict: diffs.length ? "wrong_args" : "pass", chosenTool: chosen, chosenArguments: args, diffs, steps: [], followUps: 0 };
    }
    results.push({ case: c, attempts: [attempt], passes: attempt.verdict === "pass" ? 1 : 0 });
  }
  const notes = skipped ? [`${skipped} case(s) have no result yet (chosenTool is null) and were skipped`] : [];
  return summarize(file.agent, `imported results (${file.platform})`, file.platform, 1, results, notes);
}

export function readResults(path: string): ResultsFile {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ResultsFile>;
  if (!raw || !Array.isArray(raw.results)) throw new Error(`${path}: expected {"platform", "agent", "results": [...]}`);
  if (!["mcp", "ios", "android"].includes(String(raw.platform))) throw new Error(`${path}: platform must be mcp, ios or android`);
  return { platform: raw.platform as Platform, agent: raw.agent ?? "imported agent", results: raw.results };
}
