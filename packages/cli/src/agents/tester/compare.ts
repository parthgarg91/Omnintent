// Compares the arguments an agent chose with the expected arguments of a case.
// Lenient where people would not care (case, surrounding quotes, trailing
// punctuation, an explicit default) and strict where it matters (entity IDs,
// numbers, dates, extra values the person never asked for).

import type { InputSchema, ParameterSchema } from "../../manifest.js";

export interface ArgumentDiff {
  name: string;
  kind: "missing" | "wrong" | "extra";
  expected?: unknown;
  actual?: unknown;
}

function normText(s: string): string {
  return s
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/[.!?,;:]+$/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function scalarMatches(expected: unknown, actual: unknown, schema: Pick<ParameterSchema, "type" | "format"> | undefined): boolean {
  if (expected === actual) return true;
  const type = schema?.type;
  if (type === "integer" || type === "number" || typeof expected === "number") {
    return typeof actual === "number" && Number(expected) === actual;
  }
  if (type === "boolean" || typeof expected === "boolean") return actual === expected;
  if (typeof expected === "string" && typeof actual === "string") {
    if (schema?.format === "date-time") {
      const a = Date.parse(actual);
      const e = Date.parse(expected);
      return !Number.isNaN(a) && a === e;
    }
    if (schema?.format === "date") return actual.trim() === expected.trim();
    return normText(expected) === normText(actual);
  }
  return false;
}

export function valueMatches(expected: unknown, actual: unknown, schema: ParameterSchema | undefined): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    // Order rarely matters for list arguments; match each expected element once.
    const remaining = [...actual];
    for (const e of expected) {
      const i = remaining.findIndex((a) => scalarMatches(e, a, schema?.items));
      if (i < 0) return false;
      remaining.splice(i, 1);
    }
    return true;
  }
  return scalarMatches(expected, actual, schema);
}

function isDefault(value: unknown, schema: ParameterSchema | undefined): boolean {
  return schema?.default !== undefined && valueMatches(schema.default, value, schema);
}

export function compareArguments(
  expected: Record<string, unknown>,
  actual: Record<string, unknown> | undefined,
  inputSchema: InputSchema | undefined,
): ArgumentDiff[] {
  const props = inputSchema?.properties ?? {};
  const got = actual ?? {};
  const diffs: ArgumentDiff[] = [];
  const names = new Set([...Object.keys(expected), ...Object.keys(got)]);
  for (const name of names) {
    const schema = props[name];
    const e = expected[name];
    const a = got[name];
    if (e === undefined && (a === undefined || a === null)) continue;
    if (e === undefined) {
      if (!isDefault(a, schema)) diffs.push({ name, kind: "extra", actual: a });
      continue;
    }
    if (a === undefined || a === null) {
      if (!isDefault(e, schema)) diffs.push({ name, kind: "missing", expected: e });
      continue;
    }
    if (!valueMatches(e, a, schema)) diffs.push({ name, kind: "wrong", expected: e, actual: a });
  }
  return diffs.sort((x, y) => x.name.localeCompare(y.name));
}

export function formatDiff(d: ArgumentDiff): string {
  const j = (v: unknown) => JSON.stringify(v);
  if (d.kind === "missing") return `${d.name} missing (expected ${j(d.expected)})`;
  if (d.kind === "extra") return `${d.name} not asked for (got ${j(d.actual)})`;
  return `${d.name} ${j(d.actual)} instead of ${j(d.expected)}`;
}
