// The builder agent (agent 2 in docs/ARCHITECTURE.md). On an approved manifest
// change it regenerates each configured platform, asks Claude to wire the
// generated code into the app, and opens one pull request per platform with a
// checklist. It stops there: a person reviews, builds, tests and merges.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GENERATORS, writeFiles } from "../generators/index.js";
import type { GeneratedFile, Target } from "../generators/types.js";
import { CLI_VERSION, type Manifest } from "../manifest.js";
import { formatIssues, validateManifest } from "../validate.js";
import { readmeChecklist } from "./checklist.js";
import type { ClaudeOptions } from "./claude.js";
import type { BuilderConfig, PlatformConfig } from "./config.js";
import { diffManifests, formatChanges, hasChanges, type ManifestChanges } from "./diff.js";
import type { CommitFile, GitHost, PullRequestInfo } from "./github.js";
import { requiredNames, wirePlatform, type WireResult } from "./wire.js";

export interface BuildOptions {
  config: BuilderConfig;
  /** Local checkout of the app's repository at the approved commit. Read only. */
  repoRoot: string;
  manifest: Manifest;
  /** The manifest before the change; undefined on the first build. */
  previousManifest?: Manifest;
  /** Limit to some configured platforms. */
  platforms?: Target[];
  /** Claude settings; leave undefined to skip AI wiring (generated code and checklist only). */
  ai?: ClaudeOptions & { maxRepairs?: number };
  /** Where branches and pull requests go. Required unless dryRunDir is set. */
  git?: GitHost;
  /** Write each planned branch (files and PR.md) here instead of touching GitHub. */
  dryRunDir?: string;
  log?: (message: string) => void;
}

export type PlatformStatus = "opened" | "exists" | "up-to-date" | "planned" | "failed";

export interface PlatformReport {
  target: Target;
  status: PlatformStatus;
  branch?: string;
  pullRequest?: PullRequestInfo;
  generatedFiles: number;
  deletedFiles: string[];
  wiringFiles: string[];
  wiring?: { model: string; attempts: number; todo: number };
  message: string;
}

export interface BuildReport {
  changes: ManifestChanges;
  platforms: PlatformReport[];
}

const TITLES: Record<Target, string> = { swift: "Siri App Intents (Swift)", kotlin: "Android AppFunctions (Kotlin)", mcp: "MCP server and backend routes" };

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Files under the generated folder that the new generation no longer produces. */
function staleGenerated(repoRoot: string, platform: PlatformConfig, generated: GeneratedFile[], previous: Manifest | undefined, target: Target): string[] {
  if (!previous) return [];
  let before: GeneratedFile[];
  try {
    before = GENERATORS[target](previous);
  } catch {
    return [];
  }
  const now = new Set(generated.map((f) => f.path));
  return before
    .filter((f) => !now.has(f.path))
    .map((f) => `${platform.generatedDir}/${f.path}`)
    .filter((p) => existsSync(join(repoRoot, p)));
}

export function branchName(config: BuilderConfig, target: Target, manifest: Manifest): string {
  const hash = createHash("sha256").update(`${CLI_VERSION}\n${target}\n${JSON.stringify(manifest)}`).digest("hex").slice(0, 10);
  return `${config.branchPrefix}/${target}-${hash}`;
}

