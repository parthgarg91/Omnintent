// Watcher agent: fetches each tracked source, compares it with docs/RESEARCH.md or the stored
// snapshot, and writes a report a maintainer can act on. It never edits the rule book,
// generators or RESEARCH.md itself: its outputs are a report (for an issue) and a new snapshot
// (for a pull request). See docs/ARCHITECTURE.md, agent 5.

import { compareVersions, extract, shortHash, type Observation } from "./extract.js";
import { WATCH_SOURCES, type WatchSource } from "./sources.js";

export interface FetchResult {
  status: number;
  text: string;
}
export type Fetcher = (url: string) => Promise<FetchResult>;

export interface SourceState {
  value: string;
  sections?: Record<string, string>;
  /** When this value was first seen (YYYY-MM-DD). */
  since: string;
}

export interface WatchState {
  /** Written by `omnintent watch --update-state`. Do not edit by hand except to remove a source. */
  version: 1;
  checkedAt: string;
  sources: Record<string, SourceState>;
}

export type FindingKind = "changed" | "research-missing" | "unreadable" | "new-baseline";

export interface Finding {
  kind: FindingKind;
  source: string;
  title: string;
  url: string;
  researchSection: string;
  affects: string[];
  /** What RESEARCH.md or the snapshot says. */
  expected?: string;
  /** What the source says now. */
  observed?: string;
  /** For research baselines: "newer", "older" or "different". */
  direction?: "newer" | "older" | "different";
  sections?: { added: string[]; removed: string[]; changed: string[] };
  notes?: string[];
  message: string;
}

export interface WatchReport {
  checkedAt: string;
  checked: number;
  unchanged: number;
  findings: Finding[];
  /** True when a maintainer should look: anything other than a first snapshot. */
  actionable: boolean;
  /** Stable ID of the actionable findings, used to avoid duplicate issues. */
  fingerprint: string;
  nextState: WatchState;
}

export interface WatchOptions {
  fetcher?: Fetcher;
  research: string;
  state?: WatchState;
  sources?: WatchSource[];
  /** ISO timestamp; defaults to now. */
  now?: string;
  /** Run only these source IDs. */
  only?: string[];
}

const USER_AGENT = "omnintent-watcher/0.1";

