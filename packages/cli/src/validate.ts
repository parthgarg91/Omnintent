// `omnintent validate`: JSON Schema structure + the rule book's semantic rules.
// Every rule has a stable ID (OI1xx) that SPEC.md documents.

import { readFileSync } from "node:fs";
import type { ErrorObject } from "ajv";
import type { Action, Entity, Manifest, ParameterSchema, ValueSchema } from "./manifest.js";
import { isCamelCase, isSnakeCase } from "./naming.js";
import { SAFETY, androidRule, isEnabledFor, refName } from "./safety.js";
import { createAjv, manifestSchema, mcpInputSchema, propertyPrivacy } from "./schema.js";

export type Severity = "error" | "warning";

export interface Issue {
  severity: Severity;
  rule: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: Issue[];
  manifest?: Manifest;
}

export function readManifestFile(path: string): unknown {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
}

export function validateManifest(data: unknown): ValidationResult {
  const ajv = createAjv();
  const check = ajv.compile(manifestSchema());
  if (!check(data)) {
    const issues = schemaIssues(check.errors ?? []);
    return { ok: false, issues };
  }
  const manifest = data as Manifest;
  const issues = semanticIssues(manifest);
  return { ok: !issues.some((i) => i.severity === "error"), issues, manifest };
}

function schemaIssues(errors: ErrorObject[]): Issue[] {
  const seen = new Set<string>();
  const issues: Issue[] = [];
  // oneOf/allOf failures repeat the underlying errors; keep the most specific ones.
  const specific = errors.filter((e) => e.keyword !== "oneOf" && e.keyword !== "allOf");
  for (const e of specific.length ? specific : errors) {
    const path = e.instancePath || "/";
    let message = e.message ?? "is invalid";
    if (e.keyword === "additionalProperties") message = `unknown field "${(e.params as { additionalProperty: string }).additionalProperty}"`;
    if (e.keyword === "unevaluatedProperties") message = `unknown field "${(e.params as { unevaluatedProperty: string }).unevaluatedProperty}"`;
    if (e.keyword === "enum") message = `must be one of: ${(e.params as { allowedValues: unknown[] }).allowedValues.join(", ")}`;
    if (e.keyword === "const") message = `must be ${JSON.stringify((e.params as { allowedValue: unknown }).allowedValue)}`;
    const key = `${path}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ severity: "error", rule: "SCHEMA", path, message });
  }
  return issues;
}

const BANNED_PHRASES: [RegExp, string][] = [
  [/\byou must\b/i, 'commands such as "you must"'],
  [/\bMUST\b/, 'shouting such as "MUST"'],
  [/\*\*|__/, "emphasis markup"],
  [/\b(CRITICAL|IMPORTANT|ALWAYS|NEVER)\b/, "capitalised emphasis"],
  [/^this (function|tool|action|method|intent|endpoint)\b/i, 'filler such as "This function"'],
  [/^(used to|helps?|allows? (you|the user) to)\b/i, 'filler such as "Used to" or "Helps"'],
];

const FORBIDDEN_PARAMS = new Set(["full_context", "fullContext", "conversation_history", "conversationHistory", "chat_history", "chatHistory"]);

function semanticIssues(m: Manifest): Issue[] {
  const issues: Issue[] = [];
  const add = (severity: Severity, rule: string, path: string, message: string) =>
    issues.push({ severity, rule, path, message });
  const entities = m.entities ?? {};

  // Entities
  for (const [name, entity] of Object.entries(entities)) {
    const base = `/entities/${name}`;
    checkEntity(entity, base, add);
    for (const [pname, prop] of Object.entries(entity.properties)) {
      checkValueSchema(prop, `${base}/properties/${pname}`, add);
    }
  }

  // Actions
  const names = new Map<string, number>();
  const utterances = new Map<string, string>();
  const ajv = createAjv();
  m.actions.forEach((action, index) => {
    const base = `/actions/${index}`;
    if (names.has(action.name)) {
      add("error", "OI101", `${base}/name`, `duplicate action name "${action.name}" (also at /actions/${names.get(action.name)})`);
    }
    names.set(action.name, index);
    if (!isSnakeCase(action.name)) {
      add("error", "OI102", `${base}/name`, `action name "${action.name}" must be snake_case, e.g. "${action.name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-.]/g, "_").toLowerCase()}"`);
    }
    if (!/^[A-Z0-9]/.test(action.title)) {
      add("warning", "OI103", `${base}/title`, "title should start with a capital letter (Title Case, e.g. \"Add Item\")");
    }
    checkDescription(action, m, `${base}/description`, add);
    checkParameters(action, entities, base, add);
    checkOutput(action, entities, base, add);
    checkConfirmation(action, base, add);
    checkBackend(action, m, base, add);
    checkPlatforms(action, base, add);
    checkExamples(action, ajv, base, add, utterances);
  });

  // Skills
  const skillNames = new Set<string>();
  (m.skills ?? []).forEach((skill, i) => {
    const base = `/skills/${i}`;
    if (skillNames.has(skill.name)) add("error", "OI160", `${base}/name`, `duplicate skill name "${skill.name}"`);
    skillNames.add(skill.name);
    if (/[\r\n]/.test(skill.description)) add("error", "OI161", `${base}/description`, "skill description must be a single line");
    for (const a of skill.actions ?? []) {
      if (!names.has(a)) add("error", "OI162", `${base}/actions`, `skill refers to unknown action "${a}"`);
    }
  });

  // App and backend
  if (!m.app.android) {
    add("warning", "OI171", "/app", `app.android.packageName is not set; the Kotlin generator will use com.example.${m.app.slug.replace(/-/g, "")}`);
  }
  if (!m.backend) {
    if (m.actions.some((a) => isEnabledFor(a, "mcp"))) {
      add("warning", "OI133", "/", "no backend section: the MCP target cannot be generated");
    }
  } else if (/[<>]/.test(m.backend.baseUrl)) {
    add("warning", "OI172", "/backend/baseUrl", "baseUrl is a placeholder; set BACKEND_BASE_URL when you deploy the MCP server");
  } else if (!/^https?:\/\//.test(m.backend.baseUrl)) {
    add("error", "OI173", "/backend/baseUrl", "baseUrl must start with http:// or https:// (or be a <PLACEHOLDER>)");
  }
  const auth = m.backend?.auth;
  if (auth?.type === "oauth") {
    for (const key of ["authorizationUrl", "tokenUrl"] as const) {
      const value = auth[key];
      const path = `/backend/auth/${key}`;
      if (/[<>]/.test(value)) {
        const env = key === "tokenUrl" ? "BACKEND_OAUTH_TOKEN_URL" : "BACKEND_OAUTH_AUTHORIZATION_URL";
        add("warning", "OI174", path, `${key} is a placeholder; set ${env} when you deploy the MCP server`);
      } else if (!/^https?:\/\//.test(value)) {
        add("error", "OI174", path, `${key} must start with https:// (or be a <PLACEHOLDER>)`);
      } else if (value.startsWith("http://") && !isLoopback(value)) {
        add("error", "OI175", path, `${key} must use https://; OAuth 2.1 allows http:// only for localhost`);
      }
    }
  }
  return issues;
}

