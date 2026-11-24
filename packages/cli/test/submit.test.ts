import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPLE_LIMITS, parseSubmitPlatforms, prepareSubmission } from "../src/agents/submit/submit.js";
import type { GeneratedFile } from "../src/generators/types.js";
import { EXAMPLE_MANIFEST, REPO, loadExample, paymentManifest, variant } from "./helpers.js";

const run = promisify(execFile);
const CLI = resolve(REPO, "packages/cli/dist/cli.js");
const DATE = "2026-11-24";

function file(files: GeneratedFile[], path: string): string {
  const f = files.find((x) => x.path === path);
  if (!f) throw new Error(`missing ${path}; have ${files.map((x) => x.path).join(", ")}`);
  return f.content;
}

afterEach(() => vi.unstubAllGlobals());

describe("submission helper", () => {
  it("writes drafts for every platform and says nothing was sent", () => {
    const { files } = prepareSubmission(loadExample(), { date: DATE });
    expect(files.map((f) => f.path)).toEqual([
      "README.md",
      "apple/testflight-what-to-test.txt",
      "apple/app-review-notes.txt",
      "apple/README.md",
      "android/connected-console.md",
      "mcp/connector-listing.md",
      "submission.json",
    ]);
    expect(file(files, "README.md")).toContain("**Nothing here was sent.**");
    expect(JSON.parse(file(files, "submission.json"))).toMatchObject({ app: "todo-example", preparedOn: DATE, sent: false });
  });

  it("has no network code: it works with fetch disabled", () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("network used");
    });
    expect(() => prepareSubmission(loadExample(), { date: DATE })).not.toThrow();
    const source = readFileSync(resolve(REPO, "packages/cli/src/agents/submit/submit.ts"), "utf8");
    expect(source).not.toMatch(/\bfetch\(|node:https?|node:net|child_process/);
  });

  it("is deterministic for a given date", () => {
    expect(prepareSubmission(loadExample(), { date: DATE })).toEqual(prepareSubmission(loadExample(), { date: DATE }));
  });

  it("keeps Siri AI preview testing to internal TestFlight testers", () => {
    const { files } = prepareSubmission(loadExample(), { date: DATE });
    const readme = file(files, "apple/README.md");
    expect(readme).toContain("Siri AI Developer Preview features reach internal testers only.");
    expect(readme).toContain("internal TestFlight group only");
    expect(readme).toContain(APPLE_LIMITS.reviewNotesSource);
    const wtt = file(files, "apple/testflight-what-to-test.txt");
    expect(wtt).toContain('"What to-do lists do I have?"');
    expect(wtt).toContain("Delete Item: asks for confirmation first; works only while the device is unlocked");
    expect(wtt.length).toBeLessThanOrEqual(APPLE_LIMITS.whatToTestChars);
    expect(Buffer.byteLength(file(files, "apple/app-review-notes.txt"))).toBeLessThanOrEqual(APPLE_LIMITS.reviewNotesBytes);
  });

  it("warns when the Apple texts are over the limits", () => {
    const long = variant((m) => {
      for (const a of m.actions) a.description = `${a.description} ${"Detail. ".repeat(120)}`.slice(0, 1000);
    });
    const { warnings } = prepareSubmission(long, { date: DATE, platforms: ["ios"] });
    expect(warnings.map((w) => w.message).join("\n")).toMatch(/App Review notes are \d+ bytes; Apple allows 4000/);
  });

  it("lists only the AppFunctions Android exposes, with the reason for the rest", () => {
    const { files } = prepareSubmission(loadExample(), { date: DATE });
    const console = file(files, "android/connected-console.md");
    expect(console).toContain("`com.example.todoexample.omnintent.BaseTodoExampleAppFunctionService#listLists`");
    expect(console).toContain("`com.example.todoexample.omnintent.BaseTodoExampleAppFunctionService#completeItem`");
    expect(console).not.toContain("#deleteItem`");
    expect(console).toMatch(/- `delete_item`: needs confirmation, which AppFunctions cannot ask for/);
    expect(console).toMatch(/- `share_list`: needs confirmation/);
    expect(console).toContain("adb shell cmd app_function list-app-functions --package com.example.todoexample");
    expect(console).toContain("not** seen");
    // Testers are never written into the repository.
    expect(console).toContain("`<tester Google account>`");
  });

  it("never offers a payment action on Android, and says MCP refuses it without a confirmation", () => {
    const { files } = prepareSubmission(paymentManifest(), { date: DATE });
    expect(file(files, "android/connected-console.md")).toContain("- `place_order`: payment actions are never exposed on Android.");
    const listing = file(files, "mcp/connector-listing.md");
    expect(listing).toContain("| `place_order` | Place Order | no | yes | server asks; refused if the host cannot ask |");
    expect(listing).toContain("`Order.cardLast4` (sensitive)");
  });

  it("describes MCP tools with the safety table's annotations and withheld fields", () => {
    const { files, warnings } = prepareSubmission(loadExample(), { date: DATE });
    const listing = file(files, "mcp/connector-listing.md");
    expect(listing).toContain("| `list_lists` | List To-do Lists | yes | no | none |");
    expect(listing).toContain("| `delete_item` | Delete Item | no | yes | server asks, or the host confirms |");
    expect(listing).toContain("`TodoItem.notes` (never returned)");
    expect(listing).toContain("`<your deployed Worker URL>/mcp`");
    expect(listing).toContain("OAuth 2.1 is not generated yet");
    // The example's backend is localhost, which must be replaced before listing.
    expect(warnings.some((w) => w.platform === "mcp" && w.message.includes("http://localhost:8788"))).toBe(true);
  });

  it("warns about missing store identifiers", () => {
    const bare = variant((m) => {
      delete m.app.ios;
      delete m.app.android;
    });
    const messages = prepareSubmission(bare, { date: DATE }).warnings.map((w) => w.message).join("\n");
    expect(messages).toContain("app.ios.bundleId is not set");
    expect(messages).toContain("app.android.packageName is not set");
  });

  it("can prepare a single platform", () => {
    const { files } = prepareSubmission(loadExample(), { date: DATE, platforms: parseSubmitPlatforms("mcp") });
    expect(files.map((f) => f.path)).toEqual(["README.md", "mcp/connector-listing.md", "submission.json"]);
    expect(() => parseSubmitPlatforms("ios,windows")).toThrow(/windows/);
  });
});

