import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateManifest } from "../src/validate.js";
import { EXAMPLE_MANIFEST, REPO, loadExample, paymentManifest, variant } from "./helpers.js";

const rules = (m: unknown) => validateManifest(m).issues.map((i) => `${i.severity}:${i.rule}`);
const errors = (m: unknown) => validateManifest(m).issues.filter((i) => i.severity === "error");

describe("validate", () => {
  it("accepts the example manifest with no issues", () => {
    const result = validateManifest(loadExample());
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("accepts the payment fixture", () => {
    expect(errors(paymentManifest())).toEqual([]);
  });

  it("reports schema errors with readable paths", () => {
    const result = validateManifest({ omnintent: "0.1", app: { name: "X" }, actions: [] });
    expect(result.ok).toBe(false);
    const text = result.issues.map((i) => `${i.path} ${i.message}`).join("\n");
    expect(text).toMatch(/\/app .*slug/);
    expect(text).toMatch(/\/actions .*fewer than 1/);
  });

  it("rejects unknown fields", () => {
    const m = variant((m) => ((m.actions[0] as unknown as Record<string, unknown>).colour = "blue"));
    expect(validateManifest(m).issues.some((i) => i.message === 'unknown field "colour"')).toBe(true);
  });

  it("rejects parameters without descriptions", () => {
    const m = variant((m) => {
      delete (m.actions[1].inputSchema.properties!.title as { description?: string }).description;
    });
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path === "/actions/1/inputSchema/properties/title" && /description/.test(i.message))).toBe(true);
  });

  it("requires unique, snake_case action names (OI101, OI102)", () => {
    expect(rules(variant((m) => (m.actions[1].name = "list_lists")))).toContain("error:OI101");
    expect(rules(variant((m) => (m.actions[1].name = "addItem")))).toContain("error:OI102");
    const msg = errors(variant((m) => (m.actions[1].name = "addItem")))[0].message;
    expect(msg).toContain('"add_item"');
  });

  it("requires at least two sample utterances (OI107)", () => {
    expect(rules(variant((m) => m.actions[0].examples.splice(1)))).toContain("error:OI107");
  });

  it("checks example arguments against the input schema (OI108)", () => {
    const m = variant((m) => (m.actions[1].examples[0].arguments = { listId: "groceries" }));
    const issue = errors(m).find((i) => i.rule === "OI108");
    expect(issue?.message).toMatch(/title/);
    expect(rules(variant((m) => (m.actions[2].examples[1].arguments.status = "later")))).toContain("error:OI108");
  });

  it("rejects the same utterance on two actions (OI109)", () => {
    const m = variant((m) => (m.actions[0].examples[0].utterance = m.actions[2].examples[0].utterance));
    expect(rules(m)).toContain("error:OI109");
  });

  it("requires confirmation prompts for destructive and payment actions (OI110)", () => {
    expect(rules(variant((m) => delete m.actions[4].confirmation))).toContain("error:OI110");
    expect(rules(variant((m) => (m.actions[4].confirmation = { required: false, prompt: "Sure?" })))).toContain("error:OI110");
    const pay = paymentManifest();
    delete pay.actions[0].confirmation;
    expect(rules(pay)).toContain("error:OI110");
  });

  it("checks confirmation placeholders (OI111)", () => {
    expect(rules(variant((m) => (m.actions[4].confirmation!.prompt = "Delete {item}?")))).toContain("error:OI111");
  });

  it("checks entity references and id/display properties (OI120-OI122)", () => {
    expect(rules(variant((m) => (m.actions[1].outputSchema = { $ref: "#/entities/Nope" })))).toContain("error:OI120");
    expect(rules(variant((m) => (m.actions[1].inputSchema.properties!.listId["x-omnintent-entity"] = "Nope")))).toContain("error:OI120");
    expect(rules(variant((m) => (m.entities!.TodoItem.displayProperty = "missing")))).toContain("error:OI121");
    expect(rules(variant((m) => (m.entities!.TodoItem.properties.title.visibility = "internal")))).toContain("error:OI122");
  });

  it("checks backend mappings (OI130, OI131, OI132)", () => {
    expect(rules(variant((m) => (m.actions[1].backend!.path = "/lists/{list}/items")))).toContain("error:OI130");
    expect(rules(variant((m) => (m.actions[1].backend!.body = ["title", "nope"])))).toContain("error:OI131");
    expect(rules(variant((m) => delete m.actions[1].backend))).toContain("error:OI132");
    // Without MCP the backend mapping is optional.
    expect(rules(variant((m) => {
      delete m.actions[1].backend;
      m.actions[1].platforms = { mcp: { enabled: false } };
    }))).not.toContain("error:OI132");
  });

  it("warns when the HTTP method and safety level disagree (OI134)", () => {
    expect(rules(variant((m) => (m.actions[4].safety = "write")))).toContain("warning:OI134");
  });

  it("forbids payment actions on Android (OI140)", () => {
    const pay = paymentManifest();
    pay.actions[0].platforms = { android: { enabled: true } };
    expect(rules(pay)).toContain("error:OI140");
  });

  it("forbids conversation-dump parameter names (OI150)", () => {
    const m = variant((m) => {
      m.actions[1].inputSchema.properties!.conversationHistory = { type: "string", description: "Everything said so far." };
    });
    expect(rules(m)).toContain("error:OI150");
  });

  it("checks types, formats and defaults (OI151)", () => {
    expect(rules(variant((m) => (m.actions[2].inputSchema.properties!.status.default = "soon")))).toContain("error:OI151");
    expect(rules(variant((m) => (m.entities!.TodoList.properties.openCount.format = "date")))).toContain("error:OI151");
  });

  it("lints descriptions without failing validation (OI104, OI105)", () => {
    const m = variant((m) => (m.actions[1].description = "This function is used to add items. You MUST call list_lists first."));
    const result = validateManifest(m);
    expect(result.ok).toBe(true);
    expect(rules(m)).toEqual(expect.arrayContaining(["warning:OI104", "warning:OI105"]));
  });

  it("checks skills (OI160-OI162)", () => {
    expect(rules(variant((m) => m.skills!.push({ ...m.skills![0] })))).toContain("error:OI160");
    expect(rules(variant((m) => (m.skills![0].description = "two\nlines")))).toContain("error:OI161");
    expect(rules(variant((m) => (m.skills![0].actions = ["nope"])))).toContain("error:OI162");
  });

  it("exits non-zero from the CLI on an invalid manifest", () => {
    const cli = resolve(REPO, "packages/cli/dist/cli.js");
    expect(execFileSync("node", [cli, "validate", EXAMPLE_MANIFEST]).toString()).toMatch(/is valid: 6 actions, 2 entities/);
    const bad = resolve(REPO, "packages/cli/test/fixtures/invalid.json");
    let status = 0;
    let stderr = "";
    try {
      execFileSync("node", [cli, "validate", bad], { stdio: "pipe" });
    } catch (err) {
      status = (err as { status: number }).status;
      stderr = String((err as { stderr: Buffer }).stderr);
    }
    expect(status).toBe(1);
    expect(stderr).toMatch(/OI102/);
    expect(stderr).toMatch(/OI107/);
  });
});
