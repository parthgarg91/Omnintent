// AI discovery: ask Claude (Messages API) to propose actions for an app, as a
// structured "proposal" that a deterministic converter turns into a manifest.
// Structured outputs need closed objects (additionalProperties: false) and no
// free-form maps, so the proposal uses arrays where the manifest uses maps.
// The converted manifest is validated; on failure the errors go back to the
// model for a bounded number of repair rounds. Nothing invalid is returned.

import type {
  Action,
  BackendAuth,
  Entity,
  EntityProperty,
  Manifest,
  OutputSchema,
  ParameterSchema,
  Safety,
  ValueSchema,
} from "../manifest.js";
import { validateManifest, type Issue } from "../validate.js";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2026-10-21";
export const DEFAULT_MODEL = "claude-opus-5-5";

const str = { type: "string" } as const;
const bool = { type: "boolean" } as const;
const strEnum = (values: string[]) => ({ type: "string", enum: values }) as const;
const arr = (items: object) => ({ type: "array", items }) as const;
const obj = (properties: Record<string, object>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const FIELD = obj({
  name: str,
  type: strEnum(["string", "integer", "number", "boolean", "string_array"]),
  format: strEnum(["none", "date", "date-time", "uri", "email"]),
  title: str,
  description: str,
  required: bool,
  enumValues: arr(str),
});

const PROPERTY = obj({
  ...FIELD.properties,
  visibility: strEnum(["public", "internal"]),
  privacy: strEnum(["inherit", "public", "personal", "sensitive"]),
});

const PARAM = obj({
  ...FIELD.properties,
  entity: str,
  location: strEnum(["path", "query", "body"]),
});

export const PROPOSAL_SCHEMA = obj({
  app: obj({ name: str, description: str, instructions: str }),
  entities: arr(
    obj({
      name: str,
      title: str,
      description: str,
      privacy: strEnum(["public", "personal", "sensitive"]),
      idProperty: str,
      displayProperty: str,
      properties: arr(PROPERTY),
    }),
  ),
  actions: arr(
    obj({
      name: str,
      title: str,
      description: str,
      safety: strEnum(["read", "write", "destructive", "payment"]),
      idempotent: bool,
      openWorld: bool,
      confirmationPrompt: str,
      params: arr(PARAM),
      output: obj({ kind: strEnum(["none", "entity", "entity_list", "object"]), entity: str, fields: arr(FIELD) }),
      backend: obj({ method: strEnum(["GET", "POST", "PUT", "PATCH", "DELETE"]), path: str }),
      examples: arr(obj({ utterance: str, arguments: arr(obj({ name: str, value: str })) })),
    }),
  ),
  skills: arr(obj({ name: str, description: str, instructions: str, actions: arr(str) })),
});

// ---------------------------------------------------------------- proposal types

interface PField {
  name: string;
  type: "string" | "integer" | "number" | "boolean" | "string_array";
  format: "none" | "date" | "date-time" | "uri" | "email";
  title: string;
  description: string;
  required: boolean;
  enumValues: string[];
}
interface PProperty extends PField {
  visibility: "public" | "internal";
  privacy: "inherit" | "public" | "personal" | "sensitive";
}
interface PParam extends PField {
  entity: string;
  location: "path" | "query" | "body";
}
export interface Proposal {
  app: { name: string; description: string; instructions: string };
  entities: { name: string; title: string; description: string; privacy: "public" | "personal" | "sensitive"; idProperty: string; displayProperty: string; properties: PProperty[] }[];
  actions: {
    name: string;
    title: string;
    description: string;
    safety: Safety;
    idempotent: boolean;
    openWorld: boolean;
    confirmationPrompt: string;
    params: PParam[];
    output: { kind: "none" | "entity" | "entity_list" | "object"; entity: string; fields: PField[] };
    backend: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string };
    examples: { utterance: string; arguments: { name: string; value: string }[] }[];
  }[];
  skills: { name: string; description: string; instructions: string; actions: string[] }[];
}

// ---------------------------------------------------------------- conversion

function value(f: PField): ValueSchema {
  const out: ValueSchema = { type: f.type === "string_array" ? "array" : f.type, title: f.title || f.name, description: f.description || f.title || f.name };
  if (f.type === "string_array") out.items = { type: "string" };
  if (f.type === "string" && f.format !== "none") out.format = f.format;
  if (f.type === "string" && f.enumValues.length) out.enum = [...new Set(f.enumValues)];
  return out;
}

