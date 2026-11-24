import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareVersions, extract, markdownSections } from "../src/agents/watch/extract.js";
import { WATCH_SOURCES, type WatchSource } from "../src/agents/watch/sources.js";
import {
  formatWatchReport,
  issueTitle,
  researchBaseline,
  runWatch,
  type Fetcher,
  type WatchState,
} from "../src/agents/watch/watch.js";
import { REPO } from "./helpers.js";

const run = promisify(execFile);
const CLI = resolve(REPO, "packages/cli/dist/cli.js");
const RESEARCH = readFileSync(resolve(REPO, "docs/RESEARCH.md"), "utf8");
const NOW = "2026-12-01T06:17:00.000Z";

// Values docs/RESEARCH.md records for v0.1 (November 24, 2026).
const V01: Record<string, string> = {
  "android-appfunctions-release": "1.0.0",
  "mcp-spec-revision": "2026-07-28",
  "npm-mcp-server": "2.4.0",
  "npm-mcp-client": "2.4.0",
  "npm-mcp-sdk-legacy": "1.32.2",
  "npm-agents": "0.34.0",
  "npm-wrangler": "4.167.0",
  "npm-workers-types": "5.20261124.1",
  "npm-workers-oauth-provider": "1.3.0",
};

const APPLE_PAGE = `# Siri AI Developer Preview

Bring custom actions and content to Siri AI.

## Overview

Works in development builds and internal TestFlight only.

\`\`\`swift
## not a heading inside a code fence
\`\`\`

## Availability

Supported regions.
`;

/** A fake web: each source answers with content matching RESEARCH.md v0.1, unless overridden. */
function fakeWeb(overrides: Record<string, string | number> = {}): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    const source = WATCH_SOURCES.find((s) => s.url === url);
    if (!source) return { status: 404, text: "not found" };
    const o = overrides[source.id];
    if (typeof o === "number") return { status: o, text: "error" };
    if (typeof o === "string") return { status: 200, text: o };
    switch (source.extractor.type) {
      case "npm-latest":
        return { status: 200, text: JSON.stringify({ "dist-tags": { latest: V01[source.id] }, time: { [V01[source.id]]: "2026-10-23T00:00:00.000Z" } }) };
      case "jetpack-release":
        return { status: 200, text: "<h3>Version 1.0.0</h3><h3>Version 1.0.0-rc01</h3><h3>Version 1.0.0-beta01</h3>" };
      case "mcp-latest-revision":
        return { status: 200, text: '{"versions":[{"version": "Version 2026-07-28 (latest)"},{"version": "Version 2025-11-25"}]}' };
      case "markdown-sections":
        return { status: 200, text: `${APPLE_PAGE}\n<!-- ${source.id} -->\n` };
    }
  };
  return { fetcher, calls };
}

async function baselineState(): Promise<WatchState> {
  const first = await runWatch({ fetcher: fakeWeb().fetcher, research: RESEARCH, now: "2026-11-24T00:00:00.000Z" });
  return first.nextState;
}

afterEach(() => vi.unstubAllGlobals());

describe("watcher sources and RESEARCH.md", () => {
  it("reads every research baseline out of the real docs/RESEARCH.md", () => {
    for (const source of WATCH_SOURCES.filter((s) => s.baseline.kind === "research")) {
      expect(researchBaseline(source, RESEARCH), source.id).toBe(V01[source.id]);
    }
    expect(WATCH_SOURCES.filter((s) => s.baseline.kind === "research").map((s) => s.id).sort()).toEqual(Object.keys(V01).sort());
  });

  it("has unique IDs, https URLs and existing research sections", () => {
    const ids = WATCH_SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of WATCH_SOURCES) {
      expect(s.url.startsWith("https://"), s.id).toBe(true);
      expect(RESEARCH.includes(`## ${s.researchSection}`), `${s.id}: ${s.researchSection}`).toBe(true);
      for (const file of s.affects) expect(existsSync(resolve(REPO, file)), `${s.id}: ${file}`).toBe(true);
    }
  });

  it("covers Siri, AppFunctions, MCP and Cloudflare", () => {
    const ids = WATCH_SOURCES.map((s) => s.id).join(" ");
    for (const area of ["apple-", "android-", "mcp-spec", "npm-mcp", "cloudflare-", "npm-agents"]) expect(ids).toContain(area);
  });

  it("has a committed snapshot that only names known sources", () => {
    const state = JSON.parse(readFileSync(resolve(REPO, "docs/watch-state.json"), "utf8")) as WatchState;
    expect(state.version).toBe(1);
    const known = new Set(WATCH_SOURCES.map((s) => s.id));
    for (const id of Object.keys(state.sources)) expect(known.has(id), id).toBe(true);
  });
});

