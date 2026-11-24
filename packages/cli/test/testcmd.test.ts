import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { testManifest, testPlan } from "../src/testcmd.js";
import { EXAMPLE_MANIFEST, REPO, loadExample, variant } from "./helpers.js";

const rules = (m: Parameters<typeof testManifest>[0]) => testManifest(m).findings.map((f) => `${f.severity}:${f.rule}`);

describe("omnintent test (static utterance checks)", () => {
  it("passes the example", () => {
    const report = testManifest(loadExample());
    expect(report).toMatchObject({ ok: true, actions: 6, examples: 12, findings: [] });
  });

  it("fails when an utterance does not contain a required argument (T001)", () => {
    const m = variant((m) => (m.actions[1].examples[0].utterance = "Add something to my groceries list"));
    expect(rules(m)).toContain("error:T001");
    expect(testManifest(m).ok).toBe(false);
  });

  it("does not require entity IDs to appear in utterances", () => {
    const m = variant((m) => (m.actions[3].examples[0].utterance = "Tick off the milk"));
    expect(rules(m)).toEqual([]);
  });

  it("warns when enum values are not mentioned (T002)", () => {
    const m = variant((m) => (m.actions[2].examples[1].utterance = "Which work items are finished?"));
    expect(rules(m)).toContain("warning:T002");
  });

  it("warns when no example uses the optional parameters (T003)", () => {
    const m = variant((m) => {
      m.actions[1].examples[1] = { utterance: "Put file taxes on my work list", arguments: { listId: "work", title: "file taxes" } };
    });
    expect(rules(m)).toContain("warning:T003");
  });

  it("warns about near-duplicate utterances across actions (T005)", () => {
    const m = variant((m) => (m.actions[0].examples[1].utterance = "Show my groceries list"));
    m.actions[2].examples[0].utterance = "Show my groceries list please";
    expect(rules(m)).toContain("warning:T005");
  });

  it("writes a test plan for SiriEvaluations, adb and MCP", () => {
    const files = Object.fromEntries(testPlan(loadExample()).map((f) => [f.path, f.content]));
    expect(JSON.parse(files["cases.json"])).toHaveLength(12);
    expect(files["adb-commands.sh"]).toContain(
      "--function 'com.example.todoexample.omnintent.BaseTodoExampleAppFunctionService#addItem'",
    );
    expect(files["adb-commands.sh"]).not.toContain("#deleteItem");
    expect(files["siri-requests.md"]).toContain("| Delete the eggs item | Delete Item |");
  });

  it("runs from the CLI", () => {
    const plan = mkdtempSync(join(tmpdir(), "omnintent-plan-"));
    const out = execFileSync("node", [resolve(REPO, "packages/cli/dist/cli.js"), "test", EXAMPLE_MANIFEST, "--plan", plan]).toString();
    expect(out).toMatch(/6 actions, 12 sample utterances, 0 errors, 0 warnings/);
    expect(readFileSync(join(plan, "cases.json"), "utf8")).toContain('"expectedTool": "share_list"');
  });
});