/** The default fetcher: plain GET with a timeout. No credentials are ever sent. */
export const httpFetcher: Fetcher = async (url) => {
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/markdown, application/json, text/html;q=0.9, */*;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, text: await res.text() };
};

export function emptyState(now: string): WatchState {
  return { version: 1, checkedAt: now, sources: {} };
}

/** Reads the baseline value a source records in RESEARCH.md, or undefined if the pattern no longer matches. */
export function researchBaseline(source: WatchSource, research: string): string | undefined {
  if (source.baseline.kind !== "research") return undefined;
  return source.baseline.researchPattern.exec(research)?.[1];
}

function base(source: WatchSource) {
  return {
    source: source.id,
    title: source.title,
    url: source.readUrl ?? source.url,
    researchSection: source.researchSection,
    affects: source.affects,
  };
}

function sectionDiff(before: Record<string, string> = {}, after: Record<string, string> = {}) {
  const added = Object.keys(after).filter((k) => !(k in before));
  const removed = Object.keys(before).filter((k) => !(k in after));
  const changed = Object.keys(after).filter((k) => k in before && before[k] !== after[k]);
  return { added, removed, changed };
}

async function observe(source: WatchSource, fetcher: Fetcher): Promise<Observation> {
  const res = await fetcher(source.url);
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  return extract(source.extractor, res.text);
}

export async function runWatch(options: WatchOptions): Promise<WatchReport> {
  const now = options.now ?? new Date().toISOString();
  const today = now.slice(0, 10);
  const fetcher = options.fetcher ?? httpFetcher;
  const all = options.sources ?? WATCH_SOURCES;
  const sources = options.only?.length ? all.filter((s) => options.only!.includes(s.id)) : all;
  const unknown = (options.only ?? []).filter((id) => !all.some((s) => s.id === id));
  if (unknown.length) throw new Error(`unknown source(s): ${unknown.join(", ")}`);

  const previous = options.state ?? emptyState(now);
  const next: WatchState = { version: 1, checkedAt: now, sources: { ...previous.sources } };
  const findings: Finding[] = [];
  let unchanged = 0;

  // Fetch in small parallel batches: polite to the sites, fast enough for CI.
  const results = new Map<string, Observation | Error>();
  for (let i = 0; i < sources.length; i += 4) {
    const batch = sources.slice(i, i + 4);
    const settled = await Promise.allSettled(batch.map((s) => observe(s, fetcher)));
    settled.forEach((r, j) => {
      results.set(batch[j].id, r.status === "fulfilled" ? r.value : r.reason instanceof Error ? r.reason : new Error(String(r.reason)));
    });
  }

  for (const source of sources) {
    const result = results.get(source.id)!;
    const stored = previous.sources[source.id];

    let expected: string | undefined;
    if (source.baseline.kind === "research") {
      expected = researchBaseline(source, options.research);
      if (expected === undefined) {
        findings.push({
          ...base(source),
          kind: "research-missing",
          message: `docs/RESEARCH.md no longer contains the fact this source is checked against (pattern ${source.baseline.researchPattern}). Update the pattern in packages/cli/src/agents/watch/sources.ts or restore the fact.`,
        });
      }
    }

    if (result instanceof Error) {
      findings.push({ ...base(source), kind: "unreadable", expected: expected ?? stored?.value, message: `Could not read the source: ${result.message}` });
      continue;
    }

    const obs = result;
    const keepSince = stored && stored.value === obs.value ? stored.since : today;
    next.sources[source.id] = { value: obs.value, ...(obs.sections ? { sections: obs.sections } : {}), since: keepSince };

    if (source.baseline.kind === "research") {
      if (expected === undefined) continue;
      if (expected === obs.value) {
        unchanged++;
        continue;
      }
      const cmp = /^\d/.test(expected) && /^\d/.test(obs.value) ? compareVersions(obs.value, expected) : NaN;
      const direction = Number.isNaN(cmp) ? "different" : cmp > 0 ? "newer" : cmp < 0 ? "older" : "different";
      findings.push({
        ...base(source),
        kind: "changed",
        expected,
        observed: obs.value,
        direction,
        notes: obs.notes,
        message: `docs/RESEARCH.md says ${expected}; the source now says ${obs.value}${direction === "newer" ? " (newer)" : direction === "older" ? " (older: check for a yanked release)" : ""}.`,
      });
      continue;
    }

    // Snapshot baseline.
    if (!stored) {
      findings.push({
        ...base(source),
        kind: "new-baseline",
        observed: obs.value,
        notes: obs.notes,
        message: "First snapshot recorded. Nothing to compare yet.",
      });
      continue;
    }
    if (stored.value === obs.value) {
      unchanged++;
      continue;
    }
    const sections = obs.sections || stored.sections ? sectionDiff(stored.sections, obs.sections) : undefined;
    findings.push({
      ...base(source),
      kind: "changed",
      expected: stored.value,
      observed: obs.value,
      sections,
      notes: obs.notes,
      message: `The page's content changed since the snapshot from ${stored.since}.`,
    });
  }

  const actionableFindings = findings.filter((f) => f.kind !== "new-baseline");
  const fingerprint = shortHash(
    actionableFindings
      .map((f) => `${f.source}|${f.kind}|${f.observed ?? ""}`)
      .sort()
      .join("\n"),
  ).slice(0, 12);

  return {
    checkedAt: now,
    checked: sources.length,
    unchanged,
    findings,
    actionable: actionableFindings.length > 0,
    fingerprint,
    nextState: next,
  };
}

const KIND_LABEL: Record<FindingKind, string> = {
  changed: "Changed",
  "research-missing": "RESEARCH.md fact missing",
  unreadable: "Could not read",
  "new-baseline": "First snapshot",
};

/** Markdown for a GitHub issue or a job summary. */
export function formatWatchReport(report: WatchReport): string {
  const date = report.checkedAt.slice(0, 10);
  const out: string[] = [];
  out.push(`<!-- omnintent-watcher fingerprint:${report.fingerprint} -->`);
  out.push(`The watcher agent checked ${report.checked} sources on ${date}: ${report.unchanged} unchanged, ${report.findings.length} to note.`);
  out.push("");
  if (!report.findings.length) {
    out.push("Nothing changed since `docs/RESEARCH.md` and the last snapshot.");
    return `${out.join("\n")}\n`;
  }
  out.push(
    "The watcher only notices that something moved. It does not read or interpret the change. A maintainer should read each source, then update `docs/RESEARCH.md`, `SPEC.md`, the generators and `docs/LIMITATIONS.md` as needed, citing the source and the date it was read.",
  );
  for (const kind of ["changed", "research-missing", "unreadable", "new-baseline"] as FindingKind[]) {
    const group = report.findings.filter((f) => f.kind === kind);
    if (!group.length) continue;
    out.push("", `## ${KIND_LABEL[kind]} (${group.length})`, "");
    for (const f of group) {
      out.push(`### [${f.title}](${f.url})`, "", f.message);
      if (f.sections) {
        const list = (label: string, items: string[]) =>
          items.length ? `- ${label}: ${items.slice(0, 15).map((h) => `\`${h.replace(/^#+ /, "")}\``).join(", ")}${items.length > 15 ? `, and ${items.length - 15} more` : ""}` : null;
        const lines = [list("Changed sections", f.sections.changed), list("New sections", f.sections.added), list("Removed sections", f.sections.removed)].filter(Boolean);
        if (lines.length) out.push("", ...(lines as string[]));
      }
      for (const n of f.notes ?? []) out.push(`- Note: ${n}`);
      if (kind !== "new-baseline") {
        out.push(`- Recorded in: \`docs/RESEARCH.md\`, section "${f.researchSection}"`);
        out.push(`- Re-check: ${f.affects.map((a) => `\`${a}\``).join(", ")}`);
      }
      out.push("");
    }
  }
  out.push("---", "_Opened by the Omnintent watcher agent (`omnintent watch`). It never merges, edits the rule book or changes a safety rule; a maintainer decides what to do._");
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

export function issueTitle(report: WatchReport): string {
  const changed = report.findings.filter((f) => f.kind === "changed");
  const names = changed.slice(0, 3).map((f) => f.title.replace(/^npm: /, ""));
  const what = names.length ? `${names.join(", ")}${changed.length > 3 ? ` and ${changed.length - 3} more` : ""}` : "sources need attention";
  return `Watcher: ${what} (${report.checkedAt.slice(0, 10)})`;
}