type Add = (severity: Severity, rule: string, path: string, message: string) => void;

function checkEntity(entity: Entity, base: string, add: Add) {
  const props = entity.properties;
  for (const key of ["idProperty", "displayProperty"] as const) {
    const pname = entity[key];
    const prop = props[pname];
    if (!prop) {
      add("error", "OI121", `${base}/${key}`, `${key} "${pname}" is not one of the entity's properties`);
      continue;
    }
    if (prop.type !== "string") add("error", "OI121", `${base}/${key}`, `${key} "${pname}" must be a string property`);
    if (!(entity.required ?? []).includes(pname)) add("error", "OI121", `${base}/${key}`, `${key} "${pname}" must be listed in required`);
    if (prop.visibility === "internal" || propertyPrivacy(entity, prop) === "sensitive") {
      add("error", "OI122", `${base}/properties/${pname}`, `${key} "${pname}" cannot be internal or sensitive; agents need it to refer to the entity`);
    }
  }
  for (const r of entity.required ?? []) {
    if (!props[r]) add("error", "OI123", `${base}/required`, `required property "${r}" is not defined`);
  }
}

function checkValueSchema(schema: ValueSchema, path: string, add: Add) {
  if (schema.format && schema.type !== "string" && !(schema.format === "int64" && schema.type === "integer")) {
    add("error", "OI151", `${path}/format`, `format "${schema.format}" needs type string${schema.format === "int64" ? " or integer" : ""}`);
  }
  if (schema.format === "int64" && schema.type !== "integer") {
    add("error", "OI151", `${path}/format`, 'format "int64" needs type integer');
  }
  if (schema.enum && schema.type !== "string") add("error", "OI151", `${path}/enum`, "enum is only supported on string values");
  if (schema.type === "array" && !schema.items) add("error", "OI151", path, "array values need an items schema");
  if (schema.type !== "array" && schema.items) add("error", "OI151", `${path}/items`, "items is only allowed on arrays");
  if (schema.default !== undefined) {
    const ajv = createAjv();
    const plain: Record<string, unknown> = { ...schema };
    delete plain["x-omnintent-entity"];
    delete plain.privacy;
    delete plain.visibility;
    delete plain.authentication;
    if (plain.format === "int64") delete plain.format;
    const ok = ajv.validate(plain, schema.default);
    if (!ok) add("error", "OI151", `${path}/default`, `default ${JSON.stringify(schema.default)} does not match the schema`);
    if (schema.type === "string" && (schema.format === "date" || schema.format === "date-time")) {
      add("error", "OI151", `${path}/default`, "date defaults are not supported; resolve them in your handler");
    }
  }
}