describe("submit-prep CLI", () => {
  it("writes the drafts and prints warnings", async () => {
    const out = mkdtempSync(join(tmpdir(), "omnintent-submit-"));
    const { stdout, stderr } = await run("node", [CLI, "submit-prep", EXAMPLE_MANIFEST, "--out", out]);
    expect(stdout).toContain("Nothing was sent");
    expect(stderr).toContain("warning (mcp)");
    expect(readdirSync(out).sort()).toEqual(["README.md", "android", "apple", "mcp", "submission.json"]);
  });

  it("refuses an invalid manifest", async () => {
    const out = mkdtempSync(join(tmpdir(), "omnintent-submit-"));
    const error = await run("node", [CLI, "submit-prep", resolve(REPO, "packages/cli/test/fixtures/invalid.json"), "--out", out]).then(
      () => null,
      (e: { code: number }) => e,
    );
    expect(error?.code).toBe(1);
    expect(readdirSync(out)).toEqual([]);
  });
});

describe("App Review notes", () => {
  it("names exactly the actions that confirm", () => {
    const notes = prepareSubmission(loadExample(), { date: DATE }).files.find((f) => f.path === "apple/app-review-notes.txt")!.content;
    expect(notes).toContain("Delete Item, Share List ask for confirmation before they run.");
  });
});
