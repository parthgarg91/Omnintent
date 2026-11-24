// The tester agent against the real generated MCP server (Node adapter) and
// the example's mock backend, through the official MCP client. The model is a
// fake; everything else is real. The key property: lookups read real data
// and no write ever reaches the backend.

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exampleCases } from "../src/agents/tester/cases.js";
import { runAgentTest, runAttempt } from "../src/agents/tester/run.js";
import { mcpServerSurface, overlaySurface, type Surface } from "../src/agents/tester/surfaces.js";
import { EXAMPLE_DIR, GENERATED_DIR, loadExample, variant } from "./helpers.js";
import { fakeModel, reply, text, toolUse, turnOf, utteranceOf } from "./agents-helpers.js";

const procs: ChildProcess[] = [];
const MCP_TOKEN = "tester-mcp-token";
const BACKEND_TOKEN = "tester-backend-token";

function start(cmd: string, args: string[], cwd: string, env: Record<string, string>, ready: RegExp): Promise<RegExpMatchArray> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(cmd, args, { cwd, env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    procs.push(proc);
    let output = "";
    const timer = setTimeout(() => reject(new Error(`${cmd} did not start:\n${output}`)), 60_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(ready);
      if (match) {
        clearTimeout(timer);
        resolvePromise(match);
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.on("exit", (code) => reject(new Error(`${cmd} exited with ${code}:\n${output}`)));
  });
}

afterAll(() => {
  for (const p of procs) p.kill("SIGTERM");
});

describe("tester agent against the generated MCP server", () => {
  const manifest = loadExample();
  let backend = "";
  let url = "";
  let live: Surface;
  const state = async () => (await (await fetch(`${backend}/__state`)).json()) as { items: { id: string; done: boolean }[]; shares: unknown[] };

  beforeAll(async () => {
    backend = (await start("node", [join(EXAMPLE_DIR, "mock-backend/server.mjs")], EXAMPLE_DIR, { PORT: "0", MOCK_BACKEND_TOKEN: BACKEND_TOKEN }, /listening on (http:\/\/127\.0\.0\.1:\d+)/))[1];
    url = (
      await start(
        "node",
        ["scripts/serve-node.mjs"],
        join(GENERATED_DIR, "mcp"),
        { PORT: "0", BACKEND_BASE_URL: backend, BACKEND_TOKEN, MCP_ACCESS_TOKEN: MCP_TOKEN },
        /listening on (http:\/\/127\.0\.0\.1:\d+\/mcp)/,
      )
    )[1];
    live = await mcpServerSurface({ url, token: MCP_TOKEN, manifest });
  }, 90_000);

  afterAll(async () => {
    await live?.close();
  });

  it("sees the tools a host sees and only treats reads as callable", () => {
    expect(live.tools.map((t) => `${t.name}:${t.readOnly}`)).toEqual([
      "list_lists:true",
      "add_item:false",
      "list_items:true",
      "complete_item:false",
      "delete_item:false",
      "share_list:false",
    ]);
    expect(live.notes).toEqual([]);
    expect(live.instructions).toContain("personal to-do app");
  });

  it("looks up real IDs through read tools and stops before the write", async () => {
    await fetch(`${backend}/__reset`, { method: "POST" });
    const before = await state();
    const model = fakeModel((req) => {
      const turn = turnOf(req);
      if (turn === 0) return reply(toolUse("list_lists"));
      if (turn === 1) return reply(toolUse("list_items", { listId: "groceries" }));
      return reply(toolUse("complete_item", { itemId: "item-1" }));
    });
    const c = exampleCases(manifest, "mcp").find((x) => x.id === "complete_item#0")!;
    const a = await runAttempt(c, manifest, live, model);
    expect(a.verdict).toBe("pass");
    expect(JSON.stringify(model.requests[1].messages[2].content)).toContain("Groceries");
    const items = JSON.stringify(model.requests[2].messages[4].content);
    expect(items).toContain("Buy milk");
    expect(items).not.toContain("Two percent only"); // internal notes are stripped by the server
    expect(await state()).toEqual(before);
  });

  it("runs every sample without changing backend state", async () => {
    await fetch(`${backend}/__reset`, { method: "POST" });
    const before = await state();
    const cases = exampleCases(manifest, "mcp");
    // An oracle agent: one lookup, then the expected call.
    const model = fakeModel((req) => {
      const c = cases.find((x) => x.utterance === utteranceOf(req))!;
      if (turnOf(req) === 0 && c.expectedTool !== "list_lists") return reply(text("Let me check your lists."), toolUse("list_lists"));
      return reply(toolUse(c.expectedTool, c.expectedArguments));
    });
    const report = await runAgentTest(manifest, cases, live, model, { concurrency: 3 });
    expect(report.passes).toBe(12);
    expect(await state()).toEqual(before);
  });

  it("can test a candidate's descriptions against the live server's data", async () => {
    const candidate = variant((m) => (m.actions[0].description = "Lists every to-do list the user has, with IDs, names and open item counts."));
    const overlay = overlaySurface(candidate, live);
    expect(overlay.tools[0].description).toBe(candidate.actions[0].description);
    expect(overlay.tools.filter((t) => t.readOnly).map((t) => t.name)).toEqual(["list_lists", "list_items"]);
    const answer = await overlay.callRead(overlay.tools[0], {});
    expect(answer.content).toContain("Work");
    await overlay.close(); // leaves the live connection open
    expect((await live.callRead(live.tools[0], {})).isError).toBe(false);
  });

  it("notices when the deployed server and the manifest disagree", async () => {
    const edited = variant((m) => {
      m.actions[0].description = "Lists lists.";
      m.actions.push({ ...structuredClone(m.actions[0]), name: "archive_list", examples: m.actions[0].examples });
    });
    const s = await mcpServerSurface({ url, token: MCP_TOKEN, manifest: edited });
    await s.close();
    expect(s.notes).toEqual([
      'the server\'s description of "list_lists" differs from the manifest; redeploy after editing',
      'the manifest\'s "archive_list" is missing from the server',
    ]);
  });
});