function checkDescription(action: Action, m: Manifest, path: string, add: Add) {
  const d = action.description.trim();
  const first = d.split(/\s+/)[0] ?? "";
  if (!/^[A-Z][a-z]+s$/.test(first)) {
    add("warning", "OI104", path, `start with a third-person verb that says what happens, e.g. "Adds …" or "Lists …" (found "${first}")`);
  }
  for (const [re, what] of BANNED_PHRASES) {
    if (re.test(d)) add("warning", "OI104", path, `avoid ${what}; describe what the action does in neutral language`);
  }
  if (d.toLowerCase() === action.title.toLowerCase() || d.length < 20) {
    add("warning", "OI104", path, "description is too short to tell this action apart from others; say what it does and what it returns");
  }
  for (const other of m.actions) {
    if (other.name !== action.name && new RegExp(`\\b${other.name}\\b`).test(d)) {
      add("warning", "OI105", path, `description refers to another action ("${other.name}"); put cross-action guidance in app.instructions or a skill`);
    }
  }
}

function checkParameters(action: Action, entities: Record<string, Entity>, base: string, add: Add) {
  const input = action.inputSchema;
  const props = input.properties ?? {};
  if (input.additionalProperties !== false) {
    add("warning", "OI152", `${base}/inputSchema`, 'set "additionalProperties": false so agents cannot pass unknown arguments');
  }
  for (const r of input.required ?? []) {
    if (!props[r]) add("error", "OI123", `${base}/inputSchema/required`, `required parameter "${r}" is not defined`);
  }
  for (const [pname, p] of Object.entries(props) as [string, ParameterSchema][]) {
    const path = `${base}/inputSchema/properties/${pname}`;
    if (FORBIDDEN_PARAMS.has(pname)) {
      add("error", "OI150", path, `parameter name "${pname}" invites agents to send their whole conversation; name it after the data the action needs`);
    } else if (!isCamelCase(pname)) {
      add("warning", "OI150", path, `parameter "${pname}" should be camelCase; it becomes a Swift and Kotlin identifier`);
    }
    if (!p.title) add("warning", "OI106", `${path}/title`, "add a short title; Siri shows it to the user (derived from the name for now)");
    checkValueSchema(p, path, add);
    const ent = p["x-omnintent-entity"];
    if (ent) {
      if (!entities[ent]) add("error", "OI120", `${path}/x-omnintent-entity`, `unknown entity "${ent}"`);
      if (p.type !== "string") add("error", "OI124", `${path}/x-omnintent-entity`, "entity parameters carry the entity ID and must be strings");
      if (p.enum) add("error", "OI124", `${path}/x-omnintent-entity`, "entity parameters cannot also be enums");
    }
    if (p.default !== undefined && (input.required ?? []).includes(pname)) {
      add("warning", "OI151", `${path}/default`, "a required parameter never uses its default");
    }
  }
}

function checkOutput(action: Action, entities: Record<string, Entity>, base: string, add: Add) {
  const out = action.outputSchema;
  if (!out) return;
  const refs = "$ref" in out ? [out.$ref] : out.type === "array" ? [out.items.$ref] : [];
  for (const ref of refs) {
    if (!entities[refName(ref)]) add("error", "OI120", `${base}/outputSchema`, `unknown entity reference "${ref}"`);
  }
  if (!("$ref" in out) && out.type === "object") {
    for (const r of out.required ?? []) {
      if (!out.properties[r]) add("error", "OI123", `${base}/outputSchema/required`, `required field "${r}" is not defined`);
    }
    for (const [pname, prop] of Object.entries(out.properties)) checkValueSchema(prop, `${base}/outputSchema/properties/${pname}`, add);
  }
}

