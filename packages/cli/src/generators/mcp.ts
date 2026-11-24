// MCP target: a Cloudflare Workers project that exposes each action as an MCP
// tool over Streamable HTTP and proxies calls to the developer's backend.

import type { Action, Manifest } from "../manifest.js";
import { SAFETY, confirmationPrompt, isEnabledFor, mcpConfirmation, skillsFor } from "../safety.js";
import { mcpInputSchema, mcpOutputSchema, outputShape } from "../schema.js";
import { AUTH_TS, INDEX_TS, SERVER_TS, TYPES_TS } from "./mcp-runtime.js";
import { HEADER, lines, type GeneratedFile } from "./types.js";

/** Versions the generated project pins; verified together in this repository's tests. */
export const MCP_DEPENDENCIES = {
  "@modelcontextprotocol/server": "2.4.0",
  agents: "0.34.0",
  zod: "^4.2.0",
};
export const MCP_DEV_DEPENDENCIES = {
  "@cloudflare/workers-types": "^5.20261124.1",
  typescript: "^5.9.3",
  wrangler: "^4.167.0",
};
export const COMPATIBILITY_DATE = "2026-11-01";

export function generateMcp(manifest: Manifest): GeneratedFile[] {
  if (!manifest.backend) {
    throw new Error("The MCP target needs a backend section in omnintent.json (see SPEC.md, section E).");
  }
  const actions = manifest.actions.filter((a) => isEnabledFor(a, "mcp"));
  const missing = actions.filter((a) => !a.backend).map((a) => a.name);
  if (missing.length) {
    throw new Error(`These MCP-enabled actions have no backend mapping: ${missing.join(", ")}.`);
  }
  const workerName = `${manifest.app.slug}-mcp`;
  const secret = manifest.backend.auth?.type === "bearer" ? manifest.backend.auth.secret : undefined;
  return [
    { path: "package.json", content: packageJson(workerName, manifest) },
    { path: "wrangler.jsonc", content: wranglerConfig(workerName, manifest) },
    { path: "tsconfig.json", content: TSCONFIG },
    { path: ".gitignore", content: lines(["node_modules/", ".wrangler/", ".dev.vars"]) },
    { path: ".dev.vars.example", content: devVars(manifest, secret) },
    { path: "src/types.ts", content: TYPES_TS },
    { path: "src/tools.ts", content: toolsFile(manifest, actions) },
    { path: "src/server.ts", content: SERVER_TS },
    { path: "src/auth.ts", content: AUTH_TS },
    { path: "src/index.ts", content: INDEX_TS },
    { path: "scripts/serve-node.mjs", content: serveNode(manifest, secret) },
    { path: "README.md", content: readme(manifest, actions, workerName, secret) },
  ];
}

export function serverInstructions(manifest: Manifest): string {
  const parts = [manifest.app.description.trim()];
  if (manifest.app.instructions) parts.push(manifest.app.instructions.trim());
  for (const skill of skillsFor(manifest, "mcp")) {
    parts.push(`Workflow "${skill.name}": ${skill.description.trim()}\n${skill.instructions.trim()}`);
  }
  return parts.join("\n\n");
}

