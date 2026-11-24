// MCP target: a Cloudflare Workers project that exposes each action as an MCP
// tool over Streamable HTTP and proxies calls to the developer's backend.

import type { Action, BackendAuth, BackendOAuth, Manifest } from "../manifest.js";
import { SAFETY, confirmationPrompt, isEnabledFor, mcpConfirmation, skillsFor } from "../safety.js";
import { mcpInputSchema, mcpOutputSchema, outputShape } from "../schema.js";
import { AUTH_TS, INDEX_OAUTH_TS, INDEX_TS, OAUTH_TS, SERVER_TS, TYPES_TS } from "./mcp-runtime.js";
import { HEADER, lines, type GeneratedFile } from "./types.js";

/** Versions the generated project pins; verified together in this repository's tests. */
export const MCP_DEPENDENCIES = {
  "@modelcontextprotocol/server": "2.4.0",
  agents: "0.34.0",
  zod: "^4.2.0",
};
/** Added when backend.auth.type is "oauth". */
export const MCP_OAUTH_DEPENDENCIES = {
  "@cloudflare/workers-oauth-provider": "1.3.0",
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
  const oauth = oauthConfig(manifest.backend.auth);
  return [
    { path: "package.json", content: packageJson(workerName, manifest, !!oauth) },
    { path: "wrangler.jsonc", content: wranglerConfig(workerName, manifest, oauth) },
    { path: "tsconfig.json", content: TSCONFIG },
    { path: ".gitignore", content: lines(["node_modules/", ".wrangler/", ".dev.vars"]) },
    { path: ".dev.vars.example", content: devVars(manifest, secret, oauth) },
    { path: "src/types.ts", content: TYPES_TS },
    { path: "src/tools.ts", content: toolsFile(manifest, actions) },
    { path: "src/server.ts", content: SERVER_TS },
    oauth ? { path: "src/oauth.ts", content: OAUTH_TS } : { path: "src/auth.ts", content: AUTH_TS },
    { path: "src/index.ts", content: oauth ? INDEX_OAUTH_TS : INDEX_TS },
    { path: "scripts/serve-node.mjs", content: serveNode(manifest, secret, oauth) },
    { path: "README.md", content: oauth ? readmeOAuth(manifest, actions, workerName, oauth) : readme(manifest, actions, workerName, secret) },
  ];
}

