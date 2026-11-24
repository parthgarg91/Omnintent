#!/usr/bin/env node
// omnintent: validate, generate, discover, test, build.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { formatBuildReport, GitHubRest, loadBuilderConfig, runBuilder } from "./builder/index.js";
import { AGENT_COMMANDS, AGENT_HELP, submitPrepCommand, watchCommand } from "./agents/commands.js";
import { discover } from "./discover/index.js";
import { generate, parseTargets, writeFiles } from "./generators/index.js";
import { CLI_VERSION, type Manifest } from "./manifest.js";
import { formatReport, testManifest, testPlan } from "./testcmd.js";
import { formatIssues, readManifestFile, validateManifest } from "./validate.js";

const HELP = `omnintent ${CLI_VERSION} - describe your app's actions once, reach every agent.

Usage:
  omnintent validate <omnintent.json> [--json]
  omnintent generate <omnintent.json> --target swift|kotlin|mcp|all --out <dir>
  omnintent discover <openapi-file|code-directory> [--out omnintent.json] [--no-ai] [--model <id>] [--force]
  omnintent test <omnintent.json> [--plan <dir>] [--json]
  omnintent build [--config omnintent.builder.json] [--since <git-ref>] [--platform swift,kotlin,mcp]
                  [--dry-run <dir>] [--no-ai] [--model <id>] [--json]
${AGENT_HELP}
Commands:
  validate  Check the manifest against the JSON Schema and the rule book.
  generate  Write Swift App Intents, Kotlin AppFunctions and/or an MCP server.
  discover  Draft a manifest from an OpenAPI file or a codebase. With
            ANTHROPIC_API_KEY set, Claude refines the draft. Only a valid
            manifest is ever written.
  test      Check that sample utterances match their expected arguments.
            --plan writes test cases for SiriEvaluations, adb and MCP.
  build     Builder agent: regenerate each configured platform, wire it into
            the app with Claude (ANTHROPIC_API_KEY), and open one draft pull
            request per platform (GITHUB_TOKEN). Never merges or deploys.
            --since compares with the manifest at a git ref; --dry-run writes
            the planned branches to a folder instead of GitHub.
${AGENT_COMMANDS}`;

function fail(message: string): never {
  process.stderr.write(`omnintent: ${message}\n`);
  process.exit(1);
}

