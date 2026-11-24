// A small streaming client for the Claude Messages API, used by the builder
// agent. It sends one structured-output request with no tools: the model can
// only return JSON matching the schema, which the agent then checks before
// anything is written. Streaming keeps long requests clear of HTTP timeouts.
//
// Request shape (checked against the Claude API docs on 2026-11-24):
// - anthropic-version 2026-10-21 (no temperature/top_p/top_k on this version)
// - model claude-opus-5-5, adaptive thinking (it cannot be disabled on this model)
// - output_config.effort "high" (the model's default is "medium"; wiring code is a coding task)
// - output_config.format json_schema for structured output
// - fallbacks "default" with the server-side-fallback-2026-07-01 beta, so a
//   safety-classifier refusal is retried on a fallback model inside the same call

import { ANTHROPIC_BASE_URL, ANTHROPIC_VERSION, DEFAULT_MODEL } from "../discover/ai.js";

export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface ClaudeOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  /** Server-side refusal fallbacks (default true). Not available on Bedrock, Vertex or Foundry. */
  fallbacks?: boolean;
  fetchImpl?: typeof fetch;
}

export type Turn = { role: "user" | "assistant"; content: string };

export interface StructuredRequest {
  system: string;
  messages: Turn[];
  schema: object;
}

export interface StructuredResponse {
  text: string;
  model: string;
  stopReason: string | undefined;
  usage: { input_tokens?: number; output_tokens?: number };
}

interface StreamState {
  blocks: { type: string; text: string }[];
  stopReason?: string;
  model: string;
  usage: { input_tokens?: number; output_tokens?: number };
}

/** Applies one server-sent event to the accumulated message. */
function applyEvent(state: StreamState, event: string, data: string): void {
  if (!data) return;
  const payload = JSON.parse(data) as Record<string, any>;
  switch (payload.type ?? event) {
    case "message_start":
      state.model = payload.message?.model ?? state.model;
      state.usage = { ...state.usage, ...payload.message?.usage };
      return;
    case "content_block_start":
      state.blocks[payload.index] = { type: payload.content_block?.type ?? "unknown", text: payload.content_block?.text ?? "" };
      return;
    case "content_block_delta":
      if (payload.delta?.type === "text_delta" && state.blocks[payload.index]) state.blocks[payload.index].text += payload.delta.text;
      return;
    case "message_delta":
      if (payload.delta?.stop_reason) state.stopReason = payload.delta.stop_reason;
      state.usage = { ...state.usage, ...payload.usage };
      return;
    case "error":
      throw new Error(`Anthropic API stream error: ${payload.error?.type ?? "error"}: ${payload.error?.message ?? data.slice(0, 300)}`);
    default:
      return; // ping, content_block_stop, message_stop, and future event types
  }
}

/** Parses a text/event-stream body into the final message. */
export async function readStream(body: ReadableStream<Uint8Array>, model: string): Promise<StreamState> {
  const state: StreamState = { blocks: [], model, usage: {} };
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (chunk: string) => {
    let event = "";
    const data: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    applyEvent(state, event, data.join("\n"));
  };
  for await (const part of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(part, { stream: true }).replace(/\r\n/g, "\n");
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      flush(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) flush(buffer);
  return state;
}

export function buildRequestBody(req: StructuredRequest, opts: ClaudeOptions): Record<string, unknown> {
  return {
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? 64000,
    stream: true,
    system: req.system,
    messages: req.messages,
    thinking: { type: "adaptive" },
    output_config: { effort: opts.effort ?? "high", format: { type: "json_schema", schema: req.schema } },
    ...(opts.fallbacks === false ? {} : { fallbacks: "default" }),
  };
}

export async function callStructured(req: StructuredRequest, opts: ClaudeOptions): Promise<StructuredResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${(opts.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, "")}/v1/messages`;
  const headers: Record<string, string> = {
    "x-api-key": opts.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
    accept: "text/event-stream",
  };
  if (opts.fallbacks !== false) headers["anthropic-beta"] = FALLBACK_BETA;
  const response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(buildRequestBody(req, opts)) });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(`Anthropic API error ${response.status}: ${text.slice(0, 500)}`);
  }
  const state = await readStream(response.body, opts.model ?? DEFAULT_MODEL);
  if (state.stopReason === "refusal") throw new Error("The model declined this request.");
  if (state.stopReason === "max_tokens") throw new Error("The model ran out of output tokens; configure fewer source folders or a smaller app slice.");
  // After a server-side fallback, only the blocks after the last fallback marker belong to the final answer.
  const lastFallback = state.blocks.map((b) => b?.type).lastIndexOf("fallback");
  const text = state.blocks
    .slice(lastFallback + 1)
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("");
  if (!text) throw new Error("The Anthropic API response had no text content.");
  return { text, model: state.model, stopReason: state.stopReason, usage: state.usage };
}