/** The OAuth settings with defaults filled in, or undefined for shared-token servers. */
export function oauthConfig(auth: BackendAuth | undefined): Required<BackendOAuth> | undefined {
  if (auth?.type !== "oauth") return undefined;
  return {
    type: "oauth",
    authorizationUrl: auth.authorizationUrl,
    tokenUrl: auth.tokenUrl,
    userInfoPath: auth.userInfoPath,
    userIdPointer: auth.userIdPointer ?? "/id",
    scopes: auth.scopes ?? [],
    tokenAuthMethod: auth.tokenAuthMethod ?? "client_secret_basic",
  };
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
      auth: oauthConfig(b.auth) ?? b.auth ?? { type: "none" },
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

function packageJson(workerName: string, manifest: Manifest, oauth: boolean): string {
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
    dependencies: oauth ? sortKeys({ ...MCP_DEPENDENCIES, ...MCP_OAUTH_DEPENDENCIES }) : MCP_DEPENDENCIES,
    devDependencies: MCP_DEV_DEPENDENCIES,
    engines: { node: ">=22.18" },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function wranglerConfig(workerName: string, manifest: Manifest, oauth: BackendOAuth | undefined): string {
  const config = {
    $schema: "node_modules/wrangler/config-schema.json",
    name: workerName,
    main: "src/index.ts",
    compatibility_date: COMPATIBILITY_DATE,
    // global_fetch_strictly_public: required for Client ID Metadata Documents (SSRF protection).
    compatibility_flags: oauth ? ["nodejs_compat", "global_fetch_strictly_public"] : ["nodejs_compat"],
    vars: oauth
      ? {
          BACKEND_BASE_URL: manifest.backend!.baseUrl,
          BACKEND_OAUTH_AUTHORIZATION_URL: oauth.authorizationUrl,
          BACKEND_OAUTH_TOKEN_URL: oauth.tokenUrl,
        }
      : { BACKEND_BASE_URL: manifest.backend!.baseUrl },
    ...(oauth ? { kv_namespaces: [{ binding: "OAUTH_KV", id: "<YOUR_KV_NAMESPACE_ID>" }] } : {}),
    observability: { enabled: true },
  };
  const notes = oauth
    ? [
        "Secrets (never put them here): BACKEND_OAUTH_CLIENT_ID, BACKEND_OAUTH_CLIENT_SECRET, and optionally",
        "CONSENT_SECRET. Set them with `wrangler secret put <NAME>`. Also set MCP_SERVER_URL to this Worker's",
        "public origin (a var), and create the KV namespace with `wrangler kv namespace create OAUTH_KV`.",
      ]
    : [
        `Secrets (never put them here): ${[
          manifest.backend!.auth?.type === "bearer" ? manifest.backend!.auth.secret : undefined,
          "MCP_ACCESS_TOKEN",
        ]
          .filter(Boolean)
          .join(", ")}. Set them with \`wrangler secret put <NAME>\`.`,
      ];
  return `// ${HEADER}\n${notes.map((n) => `// ${n}\n`).join("")}${JSON.stringify(config, null, 2)}\n`;
}

function sortKeys<T extends Record<string, string>>(record: T): T {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) as T;
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

function devVars(manifest: Manifest, secret: string | undefined, oauth: BackendOAuth | undefined): string {
  if (oauth) {
    return lines([
      "# Copy to .dev.vars for `wrangler dev`. Never commit .dev.vars.",
      "# This server's own origin: wrangler dev serves http://localhost:8787.",
      "MCP_SERVER_URL=http://localhost:8787",
      `BACKEND_BASE_URL=${manifest.backend!.baseUrl}`,
      `BACKEND_OAUTH_AUTHORIZATION_URL=${oauth.authorizationUrl}`,
      `BACKEND_OAUTH_TOKEN_URL=${oauth.tokenUrl}`,
      "# The OAuth client this server is registered as at your backend. Its redirect URI is",
      "# <MCP_SERVER_URL>/oauth/callback.",
      "BACKEND_OAUTH_CLIENT_ID=<YOUR_CLIENT_ID>",
      oauth.tokenAuthMethod === "none" ? false : "BACKEND_OAUTH_CLIENT_SECRET=<YOUR_CLIENT_SECRET>",
      "# Optional: 32+ random characters to remember each user's consent for 30 days.",
      "# CONSENT_SECRET=<A_LONG_RANDOM_STRING>",
    ]);
  }
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

function serveNode(manifest: Manifest, secret: string | undefined, oauth: BackendOAuth | undefined): string {
  if (oauth) return serveNodeOAuth();
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
    ...NODE_HTTP_SERVER,
  ]);
}

const NODE_HTTP_SERVER = [
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
];

function serveNodeOAuth(): string {
  const keys = [
    "MCP_SERVER_URL",
    "BACKEND_BASE_URL",
    "BACKEND_OAUTH_AUTHORIZATION_URL",
    "BACKEND_OAUTH_TOKEN_URL",
    "BACKEND_OAUTH_CLIENT_ID",
    "BACKEND_OAUTH_CLIENT_SECRET",
    "CONSENT_SECRET",
  ];
  return lines([
    `// ${HEADER}`,
    "//",
    "// Runs the same Worker handler on Node.js 22.18+ (which strips TypeScript types),",
    "// for local testing without wrangler. KV lives in memory, so sign-ins are lost",
    "// when the process stops. Usage:",
    "// PORT=8787 MCP_SERVER_URL=http://localhost:8787 node scripts/serve-node.mjs",
    "",
    'import http from "node:http";',
    'import { registerHooks } from "node:module";',
    "",
    '// The OAuth library imports WorkerEntrypoint from "cloudflare:workers", which only',
    "// exists on Workers. This stand-in is enough for local runs.",
    "registerHooks({",
    "  resolve(specifier, context, nextResolve) {",
    '    if (specifier !== "cloudflare:workers") return nextResolve(specifier, context);',
    "    const source = \"export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }\";",
    "    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };",
    "  },",
    "});",
    'const { default: worker } = await import("../src/index.ts");',
    "",
    "/** Enough of the Workers KV API for the OAuth library, kept in memory. */",
    "class MemoryKV {",
    "  #data = new Map();",
    "  #live(key) {",
    "    const entry = this.#data.get(key);",
    "    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {",
    "      this.#data.delete(key);",
    "      return undefined;",
    "    }",
    "    return entry;",
    "  }",
    "  async get(key, options) {",
    "    const entry = this.#live(key);",
    "    if (!entry) return null;",
    '    const type = typeof options === "string" ? options : options?.type;',
    '    return type === "json" ? JSON.parse(entry.value) : entry.value;',
    "  }",
    "  async getWithMetadata(key, options) {",
    "    const value = await this.get(key, options);",
    "    return { value, metadata: value === null ? null : (this.#live(key)?.metadata ?? null) };",
    "  }",
    "  async put(key, value, options = {}) {",
    "    const expiresAt = options.expirationTtl",
    "      ? Date.now() + options.expirationTtl * 1000",
    "      : options.expiration",
    "        ? options.expiration * 1000",
    "        : undefined;",
    "    this.#data.set(key, { value: String(value), metadata: options.metadata ?? null, expiresAt });",
    "  }",
    "  async delete(key) {",
    "    this.#data.delete(key);",
    "  }",
    '  async list({ prefix = "", limit = 1000, cursor } = {}) {',
    "    const names = [...this.#data.keys()].filter((k) => k.startsWith(prefix) && this.#live(k)).sort();",
    "    const start = cursor ? Number(cursor) : 0;",
    "    const done = start + limit >= names.length;",
    "    const keys = names.slice(start, start + limit).map((name) => {",
    "      const { metadata, expiresAt } = this.#data.get(name);",
    "      return {",
    "        name,",
    "        ...(metadata ? { metadata } : {}),",
    "        ...(expiresAt !== undefined ? { expiration: Math.floor(expiresAt / 1000) } : {}),",
    "      };",
    "    });",
    "    return { keys, list_complete: done, ...(done ? {} : { cursor: String(start + limit) }) };",
    "  }",
    "}",
    "",
    `const KEYS = ${JSON.stringify(keys)};`,
    "const env = Object.fromEntries(KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));",
    "env.OAUTH_KV = new MemoryKV();",
    "const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };",
    'const port = Number(process.env.PORT ?? 8787);',
    'const host = process.env.HOST ?? "127.0.0.1";',
    "",
    ...NODE_HTTP_SERVER,
  ]);
}

function toolsSection(manifest: Manifest, actions: Action[], oauth: boolean): (string | false)[] {
  const rows = actions.map((a) => {
    const ann = SAFETY[a.safety].mcpAnnotations(a);
    const hints = Object.entries(ann)
      .filter(([, v]) => v)
      .map(([k]) => k.replace("Hint", ""))
      .join(", ");
    const conf = mcpConfirmation(a);
    const scope = oauth ? ` ${a.safety === "read" ? "`mcp:read`" : "`mcp:write`"} |` : "";
    return `| \`${a.name}\` | ${a.safety} | ${hints || "none"} | ${conf === "none" ? "no" : conf} |${scope} \`${a.backend!.method} ${a.backend!.path}\` |`;
  });
  const skipped = manifest.actions.filter((a) => !isEnabledFor(a, "mcp"));
  return [
    "## Tools",
    "",
    oauth ? "| Tool | Safety | Annotations | Confirmation | Scope | Backend |" : "| Tool | Safety | Annotations | Confirmation | Backend |",
    oauth ? "| --- | --- | --- | --- | --- | --- |" : "| --- | --- | --- | --- | --- |",
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
  ];
}

function readme(manifest: Manifest, actions: Action[], workerName: string, secret: string | undefined): string {
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
    ...toolsSection(manifest, actions, false),
    "",
    "## Authentication: what this is and is not",
    "",
    "`MCP_ACCESS_TOKEN` is a pre-shared API key. It suits clients that let a user paste an API key or header",
    "(for example Meta Muse custom connectors). It is not MCP OAuth, and every caller acts as the single backend",
    `account behind ${secret ? `\`${secret}\`` : "the backend"}. For per-user sign-in with OAuth 2.1, which hosts that only`,
    "support OAuth need, set `backend.auth` to `{\"type\": \"oauth\", ...}` in `omnintent.json` and generate",
    "again (see section E.5 of Omnintent's SPEC.md). That needs a backend with its own OAuth server.",
    "",
    "## Connect a client",
    "",
    `After \`wrangler deploy\`, the endpoint is \`https://${workerName}.<YOUR_SUBDOMAIN>.workers.dev/mcp\`.`,
    "Hosts that accept a custom MCP server URL with a header (Claude, ChatGPT developer mode, Gemini Spark,",
    "Meta Muse) can use it; hosts that only support OAuth need the OAuth setup above.",
  ]);
}

