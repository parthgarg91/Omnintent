// Watcher agent (agent 5 in docs/ARCHITECTURE.md): the list of platform sources it tracks.
//
// Two kinds of baseline:
// - "research": the expected value is read out of docs/RESEARCH.md with `researchPattern`
//   (one capture group). The watcher reports when the live value differs from what
//   RESEARCH.md says, so RESEARCH.md stays the single place where facts are recorded.
// - "snapshot": pages whose wording matters. The baseline is a stored snapshot
//   (docs/watch-state.json) of per-section hashes. Apple, Android, Cloudflare and the MCP
//   repository all serve these pages as Markdown. A change means
//   "a maintainer should read this page again", not that something broke.

export type Extractor =
  /** `dist-tags.latest` from the npm registry's JSON for a package. */
  | { type: "npm-latest"; packageName: string }
  /** Newest stable "Version x.y.z" heading on a Jetpack release-notes page. */
  | { type: "jetpack-release" }
  /** The `(latest)` revision named in the MCP docs site config (docs/docs.json). */
  | { type: "mcp-latest-revision" }
  /** Per-heading content hashes of a Markdown page. */
  | { type: "markdown-sections" };

export interface WatchSource {
  id: string;
  title: string;
  /** URL that is fetched. */
  url: string;
  /** URL a person should read (defaults to `url`). */
  readUrl?: string;
  extractor: Extractor;
  baseline:
    | { kind: "research"; researchPattern: RegExp }
    | { kind: "snapshot" };
  /** Heading in docs/RESEARCH.md that records this source. */
  researchSection: string;
  /** Files a maintainer should re-check when this source changes. */
  affects: string[];
}

const NPM = "https://registry.npmjs.org";
const npm = (
  id: string,
  packageName: string,
  researchPattern: RegExp,
  researchSection: string,
  affects: string[],
): WatchSource => ({
  id,
  title: `npm: ${packageName}`,
  url: `${NPM}/${packageName.replace("/", "%2F")}`,
  readUrl: `https://www.npmjs.com/package/${packageName}`,
  extractor: { type: "npm-latest", packageName },
  baseline: { kind: "research", researchPattern },
  researchSection,
  affects,
});

const MCP_RUNTIME = ["packages/cli/src/generators/mcp.ts", "packages/cli/src/generators/mcp-runtime.ts"];