function backendParams(action: Action) {
  const b = action.backend!;
  const params = Object.keys(action.inputSchema.properties ?? {});
  const pathParams = [...b.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  const rest = params.filter((p) => !pathParams.includes(p));
  const hasBody = b.method === "POST" || b.method === "PUT" || b.method === "PATCH";
  const query = b.query ?? (hasBody ? [] : rest);
  const body = b.body ?? (hasBody ? rest.filter((p) => !query.includes(p)) : []);
  return { method: b.method, path: b.path, pathParams, query, body, ...(b.resultPointer ? { resultPointer: b.resultPointer } : {}) };
}

export function toolDefinition(manifest: Manifest, action: Action) {
  const shape = outputShape(action);
  const outputSchema = mcpOutputSchema(manifest, action);
  const confirmation = mcpConfirmation(action);
  return {
    name: action.name,
    title: action.title,
    description: action.description,
    safety: action.safety,
    inputSchema: mcpInputSchema(action),
    ...(outputSchema ? { outputSchema } : {}),
    outputKind: shape.kind === "entityList" ? "list" : shape.kind,
    annotations: SAFETY[action.safety].mcpAnnotations(action),
    ...(confirmation !== "none" ? { confirmation: { mode: confirmation, prompt: confirmationPrompt(action) } } : {}),
    backend: backendParams(action),
  };
}

function toolsFile(manifest: Manifest, actions: Action[]): string {
  const b = manifest.backend!;
  const app = {
    name: manifest.app.name,
    version: manifest.app.version ?? "0.1.0",
    instructions: serverInstructions(manifest),
    backend: {
      baseUrl: b.baseUrl,
      auth: b.auth ?? { type: "none" },
      timeoutMs: b.timeoutMs ?? 10000,
    },
  };
  return lines([
    `// ${HEADER}`,
    "",
    'import type { AppDefinition, ToolDefinition } from "./types.ts";',
    "",
    `export const APP: AppDefinition = ${JSON.stringify(app, null, 2)};`,
    "",
    `export const TOOLS: ToolDefinition[] = ${JSON.stringify(actions.map((a) => toolDefinition(manifest, a)), null, 2)};`,
  ]);
}

function packageJson(workerName: string, manifest: Manifest): string {
  const pkg = {
    name: workerName,
    private: true,
    version: manifest.app.version ?? "0.1.0",
    description: `MCP server for ${manifest.app.name}, generated by Omnintent.`,
    type: "module",
    scripts: {
      dev: "wrangler dev",
      deploy: "wrangler deploy",
      "start:node": "node scripts/serve-node.mjs",
      typecheck: "tsc --noEmit",
    },
    dependencies: MCP_DEPENDENCIES,
    devDependencies: MCP_DEV_DEPENDENCIES,
    engines: { node: ">=22.18" },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function wranglerConfig(workerName: string, manifest: Manifest): string {
  const config = {
    $schema: "node_modules/wrangler/config-schema.json",
    name: workerName,
    main: "src/index.ts",
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: ["nodejs_compat"],
    vars: { BACKEND_BASE_URL: manifest.backend!.baseUrl },
    observability: { enabled: true },
  };
  return `// ${HEADER}\n// Secrets (never put them here): ${[
    manifest.backend!.auth?.type === "bearer" ? manifest.backend!.auth.secret : undefined,
    "MCP_ACCESS_TOKEN",
  ]
    .filter(Boolean)
    .join(", ")}. Set them with \`wrangler secret put <NAME>\`.\n${JSON.stringify(config, null, 2)}\n`;
}

const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ES2023",
      module: "ESNext",
      moduleResolution: "Bundler",
      lib: ["ES2023"],
      types: ["@cloudflare/workers-types"],
      strict: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: true,
      erasableSyntaxOnly: true,
      isolatedModules: true,
      skipLibCheck: true,
    },
    include: ["src/**/*.ts"],
  },
  null,
  2,
)}\n`;

function devVars(manifest: Manifest, secret: string | undefined): string {
  return lines([
    "# Copy to .dev.vars for `wrangler dev`. Never commit .dev.vars.",
    `BACKEND_BASE_URL=${manifest.backend!.baseUrl}`,
    secret ? `${secret}=<YOUR_BACKEND_TOKEN>` : false,
    "# Either require a token from MCP clients...",
    "MCP_ACCESS_TOKEN=<A_LONG_RANDOM_STRING>",
    "# ...or, for local development only, allow unauthenticated requests:",
    "# ALLOW_UNAUTHENTICATED=true",
  ]);
}

function serveNode(manifest: Manifest, secret: string | undefined): string {
  const keys = ["BACKEND_BASE_URL", ...(secret ? [secret] : []), "MCP_ACCESS_TOKEN", "ALLOW_UNAUTHENTICATED"];
  return lines([
    `// ${HEADER}`,
    "//",
    "// Runs the same Worker handler on Node.js 22.18+ (which strips TypeScript types),",
    "// for local testing without wrangler. Usage: PORT=8787 node scripts/serve-node.mjs",
    "",
    'import http from "node:http";',
    'import worker from "../src/index.ts";',
    "",
    `const KEYS = ${JSON.stringify(keys)};`,
    "const env = Object.fromEntries(KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));",
    "const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };",
    'const port = Number(process.env.PORT ?? 8787);',
    'const host = process.env.HOST ?? "127.0.0.1";',
    "",
    "const server = http.createServer(async (req, res) => {",
    "  try {",
    "    const chunks = [];",
    "    for await (const chunk of req) chunks.push(chunk);",
    "    const body = chunks.length ? Buffer.concat(chunks) : undefined;",
    "    const headers = new Headers();",
    "    for (const [name, value] of Object.entries(req.headers)) {",
    "      if (Array.isArray(value)) for (const v of value) headers.append(name, v);",
    "      else if (value !== undefined) headers.set(name, value);",
    "    }",
    "    const request = new Request(`http://${req.headers.host ?? `${host}:${port}`}${req.url}`, {",
    "      method: req.method,",
    "      headers,",
    '      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,',
    "    });",
    "    const response = await worker.fetch(request, env, ctx);",
    "    res.writeHead(response.status, Object.fromEntries(response.headers));",
    "    if (response.body) for await (const chunk of response.body) res.write(chunk);",
    "    res.end();",
    "  } catch (err) {",
    "    res.writeHead(500, { \"content-type\": \"text/plain\" });",
    "    res.end(String(err?.stack ?? err));",
    "  }",
    "});",
    "",
    "server.listen(port, host, () => {",
    "  const address = server.address();",
    "  console.log(`MCP server listening on http://${host}:${address.port}/mcp`);",
    "});",
  ]);
}