function checkConfirmation(action: Action, base: string, add: Add) {
  const rule = SAFETY[action.safety].confirmation;
  const c = action.confirmation;
  if (rule === "required") {
    if (c?.required === false) {
      add("error", "OI110", `${base}/confirmation/required`, `${action.safety} actions always require confirmation; remove "required": false`);
    }
    if (!c?.prompt) {
      add("error", "OI110", `${base}/confirmation`, `${action.safety} actions need confirmation.prompt, the question shown to the user before it runs`);
    }
  }
  if (rule === "none" && c) {
    add("warning", "OI112", `${base}/confirmation`, "read actions never ask for confirmation; this block is ignored");
  }
  if (c?.prompt) {
    const params = action.inputSchema.properties ?? {};
    for (const match of c.prompt.matchAll(/\{([^}]+)\}/g)) {
      if (!params[match[1]]) add("error", "OI111", `${base}/confirmation/prompt`, `placeholder {${match[1]}} is not an input parameter`);
    }
  }
}

function checkBackend(action: Action, m: Manifest, base: string, add: Add) {
  const b = action.backend;
  if (!b) {
    if (m.backend && isEnabledFor(action, "mcp")) {
      add("error", "OI132", `${base}`, 'action is enabled for MCP but has no backend mapping; add "backend" or set platforms.mcp.enabled to false');
    }
    return;
  }
  const params = action.inputSchema.properties ?? {};
  const required = new Set(action.inputSchema.required ?? []);
  const pathParams = [...b.path.matchAll(/\{([^}]+)\}/g)].map((x) => x[1]);
  for (const p of pathParams) {
    if (!params[p]) add("error", "OI130", `${base}/backend/path`, `path placeholder {${p}} is not an input parameter`);
    else if (!required.has(p)) add("error", "OI130", `${base}/backend/path`, `path placeholder {${p}} must be a required parameter`);
  }
  const query = b.query ?? [];
  const body = b.body ?? [];
  for (const [list, field] of [[query, "query"], [body, "body"]] as const) {
    for (const p of list) {
      if (!params[p]) add("error", "OI131", `${base}/backend/${field}`, `"${p}" is not an input parameter`);
      if (pathParams.includes(p)) add("error", "OI131", `${base}/backend/${field}`, `"${p}" is already used in the path`);
    }
  }
  for (const p of query) if (body.includes(p)) add("error", "OI131", `${base}/backend`, `"${p}" is listed in both query and body`);
  if ((b.method === "GET" || b.method === "DELETE") && body.length) {
    add("warning", "OI131", `${base}/backend/body`, `${b.method} requests usually have no body`);
  }
  const expected: Record<string, string[]> = {
    GET: ["read"],
    DELETE: ["destructive"],
    POST: ["write", "destructive", "payment", "read"],
    PUT: ["write", "destructive"],
    PATCH: ["write", "destructive"],
  };
  if (!expected[b.method].includes(action.safety)) {
    add("warning", "OI134", `${base}/safety`, `safety "${action.safety}" is unusual for ${b.method}; check that the safety level matches what the endpoint does`);
  }
}

function checkPlatforms(action: Action, base: string, add: Add) {
  const android = action.platforms?.android?.enabled;
  if (action.safety === "payment" && android === true) {
    add("error", "OI140", `${base}/platforms/android`, "payment actions cannot be exposed as Android AppFunctions (they must not handle financial details)");
  }
  if (androidRule(action) === "opt-in" && android === true) {
    add("warning", "OI141", `${base}/platforms/android`, "this AppFunction needs confirmation, so it is generated disabled (isEnabled = false); enable it at runtime only after your own consent UI");
  }
}

function checkExamples(
  action: Action,
  ajv: ReturnType<typeof createAjv>,
  base: string,
  add: Add,
  utterances: Map<string, string>,
) {
  if (action.examples.length < 2) {
    add("error", "OI107", `${base}/examples`, `add at least 2 sample utterances (found ${action.examples.length})`);
  }
  const validate = ajv.compile(mcpInputSchema(action));
  const local = new Set<string>();
  action.examples.forEach((ex, i) => {
    const path = `${base}/examples/${i}`;
    if (!validate(ex.arguments)) {
      const why = (validate.errors ?? []).map((e) => `${e.instancePath || "arguments"} ${e.message}`).join("; ");
      add("error", "OI108", `${path}/arguments`, `arguments do not match inputSchema: ${why}`);
    }
    const key = ex.utterance.trim().toLowerCase();
    if (local.has(key)) add("warning", "OI109", `${path}/utterance`, "duplicate utterance within this action");
    local.add(key);
    const owner = utterances.get(key);
    if (owner && owner !== action.name) {
      add("error", "OI109", `${path}/utterance`, `the same utterance is also an example of "${owner}"; an agent could not tell them apart`);
    } else utterances.set(key, action.name);
  });
}

export function formatIssues(issues: Issue[]): string {
  return issues
    .map((i) => `${i.severity === "error" ? "error  " : "warning"} ${i.rule.padEnd(6)} ${i.path}: ${i.message}`)
    .join("\n");
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}
