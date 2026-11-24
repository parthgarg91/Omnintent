// CLI entry point for the tester agent:
//   omnintent agent-test <omnintent.json> ...

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Manifest } from "../../manifest.js";
import { formatIssues, readManifestFile, validateManifest } from "../../validate.js";
import { claudeAgent, type AgentModel, type Effort } from "../claude.js";
import { exampleCases, type Platform } from "./cases.js";
import { importResults, readResults } from "./import.js";
import { formatAgentReport, markdownAgentReport } from "./report.js";
import { runAgentTest } from "./run.js";
import { manifestSurface, mcpServerSurface, overlaySurface, readFixtures, type Surface } from "./surfaces.js";

export const TESTER_USAGE = `  omnintent agent-test <omnintent.json> [--server <url>] [--platform mcp|ios|android] [--fixtures <file>]
                      [--local-descriptions] [--runs <n>] [--import <results.json>] [--report <file.md>] [--json] [--fail-under <0-1>]
`;

export const TESTER_COMMANDS = `  agent-test   Tester agent: play every sample utterance to Claude acting as an agent
               that sees the app's tools (from a live MCP server, or projected from the
               manifest for mcp, ios or android) and report the action and arguments it
               chose next to the expected ones. --local-descriptions uses this manifest's
               descriptions with the server's data. Needs ANTHROPIC_API_KEY. --import reads
               results recorded from Siri or Android agents (see test --plan).
`;

const SURFACE_OPTIONS = {
  server: { type: "string" },
  "token-env": { type: "string" },
  platform: { type: "string" },
  fixtures: { type: "string" },
  runs: { type: "string" },
  model: { type: "string" },
  effort: { type: "string" },
  concurrency: { type: "string" },
  report: { type: "string" },
  json: { type: "boolean" },
} as const;

class UsageError extends Error {}

function num(value: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new UsageError(`--${name} must be a number from ${min} to ${max}`);
  return n;
}

function loadManifest(path: string | undefined): Manifest {
  if (!path) throw new UsageError("missing <omnintent.json>");
  if (!existsSync(path)) throw new UsageError(`${path} does not exist`);
  const result = validateManifest(readManifestFile(path));
  if (!result.ok || !result.manifest) throw new UsageError(`${path} is not valid:\n${formatIssues(result.issues.filter((i) => i.severity === "error"))}`);
  return result.manifest;
}

function platformOf(value: string | undefined, server: string | undefined): Platform {
  const p = value ?? "mcp";
  if (!["mcp", "ios", "android"].includes(p)) throw new UsageError("--platform must be mcp, ios or android");
  if (server && p !== "mcp") throw new UsageError("--server tests an MCP server; use --platform only without it");
  return p as Platform;
}

function agentModel(values: { model?: string; effort?: string }): AgentModel {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new UsageError("ANTHROPIC_API_KEY is not set; the tester uses Claude to play the agent");
  const effort = values.effort as Effort | undefined;
  if (effort && !["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new UsageError("--effort must be low, medium, high, xhigh or max");
  return claudeAgent({ apiKey, baseUrl: process.env.ANTHROPIC_BASE_URL, model: values.model, effort });
}

async function liveSurface(manifest: Manifest, url: string, tokenEnv: string | undefined): Promise<Surface> {
  const name = tokenEnv ?? "MCP_ACCESS_TOKEN";
  const token = process.env[name];
  if (!token) process.stderr.write(`note: ${name} is not set; connecting without a bearer token\n`);
  return mcpServerSurface({ url, token, manifest });
}

function write(path: string, content: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, content);
}

const progress = (done: number, total: number) => {
  if (process.stderr.isTTY) process.stderr.write(`\r${done}/${total} attempts${done === total ? "\n" : ""}`);
};

async function agentTest(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { ...SURFACE_OPTIONS, import: { type: "string" }, "fail-under": { type: "string" }, "local-descriptions": { type: "boolean" } },
  });
  const manifest = loadManifest(positionals[0]);
  const failUnder = values["fail-under"] === undefined ? undefined : num(values["fail-under"], "fail-under", 1, 0, 1);

  let report;
  if (values.import) {
    report = importResults(manifest, readResults(values.import));
  } else {
    const platform = platformOf(values.platform, values.server);
    const cases = exampleCases(manifest, platform);
    const runs = num(values.runs, "runs", 1, 1, 50);
    const model = agentModel(values);
    const live = values.server ? await liveSurface(manifest, values.server, values["token-env"]) : undefined;
    const surface = live
      ? values["local-descriptions"]
        ? { ...overlaySurface(manifest, live), close: () => live.close() }
        : live
      : manifestSurface(manifest, platform, values.fixtures ? readFixtures(values.fixtures) : {});
    process.stderr.write(`Testing ${cases.length} cases x ${runs} run(s) with ${model.label} against ${surface.label}; each attempt makes 1-6 API calls.\n`);
    try {
      report = await runAgentTest(manifest, cases, surface, model, { runs, concurrency: num(values.concurrency, "concurrency", 4, 1, 32), onProgress: progress });
    } finally {
      await surface.close();
    }
  }
  if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${formatAgentReport(report)}\n`);
  if (values.report) {
    write(values.report, markdownAgentReport(report));
    process.stderr.write(`Wrote ${values.report}\n`);
  }
  return failUnder !== undefined && report.passRate < failUnder ? 1 : 0;
}

/** Runs an agent command; returns undefined when the command is not one of ours. */
export async function runAgentCommand(command: string, argv: string[]): Promise<number | undefined> {
  try {
    if (command === "agent-test") return await agentTest(argv);
    return undefined;
  } catch (err) {
    process.stderr.write(`omnintent ${command}: ${err instanceof Error ? err.message : String(err)}\n`);
    return err instanceof UsageError ? 2 : 1;
  }
}
