// A small Messages API client for the tester agent. It follows
// the same raw-fetch pattern as discover/ai.ts so the CLI keeps zero SDK
// dependencies, and it is hidden behind interfaces so tests can use fakes.

import { ANTHROPIC_BASE_URL, ANTHROPIC_VERSION, DEFAULT_MODEL } from "../discover/ai.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** A tool as the model sees it: what an MCP host would pass from tools/list. */
export interface ModelTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
/** Any block the API returns (thinking blocks included). They are passed back unchanged. */
export type ResponseBlock = TextBlock | ToolUseBlock | { type: string; [key: string]: unknown };

export interface ModelMessage {
  role: "user" | "assistant";
  content: string | (ResponseBlock | ToolResultBlock)[];
}

export interface ModelRequest {
  system: string;
  tools: ModelTool[];
  messages: ModelMessage[];
}

export interface ModelResponse {
  content: ResponseBlock[];
  stop_reason: string;
}

/** Anything that can play the agent: the real API, or a fake in tests. */
export interface AgentModel {
  /** A label for reports, e.g. the model ID. */
  readonly label: string;
  respond(request: ModelRequest): Promise<ModelResponse>;
}

export interface ClaudeOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  /** Retries for 429, 5xx and network errors. */
  maxRetries?: number;
  /** Milliseconds; tests set 0. */
  retryDelayMs?: number;
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export async function postMessages(body: Record<string, unknown>, opts: ClaudeOptions, extraHeaders: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${(opts.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, "")}/v1/messages`;
  const maxRetries = opts.maxRetries ?? 3;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, (opts.retryDelayMs ?? 1000) * 2 ** (attempt - 1)));
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "x-api-key": opts.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastError = err;
      continue;
    }
    const text = await response.text();
    if (response.ok) return JSON.parse(text) as Record<string, unknown>;
    lastError = new Error(`Anthropic API error ${response.status}: ${text.slice(0, 500)}`);
    if (!RETRYABLE.has(response.status) || response.headers.get("x-should-retry") === "false") break;
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Claude as the agent under test. Deliberately no server-side fallback: a
 * fallback would answer with a different model and the score would be wrong.
 * A refusal is reported as an error outcome instead.
 */
export function claudeAgent(opts: ClaudeOptions): AgentModel {
  const model = opts.model ?? DEFAULT_MODEL;
  return {
    label: model,
    async respond(request: ModelRequest): Promise<ModelResponse> {
      const body = await postMessages(
        {
          model,
          max_tokens: opts.maxTokens ?? 16000,
          system: request.system,
          tools: request.tools,
          tool_choice: { type: "auto" },
          messages: request.messages,
          output_config: { effort: opts.effort ?? "medium" },
          // The tools and system prompt repeat for every case: cache them.
          cache_control: { type: "ephemeral" },
        },
        opts,
      );
      return { content: (body.content as ResponseBlock[] | undefined) ?? [], stop_reason: String(body.stop_reason ?? "") };
    },
  };
}