function typedArgument(raw: string, f: PField | undefined): unknown {
  if (!f) return raw;
  if (f.type === "integer") return Number.parseInt(raw, 10);
  if (f.type === "number") return Number.parseFloat(raw);
  if (f.type === "boolean") return raw.trim().toLowerCase() === "true";
  if (f.type === "string_array") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // fall through to comma splitting
    }
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return raw;
}

export interface ConversionBase {
  slug: string;
  version?: string;
  baseUrl: string;
  auth: BackendAuth;
  android?: { packageName: string };
}

export function proposalToManifest(p: Proposal, base: ConversionBase): Manifest {
  const entities: Record<string, Entity> = {};
  for (const e of p.entities) {
    const properties: Record<string, EntityProperty> = {};
    for (const prop of e.properties) {
      const v: EntityProperty = value(prop);
      if (prop.visibility === "internal") v.visibility = "internal";
      if (prop.privacy !== "inherit") v.privacy = prop.privacy;
      properties[prop.name] = v;
    }
    entities[e.name] = {
      type: "object",
      title: e.title,
      description: e.description,
      privacy: e.privacy,
      idProperty: e.idProperty,
      displayProperty: e.displayProperty,
      properties,
      required: e.properties.filter((x) => x.required || x.name === e.idProperty || x.name === e.displayProperty).map((x) => x.name),
    };
  }
  const actions: Action[] = p.actions.map((a) => {
    const properties: Record<string, ParameterSchema> = {};
    for (const param of a.params) {
      const v: ParameterSchema = value(param);
      if (param.entity) v["x-omnintent-entity"] = param.entity;
      properties[param.name] = v;
    }
    const required = a.params.filter((x) => x.required || x.location === "path").map((x) => x.name);
    let outputSchema: OutputSchema | undefined;
    if (a.output.kind === "entity") outputSchema = { $ref: `#/entities/${a.output.entity}` };
    if (a.output.kind === "entity_list") outputSchema = { type: "array", items: { $ref: `#/entities/${a.output.entity}` } };
    if (a.output.kind === "object" && a.output.fields.length) {
      outputSchema = {
        type: "object",
        properties: Object.fromEntries(a.output.fields.map((f) => [f.name, value(f)])),
        required: a.output.fields.filter((f) => f.required).map((f) => f.name),
      };
    }
    const byName = new Map(a.params.map((x) => [x.name, x]));
    const query = a.params.filter((x) => x.location === "query").map((x) => x.name);
    const body = a.params.filter((x) => x.location === "body").map((x) => x.name);
    const action: Action = {
      name: a.name,
      title: a.title,
      description: a.description,
      safety: a.safety,
      inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
      ...(outputSchema ? { outputSchema } : {}),
      backend: { method: a.backend.method, path: a.backend.path, ...(query.length ? { query } : {}), ...(body.length ? { body } : {}) },
      examples: a.examples.map((ex) => ({
        utterance: ex.utterance,
        arguments: Object.fromEntries(ex.arguments.map((arg) => [arg.name, typedArgument(arg.value, byName.get(arg.name))])),
      })),
    };
    if (a.idempotent) action.idempotent = true;
    if (a.openWorld) action.openWorld = true;
    if (a.confirmationPrompt.trim()) {
      action.confirmation = { prompt: a.confirmationPrompt.trim() };
      if (a.safety === "write") action.confirmation.required = true;
    }
    return action;
  });
  const manifest: Manifest = {
    omnintent: "0.1",
    app: {
      name: p.app.name,
      slug: base.slug,
      version: base.version ?? "0.1.0",
      description: p.app.description,
      ...(p.app.instructions.trim() ? { instructions: p.app.instructions.trim() } : {}),
      ...(base.android ? { android: base.android } : {}),
    },
    backend: { baseUrl: base.baseUrl, auth: base.auth },
    ...(Object.keys(entities).length ? { entities } : {}),
    actions,
  };
  if (p.skills.length) manifest.skills = p.skills.map((s) => ({ ...s, actions: s.actions }));
  return manifest;
}

// ---------------------------------------------------------------- prompting

