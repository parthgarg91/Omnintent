// The tester agent with fake models: scoring, the lookup loop, platform
// exposure, the Claude request shape, device plans and result import.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeAgent } from "../src/agents/claude.js";
import { exampleCases } from "../src/agents/tester/cases.js";
import { compareArguments } from "../src/agents/tester/compare.js";
import { androidRunScript, devicePlans } from "../src/agents/tester/android.js";
import { importResults, resolveActionName, resultsTemplate } from "../src/agents/tester/import.js";
import { formatAgentReport, markdownAgentReport } from "../src/agents/tester/report.js";
import { runAgentTest, runAttempt } from "../src/agents/tester/run.js";
import { siriEvaluationFile, siriUtterance } from "../src/agents/tester/siri.js";
import { manifestSurface, type Fixtures } from "../src/agents/tester/surfaces.js";
import { EXAMPLE_MANIFEST, REPO, loadExample, paymentManifest } from "./helpers.js";
import { fakeModel, reply, text, toolUse, turnOf, utteranceOf } from "./agents-helpers.js";

const CLI = resolve(REPO, "packages/cli/dist/cli.js");
const manifest = loadExample();
const caseById = (id: string, platform: "mcp" | "android" = "mcp") => exampleCases(manifest, platform).find((c) => c.id === id)!;

const FIXTURES: Fixtures = {
  list_lists: { result: [{ id: "groceries", name: "Groceries", openCount: 1 }, { id: "work", name: "Work", openCount: 1 }] },
  list_items: [
    { arguments: { listId: "groceries" }, result: { items: [{ id: "item-1", listId: "groceries", title: "Buy milk", done: false }] } },
    { arguments: { listId: "work" }, result: { items: [{ id: "item-3", listId: "work", title: "Send report", done: false }] } },
  ],
};

describe("argument comparison", () => {
  const schema = manifest.actions.find((a) => a.name === "list_items")!.inputSchema;
  const add = manifest.actions.find((a) => a.name === "add_item")!.inputSchema;

  it("ignores case, quotes and trailing punctuation in free text", () => {
    expect(compareArguments({ listId: "work", title: "file taxes" }, { listId: "work", title: '"File taxes."' }, add)).toEqual([]);
  });

  it("accepts an explicit default the person did not mention", () => {
    expect(compareArguments({ listId: "groceries" }, { listId: "groceries", status: "open" }, schema)).toEqual([]);
  });

  it("reports missing, wrong and extra values", () => {
    expect(compareArguments({ listId: "work", status: "done" }, { listId: "groceries", status: "all" }, schema).map((d) => `${d.kind}:${d.name}`)).toEqual([
      "wrong:listId",
      "wrong:status",
    ]);
    expect(compareArguments({ listId: "work", title: "x", dueDate: "2027-04-15" }, { listId: "work", title: "x" }, add)[0]).toMatchObject({ kind: "missing", name: "dueDate" });
    expect(compareArguments({ listId: "work", title: "x" }, { listId: "work", title: "x", dueDate: "2027-01-01" }, add)[0]).toMatchObject({ kind: "extra", name: "dueDate" });
  });

  it("is strict about dates and numbers", () => {
    expect(compareArguments({ dueDate: "2027-04-15" }, { dueDate: "2027-04-16" }, add)).toHaveLength(1);
    expect(compareArguments({ n: 5 }, { n: "5" }, { type: "object", properties: { n: { type: "integer", description: "n" } } })).toHaveLength(1);
  });
});

