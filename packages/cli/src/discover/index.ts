// `omnintent discover`: draft omnintent.json from an OpenAPI file or a codebase.
// Deterministic path: OpenAPI -> draft. AI path (ANTHROPIC_API_KEY set): the
// draft and/or a codebase summary go to Claude, whose proposal is converted
// and validated. The caller writes the result only if it validates.

import { statSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "../manifest.js";
import { draftWithAi, type AiOptions, type ConversionBase } from "./ai.js";
import { summarizeCodebase } from "./codebase.js";
import { draftFromOpenApi, loadOpenApi, openApiSummary } from "./openapi.js";

export interface DiscoverOptions {
  apiKey?: string;
  useAi?: boolean;
  model?: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

export interface DiscoverResult {
  manifest: Manifest;
  mode: "openapi" | "ai";
  notes: string[];
}

export async function discover(input: string, opts: DiscoverOptions = {}): Promise<DiscoverResult> {
  const log = opts.log ?? (() => {});
  const isDir = statSync(input).isDirectory();
  const notes: string[] = [];
  let draft: Manifest | undefined;
  let context: string;

  if (isDir) {
    const summary = summarizeCodebase(input);
    log(`Scanned ${input}: ${summary.routes} HTTP routes, ${summary.openApiFiles.length} OpenAPI file(s).`);
    context = summary.text;
    if (summary.openApiFiles.length) {
      const file = join(input, summary.openApiFiles[0]);
      const result = draftFromOpenApi(loadOpenApi(file));
      draft = result.manifest;
      notes.push(`Used ${summary.openApiFiles[0]} for the deterministic draft.`, ...result.notes);
    }
  } else {
    const doc = loadOpenApi(input);
    const result = draftFromOpenApi(doc);
    draft = result.manifest;
    notes.push(...result.notes);
    context = openApiSummary(doc);
  }

  const useAi = (opts.useAi ?? true) && !!opts.apiKey;
  if (!useAi) {
    if (!draft) {
      throw new Error(
        "No OpenAPI file was found. Pass an OpenAPI 3.x file, or set ANTHROPIC_API_KEY so discover can read the code with Claude.",
      );
    }
    return { manifest: draft, mode: "openapi", notes };
  }

  const base: ConversionBase = {
    slug: draft?.app.slug ?? "my-app",
    version: draft?.app.version,
    baseUrl: draft?.backend?.baseUrl ?? "<YOUR_BACKEND_URL>",
    auth: draft?.backend?.auth ?? { type: "bearer", secret: "BACKEND_TOKEN" },
  };
  const aiOpts: AiOptions = { apiKey: opts.apiKey!, model: opts.model, fetchImpl: opts.fetchImpl, log };
  const result = await draftWithAi(context, draft, base, aiOpts);
  notes.push(`Claude drafted the manifest in ${result.attempts} attempt(s). Review every description, safety level and utterance before you generate.`);
  return { manifest: result.manifest, mode: "ai", notes };
}
