// Deterministic discovery: draft an omnintent.json from an OpenAPI 3.x file.
// Names, descriptions and parameters come from the spec; safety comes from the
// HTTP method (plus a payment keyword check); sample utterances are templated
// from example values. The draft is meant to be reviewed, then refined by the
// AI path or by hand.

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type {
  Action,
  ActionBackend,
  Entity,
  EntityProperty,
  HttpMethod,
  Manifest,
  OutputSchema,
  ParameterSchema,
  Safety,
  ValueSchema,
} from "../manifest.js";
import { kebabCase, pascalCase, snakeCase, titleCase } from "../naming.js";

type Obj = Record<string, unknown>;

export interface Draft {
  manifest: Manifest;
  notes: string[];
}

export function loadOpenApi(path: string): Obj {
  const text = readFileSync(path, "utf8");
  const doc = (/\.json$/i.test(path) ? JSON.parse(text) : parseYaml(text)) as unknown;
  if (!isObj(doc) || typeof doc.openapi !== "string" || !doc.openapi.startsWith("3.")) {
    throw new Error(`${path} is not an OpenAPI 3.x document (missing "openapi: 3.x").`);
  }
  return doc;
}

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const PAYMENT_WORDS = /\b(pay|payment|checkout|purchase|charge|order|buy|subscribe|refund|invoice)s?\b/i;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sentence(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

export function draftFromOpenApi(doc: Obj): Draft {
  const notes: string[] = [];
  const resolve = (v: unknown, seen = new Set<string>()): unknown => {
    if (!isObj(v) || typeof v.$ref !== "string") return v;
    const ref = v.$ref;
    if (!ref.startsWith("#/") || seen.has(ref)) return {};
    seen.add(ref);
    let cur: unknown = doc;
    for (const part of ref.slice(2).split("/")) cur = isObj(cur) ? cur[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
    return resolve(cur, seen);
  };
  const refName = (v: unknown): string | undefined =>
    isObj(v) && typeof v.$ref === "string" && v.$ref.startsWith("#/components/schemas/") ? v.$ref.split("/").pop() : undefined;

  const info = (isObj(doc.info) ? doc.info : {}) as Obj;
  const appName = clip(typeof info.title === "string" && info.title.trim() ? info.title.trim() : "My App", 60);
  const slug = (kebabCase(appName).replace(/[^a-z0-9-]/g, "") || "my-app").replace(/^[^a-z]+/, "").slice(0, 50).replace(/-+$/, "") || "my-app";
  let description = typeof info.description === "string" && info.description.trim() ? sentence(info.description) : `${appName} API.`;
  if (description.length < 10) description = `The ${appName} app and its API.`;
  const version = typeof info.version === "string" && /^\d+\.\d+\.\d+/.test(info.version) ? info.version : "0.1.0";

  // Backend
  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  const serverUrl = isObj(servers[0]) && typeof servers[0].url === "string" ? servers[0].url : "";
  const baseUrl = /^https?:\/\//.test(serverUrl) ? serverUrl.replace(/\/+$/, "") : "<YOUR_BACKEND_URL>";
  if (baseUrl.startsWith("<")) notes.push("No absolute server URL in the OpenAPI file; backend.baseUrl is a placeholder.");
  const components = (isObj(doc.components) ? doc.components : {}) as Obj;
  const schemes = isObj(components.securitySchemes) ? Object.values(components.securitySchemes).map((s) => resolve(s)) : [];
  const bearer = schemes.some((s) => isObj(s) && ((s.type === "http" && String(s.scheme).toLowerCase() === "bearer") || s.type === "oauth2" || s.type === "openIdConnect"));
  const apiKey = schemes.some((s) => isObj(s) && s.type === "apiKey");
  if (apiKey && !bearer) notes.push("The API uses an API-key header; v0.1 MCP servers send only Authorization: Bearer. Adjust the backend or the generated server.");
  const auth = bearer || apiKey ? ({ type: "bearer", secret: "BACKEND_TOKEN" } as const) : ({ type: "none" } as const);
  if (schemes.some((s) => isObj(s) && (s.type === "oauth2" || s.type === "openIdConnect"))) {
    notes.push('The API uses OAuth. For per-user sign-in, set backend.auth to {"type": "oauth", ...} (SPEC.md, section E.5); the draft uses one shared bearer token.');
  }

  // Entities from component schemas used in responses
  const schemas = (isObj(components.schemas) ? components.schemas : {}) as Obj;
  const entities: Record<string, Entity> = {};
  const entityFor = new Map<string, string>();
  const toEntity = (compName: string): string | undefined => {
    if (entityFor.has(compName)) return entityFor.get(compName);
    const schema = resolve(schemas[compName]);
    if (!isObj(schema) || !isObj(schema.properties)) return undefined;
    const name = pascalCase(compName);
    const title = titleCase(compName);
    const props: Record<string, EntityProperty> = {};
    for (const [pname, raw] of Object.entries(schema.properties)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(pname)) continue;
      const v = valueSchema(resolve(raw), pname, `the ${title.toLowerCase()}`);
      if (v) props[pname] = v;
      else notes.push(`Skipped ${compName}.${pname}: nested objects are not supported in v0.1 entities.`);
    }
    const strings = Object.entries(props).filter(([, p]) => p.type === "string" && !p.format && !p.enum).map(([n]) => n);
    const idProperty = strings.find((n) => n === "id") ?? strings.find((n) => /(Id|_id)$/.test(n)) ?? strings[0];
    if (!idProperty) return undefined; // Not an entity; responses using it become inline results.
    const displayProperty = strings.find((n) => /^(name|title|label|displayName|summary)$/.test(n)) ?? idProperty;
    const required = new Set((Array.isArray(schema.required) ? schema.required : []).filter((r): r is string => typeof r === "string" && !!props[r]));
    for (const key of [idProperty, displayProperty]) {
      if (!required.has(key)) {
        required.add(key);
        notes.push(`${name}.${key} was not required in the OpenAPI schema; it is required here because agents use it to refer to the entity.`);
      }
    }
    entities[name] = {
      type: "object",
      title,
      description: typeof schema.description === "string" && schema.description.trim() ? sentence(schema.description) : `A ${title.toLowerCase()} in ${appName}.`,
      privacy: "personal",
      idProperty,
      displayProperty,
      properties: props,
      required: [...required],
    };
    entityFor.set(compName, name);
    return name;
  };

  // Actions
  const actions: Action[] = [];
  const paths = (isObj(doc.paths) ? doc.paths : {}) as Obj;
  const usedNames = new Set<string>();
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = resolve(rawItem);
    if (!isObj(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method.toLowerCase()];
      if (!isObj(op) || op["x-omnintent-ignore"] === true) continue;
      const action = draftAction(path, method, op, shared);
      if (action) actions.push(action);
    }
  }
  if (!actions.length) throw new Error("The OpenAPI file has no operations Omnintent can use.");

  function draftAction(path: string, method: HttpMethod, op: Obj, shared: unknown[]): Action | undefined {
    const opId = typeof op.operationId === "string" ? op.operationId : `${method} ${path.replace(/[{}]/g, "")}`;
    let name = snakeCase(opId).replace(/^[^a-z]+/, "") || `${method.toLowerCase()}_action`;
    while (usedNames.has(name)) name = `${name}_2`;
    usedNames.add(name);
    const summary = typeof op.summary === "string" ? op.summary.trim() : "";
    const title = clip(summary ? titleText(summary) : titleCase(name), 60);
    let desc = typeof op.description === "string" && op.description.trim() ? op.description : summary || `${title}.`;
    desc = clip(sentence(desc), 1024);
    if (desc.length < 10) desc = `${title} in ${appName}.`;

    const text = `${opId} ${path} ${summary}`;
    let safety: Safety = method === "GET" ? "read" : method === "DELETE" ? "destructive" : "write";
    if (method !== "GET" && PAYMENT_WORDS.test(text)) safety = "payment";

    const properties: Record<string, ParameterSchema> = {};
    const required: string[] = [];
    const query: string[] = [];
    const body: string[] = [];
    const params = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])].map((p) => resolve(p));
    for (const p of params) {
      if (!isObj(p) || typeof p.name !== "string" || (p.in !== "path" && p.in !== "query")) continue;
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(p.name)) {
        notes.push(`${name}: skipped parameter "${p.name}" (not a valid identifier).`);
        continue;
      }
      const schema = { ...(isObj(resolve(p.schema)) ? (resolve(p.schema) as Obj) : { type: "string" }) };
      if (typeof p.description === "string") schema.description = p.description;
      if (p.example !== undefined) schema.examples = [p.example];
      const v = valueSchema(schema, p.name, "the request");
      if (!v) continue;
      properties[p.name] = v;
      if (p.in === "path" || p.required === true) required.push(p.name);
      if (p.in === "query") query.push(p.name);
    }
    const reqBody = resolve(op.requestBody);
    const content = isObj(reqBody) && isObj(reqBody.content) ? reqBody.content : {};
    const json = resolve(isObj(content["application/json"]) ? (content["application/json"] as Obj).schema : undefined);
    if (isObj(json) && isObj(json.properties)) {
      const bodyRequired = Array.isArray(json.required) ? json.required : [];
      for (const [pname, raw] of Object.entries(json.properties)) {
        if (properties[pname] || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(pname)) continue;
        const v = valueSchema(resolve(raw), pname, "the request");
        if (!v) {
          notes.push(`${name}: skipped body field "${pname}" (nested objects are not supported in v0.1).`);
          continue;
        }
        properties[pname] = v;
        body.push(pname);
        if (bodyRequired.includes(pname)) required.push(pname);
      }
    }

    // Link ID parameters to entities: listId -> TodoList when the match is unique.
    for (const [pname, p] of Object.entries(properties)) {
      const base = pname.replace(/(Id|_id)$/, "");
      if (base === pname || p.type !== "string") continue;
      const matches = Object.keys(entities).filter((e) => e.toLowerCase().endsWith(base.toLowerCase()));
      if (matches.length === 1) p["x-omnintent-entity"] = matches[0];
    }

    let outputSchema: OutputSchema | undefined;
    const responses = isObj(op.responses) ? op.responses : {};
    const okKey = Object.keys(responses).find((k) => /^2/.test(k));
    const okResp = okKey ? resolve(responses[okKey]) : undefined;
    const okContent = isObj(okResp) && isObj(okResp.content) ? okResp.content : {};
    const okSchemaRaw = isObj(okContent["application/json"]) ? (okContent["application/json"] as Obj).schema : undefined;
    const okSchema = resolve(okSchemaRaw);
    const direct = refName(okSchemaRaw);
    if (direct && toEntity(direct)) {
      outputSchema = { $ref: `#/entities/${entityFor.get(direct)}` };
    } else if (isObj(okSchema) && okSchema.type === "array" && refName(okSchema.items) && toEntity(refName(okSchema.items)!)) {
      outputSchema = { type: "array", items: { $ref: `#/entities/${entityFor.get(refName(okSchema.items)!)}` } };
    } else if (isObj(okSchema) && isObj(okSchema.properties)) {
      const props: Record<string, EntityProperty> = {};
      for (const [pname, raw] of Object.entries(okSchema.properties)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(pname)) continue;
        const v = valueSchema(resolve(raw), pname, "the result");
        if (v) props[pname] = v;
      }
      if (Object.keys(props).length) {
        const req = (Array.isArray(okSchema.required) ? okSchema.required : []).filter((r): r is string => typeof r === "string" && !!props[r]);
        outputSchema = { type: "object", properties: props, ...(req.length ? { required: req } : {}) };
      }
    }

    const backend: ActionBackend = { method, path };
    if (query.length) backend.query = query;
    if (body.length) backend.body = body;

    const action: Action = {
      name,
      title,
      description: desc,
      safety,
      inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
      ...(outputSchema ? { outputSchema } : {}),
      backend,
      examples: [],
    };
    if (method === "PUT" || method === "DELETE") action.idempotent = true;
    if (safety === "destructive") action.confirmation = { prompt: clip(`${title}? This cannot be undone.`, 200) };
    if (safety === "payment") action.confirmation = { prompt: clip(`Confirm: ${title}?`, 200) };
    action.examples = templateExamples(action);
    return action;
  }

  const manifest: Manifest = {
    omnintent: "0.1",
    app: { name: appName, slug, version, description: clip(description, 1024) },
    backend: { baseUrl, auth },
    ...(Object.keys(entities).length ? { entities } : {}),
    actions,
  };
  notes.push("Sample utterances were templated from example values; rewrite them as things a person would say.");
  return { manifest, notes };
}