describe("tester agent: one attempt", () => {
  const surface = manifestSurface(manifest, "mcp", FIXTURES);

  it("passes when the agent calls the expected action with the expected arguments", async () => {
    const model = fakeModel(() => reply(toolUse("add_item", { listId: "groceries", title: "Milk" })));
    const a = await runAttempt(caseById("add_item#0"), manifest, surface, model);
    expect(a).toMatchObject({ verdict: "pass", chosenTool: "add_item", followUps: 0 });
  });

  it("answers read lookups from fixtures, passes thinking blocks back, and scores the decision", async () => {
    const model = fakeModel((req) => {
      const turn = turnOf(req);
      if (turn === 0) return reply({ type: "thinking", thinking: "", signature: "sig-1" }, toolUse("list_lists"));
      if (turn === 1) return reply(toolUse("list_items", { listId: "groceries" }));
      return reply(toolUse("complete_item", { itemId: "item-1" }));
    });
    const a = await runAttempt(caseById("complete_item#0"), manifest, surface, model);
    expect(a.verdict).toBe("pass");
    expect(a.steps.map((s) => `${s.role}:${s.tool}`)).toEqual(["lookup:list_lists", "lookup:list_items", "decision:complete_item"]);
    const second = model.requests[1];
    // The assistant turn, thinking block included, comes back unchanged.
    expect(second.messages[1]).toMatchObject({ role: "assistant", content: [{ type: "thinking", signature: "sig-1" }, { type: "tool_use", name: "list_lists" }] });
    expect(JSON.stringify(second.messages[2].content)).toContain("Groceries");
    expect(JSON.stringify(model.requests[2].messages[4].content)).toContain("Buy milk");
  });

  it("reports a wrong action and wrong arguments", async () => {
    const wrongTool = await runAttempt(caseById("delete_item#1"), manifest, surface, fakeModel(() => reply(toolUse("complete_item", { itemId: "item-1" }))));
    expect(wrongTool).toMatchObject({ verdict: "wrong_tool", chosenTool: "complete_item" });
    const wrongArgs = await runAttempt(caseById("share_list#0"), manifest, surface, fakeModel(() => reply(toolUse("share_list", { listId: "groceries", email: "sam@example.org" }))));
    expect(wrongArgs.verdict).toBe("wrong_args");
    expect(wrongArgs.diffs).toEqual([{ name: "email", kind: "wrong", expected: "sam@example.com", actual: "sam@example.org" }]);
  });

  it("answers one question with 'Yes, go ahead.' and then gives up", async () => {
    const asksOnce = fakeModel((req) => (turnOf(req) === 0 ? reply(text("Delete the eggs item?")) : reply(toolUse("delete_item", { itemId: "item-2" }))));
    expect(await runAttempt(caseById("delete_item#0"), manifest, surface, asksOnce)).toMatchObject({ verdict: "pass", followUps: 1 });
    expect(asksOnce.requests[1].messages.at(-1)).toEqual({ role: "user", content: "Yes, go ahead." });

    const neverActs = fakeModel(() => reply(text("I can't help with that.")));
    const a = await runAttempt(caseById("delete_item#0"), manifest, surface, neverActs);
    expect(a).toMatchObject({ verdict: "no_action", chosenTool: null, followUps: 1, text: "I can't help with that." });
  });

  it("never executes a write action, even when it is not the expected one", async () => {
    let reads = 0;
    const spy = { ...surface, callRead: async (...args: Parameters<typeof surface.callRead>) => (reads++, surface.callRead(...args)) };
    const model = fakeModel(() => reply(toolUse("delete_item", { itemId: "item-1" }), toolUse("list_lists")));
    const a = await runAttempt(caseById("list_lists#0"), manifest, spy, model);
    expect(a).toMatchObject({ verdict: "wrong_tool", chosenTool: "delete_item" });
    expect(reads).toBe(0);
    expect(model.requests).toHaveLength(1);
  });

  it("turns refusals and API errors into error verdicts", async () => {
    const refused = await runAttempt(caseById("list_lists#0"), manifest, surface, fakeModel(() => ({ content: [], stop_reason: "refusal" })));
    expect(refused).toMatchObject({ verdict: "error", error: "the model refused the request" });
    const broken = await runAttempt(caseById("list_lists#0"), manifest, surface, fakeModel(() => Promise.reject(new Error("boom"))));
    expect(broken).toMatchObject({ verdict: "error", error: "boom" });
  });
});

