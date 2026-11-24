// `omnintent test`: static checks on sample utterances, plus an optional test
// plan for live testing (SiriEvaluations, adb, MCP). Live agent testing itself
// is future work; see docs/ARCHITECTURE.md.

import type { Action, Manifest } from "./manifest.js";
import { adbExecute, kotlinNames } from "./generators/kotlin.js";
import { isEnabledFor } from "./safety.js";
import type { GeneratedFile } from "./generators/types.js";

export interface TestFinding {
  severity: "error" | "warning";
  rule: string;
  action: string;
  example?: number;
  message: string;
}

export interface TestReport {
  findings: TestFinding[];
  actions: number;
  examples: number;
  ok: boolean;
}

const STOP = new Set(["a", "an", "the", "my", "to", "of", "on", "in", "for", "and", "with", "me", "i", "is", "it", "please", "what", "which"]);

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9@.\s-]/g, " ")
      .split(/\s+/)
      .filter((t) => t && !STOP.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
}

/** Does the utterance mention the value (case-insensitive, punctuation-tolerant)? */
function mentions(utterance: string, value: unknown): boolean {
  const u = utterance.toLowerCase();
  if (typeof value === "string") {
    const v = value.toLowerCase();
    if (u.includes(v)) return true;
    const loose = (s: string) => s.replace(/[^a-z0-9@.]+/g, " ").trim();
    return loose(u).includes(loose(v));
  }
  if (typeof value === "number") return u.includes(String(value));
  return true;
}

export function testManifest(manifest: Manifest): TestReport {
  const findings: TestFinding[] = [];
  let examples = 0;
  const all: { action: string; index: number; tokens: Set<string> }[] = [];

  for (const action of manifest.actions) {
    const props = action.inputSchema.properties ?? {};
    const required = new Set(action.inputSchema.required ?? []);
    action.examples.forEach((ex, i) => {
      examples++;
      all.push({ action: action.name, index: i, tokens: tokens(ex.utterance) });
      for (const [name, schema] of Object.entries(props)) {
        const value = ex.arguments[name];
        if (value === undefined) continue;
        // Agents resolve entity IDs (T004); booleans and defaults are often implied.
        if (schema["x-omnintent-entity"] || typeof value === "boolean") continue;
        if (schema.enum || (!required.has(name) && schema.type !== "string")) {
          if (!mentions(ex.utterance, value)) {
            findings.push({ severity: "warning", rule: "T002", action: action.name, example: i, message: `utterance does not mention "${String(value)}" for ${name}; check the agent can infer it` });
          }
          continue;
        }
        if (!mentions(ex.utterance, value)) {
          findings.push({
            severity: required.has(name) ? "error" : "warning",
            rule: "T001",
            action: action.name,
            example: i,
            message: `utterance "${ex.utterance}" does not contain the value ${JSON.stringify(value)} expected for ${name}`,
          });
        }
      }
    });
    const optional = Object.keys(props).filter((p) => !required.has(p));
    if (optional.length && action.examples.every((ex) => optional.every((p) => ex.arguments[p] === undefined))) {
      findings.push({ severity: "warning", rule: "T003", action: action.name, message: `no example uses the optional parameters (${optional.join(", ")})` });
    }
  }

  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      if (a.action === b.action) continue;
      const score = jaccard(a.tokens, b.tokens);
      if (score >= 0.75) {
        findings.push({
          severity: "warning",
          rule: "T005",
          action: a.action,
          example: a.index,
          message: `very similar to example ${b.index} of "${b.action}" (overlap ${score.toFixed(2)}); agents may confuse the two`,
        });
      }
    }
  }
  return { findings, actions: manifest.actions.length, examples, ok: !findings.some((f) => f.severity === "error") };
}

export function formatReport(report: TestReport): string {
  const out = report.findings.map(
    (f) => `${f.severity === "error" ? "error  " : "warning"} ${f.rule} ${f.action}${f.example !== undefined ? `#${f.example}` : ""}: ${f.message}`,
  );
  out.push(`${report.actions} actions, ${report.examples} sample utterances, ${report.findings.filter((f) => f.severity === "error").length} errors, ${report.findings.filter((f) => f.severity === "warning").length} warnings`);
  return out.join("\n");
}

/** Test plan files for live testing on each platform. */
export function testPlan(manifest: Manifest): GeneratedFile[] {
  const names = kotlinNames(manifest);
  const cases = manifest.actions.flatMap((a: Action) =>
    a.examples.map((ex) => ({ utterance: ex.utterance, expectedTool: a.name, expectedArguments: ex.arguments, safety: a.safety })),
  );
  const adb = manifest.actions
    .filter((a) => isEnabledFor(a, "android"))
    .flatMap((a) => [`# ${a.name}: ${a.examples[0]?.utterance ?? ""}`, adbExecute(manifest, names, a)]);
  const siri = manifest.actions
    .filter((a) => isEnabledFor(a, "ios"))
    .flatMap((a) => a.examples.map((ex) => `| ${ex.utterance.replace(/\|/g, "\\|")} | ${a.title} | \`${JSON.stringify(ex.arguments)}\` |`));
  return [
    { path: "cases.json", content: `${JSON.stringify(cases, null, 2)}\n` },
    {
      path: "adb-commands.sh",
      content: [
        "#!/bin/sh",
        "# Runs each Android AppFunction once with its first sample's arguments.",
        "# Entity IDs come from your test data; adjust them before running.",
        "set -e",
        `adb shell cmd app_function list-app-functions --package ${manifest.app.android?.packageName ?? names.packageName}`,
        ...adb,
        "",
      ].join("\n"),
    },
    {
      path: "siri-requests.md",
      content: [
        "# Siri requests to script with SiriEvaluations",
        "",
        "| Request | Expected intent | Expected arguments |",
        "| --- | --- | --- |",
        ...siri,
        "",
      ].join("\n"),
    },
  ];
}
