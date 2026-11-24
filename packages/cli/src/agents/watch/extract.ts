// Turns a fetched page into a small, stable observation the watcher can compare.
// Each extractor throws a clear error when the page no longer looks the way it expects,
// so a redesigned page shows up as "could not read" rather than as a silent pass.

import { createHash } from "node:crypto";
import type { Extractor } from "./sources.js";

export interface Observation {
  /** The value that is compared, such as "0.35.0", "2026-11-16" or a content hash. */
  value: string;
  /** Section heading -> short hash, for Markdown pages. */
  sections?: Record<string, string>;
  /** Extra facts shown in reports but not compared. */
  notes?: string[];
}

export function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function normalise(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}

/** Splits Markdown by headings (outside code fences) and hashes each section. */
export function markdownSections(markdown: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const counts = new Map<string, number>();
  let heading = "(top)";
  let buffer: string[] = [];
  let inFence = false;
  const flush = () => {
    const seen = counts.get(heading) ?? 0;
    counts.set(heading, seen + 1);
    const key = seen ? `${heading} (${seen + 1})` : heading;
    const body = normalise(buffer.join("\n"));
    if (body || key !== "(top)") sections[key] = shortHash(body);
    buffer = [];
  };
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      flush();
      heading = `${m[1]} ${m[2]}`;
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

/** Compares dotted versions with an optional alpha/beta/rc suffix. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split("-", 2);
    const nums = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
    const m = pre ? /^([a-z]+)(\d*)$/.exec(pre) : null;
    const rank = m ? ({ alpha: 0, beta: 1, rc: 2 } as Record<string, number>)[m[1]] ?? 0 : 3;
    return { nums, rank, n: m ? Number(m[2] || 0) : 0 };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d;
  }
  return x.rank - y.rank || x.n - y.n;
}

export function extract(extractor: Extractor, body: string): Observation {
  switch (extractor.type) {
    case "npm-latest": {
      let doc: { "dist-tags"?: { latest?: string }; time?: Record<string, string> };
      try {
        doc = JSON.parse(body);
      } catch {
        throw new Error(`the npm registry did not return JSON for ${extractor.packageName}`);
      }
      const latest = doc["dist-tags"]?.latest;
      if (!latest) throw new Error(`no dist-tags.latest for ${extractor.packageName}`);
      const published = doc.time?.[latest];
      return { value: latest, notes: published ? [`published ${published.slice(0, 10)}`] : undefined };
    }
    case "jetpack-release": {
      const versions = [...new Set([...body.matchAll(/Version (\d+\.\d+\.\d+(?:-[a-z]+\d+)?)/g)].map((m) => m[1]))];
      if (!versions.length) throw new Error("no \"Version x.y.z\" headings found on the release-notes page");
      versions.sort(compareVersions);
      const stable = versions.filter((v) => !v.includes("-"));
      const newest = versions[versions.length - 1];
      if (!stable.length) return { value: "none", notes: [`newest pre-release: ${newest}`] };
      const latestStable = stable[stable.length - 1];
      const notes = compareVersions(newest, latestStable) > 0 ? [`newer pre-release: ${newest}`] : undefined;
      return { value: latestStable, notes };
    }
    case "mcp-latest-revision": {
      const m = /"version"\s*:\s*"Version (\d{4}-\d{2}-\d{2}) \(latest\)"/.exec(body);
      if (!m) throw new Error("no \"Version YYYY-MM-DD (latest)\" entry in the MCP docs config");
      return { value: m[1] };
    }
    case "markdown-sections": {
      if (/^\s*<(!doctype|html)/i.test(body)) throw new Error("expected Markdown but the page returned HTML");
      const sections = markdownSections(body);
      if (Object.keys(sections).length < 2) throw new Error("the page has no Markdown headings");
      return { value: shortHash(normalise(body)), sections };
    }
  }
}