export const SYSTEM_PROMPT = `You draft Omnintent manifests: one description of an app's actions that becomes Siri tool intents, Android AppFunctions and MCP tools.
Follow the Omnintent Rule Book v0.1:
- Propose the actions a person would ask an assistant to do in this app. Each action does one thing. Prefer 3 to 12 actions.
- Action names are snake_case verbs plus resource (add_item, list_items). Titles are short Title Case ("Add Item").
- Descriptions start with a third-person verb and the resource ("Adds an item to a list."), say what is returned, and stay neutral. No "you must", no capitals for emphasis, no filler such as "This function", no references to other actions.
- Safety: read (no changes), write (creates or changes, reversible), destructive (deletes or cannot be undone), payment (moves money or commits to a purchase). When unsure between write and destructive, choose destructive.
- destructive and payment actions need confirmationPrompt: a short question naming what will happen, which may use {paramName} placeholders. Leave it empty for read actions.
- Parameter names are camelCase. Each parameter has a title and a description with an example value. Parameters that hold the ID of an entity set entity to the entity name. Never add parameters such as fullContext or conversationHistory.
- Every path placeholder in backend.path is a required parameter with location path. Use the real API routes you were given; do not invent endpoints.
- Entities are the things actions return. idProperty and displayProperty must be required string properties. Mark passwords, tokens, payment data and health data privacy "sensitive"; mark app-internal fields visibility "internal".
- Give every action at least 2 example utterances, phrased the way a person would talk to an assistant, with the arguments an assistant should extract. Every required string argument value appears word for word in its utterance, except entity IDs. No two actions share an utterance.
- Skills are optional multi-step workflows (lowercase-hyphen names) that refer to actions informally.
- Use "none" for format when no format applies, and empty strings or arrays for unused fields.`;

export interface AiOptions {
  apiKey: string;
  /** API origin; defaults to https://api.anthropic.com (ANTHROPIC_BASE_URL in the CLI). */
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  maxRepairs?: number;
  maxTokens?: number;
  log?: (message: string) => void;
}

type Message = { role: "user" | "assistant"; content: string };

export async function callClaude(messages: Message[], opts: AiOptions): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${(opts.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, "")}/v1/messages`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "x-api-key": opts.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model ?? DEFAULT_MODEL,
      max_tokens: opts.maxTokens ?? 32000,
      system: SYSTEM_PROMPT,
      messages,
      output_config: { format: { type: "json_schema", schema: PROPOSAL_SCHEMA } },
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Anthropic API error ${response.status}: ${text.slice(0, 500)}`);
  const body = JSON.parse(text) as { stop_reason?: string; content?: { type: string; text?: string }[] };
  if (body.stop_reason === "refusal") throw new Error("The model declined to draft this manifest.");
  if (body.stop_reason === "max_tokens") throw new Error("The model ran out of output tokens; try a smaller input.");
  const block = body.content?.find((c) => c.type === "text" && typeof c.text === "string");
  if (!block?.text) throw new Error("The Anthropic API response had no text content.");
  return block.text;
}

export interface AiResult {
  manifest: Manifest;
  attempts: number;
  issues: Issue[];
}

export async function draftWithAi(context: string, draft: Manifest | undefined, base: ConversionBase, opts: AiOptions): Promise<AiResult> {
  const maxRepairs = opts.maxRepairs ?? 2;
  const messages: Message[] = [
    {
      role: "user",
      content: [
        "Draft the Omnintent proposal for this app.",
        "",
        "<app_context>",
        context,
        "</app_context>",
        draft ? "\nA mechanical draft made from the API description follows. Keep its routes and entities, improve names, descriptions, safety levels, parameters and utterances, and drop actions an assistant should not perform." : "",
        draft ? `<mechanical_draft>\n${JSON.stringify(draft)}\n</mechanical_draft>` : "",
      ].join("\n"),
    },
  ];
  let lastIssues: Issue[] = [];
  for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
    opts.log?.(`Asking ${opts.model ?? DEFAULT_MODEL} for a proposal (attempt ${attempt})...`);
    const text = await callClaude(messages, opts);
    let proposal: Proposal;
    try {
      proposal = JSON.parse(text) as Proposal;
    } catch {
      lastIssues = [{ severity: "error", rule: "AI", path: "/", message: "response was not valid JSON" }];
      messages.push({ role: "assistant", content: text }, { role: "user", content: "That was not valid JSON. Return the full proposal again." });
      continue;
    }
    const manifest = proposalToManifest(proposal, base);
    const result = validateManifest(manifest);
    if (result.ok) return { manifest, attempts: attempt, issues: result.issues };
    lastIssues = result.issues.filter((i) => i.severity === "error");
    messages.push(
      { role: "assistant", content: text },
      {
        role: "user",
        content: `The proposal converts to a manifest with these errors:\n${lastIssues.map((i) => `- ${i.path}: ${i.message}`).join("\n")}\nReturn the full corrected proposal.`,
      },
    );
  }
  const summary = lastIssues.map((i) => `${i.path}: ${i.message}`).join("; ");
  throw new Error(`The AI proposal was still invalid after ${maxRepairs} repair rounds: ${summary}`);
}