function readmeOAuth(manifest: Manifest, actions: Action[], workerName: string, oauth: Required<BackendOAuth>): string {
  const origin = `https://${workerName}.<YOUR_SUBDOMAIN>.workers.dev`;
  return lines([
    `# ${manifest.app.name}: MCP server (generated)`,
    "",
    HEADER,
    "",
    "A remote MCP server for Cloudflare Workers. It exposes each action in `omnintent.json` as an MCP tool",
    "over Streamable HTTP at `/mcp` and forwards every call to your existing backend. It speaks MCP",
    "revision 2026-07-28 (stateless) and still serves 2025-era clients through the SDK's stateless fallback.",
    "",
    "Each person signs in with their own account. Tool calls reach your backend with that person's own",
    "token, never a shared one.",
    "",
    "## How sign-in works",
    "",
    "1. An MCP client (Claude, ChatGPT, ...) calls `/mcp` without a token. The server answers `401` and points",
    "   it at `/.well-known/oauth-protected-resource/mcp` (RFC 9728), which names this server as the",
    "   authorization server.",
    "2. The client registers, with a Client ID Metadata Document or Dynamic Client Registration, and opens",
    "   `/authorize` in the browser.",
    "3. A consent page shows which app is asking, where access will be sent, and what it may do: **See your",
    "   data** (`mcp:read`, always) and **Make changes for you** (`mcp:write`, can be unticked).",
    "4. After **Allow**, the person signs in to your backend's own OAuth server (authorization code + PKCE).",
    `   The server looks them up at \`${oauth.userInfoPath}\` and stores their backend token, encrypted, in KV.`,
    "5. The client receives its own access token, valid only for this server's `/mcp` (RFC 8707 audience).",
    "   That token is never sent to your backend, and the backend token is never sent to the client.",
    "",
    "When the backend token is close to expiring, the server refreshes it as the client refreshes its own",
    "token. If the backend refuses the refresh, the grant is revoked and the person signs in again.",
    "",
    "## Set up your backend",
    "",
    "Register this server as an OAuth client at your backend, with the redirect URI",
    "`<MCP_SERVER_URL>/oauth/callback`. Your backend needs:",
    "",
    `- an authorization endpoint (\`BACKEND_OAUTH_AUTHORIZATION_URL\`, now \`${oauth.authorizationUrl}\`) that accepts PKCE (S256);`,
    `- a token endpoint (\`BACKEND_OAUTH_TOKEN_URL\`, now \`${oauth.tokenUrl}\`) for the \`authorization_code\` and, ideally,`,
    `  \`refresh_token\` grants, with \`${oauth.tokenAuthMethod}\` client authentication;`,
    `- \`GET ${oauth.userInfoPath}\`, which returns the signed-in user with a stable ID at \`${oauth.userIdPointer}\`${oauth.scopes.length ? ";" : "."}`,
    oauth.scopes.length ? `- the scopes ${oauth.scopes.map((x) => `\`${x}\``).join(", ")}.` : false,
    "",
    "## Run locally",
    "",
    "```sh",
    "npm install",
    "cp .dev.vars.example .dev.vars   # then fill in the values",
    "npm run dev                      # wrangler dev, serves http://localhost:8787/mcp",
    "```",
    "",
    "Without wrangler, the same handler runs on Node.js 22.18+, with KV in memory:",
    "",
    "```sh",
    "PORT=8787 MCP_SERVER_URL=http://127.0.0.1:8787 BACKEND_OAUTH_CLIENT_ID=<ID> BACKEND_OAUTH_CLIENT_SECRET=<SECRET> npm run start:node",
    "```",
    "",
    "Give MCP clients the same address as `MCP_SERVER_URL` (here `http://127.0.0.1:8787/mcp`): tokens are",
    "only valid for that exact URL.",
    "",
    "## Configuration",
    "",
    "| Name | Kind | Purpose |",
    "| --- | --- | --- |",
    "| `MCP_SERVER_URL` | var | This server's public origin, with no path, for example the `workers.dev` URL or your own domain. Sign-in refuses to start without it. |",
    "| `BACKEND_BASE_URL` | var | Base URL of your backend. Defaults to the manifest's `backend.baseUrl`. |",
    "| `BACKEND_OAUTH_AUTHORIZATION_URL` | var | Your backend's OAuth authorization endpoint. |",
    "| `BACKEND_OAUTH_TOKEN_URL` | var | Your backend's OAuth token endpoint. |",
    "| `BACKEND_OAUTH_CLIENT_ID` | secret | The client ID your backend gave this server. |",
    oauth.tokenAuthMethod === "none" ? false : "| `BACKEND_OAUTH_CLIENT_SECRET` | secret | The matching client secret. |",
    "| `CONSENT_SECRET` | secret | Optional, 32+ characters. Remembers each browser's consent for 30 days. |",
    "| `OAUTH_KV` | KV binding | Grants, tokens (stored as hashes) and encrypted backend tokens. |",
    "",
    "## Deploy",
    "",
    "```sh",
    "npx wrangler kv namespace create OAUTH_KV   # put the printed id in wrangler.jsonc",
    "npx wrangler secret put BACKEND_OAUTH_CLIENT_ID",
    oauth.tokenAuthMethod === "none" ? false : "npx wrangler secret put BACKEND_OAUTH_CLIENT_SECRET",
    "npm run deploy",
    "```",
    "",
    `Then set \`MCP_SERVER_URL\` to the deployed origin (for example \`${origin}\`) as a variable in`,
    "`wrangler.jsonc` or the Cloudflare dashboard, deploy again, and add `<MCP_SERVER_URL>/oauth/callback` as a",
    "redirect URI at your backend.",
    "",
    ...toolsSection(manifest, actions, true),
    "- A token without `mcp:write` can list and call read tools only. Other tools answer `403`",
    "  `insufficient_scope`, so the client can ask the person for more access.",
    "",
    "## Connect a client",
    "",
    "Add `<MCP_SERVER_URL>/mcp` as a custom MCP server or connector in the host. The host opens the sign-in",
    "page itself; there is no key to paste.",
  ]);
}
