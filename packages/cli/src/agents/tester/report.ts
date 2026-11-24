// Human-readable tester reports (terminal text and Markdown for a PR).

import { formatDiff } from "./compare.js";
import type { AgentTestReport, Attempt, CaseResult } from "./run.js";

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** One line describing what went wrong in an attempt. */
export function describeAttempt(c: CaseResult["case"], a: Attempt): string {
  switch (a.verdict) {
    case "pass":
      return c.exposed ? `called ${a.chosenTool}${a.followUps ? " after a follow-up" : ""}` : "made no write call (the action is not on this platform)";
    case "wrong_tool":
      return `called ${a.chosenTool} instead of ${c.expectedTool}`;
    case "wrong_args":
      return `called ${a.chosenTool} with ${a.diffs.map(formatDiff).join("; ")}`;
    case "no_action":
      return `called nothing${a.text ? `; replied "${truncate(a.text, 120)}"` : ""}`;
    case "unsafe_call":
      return `called ${a.chosenTool}, but ${c.expectedTool} is not available on this platform, so no write was expected`;
    case "error":
      return `error: ${a.error ?? "unknown"}`;
  }
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** The most common failure of a case, for compact output. */
function mainFailure(r: CaseResult): Attempt | undefined {
  const failed = r.attempts.filter((a) => a.verdict !== "pass");
  if (!failed.length) return undefined;
  const counts = new Map<string, { n: number; a: Attempt }>();
  for (const a of failed) {
    const key = describeAttempt(r.case, a);
    const entry = counts.get(key) ?? { n: 0, a };
    entry.n++;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((x, y) => y.n - x.n)[0].a;
}

export function formatAgentReport(report: AgentTestReport): string {
  const out: string[] = [`Agent: ${report.agent}   Tools: ${report.surface}   Runs per case: ${report.runs}`];
  for (const note of report.notes) out.push(`note: ${note}`);
  for (const r of report.results) {
    const ok = r.passes === r.attempts.length;
    const mark = ok ? "pass" : r.passes === 0 ? "FAIL" : "flaky";
    const fail = mainFailure(r);
    out.push(`${mark.padEnd(5)} ${r.case.id.padEnd(22)} ${r.passes}/${r.attempts.length}  "${truncate(r.case.utterance, 60)}"${fail ? `  -> ${describeAttempt(r.case, fail)}` : ""}`);
  }
  out.push(`${report.passes}/${report.total} attempts passed (${pct(report.passRate)}) across ${report.results.length} cases`);
  return out.join("\n");
}

export function markdownAgentReport(report: AgentTestReport, title = "Agent test report"): string {
  const out: string[] = [
    `# ${title}`,
    "",
    `- Agent: ${report.agent}`,
    `- Tools from: ${report.surface}`,
    `- Runs per case: ${report.runs}`,
    `- Result: **${report.passes}/${report.total} attempts passed (${pct(report.passRate)})**`,
    "",
  ];
  if (report.notes.length) out.push("Notes:", "", ...report.notes.map((n) => `- ${n}`), "");
  out.push("| Case | Request | Expected | Passed | Most common problem |", "| --- | --- | --- | --- | --- |");
  for (const r of report.results) {
    const fail = mainFailure(r);
    const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
    const expected = r.case.exposed ? `\`${r.case.expectedTool}\` ${esc(JSON.stringify(r.case.expectedArguments))}` : `no write (\`${r.case.expectedTool}\` is not on ${report.platform})`;
    out.push(`| ${r.case.id} | ${esc(r.case.utterance)} | ${expected} | ${r.passes}/${r.attempts.length} | ${fail ? esc(describeAttempt(r.case, fail)) : ""} |`);
  }
  out.push("");
  return out.join("\n");
}
