// CLI handlers for the watcher agent (`omnintent watch`) and the submission helper
// (`omnintent submit-prep`). Kept apart from cli.ts so each agent stays in its own files.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeFiles } from "../generators/index.js";
import type { Manifest } from "../manifest.js";
import { parseSubmitPlatforms, prepareSubmission } from "./submit/submit.js";
import { formatWatchReport, issueTitle, runWatch, type WatchState } from "./watch/watch.js";

export const AGENT_HELP = `  omnintent watch [--research docs/RESEARCH.md] [--state docs/watch-state.json]
                  [--update-state] [--report <file.md>] [--report-json <file.json>]
                  [--only <id,id>] [--json]
  omnintent submit-prep <omnintent.json> --out <dir> [--platform ios,android,mcp|all]
`;

export const AGENT_COMMANDS = `  watch        Watcher agent: check the Siri, AppFunctions, MCP and Cloudflare
               sources against docs/RESEARCH.md and the last snapshot. Writes a
               report; --update-state records the new snapshot. Edits nothing else.
  submit-prep  Submission helper: write TestFlight notes, a Google Connected
               Console draft and an MCP connector listing. Sends nothing.
`;

export interface WatchFlags {
  research?: string;
  state?: string;
  "update-state"?: boolean;
  report?: string;
  "report-json"?: string;
  only?: string;
  json?: boolean;
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, text);
}

export async function watchCommand(flags: WatchFlags): Promise<void> {
  const researchPath = flags.research ?? "docs/RESEARCH.md";
  const statePath = flags.state ?? "docs/watch-state.json";
  if (!existsSync(researchPath)) throw new Error(`${researchPath} does not exist (pass --research)`);
  const research = readFileSync(researchPath, "utf8");
  const state = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as WatchState) : undefined;
  const report = await runWatch({
    research,
    state,
    only: flags.only ? flags.only.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
  });
  const markdown = formatWatchReport(report);
  if (flags.report) writeText(flags.report, markdown);
  const { nextState, ...summary } = report;
  if (flags["report-json"]) writeText(flags["report-json"], `${JSON.stringify({ ...summary, title: issueTitle(report) }, null, 2)}\n`);
  if (flags["update-state"]) writeText(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
  if (flags.json) process.stdout.write(`${JSON.stringify({ ...summary, title: issueTitle(report) }, null, 2)}\n`);
  else process.stdout.write(markdown);
}

export function submitPrepCommand(manifest: Manifest, out: string, platform?: string): void {
  const bundle = prepareSubmission(manifest, { platforms: parseSubmitPlatforms(platform ?? "all") });
  writeFiles(resolve(out), bundle.files);
  for (const w of bundle.warnings) process.stderr.write(`warning (${w.platform}): ${w.message}\n`);
  process.stdout.write(`Wrote ${bundle.files.length} draft files to ${out}. Nothing was sent; review and submit them yourself.\n`);
}