describe("extractors", () => {
  it("splits Markdown by heading, ignoring headings in code fences", () => {
    const sections = markdownSections(APPLE_PAGE);
    expect(Object.keys(sections)).toEqual(["# Siri AI Developer Preview", "## Overview", "## Availability"]);
    const edited = markdownSections(APPLE_PAGE.replace("Supported regions.", "Supported regions and languages."));
    expect(edited["## Overview"]).toBe(sections["## Overview"]);
    expect(edited["## Availability"]).not.toBe(sections["## Availability"]);
    // Whitespace-only edits are not changes.
    expect(markdownSections(APPLE_PAGE.replace("## Overview\n", "## Overview\n\n\n"))).toEqual(sections);
  });

  it("picks the newest stable Jetpack version and notes a newer pre-release", () => {
    const obs = extract({ type: "jetpack-release" }, "Version 1.1.0-alpha02 Version 1.1.0-alpha01 Version 1.0.1 Version 1.0.0 Version 1.0.0-rc01");
    expect(obs.value).toBe("1.0.1");
    expect(obs.notes).toEqual(["newer pre-release: 1.1.0-alpha02"]);
  });

  it("orders versions with pre-release suffixes", () => {
    const sorted = ["1.0.0", "1.0.0-alpha13", "1.0.0-rc01", "1.0.0-beta01", "0.9.0", "1.0.0-alpha02", "1.10.0", "1.2.0"].sort(compareVersions);
    expect(sorted).toEqual(["0.9.0", "1.0.0-alpha02", "1.0.0-alpha13", "1.0.0-beta01", "1.0.0-rc01", "1.0.0", "1.2.0", "1.10.0"]);
  });

  it("reads the MCP latest revision and fails loudly on a redesigned page", () => {
    expect(extract({ type: "mcp-latest-revision" }, '"version": "Version 2027-03-01 (latest)"').value).toBe("2027-03-01");
    expect(() => extract({ type: "mcp-latest-revision" }, "{}")).toThrow(/latest/);
    expect(() => extract({ type: "markdown-sections" }, "<!DOCTYPE html><html></html>")).toThrow(/HTML/);
    expect(() => extract({ type: "npm-latest", packageName: "x" }, "not json")).toThrow(/JSON/);
  });
});