describe("tester agent: platforms", () => {
  it("projects tool names per platform and hides what the platform hides", () => {
    expect(manifestSurface(manifest, "android").tools.map((t) => t.name)).toEqual(["listLists", "addItem", "listItems", "completeItem"]);
    expect(manifestSurface(manifest, "ios").tools.map((t) => t.name)).toContain("DeleteItemIntent");
    expect(manifestSurface(manifest, "mcp").instructions).toContain('Workflow "tidy-list"');
    expect(manifestSurface(paymentManifest(), "android").tools).toEqual([]);
  });

  it("on Android, a hidden destructive action passes only if the agent writes nothing", async () => {
    const surface = manifestSurface(manifest, "android", FIXTURES);
    const c = caseById("delete_item#0", "android");
    expect(c.exposed).toBe(false);
    const unsafe = await runAttempt(c, manifest, surface, fakeModel(() => reply(toolUse("completeItem", { itemId: "item-2" }))));
    expect(unsafe).toMatchObject({ verdict: "unsafe_call", chosenTool: "complete_item" });
    const declines = await runAttempt(c, manifest, surface, fakeModel((req) => (turnOf(req) === 0 ? reply(toolUse("listLists")) : reply(text("I can't delete items here.")))));
    expect(declines.verdict).toBe("pass");
  });

  it("runs every case several times and summarises flaky ones", async () => {
    let n = 0;
    // Right on even calls, wrong on odd ones: every case passes 1 of 2 runs.
    const model = fakeModel((req) => {
      const c = exampleCases(manifest, "mcp").find((x) => x.utterance === utteranceOf(req))!;
      return reply(toolUse(n++ % 2 ? "list_lists" : c.expectedTool, c.expectedArguments));
    });
    const report = await runAgentTest(manifest, exampleCases(manifest, "mcp"), manifestSurface(manifest, "mcp", FIXTURES), model, { runs: 2, concurrency: 1, maxFollowUps: 0 });
    expect(report).toMatchObject({ total: 24, runs: 2 });
    expect(report.passes).toBeGreaterThanOrEqual(12);
    expect(formatAgentReport(report)).toMatch(/flaky|pass/);
    expect(markdownAgentReport(report)).toContain("| add_item#0 | Add milk to my groceries list |");
  });
});

describe("Claude as the agent", () => {
  it("sends tools with tool_choice auto, effort and no sampling parameters, and retries overload", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 1) return new Response('{"type":"error","error":{"type":"overloaded_error"}}', { status: 529 });
      return new Response(JSON.stringify({ content: [{ type: "tool_use", id: "t1", name: "list_lists", input: {} }], stop_reason: "tool_use" }), { status: 200 });
    }) as unknown as typeof fetch;
    const model = claudeAgent({ apiKey: "sk-test", fetchImpl, retryDelayMs: 0 });
    const surface = manifestSurface(manifest, "mcp", FIXTURES);
    const a = await runAttempt(caseById("list_lists#0"), manifest, surface, model);
    expect(a.verdict).toBe("pass");
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe("https://api.anthropic.com/v1/messages");
    const headers = calls[1].init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2026-10-21");
    const body = JSON.parse(String(calls[1].init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "claude-opus-5-5", tool_choice: { type: "auto" }, output_config: { effort: "medium" } });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("fallbacks");
    const tools = body.tools as { name: string; input_schema: { additionalProperties?: boolean } }[];
    expect(tools.map((t) => t.name)).toEqual(["list_lists", "add_item", "list_items", "complete_item", "delete_item", "share_list"]);
    expect(tools[1].input_schema.additionalProperties).toBe(false);
    expect(String(body.system)).toContain("Todo Example");
  });

  it("does not retry a bad request", async () => {
    let n = 0;
    const fetchImpl = (async () => (n++, new Response("bad", { status: 400 }))) as unknown as typeof fetch;
    await expect(claudeAgent({ apiKey: "k", fetchImpl, retryDelayMs: 0 }).respond({ system: "", tools: [], messages: [] })).rejects.toThrow(/400/);
    expect(n).toBe(1);
  });
});

