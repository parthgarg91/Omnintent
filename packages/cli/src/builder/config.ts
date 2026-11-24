// Builder agent configuration (omnintent.builder.json). It says where each
// platform's generated code and hand-written app code live in the app's repo,
// and which GitHub repository and base branch pull requests target.

import { readFileSync } from "node:fs";
import type { Target } from "../generators/types.js";

export interface PlatformConfig {
  /** Repo-relative folder that receives `omnintent generate --target <platform>` output. */
  generatedDir: string;
  /** Repo-relative folders of hand-written code that the agent may read and change. */
  sourceDirs: string[];
  /** Optional suggested path for the handlers implementation (Swift/Kotlin). */
  handlersFile?: string;
}

export interface BuilderConfig {
  /** "owner/name" of the GitHub repository. */
  repo: string;
  /** Branch that pull requests target. Never written to. */
  baseBranch: string;
  /** Repo-relative path of omnintent.json. */
  manifest: string;
  /** Every branch the agent creates starts with this prefix; it refuses to write any other ref. */
  branchPrefix: string;
  /** Open pull requests as drafts (default true). */
  draft: boolean;
  platforms: Partial<Record<Target, PlatformConfig>>;
}

export const DEFAULT_BRANCH_PREFIX = "omnintent/build";

const PLATFORM_KEYS: Target[] = ["swift", "kotlin", "mcp"];

/** Normalizes a repo-relative path and rejects anything that escapes the repo. */
export function repoPath(p: string, what: string): string {
  const norm = p.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!norm || norm.startsWith("/") || /^[A-Za-z]:/.test(norm) || norm.split("/").some((s) => s === ".." || s === "")) {
    throw new Error(`${what} must be a relative path inside the repository, got "${p}"`);
  }
  return norm;
}

export function parseBuilderConfig(raw: unknown): BuilderConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("builder config must be a JSON object");
  const c = raw as Record<string, unknown>;
  if (typeof c.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(c.repo)) throw new Error('builder config: "repo" must look like "owner/name"');
  const baseBranch = typeof c.baseBranch === "string" && c.baseBranch ? c.baseBranch : "main";
  const branchPrefix = typeof c.branchPrefix === "string" && c.branchPrefix ? c.branchPrefix.replace(/\/+$/, "") : DEFAULT_BRANCH_PREFIX;
  if (!/^[\w.-]+(\/[\w.-]+)*$/.test(branchPrefix)) throw new Error('builder config: "branchPrefix" has characters git does not allow');
  if (baseBranch === branchPrefix || baseBranch.startsWith(`${branchPrefix}/`) || baseBranch.startsWith(`${branchPrefix}-`)) {
    throw new Error('builder config: "baseBranch" must not start with "branchPrefix"');
  }
  const platformsRaw = c.platforms;
  if (!platformsRaw || typeof platformsRaw !== "object" || Array.isArray(platformsRaw)) {
    throw new Error('builder config: "platforms" must be an object with swift, kotlin and/or mcp');
  }
  const platforms: Partial<Record<Target, PlatformConfig>> = {};
  for (const [key, value] of Object.entries(platformsRaw as Record<string, unknown>)) {
    if (!(PLATFORM_KEYS as string[]).includes(key)) throw new Error(`builder config: unknown platform "${key}" (use swift, kotlin or mcp)`);
    const p = value as Record<string, unknown>;
    if (!p || typeof p !== "object") throw new Error(`builder config: platforms.${key} must be an object`);
    if (typeof p.generatedDir !== "string") throw new Error(`builder config: platforms.${key}.generatedDir is required`);
    const generatedDir = repoPath(p.generatedDir, `platforms.${key}.generatedDir`);
    const sourceDirs = Array.isArray(p.sourceDirs) ? p.sourceDirs.map((d, i) => repoPath(String(d), `platforms.${key}.sourceDirs[${i}]`)) : [];
    if (!sourceDirs.length) throw new Error(`builder config: platforms.${key}.sourceDirs needs at least one folder`);
    for (const dir of sourceDirs) {
      if (dir === generatedDir || dir.startsWith(`${generatedDir}/`)) {
        throw new Error(`builder config: platforms.${key}.sourceDirs must not be inside generatedDir`);
      }
    }
    const handlersFile = typeof p.handlersFile === "string" ? repoPath(p.handlersFile, `platforms.${key}.handlersFile`) : undefined;
    platforms[key as Target] = { generatedDir, sourceDirs, ...(handlersFile ? { handlersFile } : {}) };
  }
  if (!Object.keys(platforms).length) throw new Error("builder config: configure at least one platform");
  return {
    repo: c.repo,
    baseBranch,
    manifest: typeof c.manifest === "string" ? repoPath(c.manifest, "manifest") : "omnintent.json",
    branchPrefix,
    draft: c.draft === undefined ? true : c.draft === true,
    platforms,
  };
}

export function loadBuilderConfig(path: string): BuilderConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseBuilderConfig(raw);
}