export const WATCH_SOURCES: WatchSource[] = [
  // --- Apple: Siri AI Developer Preview -----------------------------------------------------
  {
    id: "apple-siri-ai-preview",
    title: "Apple: Siri AI Developer Preview",
    url: "https://developer.apple.com/documentation/appintents/siri-ai-developer-preview.md",
    extractor: { type: "markdown-sections" },
    baseline: { kind: "snapshot" },
    researchSection: "Apple: Siri AI Developer Preview and App Intents",
    affects: ["SPEC.md", "packages/cli/src/generators/swift.ts", "packages/cli/src/agents/submit/submit.ts"],
  },
  {
    id: "apple-custom-actions",
    title: "Apple: Bringing custom actions and content to Siri",
    url: "https://developer.apple.com/documentation/AppIntents/bringing-custom-actions-and-content-to-siri.md",
    extractor: { type: "markdown-sections" },
    baseline: { kind: "snapshot" },
    researchSection: "Apple: Siri AI Developer Preview and App Intents",
    affects: ["SPEC.md", "packages/cli/src/generators/swift.ts"],
  },
  {
    id: "apple-app-skills",
    title: "Apple: Orchestrating complex actions with app skills",
    url: "https://developer.apple.com/documentation/AppIntents/orchestrating-complex-actions-with-app-skills.md",
    extractor: { type: "markdown-sections" },
    baseline: { kind: "snapshot" },
    researchSection: "Apple: Siri AI Developer Preview and App Intents",
    affects: ["packages/cli/src/generators/swift.ts", "packages/cli/src/validate.ts"],
  },

  // --- Android: AppFunctions -----------------------------------------------------------------
  {
    id: "android-appfunctions-release",
    title: "Jetpack AppFunctions release notes",
    url: "https://developer.android.com/jetpack/androidx/releases/appfunctions",
    extractor: { type: "jetpack-release" },
    baseline: { kind: "research", researchPattern: /\*\*(\d+\.\d+\.\d+) stable: / },
    researchSection: "Android: AppFunctions",
    affects: ["packages/cli/src/generators/kotlin.ts", "packages/cli/test/fixtures/kotlin-stubs/", "docs/LIMITATIONS.md"],
  },
  {
    id: "android-appfunctions-overview",
    title: "Android: AppFunctions overview",
    url: "https://developer.android.com/ai/appfunctions",
    extractor: { type: "markdown-sections" },
    baseline: { kind: "snapshot" },
    researchSection: "Android: AppFunctions",
    affects: ["SPEC.md", "packages/cli/src/agents/submit/submit.ts"],
  },
  {
    id: "android-add-appfunctions",
    title: "Android: Add AppFunctions to your app",
    url: "https://developer.android.com/ai/appfunctions/add-appfunctions",
    extractor: { type: "markdown-sections" },
    baseline: { kind: "snapshot" },
    researchSection: "Android: AppFunctions",
    affects: ["packages/cli/src/generators/kotlin.ts"],
  },
  {
    id: "android-quality-guidelines",
    title: "Android: AppFunctions quality guidelines",
    url: "https://developer.android.com/ai/appfunctions/quality-guidelines",
    extractor: { type: "markdown-sections" },
    baseline: { kind: "snapshot" },
    researchSection: "Android: AppFunctions",
    affects: ["SPEC.md", "packages/cli/src/validate.ts"],
  },

  // --- Model Context Protocol ----------------------------------------------------------------
  {
    id: "mcp-spec-revision",
    title: "MCP specification: latest revision",
    url: "https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/docs.json",
    readUrl: "https://modelcontextprotocol.io/specification/latest",
    extractor: { type: "mcp-latest-revision" },
    baseline: { kind: "research", researchPattern: /The latest revision is \*\*(\d{4}-\d{2}-\d{2})\*\*/ },
    researchSection: "Model Context Protocol",
    affects: ["SPEC.md", ...MCP_RUNTIME, "packages/cli/test/e2e-mcp.test.ts"],
  },
  {
    id: "mcp-spec-tools",
    title: "MCP specification 2026-07-28: Tools",
    url: "https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/server/tools.mdx",
    readUrl: "https://modelcontextprotocol.io/specification/2026-07-28/server/tools",
    extractor: { type: "markdown-sections" },
    baseline: { kind: "snapshot" },
    researchSection: "Model Context Protocol",
    affects: MCP_RUNTIME,
  },
  {
    id: "mcp-spec-authorization",
    title: "MCP specification 2026-07-28: Authorization",
    url: "https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/authorization/index.mdx",
    readUrl: "https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization",
    extractor: { type: "markdown-sections" },
    baseline: { kind: "snapshot" },
    researchSection: "Model Context Protocol",
    affects: ["docs/LIMITATIONS.md", ...MCP_RUNTIME],
  },
  {
    id: "mcp-spec-streamable-http",
    title: "MCP specification 2026-07-28: Streamable HTTP",
    url: "https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx",
    readUrl: "https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http",
    extractor: { type: "markdown-sections" },
    baseline: { kind: "snapshot" },
    researchSection: "Model Context Protocol",
    affects: MCP_RUNTIME,
  },
  npm(
    "npm-mcp-server",
    "@modelcontextprotocol/server",
    /`@modelcontextprotocol\/server` and `@modelcontextprotocol\/client` (\d+\.\d+\.\d+)/,
    "Model Context Protocol",
    MCP_RUNTIME,
  ),
  npm(
    "npm-mcp-client",
    "@modelcontextprotocol/client",
    /`@modelcontextprotocol\/server` and `@modelcontextprotocol\/client` (\d+\.\d+\.\d+)/,
    "Model Context Protocol",
    ["packages/cli/package.json", "packages/cli/test/e2e-mcp.test.ts"],
  ),
  npm(
    "npm-mcp-sdk-legacy",
    "@modelcontextprotocol/sdk",
    /legacy `@modelcontextprotocol\/sdk` is (\d+\.\d+\.\d+)/,
    "Model Context Protocol",
    ["docs/RESEARCH.md"],
  ),

  // --- Cloudflare ------------------------------------------------------------------------------
  {
    id: "cloudflare-mcp-handler",
    title: "Cloudflare: MCP handler API",
    url: "https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/index.md",
    extractor: { type: "markdown-sections" },
    baseline: { kind: "snapshot" },
    researchSection: "Cloudflare",
    affects: MCP_RUNTIME,
  },
  {
    id: "cloudflare-securing-mcp",
    title: "Cloudflare: Securing MCP servers",
    url: "https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/index.md",
    extractor: { type: "markdown-sections" },
    baseline: { kind: "snapshot" },
    researchSection: "Cloudflare",
    affects: ["docs/LIMITATIONS.md", ...MCP_RUNTIME],
  },
  npm("npm-agents", "agents", /`agents` (\d+\.\d+\.\d+) \(peers/, "Cloudflare", MCP_RUNTIME),
  npm("npm-wrangler", "wrangler", /`wrangler`\s+(\d+\.\d+\.\d+)/, "Cloudflare", ["packages/cli/src/generators/mcp.ts"]),
  npm(
    "npm-workers-types",
    "@cloudflare/workers-types",
    /`@cloudflare\/workers-types` (\d+\.\d+\.\d+)/,
    "Cloudflare",
    ["packages/cli/src/generators/mcp.ts"],
  ),
  npm(
    "npm-workers-oauth-provider",
    "@cloudflare/workers-oauth-provider",
    /`@cloudflare\/workers-oauth-provider` (\d+\.\d+\.\d+)/,
    "Cloudflare",
    ["docs/LIMITATIONS.md"],
  ),
];
