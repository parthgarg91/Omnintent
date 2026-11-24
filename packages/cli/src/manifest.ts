// TypeScript view of omnintent.json (Omnintent Rule Book v0.1).
// The JSON Schema in schema/omnintent.schema.json is the normative structure;
// these types mirror it for the CLI's own use.

export type Safety = "read" | "write" | "destructive" | "payment";
export type Privacy = "public" | "personal" | "sensitive";
export type AuthLevel = "none" | "authenticated" | "local-device";
export type ScalarType = "string" | "integer" | "number" | "boolean";
export type ValueType = ScalarType | "array";
export type StringFormat = "date" | "date-time" | "uri" | "email" | "int64";

export interface ItemSchema {
  type: ScalarType;
  format?: StringFormat;
  enum?: string[];
  description?: string;
}

export interface ValueSchema {
  type: ValueType;
  title?: string;
  description: string;
  format?: StringFormat;
  enum?: string[];
  items?: ItemSchema;
  default?: unknown;
  examples?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
}

export interface ParameterSchema extends ValueSchema {
  "x-omnintent-entity"?: string;
}

export interface EntityProperty extends ValueSchema {
  privacy?: Privacy;
  visibility?: "public" | "internal";
  authentication?: AuthLevel;
}

export interface Entity {
  type: "object";
  title: string;
  description: string;
  privacy?: Privacy;
  authentication?: AuthLevel;
  idProperty: string;
  displayProperty: string;
  properties: Record<string, EntityProperty>;
  required?: string[];
}

export interface InputSchema {
  type: "object";
  properties?: Record<string, ParameterSchema>;
  required?: string[];
  additionalProperties?: false;
}

export interface EntityRef {
  $ref: string;
}

export interface InlineObjectOutput {
  type: "object";
  title?: string;
  description?: string;
  properties: Record<string, EntityProperty>;
  required?: string[];
}

export type OutputSchema = EntityRef | { type: "array"; items: EntityRef } | InlineObjectOutput;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ActionBackend {
  method: HttpMethod;
  path: string;
  query?: string[];
  body?: string[];
  resultPointer?: string;
}

export interface Example {
  utterance: string;
  arguments: Record<string, unknown>;
}

export interface Confirmation {
  required?: boolean;
  prompt?: string;
  acceptLabel?: string;
}

export interface PlatformSwitches {
  ios?: { enabled?: boolean };
  android?: { enabled?: boolean };
  mcp?: { enabled?: boolean };
}

export interface Action {
  name: string;
  title: string;
  description: string;
  safety: Safety;
  idempotent?: boolean;
  openWorld?: boolean;
  authentication?: AuthLevel;
  confirmation?: Confirmation;
  inputSchema: InputSchema;
  outputSchema?: OutputSchema;
  backend?: ActionBackend;
  examples: Example[];
  platforms?: PlatformSwitches;
}

export interface Skill {
  name: string;
  description: string;
  instructions: string;
  actions?: string[];
}

export interface BackendConfig {
  baseUrl: string;
  auth?: { type: "none" } | { type: "bearer"; secret: string };
  timeoutMs?: number;
}

export interface AppInfo {
  name: string;
  slug: string;
  version?: string;
  description: string;
  instructions?: string;
  ios?: { bundleId?: string };
  android?: { packageName: string };
}

export interface Manifest {
  $schema?: string;
  omnintent: "0.1";
  app: AppInfo;
  backend?: BackendConfig;
  entities?: Record<string, Entity>;
  actions: Action[];
  skills?: Skill[];
}

export const OMNINTENT_VERSION = "0.1";
export const CLI_VERSION = "0.1.0";