function readme(manifest: Manifest, actions: Action[], workerName: string, secret: string | undefined): string {
  const rows = actions.map((a) => {
    const ann = SAFETY[a.safety].mcpAnnotations(a);
    const hints = Object.entries(ann)
      .filter(([, v]) => v)
      .map(([k]) => k.replace("Hint", ""))
      .join(", ");
    const conf = mcpConfirmation(a);
    return `| \`${a.name}\` | ${a.safety} | ${hints || "none"} | ${conf === "none" ? "no" : conf} | \`${a.backend!.method} ${a.backend!.path}\` |`;
  });
  const skipped = manifest.actions.filter((a) => !isEnabledFor(a, "mcp"));
  return lines([
    `# ${manifest.app.name}: MCP server (generated)`,
    "",
    HEADER,
    "",
    "A remote MCP server for Cloudflare Workers. It exposes each action in `omnintent.json` as an MCP tool",
    "over Streamable HTTP at `/mcp` and forwards every call to your existing backend. It speaks MCP",
    "revision 2026-07-28 (stateless) and still serves 2025-era clients through the SDK's stateless fallback.",
    "",
    "## Run locally",
    "",
    "```sh",
    "npm install",
    "cp .dev.vars.example .dev.vars   # then fill in the values",
    "npm run dev                      # wrangler dev, serves http://localhost:8787/mcp",
    "```",
    "",
    "Without wrangler, the same handler runs on Node.js 22.18+:",
    "",
    "```sh",
    `BACKEND_BASE_URL=${manifest.backend!.baseUrl}${secret ? ` ${secret}=<TOKEN>` : ""} ALLOW_UNAUTHENTICATED=true npm run start:node`,
    "```",
    "",
    "## Configuration",
    "",
    "| Name | Kind | Purpose |",
    "| --- | --- | --- |",
    "| `BACKEND_BASE_URL` | var | Base URL of your backend. Defaults to the manifest's `backend.baseUrl`. |",
    secret ? `| \`${secret}\` | secret | Sent to your backend as \`Authorization: Bearer ...\`. |` : false,
    "| `MCP_ACCESS_TOKEN` | secret | Clients must send `Authorization: Bearer <token>` to `/mcp`. |",
    "| `ALLOW_UNAUTHENTICATED` | var | Set to `true` to skip the check above. Local development only. |",
    "",
    "Deploy with `npm run deploy` after `wrangler secret put` for each secret.",
    "",
    "## Tools",
    "",
    "| Tool | Safety | Annotations | Confirmation | Backend |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    skipped.length ? "" : false,
    skipped.length ? `Not exposed over MCP: ${skipped.map((a) => `\`${a.name}\``).join(", ")}.` : false,
    "",
    "- Input arguments are validated against each tool's JSON Schema before your backend is called.",
    "- Results are cut down to the fields in the tool's output schema, so internal and sensitive fields never",
    "  reach an agent. List results are returned as `{\"items\": [...]}`.",
    "- Confirmation: on MCP 2026-07-28 the server asks the user through elicitation (an `input_required`",
    "  result) when the client supports it. Otherwise destructive tools rely on the host's own confirmation,",
    "  which `destructiveHint` requests, and payment tools refuse to run.",
    "",
    "## Authentication: what this is and is not",
    "",
    "`MCP_ACCESS_TOKEN` is a pre-shared API key. It suits clients that let a user paste an API key or header",
    "(for example Meta Muse custom connectors). It is not MCP OAuth, and every caller acts as the single backend",
    `account behind ${secret ? `\`${secret}\`` : "the backend"}. For per-user access, the next step is OAuth 2.1 with PKCE as the MCP`,
    "authorization spec requires: protect `/mcp` with `OAuthResourceServer` and run an `OAuthAuthorizationServer`",
    "from `@cloudflare/workers-oauth-provider`, publish Protected Resource Metadata (RFC 9728), call",
    "`completeAuthorization()` after your own consent screen, read the user's identity with",
    "`getMcpAuthContext()` inside tools, and exchange it for a per-user backend token. Omnintent v0.1 does not",
    "generate this yet.",
    "",
    "## Connect a client",
    "",
    `After \`wrangler deploy\`, the endpoint is \`https://${workerName}.<YOUR_SUBDOMAIN>.workers.dev/mcp\`.`,
    "Hosts that accept a custom MCP server URL (Claude, ChatGPT developer mode, Gemini Spark, Meta Muse)",
    "can use it; hosts that only support OAuth need the upgrade above.",
  ]);
}

