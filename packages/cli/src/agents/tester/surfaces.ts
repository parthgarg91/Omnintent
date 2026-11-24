// What the agent under test can see and call.
//
// - mcpServerSurface: a live MCP server (usually the generated one, pointed at
//   staging data). Tools come from tools/list, exactly as a host sees them.
//   Read-only tools are really called, so the agent can look up IDs.
// - manifestSurface: no server. Tools are projected from the manifest the way
//   each platform publishes them, and read calls are answered from fixtures.
//
// Write tools are never called by the tester: the first write call is the
// agent's decision, which is all the tester needs to score.

import { readFileSync } from "node:fs";
import type { Action, Manifest } from "../../manifest.js";
import { camelCase, pascalCase } from "../../naming.js";
import { isEnabledFor, skillsFor } from "../../safety.js";
import { mcpInputSchema } from "../../schema.js";
import { serverInstructions } from "../../generators/mcp.js";
import { androidInstructions } from "../../generators/kotlin.js";
import type { Platform } from "./cases.js";

export interface SurfaceTool {
  /** The name the agent sees and calls. */
  name: string;
  /** The manifest action it stands for (undefined if the server has a tool the manifest lacks). */
  action?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The tester may call it to answer a lookup. */
  readOnly: boolean;
}

export interface ReadResult {
  content: string;
  isError: boolean;
}

export interface Surface {
  /** Shown in reports, e.g. "MCP server https://…" or "manifest projection (android)". */
  label: string;
  platform: Platform;
  instructions: string;
  tools: SurfaceTool[];
  /** Differences between what the server publishes and the manifest. */
  notes: string[];
  callRead(tool: SurfaceTool, args: Record<string, unknown>): Promise<ReadResult>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------- manifest projection

/** The callable name of an action on each platform (MCP tool, Siri intent type, AppFunction method). */
export function platformToolName(action: Pick<Action, "name">, platform: Platform): string {
  if (platform === "android") return camelCase(action.name);
  if (platform === "ios") return `${pascalCase(action.name)}Intent`;
  return action.name;
}

export interface FixtureEntry {
  /** Arguments this answer applies to; omitted means any. Matched as a subset. */
  arguments?: Record<string, unknown>;
  result: unknown;
  isError?: boolean;
}

/** Map from action name to one answer or a list of answers chosen by arguments. */
export type Fixtures = Record<string, FixtureEntry | FixtureEntry[]>;

export function readFixtures(path: string): Fixtures {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("fixtures must be an object keyed by action name");
  return raw as Fixtures;
}

const loose = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : JSON.stringify(v));

export function fixtureAnswer(fixtures: Fixtures, action: string, args: Record<string, unknown>): ReadResult {
  const entry = fixtures[action];
  const entries = entry === undefined ? [] : Array.isArray(entry) ? entry : [entry];
  const hit = entries.find((e) => Object.entries(e.arguments ?? {}).every(([k, v]) => loose(args[k]) === loose(v)));
  if (!hit) {
    return { content: `No test data for ${action} with ${JSON.stringify(args)}.`, isError: true };
  }
  return { content: typeof hit.result === "string" ? hit.result : JSON.stringify(hit.result), isError: hit.isError === true };
}

export function manifestSurface(manifest: Manifest, platform: Platform, fixtures: Fixtures = {}): Surface {
  const tools: SurfaceTool[] = manifest.actions
    .filter((a) => isEnabledFor(a, platform))
    .map((a) => ({
      name: platformToolName(a, platform),
      action: a.name,
      description: a.description,
      inputSchema: mcpInputSchema(a),
      readOnly: a.safety === "read",
    }));
  const instructions =
    platform === "android"
      ? androidInstructions(manifest)
      : platform === "mcp"
        ? serverInstructions(manifest)
        : [manifest.app.description, manifest.app.instructions, ...skillsFor(manifest, "ios").map((s) => `${s.description}\n${s.instructions}`)]
            .filter(Boolean)
            .join("\n\n");
  return {
    label: `manifest projection (${platform})`,
    platform,
    instructions,
    tools,
    notes: [],
    callRead: async (tool, args) => fixtureAnswer(fixtures, tool.action ?? tool.name, args),
    close: async () => {},
  };
}

// ---------------------------------------------------------------- live MCP server

export interface McpServerOptions {
  url: string;
  /** Sent as "Authorization: Bearer <token>". */
  token?: string;
  manifest: Manifest;
}

interface ListedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

export async function mcpServerSurface(opts: McpServerOptions): Promise<Surface> {
  // Loaded on demand so manifest-only runs need no MCP client.
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const client = new Client({ name: "omnintent-tester", version: "0.1.0" }, { capabilities: {} });
  const headers: Record<string, string> = opts.token ? { Authorization: `Bearer ${opts.token}` } : {};
  await client.connect(new StreamableHTTPClientTransport(new URL(opts.url), { requestInit: { headers } }));

  const listed: ListedTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    listed.push(...(page.tools as ListedTool[]));
    cursor = page.nextCursor;
  } while (cursor);

  const actions = new Map(opts.manifest.actions.map((a) => [a.name, a]));
  const notes: string[] = [];
  const tools: SurfaceTool[] = listed.map((t) => {
    const action = actions.get(t.name);
    if (!action) notes.push(`the server publishes "${t.name}", which is not in the manifest`);
    else if ((t.description ?? "") !== action.description) notes.push(`the server's description of "${t.name}" differs from the manifest; redeploy after editing`);
    return {
      name: t.name,
      action: action?.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
      // Both must agree before the tester calls anything: the manifest says
      // read, and the server's annotation says read-only.
      readOnly: action?.safety === "read" && t.annotations?.readOnlyHint === true,
    };
  });
  for (const a of opts.manifest.actions) {
    if (isEnabledFor(a, "mcp") && !listed.some((t) => t.name === a.name)) notes.push(`the manifest's "${a.name}" is missing from the server`);
  }

  return {
    label: `MCP server ${opts.url}`,
    platform: "mcp",
    instructions: client.getInstructions() ?? "",
    tools,
    notes,
    async callRead(tool, args) {
      if (!tool.readOnly) throw new Error(`refusing to call ${tool.name}: it is not read-only`);
      try {
        const result = await client.callTool({ name: tool.name, arguments: args });
        const content = result.structuredContent !== undefined ? JSON.stringify(result.structuredContent) : JSON.stringify(result.content);
        return { content, isError: result.isError === true };
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
    close: () => client.close(),
  };
}

/**
 * A manifest's tool descriptions, with lookups answered by a live server. This
 * tests edited descriptions against real data before redeploying
 * (`agent-test --server <url> --local-descriptions`). Closing it leaves the
 * live connection open.
 */
export function overlaySurface(manifest: Manifest, live: Surface): Surface {
  const base = manifestSurface(manifest, "mcp");
  const liveByName = new Map(live.tools.map((t) => [t.name, t]));
  return {
    ...base,
    label: `${live.label} (descriptions from the candidate manifest)`,
    tools: base.tools.map((t) => ({ ...t, readOnly: t.readOnly && liveByName.get(t.name)?.readOnly === true })),
    callRead: async (tool, args) => {
      const target = liveByName.get(tool.name);
      if (!target) return { content: `${tool.name} is not on the server.`, isError: true };
      return live.callRead(target, args);
    },
    close: async () => {},
  };
}