export function pullRequestBody(input: {
  target: Target;
  manifest: Manifest;
  manifestPath: string;
  changes: ManifestChanges;
  platform: PlatformConfig;
  generated: GeneratedFile[];
  deleted: string[];
  wire?: WireResult;
  aiSkipped: boolean;
  names: string[];
}): string {
  const { target, platform, wire } = input;
  const readme = input.generated.find((f) => f.path === "README.md")?.content ?? "";
  const build = {
    swift: "Build the app in Xcode 27 with the iOS 27.3+ SDK, and run the Siri Integration Advisor.",
    kotlin: "Build with Gradle (KSP generates the AppFunctionService) and check `adb shell cmd app_function list-app-functions`.",
    mcp: "Run the backend and the MCP server locally (`npm run dev` in the server folder) and call each tool once.",
  }[target];
  const checklist = [
    wire ? "- [ ] Read every glue file below. An AI model wrote it; the agent checked paths and coverage but did not compile or run it." : "",
    input.aiSkipped
      ? target === "mcp"
        ? `- [ ] Check that the backend serves the route for each of ${input.names.map((n) => `\`${n}\``).join(", ")}: the agent ran without \`ANTHROPIC_API_KEY\`, so it only regenerated code.`
        : `- [ ] Implement these \`OmnintentHandlers\` methods yourself: ${input.names.map((n) => `\`${n}\``).join(", ")}. The agent ran without \`ANTHROPIC_API_KEY\`, so it only regenerated code.`
      : "",
    `- [ ] ${build}`,
    `- [ ] Run \`omnintent test ${input.manifestPath}\` and the platform tests.`,
    ...(wire?.proposal.coverage.filter((c) => c.status === "todo").map((c) => `- [ ] \`${c.name}\` is a stub: ${c.note}`) ?? []),
    ...(wire?.proposal.todos.map((t) => `- [ ] ${t}`) ?? []),
    ...readmeChecklist(readme),
  ].filter(Boolean);
  const coverage = wire
    ? [
        "| Name | Status | Note |",
        "| --- | --- | --- |",
        ...wire.proposal.coverage.map((c) => `| \`${c.name}\` | ${c.status.replace("_", " ")} | ${c.note.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
      ].join("\n")
    : "";
  return [
    "<!-- omnintent-builder -->",
    `## Omnintent builder: ${TITLES[target]}`,
    "",
    `The Omnintent builder agent opened this pull request after an approved change to \`${input.manifestPath}\`. It never merges or deploys: a person reviews, builds, tests and merges it.`,
    "",
    "### Manifest changes",
    "",
    formatChanges(input.changes),
    "",
    "### Files",
    "",
    `- Generated code: ${input.generated.length} file(s) in \`${platform.generatedDir}/\`${input.deleted.length ? `, ${input.deleted.length} stale file(s) removed` : ""}. Generated by Omnintent ${CLI_VERSION}; do not edit by hand.`,
    ...(wire ? wire.proposal.files.map((f) => `- \`${f.path}\` (glue, written by ${wire.model}): ${f.reason.replace(/\n/g, " ")}`) : []),
    "",
    ...(wire ? ["### Wiring coverage", "", coverage, "", "### What the model says it did", "", wire.proposal.summary.trim(), ""] : []),
    "### Checklist",
    "",
    ...checklist,
    "",
  ].join("\n");
}

