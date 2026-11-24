// JSON Schema helpers: load the manifest meta-schema, and turn manifest
// fragments into the plain JSON Schemas that MCP tools publish.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type {
  Action,
  Entity,
  EntityProperty,
  InputSchema,
  Manifest,
  ParameterSchema,
  ValueSchema,
} from "./manifest.js";
import { refName } from "./safety.js";

// ajv-formats ships CommonJS; normalise the default export across loaders.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as unknown as (ajv: Ajv2020) => Ajv2020;

export type JsonObject = Record<string, unknown>;

let cachedSchema: JsonObject | undefined;

export function manifestSchema(): JsonObject {
  if (cachedSchema) return cachedSchema;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../schema/omnintent.schema.json"),
    resolve(here, "../../../schema/omnintent.schema.json"),
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) throw new Error("Cannot find omnintent.schema.json next to the CLI.");
  cachedSchema = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
  return cachedSchema;
}

export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

/** Keywords that exist in Omnintent manifests but not in published JSON Schemas. */
const OMNINTENT_KEYWORDS = new Set([
  "x-omnintent-entity",
  "privacy",
  "visibility",
  "authentication",
  "idProperty",
  "displayProperty",
]);

const VALUE_KEYWORDS = [
  "type",
  "title",
  "description",
  "format",
  "enum",
  "items",
  "default",
  "examples",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "pattern",
] as const;

/** A value schema with Omnintent keywords removed. `int64` is a hint for typed languages, not a JSON Schema format. */
export function plainValueSchema(schema: ValueSchema): JsonObject {
  const out: JsonObject = {};
  for (const key of VALUE_KEYWORDS) {
    const value = (schema as unknown as JsonObject)[key];
    if (value === undefined) continue;
    if (key === "format" && value === "int64") continue;
    if (key === "items" && value && typeof value === "object") {
      const items = { ...(value as JsonObject) };
      if (items.format === "int64") delete items.format;
      out.items = items;
      continue;
    }
    out[key] = value;
  }
  for (const key of Object.keys(schema)) {
    if (!OMNINTENT_KEYWORDS.has(key) && !(VALUE_KEYWORDS as readonly string[]).includes(key)) {
      out[key] = (schema as unknown as JsonObject)[key];
    }
  }
  return out;
}

/** Effective privacy of a property: its own, else its entity's, else personal. */
export function propertyPrivacy(entity: Pick<Entity, "privacy"> | undefined, prop: EntityProperty) {
  return prop.privacy ?? entity?.privacy ?? "personal";
}

/**
 * Properties an off-device agent (MCP) or Android agent may see: not internal
 * and not sensitive. The id and display properties are always visible (the
 * validator forbids marking them sensitive or internal).
 */
export function agentVisibleProperties(
  entity: Pick<Entity, "privacy" | "properties"> & Partial<Pick<Entity, "idProperty" | "displayProperty">>,
): [string, EntityProperty][] {
  return Object.entries(entity.properties).filter(([name, prop]) => {
    if (name === entity.idProperty || name === entity.displayProperty) return true;
    if (prop.visibility === "internal") return false;
    return propertyPrivacy(entity, prop) !== "sensitive";
  });
}

function objectSchema(
  title: string | undefined,
  description: string | undefined,
  props: [string, EntityProperty][],
  required: string[] | undefined,
): JsonObject {
  const names = new Set(props.map(([n]) => n));
  const out: JsonObject = { type: "object" };
  if (title) out.title = title;
  if (description) out.description = description;
  out.properties = Object.fromEntries(props.map(([n, p]) => [n, plainValueSchema(p)]));
  const req = (required ?? []).filter((r) => names.has(r));
  if (req.length) out.required = req;
  return out;
}

/** The agent-facing JSON Schema of an entity. */
export function entityJsonSchema(entity: Entity): JsonObject {
  return objectSchema(entity.title, entity.description, agentVisibleProperties(entity), entity.required);
}

export function mcpInputSchema(action: Action): JsonObject {
  const input: InputSchema = action.inputSchema;
  const props = Object.entries(input.properties ?? {});
  const out: JsonObject = {
    type: "object",
    properties: Object.fromEntries(props.map(([n, p]) => [n, plainValueSchema(p as ParameterSchema)])),
  };
  if (input.required?.length) out.required = [...input.required];
  out.additionalProperties = false;
  return out;
}

/**
 * The MCP outputSchema. Lists are wrapped as {"items": [...]} because MCP
 * revisions before 2026-07-28 require structured content to be an object.
 */
export function mcpOutputSchema(manifest: Manifest, action: Action): JsonObject | undefined {
  const out = action.outputSchema;
  if (!out) return undefined;
  if ("$ref" in out) return entityJsonSchema(entityOrThrow(manifest, out.$ref));
  if (out.type === "array") {
    return {
      type: "object",
      properties: { items: { type: "array", items: entityJsonSchema(entityOrThrow(manifest, out.items.$ref)) } },
      required: ["items"],
    };
  }
  return objectSchema(
    out.title,
    out.description,
    agentVisibleProperties({ privacy: undefined, properties: out.properties }),
    out.required,
  );
}

export function entityOrThrow(manifest: Manifest, ref: string): Entity {
  const name = refName(ref);
  const entity = manifest.entities?.[name];
  if (!entity) throw new Error(`Unknown entity reference ${ref}`);
  return entity;
}

/** How an output is shaped, for the typed generators. */
export type OutputShape =
  | { kind: "none" }
  | { kind: "entity"; entity: string }
  | { kind: "entityList"; entity: string }
  | { kind: "object"; properties: Record<string, EntityProperty>; required: string[] };

export function outputShape(action: Action): OutputShape {
  const out = action.outputSchema;
  if (!out) return { kind: "none" };
  if ("$ref" in out) return { kind: "entity", entity: refName(out.$ref) };
  if (out.type === "array") return { kind: "entityList", entity: refName(out.items.$ref) };
  return { kind: "object", properties: out.properties, required: out.required ?? [] };
}
