// Fakes for the tester tests. No network, no API key.

import type { AgentModel, ModelRequest, ModelResponse, ResponseBlock, ToolUseBlock } from "../src/agents/claude.js";

let ids = 0;
export const toolUse = (name: string, input: Record<string, unknown> = {}): ToolUseBlock => ({ type: "tool_use", id: `toolu_${++ids}`, name, input });
export const text = (t: string) => ({ type: "text" as const, text: t });
export const reply = (...content: ResponseBlock[]): ModelResponse => ({
  content,
  stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
});

/** The user's first message in a request. */
export const utteranceOf = (req: ModelRequest) => String(req.messages[0].content);

/** Number of assistant turns so far (0 on the first call). */
export const turnOf = (req: ModelRequest) => req.messages.filter((m) => m.role === "assistant").length;

/** A model driven by a function of the request; records every request. */
export function fakeModel(decide: (req: ModelRequest) => ModelResponse | Promise<ModelResponse>, label = "fake-model"): AgentModel & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    label,
    requests,
    async respond(req) {
      requests.push(structuredClone(req));
      return decide(req);
    },
  };
}