function loadValid(path: string, json: boolean): Manifest {
  if (!existsSync(path)) fail(`${path} does not exist`);
  const result = validateManifest(readManifestFile(path));
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: result.ok, issues: result.issues }, null, 2)}\n`);
  } else if (result.issues.length) {
    process.stderr.write(`${formatIssues(result.issues)}\n`);
  }
  if (!result.ok || !result.manifest) {
    if (!json) process.stderr.write(`${path} is not valid.\n`);
    process.exit(1);
  }
  return result.manifest;
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      target: { type: "string", short: "t" },
      out: { type: "string", short: "o" },
      json: { type: "boolean" },
      plan: { type: "string" },
      "no-ai": { type: "boolean" },
      model: { type: "string" },
      force: { type: "boolean" },
      config: { type: "string" },
      since: { type: "string" },
      "dry-run": { type: "string" },
      research: { type: "string" },
      state: { type: "string" },
      "update-state": { type: "boolean" },
      report: { type: "string" },
      "report-json": { type: "string" },
      only: { type: "string" },
      platform: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command, input] = positionals;
  if (values.version) return void process.stdout.write(`${CLI_VERSION}\n`);
  if (values.help || !command) return void process.stdout.write(HELP);

  switch (command) {
    case "validate": {
      if (!input) fail("usage: omnintent validate <omnintent.json>");
      const manifest = loadValid(input, !!values.json);
      if (!values.json) {
        process.stdout.write(`${input} is valid: ${manifest.actions.length} actions, ${Object.keys(manifest.entities ?? {}).length} entities.\n`);
      }
      return;
    }
    case "generate": {
      if (!input) fail("usage: omnintent generate <omnintent.json> --target <t> --out <dir>");
      if (!values.out) fail("--out <dir> is required");
      const targets = parseTargets(values.target ?? "all");
      const manifest = loadValid(input, false);
      const files = generate(manifest, targets);
      writeFiles(resolve(values.out), files);
      process.stdout.write(`Wrote ${files.length} files for ${targets.join(", ")} to ${values.out}\n`);
      return;
    }
    case "discover": {
      if (!input) fail("usage: omnintent discover <openapi-file|directory> [--out omnintent.json]");
      if (!existsSync(input)) fail(`${input} does not exist`);
      const out = resolve(values.out ?? "omnintent.json");
      if (existsSync(out) && !values.force) fail(`${out} already exists; pass --force to overwrite it`);
      const apiKey = process.env.ANTHROPIC_API_KEY;
      const log = (m: string) => process.stderr.write(`${m}\n`);
      if (!apiKey && !values["no-ai"]) log("ANTHROPIC_API_KEY is not set: using the deterministic OpenAPI path only.");
      const result = await discover(input, {
        apiKey,
        baseUrl: process.env.ANTHROPIC_BASE_URL,
        useAi: !values["no-ai"],
        model: values.model,
        log,
      });
      const check = validateManifest(result.manifest);
      if (!check.ok) {
        fail(`the drafted manifest is not valid, so nothing was written:\n${formatIssues(check.issues)}`);
      }
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(result.manifest, null, 2)}\n`);
      for (const note of result.notes) log(`note: ${note}`);
      const warnings = check.issues.filter((i) => i.severity === "warning");
      if (warnings.length) log(`${warnings.length} warning(s) to review:\n${formatIssues(warnings)}`);
      process.stdout.write(`Wrote ${out} (${result.mode} draft, ${result.manifest.actions.length} actions). Review it, then run omnintent validate.\n`);
      return;
    }
    case "test": {
      if (!input) fail("usage: omnintent test <omnintent.json>");
      const manifest = loadValid(input, false);
      const report = testManifest(manifest);
      if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stdout.write(`${formatReport(report)}\n`);
      if (values.plan) {
        const files = testPlan(manifest);
        writeFiles(resolve(values.plan), files);
        process.stdout.write(`Wrote test plan (${files.map((f) => f.path).join(", ")}) to ${values.plan}\n`);
      }
      if (!report.ok) process.exit(1);
      return;
    }
    case "build": {
      const configPath = resolve(values.config ?? "omnintent.builder.json");
      if (!existsSync(configPath)) fail(`${configPath} does not exist (see docs/BUILDER.md)`);
      const config = loadBuilderConfig(configPath);
      const repoRoot = dirname(configPath);
      const manifestPath = resolve(repoRoot, config.manifest);
      const manifest = loadValid(manifestPath, false);
      let previousManifest: Manifest | undefined;
      if (values.since) {
        try {
          const text = execFileSync("git", ["show", `${values.since}:${config.manifest}`], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
          previousManifest = JSON.parse(text) as Manifest;
        } catch {
          process.stderr.write(`No ${config.manifest} at ${values.since}; treating this as the first build.\n`);
        }
      }
      const apiKey = process.env.ANTHROPIC_API_KEY;
      const log = (m: string) => process.stderr.write(`${m}\n`);
      if (!apiKey && !values["no-ai"]) log("ANTHROPIC_API_KEY is not set: regenerating code only, without AI wiring.");
      const dryRunDir = values["dry-run"] ? resolve(values["dry-run"]) : undefined;
      const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
      if (!dryRunDir && !token) fail("GITHUB_TOKEN is not set; set it or use --dry-run <dir>");
      const report = await runBuilder({
        config,
        repoRoot,
        manifest,
        previousManifest,
        platforms: values.platform ? parseTargets(values.platform) : undefined,
        ai: apiKey && !values["no-ai"] ? { apiKey, baseUrl: process.env.ANTHROPIC_BASE_URL, model: values.model } : undefined,
        git: token ? new GitHubRest({ repo: config.repo, token, branchPrefix: config.branchPrefix, apiUrl: process.env.GITHUB_API_URL }) : undefined,
        dryRunDir,
        log,
      });
      if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stdout.write(`${formatBuildReport(report)}\n`);
      if (report.platforms.some((p) => p.status === "failed")) process.exit(1);
      return;
    }
    case "watch": {
      await watchCommand(values);
      return;
    }
    case "submit-prep": {
      if (!input) fail("usage: omnintent submit-prep <omnintent.json> --out <dir>");
      if (!values.out) fail("--out <dir> is required");
      submitPrepCommand(loadValid(input, false), values.out, values.platform);
      return;
    }
    default:
      fail(`unknown command "${command}"\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