describe("runWatch against a fake web", () => {
  it("never touches the real network when given a fetcher", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("real network used");
    });
    const { fetcher, calls } = fakeWeb();
    await runWatch({ fetcher, research: RESEARCH, now: NOW });
    expect(calls).toHaveLength(WATCH_SOURCES.length);
  });

  it("records a first snapshot without asking anyone to act", async () => {
    const report = await runWatch({ fetcher: fakeWeb().fetcher, research: RESEARCH, now: NOW });
    expect(report.actionable).toBe(false);
    expect(report.findings.every((f) => f.kind === "new-baseline")).toBe(true);
    const snapshotSources = WATCH_SOURCES.filter((s) => s.baseline.kind === "snapshot");
    expect(report.findings).toHaveLength(snapshotSources.length);
    expect(Object.keys(report.nextState.sources)).toHaveLength(WATCH_SOURCES.length);
  });

  it("reports nothing when the sources match RESEARCH.md and the snapshot", async () => {
    const report = await runWatch({ fetcher: fakeWeb().fetcher, research: RESEARCH, state: await baselineState(), now: NOW });
    expect(report.findings).toEqual([]);
    expect(report.unchanged).toBe(WATCH_SOURCES.length);
    expect(report.actionable).toBe(false);
    expect(formatWatchReport(report)).toContain("Nothing changed");
  });

  it("flags a newer npm release against what RESEARCH.md says", async () => {
    const npm = JSON.stringify({ "dist-tags": { latest: "0.35.0" }, time: { "0.35.0": "2026-11-30T10:00:00.000Z" } });
    const report = await runWatch({ fetcher: fakeWeb({ "npm-agents": npm }).fetcher, research: RESEARCH, state: await baselineState(), now: NOW });
    expect(report.findings).toHaveLength(1);
    const f = report.findings[0];
    expect(f).toMatchObject({ kind: "changed", source: "npm-agents", expected: "0.34.0", observed: "0.35.0", direction: "newer" });
    expect(f.notes).toEqual(["published 2026-11-30"]);
    expect(report.actionable).toBe(true);
    const md = formatWatchReport(report);
    expect(md).toContain("docs/RESEARCH.md says 0.34.0; the source now says 0.35.0 (newer).");
    expect(md).toContain("https://www.npmjs.com/package/agents");
    expect(md).toContain("`packages/cli/src/generators/mcp-runtime.ts`");
    expect(issueTitle(report)).toBe("Watcher: agents (2026-12-01)");
  });

  it("flags a new MCP revision and a new AppFunctions release", async () => {
    const fake = fakeWeb({
      "mcp-spec-revision": '"version": "Version 2027-03-01 (latest)"',
      "android-appfunctions-release": "Version 1.1.0 Version 1.0.0",
    });
    const report = await runWatch({ fetcher: fake.fetcher, research: RESEARCH, state: await baselineState(), now: NOW });
    expect(report.findings.map((f) => [f.source, f.observed]).sort()).toEqual([
      ["android-appfunctions-release", "1.1.0"],
      ["mcp-spec-revision", "2027-03-01"],
    ]);
  });

  it("names the sections that changed, appeared or disappeared on a page", async () => {
    const edited = APPLE_PAGE.replace("Works in development builds and internal TestFlight only.", "Now available to external testers.")
      .replace("## Availability\n\nSupported regions.\n", "## Regions\n\nMore regions.\n");
    const report = await runWatch({
      fetcher: fakeWeb({ "apple-siri-ai-preview": `${edited}\n<!-- apple-siri-ai-preview -->\n` }).fetcher,
      research: RESEARCH,
      state: await baselineState(),
      now: NOW,
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].sections).toEqual({ added: ["## Regions"], removed: ["## Availability"], changed: ["## Overview"] });
    expect(report.findings[0].message).toContain("snapshot from 2026-11-24");
    const md = formatWatchReport(report);
    expect(md).toContain("- Changed sections: `Overview`");
    expect(md).toContain("- Removed sections: `Availability`");
    // The proposed snapshot carries the new page, dated today.
    expect(report.nextState.sources["apple-siri-ai-preview"].since).toBe("2026-12-01");
    expect(report.nextState.sources["npm-agents"].since).toBe("2026-11-24");
  });

  it("reports an unreadable source and keeps its previous snapshot", async () => {
    const state = await baselineState();
    const report = await runWatch({ fetcher: fakeWeb({ "apple-app-skills": 503 }).fetcher, research: RESEARCH, state, now: NOW });
    expect(report.findings).toEqual([expect.objectContaining({ kind: "unreadable", source: "apple-app-skills", message: "Could not read the source: HTTP 503" })]);
    expect(report.nextState.sources["apple-app-skills"]).toEqual(state.sources["apple-app-skills"]);
    expect(report.actionable).toBe(true);
  });

  it("notices when RESEARCH.md no longer states a tracked fact", async () => {
    const research = RESEARCH.replace("The latest revision is **2026-07-28**.", "The latest revision is described elsewhere.");
    const report = await runWatch({ fetcher: fakeWeb().fetcher, research, state: await baselineState(), now: NOW });
    expect(report.findings).toEqual([expect.objectContaining({ kind: "research-missing", source: "mcp-spec-revision" })]);
  });

  it("gives the same fingerprint to the same findings, and a new one when they change", async () => {
    const state = await baselineState();
    const npm = (v: string) => JSON.stringify({ "dist-tags": { latest: v } });
    const a = await runWatch({ fetcher: fakeWeb({ "npm-agents": npm("0.35.0") }).fetcher, research: RESEARCH, state, now: NOW });
    const b = await runWatch({ fetcher: fakeWeb({ "npm-agents": npm("0.35.0") }).fetcher, research: RESEARCH, state, now: "2026-12-08T06:17:00.000Z" });
    const c = await runWatch({ fetcher: fakeWeb({ "npm-agents": npm("0.36.0") }).fetcher, research: RESEARCH, state, now: NOW });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
    expect(formatWatchReport(a)).toContain(`fingerprint:${a.fingerprint}`);
  });

  it("runs only the requested sources and rejects unknown ones", async () => {
    const { fetcher, calls } = fakeWeb();
    const report = await runWatch({ fetcher, research: RESEARCH, now: NOW, only: ["npm-wrangler"] });
    expect(report.checked).toBe(1);
    expect(calls).toEqual([WATCH_SOURCES.find((s) => s.id === "npm-wrangler")!.url]);
    await expect(runWatch({ fetcher, research: RESEARCH, only: ["nope"] })).rejects.toThrow(/unknown source/);
  });

  it("works with a custom source list", async () => {
    const custom: WatchSource = {
      id: "custom",
      title: "Custom",
      url: "https://example.invalid/x",
      extractor: { type: "npm-latest", packageName: "x" },
      baseline: { kind: "research", researchPattern: /x is (\S+)\./ },
      researchSection: "X",
      affects: [],
    };
    const report = await runWatch({
      sources: [custom],
      research: "x is 1.0.0.",
      fetcher: async () => ({ status: 200, text: JSON.stringify({ "dist-tags": { latest: "0.9.0" } }) }),
      now: NOW,
    });
    expect(report.findings[0]).toMatchObject({ direction: "older", observed: "0.9.0" });
  });
});

describe("watch CLI", () => {
  it("fails clearly for an unknown source without fetching anything", async () => {
    const error = await run("node", [CLI, "watch", "--only", "nope"], { cwd: REPO }).then(
      () => null,
      (e: { code: number; stderr: string }) => e,
    );
    expect(error?.code).toBe(1);
    expect(error?.stderr).toContain("unknown source(s): nope");
  });

  it("fails clearly when RESEARCH.md is missing", async () => {
    const error = await run("node", [CLI, "watch", "--research", "missing.md"], { cwd: REPO }).then(
      () => null,
      (e: { code: number; stderr: string }) => e,
    );
    expect(error?.stderr).toContain("missing.md does not exist");
  });
});
