// Library entry point: everything the CLI does, callable from code.

export * from "./manifest.js";
export { validateManifest, readManifestFile, formatIssues, type Issue, type ValidationResult } from "./validate.js";
export { generate, writeFiles, parseTargets, GENERATORS, type GeneratedFile, type Target } from "./generators/index.js";
export { generateSwift } from "./generators/swift.js";
export { generateKotlin } from "./generators/kotlin.js";
export { generateMcp } from "./generators/mcp.js";
export { discover, type DiscoverOptions, type DiscoverResult } from "./discover/index.js";
export { draftFromOpenApi, loadOpenApi } from "./discover/openapi.js";
export { draftWithAi, proposalToManifest, PROPOSAL_SCHEMA, DEFAULT_MODEL, ANTHROPIC_VERSION, type Proposal } from "./discover/ai.js";
export { testManifest, testPlan, formatReport } from "./testcmd.js";
export { SAFETY, actionAuth, androidRule, needsConfirmation, mcpConfirmation, isEnabledFor, skillsFor } from "./safety.js";
export { manifestSchema, mcpInputSchema, mcpOutputSchema } from "./schema.js";
export * from "./agents/index.js";