describe("device plans", () => {
  const files = Object.fromEntries(devicePlans(manifest).map((f) => [f.path, f.content]));

  it("writes a SiriEvaluations test that follows Apple's documented shapes", () => {
    const swift = files["siri/OmnintentSiriEvaluations.swift"];
    expect(swift).toContain('let appIntents = IntentDefinitions(bundleIdentifier: "com.example.todoexample")');
    expect(swift).toContain('UserTurn("In Todo Example, add milk to my groceries list") {');
    expect(swift).toContain('.expect(title: .equals("milk"))');
    expect(swift).toContain('todoListEntity.expect(id: .equals("groceries"))');
    // Destructive actions are confirmed in a second turn and checked across the scenario.
    expect(swift).toMatch(/UserTurn\("Yes"\)\n {4}\} expectation: \{\n {8}Calls\(\.unordered\) \{\n {12}deleteItemIntent/);
    // Every other request must not run or offer to run a destructive action.
    expect(swift).toContain("Calls(.disallowed) {\n                deleteItemIntent");
    expect(swift).toContain("try await SiriService.run(scenario: sample)");
    expect(swift).toContain("#expect(result.aggregateValue(.mean(of: .intentsAllPass)) >= requiredPassRate)");
    expect(swift).toContain("// Not checked by value (check the report): status = \"done\"");
  });

  it("produces Swift that tree-sitter parses without errors", () => {
    const require = createRequire(import.meta.url);
    let Parser: (new () => { setLanguage(l: unknown): void; parse(s: string): { rootNode: { hasError: boolean } } }) | undefined;
    let Swift: unknown;
    try {
      Parser = require("tree-sitter");
      Swift = require("tree-sitter-swift");
    } catch {
      return; // optional dependency missing on this machine
    }
    const parser = new Parser!();
    parser.setLanguage(Swift);
    for (const m of [manifest, paymentManifest()]) expect(parser.parse(siriEvaluationFile(m)).rootNode.hasError).toBe(false);
  });

  it("keeps the app name first and quotes safely", () => {
    expect(siriUtterance(manifest, "Show my lists")).toBe("In Todo Example, show my lists");
    expect(siriUtterance(manifest, "I finished sending the report")).toBe("In Todo Example, I finished sending the report");
  });

  it("writes an adb script that is valid shell and runs writes only on request", () => {
    const script = androidRunScript(manifest);
    const dir = mkdtempSync(join(tmpdir(), "omnintent-adb-"));
    writeFileSync(join(dir, "run.sh"), script);
    expect(spawnSync("sh", ["-n", join(dir, "run.sh")]).status).toBe(0);
    expect(script).toContain("run 'list_lists#0' adb shell");
    expect(script).toMatch(/if \[ "\$RUN_WRITES" = "1" \]; then\n {2}run 'add_item#0'/);
    expect(script).not.toContain("deleteItem");
    expect(files["android/agent-checklist.md"]).toContain("| delete_item#0 | Delete the eggs item | nothing that changes data (not exposed on Android) |");
  });
});

describe("imported results", () => {
  it("scores what a person recorded from Siri or an Android agent", () => {
    const file = resultsTemplate(manifest, "android", "AppFunctions testing agent");
    const set = (id: string, chosenTool: string, chosenArguments: Record<string, unknown> | null) => Object.assign(file.results.find((r) => r.case === id)!, { chosenTool, chosenArguments });
    set("add_item#0", "addItem", { listId: "groceries", title: "milk" });
    set("add_item#1", "com.example.todoexample.omnintent.BaseTodoExampleAppFunctionService#addItem", { listId: "work", title: "file taxes" });
    set("list_lists#0", "none", null);
    set("delete_item#0", "completeItem", { itemId: "item-2" });
    set("delete_item#1", "none", null);
    const report = importResults(manifest, file);
    const verdicts = Object.fromEntries(report.results.map((r) => [r.case.id, r.attempts[0].verdict]));
    expect(verdicts).toEqual({ "add_item#0": "pass", "add_item#1": "wrong_args", "list_lists#0": "no_action", "delete_item#0": "unsafe_call", "delete_item#1": "pass" });
    expect(report.notes[0]).toMatch(/7 case\(s\) have no result yet/);
    expect(resolveActionName(manifest, "DeleteItemIntent")).toBe("delete_item");
  });

  it("runs from the CLI without an API key", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnintent-import-"));
    const file = resultsTemplate(manifest, "ios", "Siri");
    file.results[0].chosenTool = "ListListsIntent";
    writeFileSync(join(dir, "results.json"), JSON.stringify(file));
    const env = { ...process.env, ANTHROPIC_API_KEY: "" };
    const out = execFileSync("node", [CLI, "agent-test", EXAMPLE_MANIFEST, "--import", join(dir, "results.json"), "--report", join(dir, "r.md")], { env }).toString();
    expect(out).toMatch(/1\/1 attempts passed \(100%\)/);
    const failing = spawnSync("node", [CLI, "agent-test", EXAMPLE_MANIFEST], { env });
    expect(failing.status).toBe(2);
    expect(failing.stderr.toString()).toMatch(/ANTHROPIC_API_KEY is not set/);
  });
});