async function buildPlatform(target: Target, platform: PlatformConfig, opts: BuildOptions, changes: ManifestChanges): Promise<PlatformReport> {
  const { config, manifest, repoRoot, log } = opts;
  const empty = { generatedFiles: 0, deletedFiles: [], wiringFiles: [] };
  let generated: GeneratedFile[];
  try {
    generated = GENERATORS[target](manifest);
  } catch (err) {
    return { target, status: "failed", ...empty, message: `generate failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const deleted = staleGenerated(repoRoot, platform, generated, opts.previousManifest, target);
  const unchanged = !deleted.length && generated.every((f) => readIfExists(join(repoRoot, platform.generatedDir, f.path)) === f.content);
  if (unchanged) {
    return { target, status: "up-to-date", ...empty, generatedFiles: generated.length, message: `generated code in ${platform.generatedDir}/ already matches the manifest` };
  }
  const branch = branchName(config, target, manifest);
  if (opts.git && !opts.dryRunDir && (await opts.git.branchSha(branch))) {
    const existing = await opts.git.findOpenPullRequest(branch);
    if (existing) return { target, status: "exists", branch, pullRequest: existing, ...empty, message: `already built for this manifest: ${existing.url}` };
    // A branch without an open pull request means a person closed it. Respect that instead of reopening.
    return { target, status: "exists", branch, ...empty, message: `branch ${branch} exists with no open pull request (it was closed); delete the branch to build again` };
  }
  const names = requiredNames(target, manifest, generated);
  let wire: WireResult | undefined;
  if (opts.ai) {
    try {
      wire = await wirePlatform(target, manifest, platform, generated, repoRoot, { ...opts.ai, log });
    } catch (err) {
      return { target, status: "failed", branch, ...empty, generatedFiles: generated.length, message: `wiring failed, nothing was pushed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const files: CommitFile[] = [
    ...generated.map((f) => ({ path: `${platform.generatedDir}/${f.path}`, content: f.content })),
    ...deleted.map((path) => ({ path, content: null })),
    ...(wire?.proposal.files.map((f) => ({ path: f.path, content: f.content })) ?? []),
  ];
  const body = pullRequestBody({ target, manifest, manifestPath: config.manifest, changes, platform, generated, deleted, wire, aiSkipped: !opts.ai, names });
  const title = `Omnintent: update ${TITLES[target]} for ${manifest.app.name}`;
  const report = {
    target,
    branch,
    generatedFiles: generated.length,
    deletedFiles: deleted,
    wiringFiles: wire?.proposal.files.map((f) => f.path) ?? [],
    ...(wire ? { wiring: { model: wire.model, attempts: wire.attempts, todo: wire.proposal.coverage.filter((c) => c.status === "todo").length } } : {}),
  };
  if (opts.dryRunDir) {
    const out = join(opts.dryRunDir, target);
    writeFiles(
      join(out, "files"),
      files.filter((f): f is GeneratedFile => f.content !== null),
    );
    writeFiles(out, [{ path: "PR.md", content: `# ${title}\n\nBranch: ${branch}\nDeletes: ${deleted.join(", ") || "none"}\n\n${body}` }]);
    return { ...report, status: "planned", message: `dry run: wrote the planned branch to ${out}` };
  }
  if (!opts.git) throw new Error("a GitHub client is required unless dryRunDir is set");
  {
    const message = `Omnintent: update ${target} for ${manifest.app.name}\n\nGenerated by the Omnintent builder agent from ${config.manifest}.`;
    await opts.git.commitToNewBranch({ branch, base: config.baseBranch, message, files });
  }
  const pr = await opts.git.openPullRequest({ branch, base: config.baseBranch, title, body, draft: config.draft });
  log?.(`${target}: opened ${pr.url}`);
  return { ...report, status: "opened", pullRequest: pr, message: `opened ${pr.url}` };
}

export async function runBuilder(opts: BuildOptions): Promise<BuildReport> {
  const check = validateManifest(opts.manifest);
  if (!check.ok) throw new Error(`the manifest is not valid, so nothing was built:\n${formatIssues(check.issues)}`);
  const changes = diffManifests(opts.previousManifest, opts.manifest);
  if (!hasChanges(changes)) {
    opts.log?.("The manifest did not change; nothing to build.");
    return { changes, platforms: [] };
  }
  const targets = (Object.keys(opts.config.platforms) as Target[]).filter((t) => !opts.platforms || opts.platforms.includes(t));
  const platforms: PlatformReport[] = [];
  for (const target of targets) {
    opts.log?.(`${target}: building`);
    platforms.push(await buildPlatform(target, opts.config.platforms[target]!, opts, changes));
  }
  return { changes, platforms };
}

export function formatBuildReport(report: BuildReport): string {
  if (!report.platforms.length) return "Nothing to build: the manifest did not change.";
  return report.platforms
    .map((p) => {
      const extra = p.wiring ? ` (glue: ${p.wiringFiles.length} file(s) by ${p.wiring.model}, ${p.wiring.todo} stub(s) left)` : "";
      return `${p.target}: ${p.status}. ${p.message}${extra}`;
    })
    .join("\n");
}

export { parseBuilderConfig, loadBuilderConfig, type BuilderConfig, type PlatformConfig } from "./config.js";
export { GitHubRest, type GitHost } from "./github.js";
export { diffManifests, type ManifestChanges } from "./diff.js";
export { WIRING_SCHEMA, WIRING_SYSTEM, checkProposal } from "./wire.js";