/** Converts an OpenAPI schema to an Omnintent value schema, or undefined if unsupported. */
function valueSchema(raw: unknown, name: string, owner: string): (ValueSchema & EntityProperty) | undefined {
  if (!isObj(raw)) return undefined;
  const type = Array.isArray(raw.type) ? raw.type.find((t) => t !== "null") : raw.type;
  const out: ValueSchema = {
    type: "string",
    title: clip(titleCase(name), 60),
    description: typeof raw.description === "string" && raw.description.trim() ? sentence(raw.description) : `The ${titleCase(name).toLowerCase()} of ${owner}.`,
  };
  if (type === "string" || (type === undefined && Array.isArray(raw.enum))) {
    out.type = "string";
    if (typeof raw.format === "string" && ["date", "date-time", "uri", "email"].includes(raw.format)) out.format = raw.format as ValueSchema["format"];
    if (Array.isArray(raw.enum) && raw.enum.every((e) => typeof e === "string" && e)) out.enum = [...new Set(raw.enum as string[])];
    if (typeof raw.minLength === "number") out.minLength = raw.minLength;
    if (typeof raw.maxLength === "number") out.maxLength = raw.maxLength;
  } else if (type === "integer" || type === "number") {
    out.type = type;
    if (type === "integer" && raw.format === "int64") out.format = "int64";
    if (typeof raw.minimum === "number") out.minimum = raw.minimum;
    if (typeof raw.maximum === "number") out.maximum = raw.maximum;
  } else if (type === "boolean") {
    out.type = "boolean";
  } else if (type === "array" && isObj(raw.items) && ["string", "integer", "number", "boolean"].includes(String(raw.items.type))) {
    out.type = "array";
    const items = raw.items;
    out.items = { type: items.type as "string" };
    if (typeof items.format === "string" && ["date", "date-time", "uri", "email"].includes(items.format)) out.items.format = items.format as ValueSchema["format"];
    if (Array.isArray(items.enum) && items.enum.every((e) => typeof e === "string")) out.items.enum = items.enum as string[];
  } else {
    return undefined;
  }
  if (raw.default !== undefined && typeof raw.default !== "object") out.default = raw.default;
  if (raw.example !== undefined && typeof raw.example !== "object") out.examples = [raw.example];
  if (Array.isArray(raw.examples) && raw.examples.length && typeof raw.examples[0] !== "object") out.examples = [raw.examples[0]];
  return out;
}