describe("agent-test CLI against a fake Messages API", () => {
  it("runs every sample, prints the report and writes Markdown", async () => {
    const { createServer } = await import("node:http");
    const cases = exampleCases(manifest, "mcp");
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        const body = JSON.parse(raw) as { messages: { role: string; content: unknown }[] };
        const c = cases.find((x) => x.utterance === body.messages[0].content)!;
        // Right for every case except share_list#1, where it picks the wrong email.
        const args = c.id === "share_list#1" ? { ...c.expectedArguments, email: "alex@example.com" } : c.expectedArguments;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: c.expectedTool, input: args }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), "omnintent-agent-"));
    // Asynchronous spawn: the fake API runs in this process and must keep answering.
    const { spawn } = await import("node:child_process");
    const child = spawn("node", [CLI, "agent-test", EXAMPLE_MANIFEST, "--report", join(dir, "report.md"), "--fail-under", "1"], {
      env: { ...process.env, ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
    });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    const status = await new Promise<number | null>((r) => child.on("close", r));
    const run = { stdout, status };
    await new Promise((r) => server.close(r));
    expect(run.stdout).toContain("11/12 attempts passed (92%)");
    expect(run.stdout).toMatch(/FAIL\s+share_list#1 .*email "alex@example.com" instead of "alex@example.org"/);
    expect(run.status).toBe(1); // below --fail-under
    expect(readFileSync(join(dir, "report.md"), "utf8")).toContain("**11/12 attempts passed (92%)**");
  });
});

describe("example fixtures", () => {
  it("answer every lookup the example's samples need", async () => {
    const { readFixtures, fixtureAnswer } = await import("../src/agents/tester/surfaces.js");
    const fx = readFixtures(resolve(REPO, "examples/todo/tester-fixtures.json"));
    expect(fixtureAnswer(fx, "list_lists", {}).content).toContain("Groceries");
    expect(fixtureAnswer(fx, "list_items", { listId: "groceries", status: "done" }).content).toContain("Buy eggs");
    expect(fixtureAnswer(fx, "list_items", { listId: "work" }).content).toContain("Send report");
    expect(fixtureAnswer(fx, "list_items", { listId: "nope" }).isError).toBe(true);
  });
});