/** Title Case for prose: capitalises words but keeps hyphenated words ("To-do") intact. */
function titleText(s: string): string {
  const small = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);
  return s
    .trim()
    .split(/\s+/)
    .map((w, i) => (i > 0 && small.has(w.toLowerCase()) ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

function sampleValue(name: string, s: ParameterSchema): unknown {
  if (s.examples?.length) return s.examples[0];
  if (s.default !== undefined) return s.default;
  if (s.enum?.length) return s.enum[0];
  switch (s.type) {
    case "integer":
      return Math.max(1, s.minimum ?? 1);
    case "number":
      return Math.max(1, s.minimum ?? 1);
    case "boolean":
      return true;
    case "array":
      return [];
    default:
      if (s.format === "date") return "2026-12-01";
      if (s.format === "date-time") return "2026-12-01T09:00:00Z";
      if (s.format === "email") return "person@example.com";
      if (s.format === "uri") return "https://example.com/item";
      return `sample ${titleCase(name).toLowerCase()}`;
  }
}

function phrase(args: Record<string, unknown>, joiner: string): string {
  return Object.entries(args)
    .filter(([, v]) => !Array.isArray(v))
    .map(([k, v]) => `${titleCase(k).toLowerCase()} ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(joiner);
}

/** Two templated sample utterances: one with required arguments, one with all of them. */
function templateExamples(action: Action): Action["examples"] {
  const props = action.inputSchema.properties ?? {};
  const required = new Set(action.inputSchema.required ?? []);
  const requiredArgs: Record<string, unknown> = {};
  const allArgs: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(props)) {
    const value = sampleValue(name, schema);
    if (Array.isArray(value)) continue;
    if (required.has(name)) requiredArgs[name] = value;
    allArgs[name] = value;
  }
  const verb = action.title.toLowerCase();
  const first = phrase(requiredArgs, " and ");
  const second = phrase(allArgs, ", ");
  return [
    { utterance: first ? `${action.title} with ${first}` : action.title, arguments: requiredArgs },
    { utterance: second ? `Please ${verb}: ${second}` : `Please ${verb} now`, arguments: allArgs },
  ];
}

export function openApiSummary(doc: Obj): string {
  // A compact view for the AI path: operations and component schemas, no prose padding.
  const paths = isObj(doc.paths) ? doc.paths : {};
  const lines: string[] = [];
  const info = isObj(doc.info) ? doc.info : {};
  lines.push(`API: ${String(info.title ?? "")} ${String(info.version ?? "")}`.trim());
  if (typeof info.description === "string") lines.push(info.description.trim());
  for (const [path, item] of Object.entries(paths)) {
    if (!isObj(item)) continue;
    for (const m of METHODS) {
      const op = item[m.toLowerCase()];
      if (!isObj(op)) continue;
      lines.push(`\n${m} ${path}  operationId=${String(op.operationId ?? "")}`);
      if (op.summary) lines.push(`  summary: ${String(op.summary)}`);
      if (op.description) lines.push(`  description: ${String(op.description).trim()}`);
      lines.push(`  spec: ${JSON.stringify({ parameters: op.parameters, requestBody: op.requestBody, responses: op.responses })}`);
    }
  }
  const components = isObj(doc.components) ? doc.components : {};
  if (isObj(components.schemas)) lines.push(`\ncomponents.schemas: ${JSON.stringify(components.schemas)}`);
  return lines.join("\n").slice(0, 60000);
}

