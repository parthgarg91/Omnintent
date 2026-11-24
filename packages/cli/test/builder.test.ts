import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { readmeChecklist } from "../src/builder/checklist.js";
import { buildRequestBody, callStructured, FALLBACK_BETA } from "../src/builder/claude.js";
import { parseBuilderConfig, type BuilderConfig } from "../src/builder/config.js";
import { diffManifests, formatChanges } from "../src/builder/diff.js";
import { GitHubRest, type CommitFile, type GitHost, type PullRequestInfo } from "../src/builder/github.js";
import { branchName, runBuilder } from "../src/builder/index.js";
import { checkProposal, collectSources, requiredNames, WIRING_SCHEMA, type WiringProposal } from "../src/builder/wire.js";
import { ANTHROPIC_VERSION, DEFAULT_MODEL } from "../src/discover/ai.js";
import { generate, GENERATORS } from "../src/generators/index.js";
import type { Manifest } from "../src/manifest.js";
import { GENERATED_DIR, REPO, loadExample, variant } from "./helpers.js";

const run = promisify(execFile);
const CLI = resolve(REPO, "packages/cli/dist/cli.js");

const CONFIG: BuilderConfig = parseBuilderConfig({
  repo: "acme/todo",
  baseBranch: "main",
  platforms: {
    swift: { generatedDir: "ios/OmnintentGenerated", sourceDirs: ["ios/App"], handlersFile: "ios/App/AppOmnintentHandlers.swift" },
    kotlin: { generatedDir: "android/omnintent", sourceDirs: ["android/app/src/main/kotlin"] },
    mcp: { generatedDir: "mcp-server", sourceDirs: ["server"] },
  },
});

/** A tiny app repository: an iOS app, an Android app and a Node backend. */
function appRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "omnintent-builder-"));
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  put("omnintent.json", `${JSON.stringify(loadExample(), null, 2)}\n`);
  put("omnintent.builder.json", JSON.stringify({ repo: "acme/todo", platforms: { swift: { generatedDir: "ios/OmnintentGenerated", sourceDirs: ["ios/App"] }, mcp: { generatedDir: "mcp-server", sourceDirs: ["server"] } } }));
  put("ios/App/TodoApp.swift", "import SwiftUI\n@main struct TodoApp: App { var body: some Scene { WindowGroup { Text(\"Hi\") } } }\n");
  put("ios/App/TodoStore.swift", "final class TodoStore { func lists() async throws -> [String] { [] } }\n");
  put("ios/App/.env.swift", "let key = \"secret\"\n");
  put("android/app/src/main/kotlin/com/example/todoexample/TodoRepository.kt", "class TodoRepository { suspend fun lists(): List<String> = emptyList() }\n");
  put("server/server.mjs", readFileSync(join(REPO, "examples/todo/mock-backend/server.mjs"), "utf8"));
  put("server/node_modules/dep/index.js", "module.exports = 1;\n");
  return root;
}

// ---------------------------------------------------------------- fakes

interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** SSE text for a message whose final text block is `text`. */
function sse(text: string, opts: { stopReason?: string; fallbackFirst?: boolean; chunk?: number } = {}): string {
  const events: [string, object][] = [["message_start", { type: "message_start", message: { model: DEFAULT_MODEL, usage: { input_tokens: 10 } } }]];
  let index = 0;
  events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } }]);
  events.push(["content_block_stop", { type: "content_block_stop", index: index++ }]);
  if (opts.fallbackFirst) {
    events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
    events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: "{\"partial" } }]);
    events.push(["content_block_stop", { type: "content_block_stop", index: index++ }]);
    events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "fallback", from: { model: DEFAULT_MODEL }, to: { model: "claude-opus-5" } } }]);
    events.push(["content_block_stop", { type: "content_block_stop", index: index++ }]);
  }
  events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
  const size = opts.chunk ?? 40;
  for (let i = 0; i < text.length; i += size) {
    events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: text.slice(i, i + size) } }]);
  }
  events.push(["content_block_stop", { type: "content_block_stop", index }]);
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: opts.stopReason ?? "end_turn" }, usage: { output_tokens: 99 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
}

/** A Response whose body arrives in small, awkwardly split chunks. */
function streamResponse(text: string, split = 7): Response {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.slice(i, i + split));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
}

/** A fake Messages API. `respond` gets the parsed request and returns the proposal (or raw text). */
function fakeClaude(respond: (req: { body: any; prompt: string; turn: number }) => WiringProposal | string) {
  const sent: SentRequest[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    sent.push({ url: String(url), headers: headersOf(init), body });
    const result = respond({ body, prompt: body.messages[0].content, turn: body.messages.length });
    return streamResponse(sse(typeof result === "string" ? result : JSON.stringify(result)));
  }) as typeof fetch;
  return { fetchImpl, sent };
}

/** A well-formed proposal for whatever platform the prompt asks about. */
function goodProposal(prompt: string): WiringProposal {
  const folder = /Allowed source folders: ([^\n,]+)/.exec(prompt)![1];
  const names = /Required names for coverage: ([^\n]*)/.exec(prompt)![1].split(", ").filter(Boolean);
  const coverage = names.map((name) => ({ name, status: "implemented" as const, note: "" }));
  if (folder === "server") {
    return { summary: "All routes already exist.", files: [], coverage: names.map((name) => ({ name, status: "already_present" as const, note: "server.mjs" })), todos: [] };
  }
  const swift = folder.startsWith("ios");
  const methods = names.map((n) => (swift ? `    func ${n}() async throws {}` : `    override suspend fun ${n}() {}`)).join("\n");
  const content = swift ? `struct AppOmnintentHandlers: OmnintentHandlers {\n${methods}\n}\n` : `class AppOmnintentHandlers : OmnintentHandlers {\n${methods}\n}\n`;
  coverage[0] = { ...coverage[0], status: "implemented" };
  return {
    summary: "Implemented the handlers with the store.",
    files: [{ path: `${folder}/AppOmnintentHandlers.${swift ? "swift" : "kt"}`, content, reason: "Implements OmnintentHandlers." }],
    coverage,
    todos: ["Check that TodoStore.lists() returns lists in display order."],
  };
}

class FakeGit implements GitHost {
  branches = new Map<string, { base: string; message: string; files: CommitFile[] }>();
  prs: { branch: string; base: string; title: string; body: string; draft: boolean; number: number; open: boolean }[] = [];
  calls: string[] = [];

  async branchSha(branch: string) {
    this.calls.push(`branchSha ${branch}`);
    return branch === "main" || this.branches.has(branch) ? `sha-${branch}` : null;
  }
  async commitToNewBranch(input: { branch: string; base: string; message: string; files: CommitFile[] }) {
    this.calls.push(`commit ${input.branch}`);
    if (!input.branch.startsWith("omnintent/build/")) throw new Error("wrong prefix");
    this.branches.set(input.branch, input);
    return "new-sha";
  }
  async findOpenPullRequest(branch: string): Promise<PullRequestInfo | null> {
    const pr = this.prs.find((p) => p.branch === branch && p.open);
    return pr ? { number: pr.number, url: `https://github.com/acme/todo/pull/${pr.number}` } : null;
  }
  async openPullRequest(input: { branch: string; base: string; title: string; body: string; draft: boolean }) {
    this.calls.push(`pr ${input.branch}`);
    const number = this.prs.length + 1;
    this.prs.push({ ...input, number, open: true });
    return { number, url: `https://github.com/acme/todo/pull/${number}` };
  }
}

const generatedFor = (target: "swift" | "kotlin" | "mcp", m: Manifest = loadExample()) => GENERATORS[target](m);

// ---------------------------------------------------------------- tests

describe("builder config", () => {
  it("fills defaults", () => {
    expect(CONFIG).toMatchObject({ baseBranch: "main", manifest: "omnintent.json", branchPrefix: "omnintent/build", draft: true });
  });

  it.each([
    [{ repo: "nope", platforms: { swift: { generatedDir: "g", sourceDirs: ["s"] } } }, /owner\/name/],
    [{ repo: "a/b", platforms: { swift: { generatedDir: "../g", sourceDirs: ["s"] } } }, /inside the repository/],
    [{ repo: "a/b", platforms: { swift: { generatedDir: "/abs", sourceDirs: ["s"] } } }, /inside the repository/],
    [{ repo: "a/b", platforms: { swift: { generatedDir: "g", sourceDirs: ["g/app"] } } }, /must not be inside generatedDir/],
    [{ repo: "a/b", platforms: { swift: { generatedDir: "g", sourceDirs: [] } } }, /at least one folder/],
    [{ repo: "a/b", platforms: { web: { generatedDir: "g", sourceDirs: ["s"] } } }, /unknown platform/],
    [{ repo: "a/b", baseBranch: "omnintent/build/x", platforms: { swift: { generatedDir: "g", sourceDirs: ["s"] } } }, /baseBranch/],
    [{ repo: "a/b", platforms: {} }, /at least one platform/],
  ])("rejects %j", (raw, message) => {
    expect(() => parseBuilderConfig(raw)).toThrow(message);
  });
});

describe("manifest diff", () => {
  it("names added, changed and removed actions and entities", () => {
    const before = loadExample();
    const after = variant((m) => {
      m.actions = m.actions.filter((a) => a.name !== "share_list");
      m.actions[0].description = "Lists every to-do list with its ID, name and number of open items.";
      m.actions.push({ ...structuredClone(m.actions[1]), name: "rename_item", title: "Rename Item" });
    });
    const c = diffManifests(before, after);
    expect(c).toMatchObject({ initial: false, addedActions: ["rename_item"], changedActions: ["list_lists"], removedActions: ["share_list"] });
    expect(formatChanges(c)).toContain("Actions removed: `share_list`");
    expect(diffManifests(undefined, after).initial).toBe(true);
    expect(diffManifests(before, structuredClone(before)).addedActions).toEqual([]);
  });
});

describe("checklist from generated READMEs", () => {
  it("turns Wire it up and Before you ship into tasks, without code blocks", () => {
    const readme = readFileSync(join(GENERATED_DIR, "swift/README.md"), "utf8");
    const list = readmeChecklist(readme);
    expect(list[0]).toBe("- [ ] Add the `OmnintentGenerated` folder to your app target.");
    expect(list.some((l) => l.startsWith("- [ ] Register the handlers once at launch"))).toBe(true);
    expect(list.some((l) => l.includes("App Shortcuts unavailable to Siri"))).toBe(true);
    expect(list.join("\n")).not.toContain("```");
    expect(list.join("\n")).not.toContain("@main");
  });
});

describe("Claude client (fake Messages API)", () => {
  it("streams one structured-output request with the current request shape", async () => {
    const { fetchImpl, sent } = fakeClaude(() => "{\"ok\":true}");
    const result = await callStructured({ system: "sys", messages: [{ role: "user", content: "hi" }], schema: WIRING_SCHEMA }, { apiKey: "k", fetchImpl });
    expect(result.text).toBe("{\"ok\":true}");
    const [req] = sent;
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.headers).toMatchObject({ "x-api-key": "k", "anthropic-version": ANTHROPIC_VERSION, "anthropic-beta": FALLBACK_BETA });
    expect(req.body).toMatchObject({
      model: "claude-opus-5-5",
      stream: true,
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema", schema: WIRING_SCHEMA } },
      fallbacks: "default",
    });
    expect(req.body).not.toHaveProperty("temperature");
    expect(req.body).not.toHaveProperty("tools");
    expect(req.body).not.toHaveProperty("tool_choice");
  });

  it("can turn server-side fallbacks off (for platforms without them)", () => {
    const body = buildRequestBody({ system: "s", messages: [], schema: {} }, { apiKey: "k", fallbacks: false });
    expect(body).not.toHaveProperty("fallbacks");
  });

  it("keeps only the text after a fallback block", async () => {
    const fetchImpl = (async () => streamResponse(sse("{\"final\":1}", { fallbackFirst: true }))) as unknown as typeof fetch;
    const result = await callStructured({ system: "s", messages: [], schema: {} }, { apiKey: "k", fetchImpl });
    expect(result.text).toBe("{\"final\":1}");
  });

  it("throws on refusals, token limits, stream errors and HTTP errors", async () => {
    const respond = (text: string) => (async () => streamResponse(text)) as unknown as typeof fetch;
    const req = { system: "s", messages: [], schema: {} };
    await expect(callStructured(req, { apiKey: "k", fetchImpl: respond(sse("", { stopReason: "refusal" })) })).rejects.toThrow(/declined/);
    await expect(callStructured(req, { apiKey: "k", fetchImpl: respond(sse("{", { stopReason: "max_tokens" })) })).rejects.toThrow(/output tokens/);
    await expect(
      callStructured(req, { apiKey: "k", fetchImpl: respond(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } })}\n\n`) }),
    ).rejects.toThrow(/overloaded_error: busy/);
    const http = (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch;
    await expect(callStructured(req, { apiKey: "k", fetchImpl: http })).rejects.toThrow(/401: bad key/);
  });
});

describe("wiring checks", () => {
  const swift = CONFIG.platforms.swift!;
  const names = requiredNames("swift", loadExample(), generatedFor("swift"));

  it("reads the required handler methods from the generated interfaces", () => {
    expect(names).toEqual([
      "listLists", "addItem", "listItems", "completeItem", "deleteItem", "shareList",
      "todoListEntities", "allTodoListEntities", "todoItemEntities", "allTodoItemEntities",
    ]);
    // Kotlin leaves out the destructive and confirm-required actions by default.
    expect(requiredNames("kotlin", loadExample(), generatedFor("kotlin"))).toEqual(["listLists", "addItem", "listItems", "completeItem"]);
    expect(requiredNames("mcp", loadExample(), generatedFor("mcp"))).toHaveLength(6);
  });

  it("accepts a proposal that covers every method inside the source folder", () => {
    const prompt = `Allowed source folders: ios/App\nRequired names for coverage: ${names.join(", ")}`;
    expect(checkProposal("swift", goodProposal(prompt), swift, names)).toEqual([]);
  });

  it.each([
    ["../outside.swift", /inside the repository/],
    ["ios/Other/X.swift", /outside the allowed source folders/],
    ["ios/OmnintentGenerated/OmnintentRuntime.swift", /outside the allowed source folders|generated files/],
    ["ios/App/.github/workflows/x.swift", /may not be changed/],
    ["ios/App/.env.swift", /may not be changed/],
    ["ios/App/Handlers.kt", /extension not allowed/],
  ])("rejects a file at %s", (path, message) => {
    const p = goodProposal(`Allowed source folders: ios/App\nRequired names for coverage: ${names.join(", ")}`);
    p.files[0].path = path;
    expect(checkProposal("swift", p, swift, names).join("\n")).toMatch(message);
  });

  it("rejects missing coverage, missing methods, unexplained stubs and too many files", () => {
    const p = goodProposal(`Allowed source folders: ios/App\nRequired names for coverage: ${names.join(", ")}`);
    p.coverage = p.coverage.slice(1);
    p.files[0].content = p.files[0].content.replace("func shareList", "func shareLists");
    expect(checkProposal("swift", p, swift, names).join("\n")).toMatch(/coverage is missing: listLists[\s\S]*methods missing from the files: shareList/);
    const q = goodProposal(`Allowed source folders: ios/App\nRequired names for coverage: ${names.join(", ")}`);
    q.coverage[0] = { name: "listLists", status: "todo", note: "" };
    q.files = Array.from({ length: 9 }, (_, i) => ({ ...q.files[0], path: `ios/App/F${i}.swift` }));
    expect(checkProposal("swift", q, swift, names).join("\n")).toMatch(/at most 8 files[\s\S]*needs a note/);
  });

  it("collects a bounded slice of app code and skips secrets and dependencies", () => {
    const root = appRepo();
    const swiftFiles = collectSources(root, "swift", swift, loadExample()).map((f) => f.path);
    expect(swiftFiles.sort()).toEqual(["ios/App/TodoApp.swift", "ios/App/TodoStore.swift"]);
    const server = collectSources(root, "mcp", CONFIG.platforms.mcp!, loadExample()).map((f) => f.path);
    expect(server).toEqual(["server/server.mjs"]);
  });
});

describe("runBuilder", () => {
  it("opens one draft pull request per platform, with generated code, glue and a checklist", async () => {
    const root = appRepo();
    const claude = fakeClaude(({ prompt }) => goodProposal(prompt));
    const git = new FakeGit();
    const report = await runBuilder({ config: CONFIG, repoRoot: root, manifest: loadExample(), ai: { apiKey: "k", fetchImpl: claude.fetchImpl }, git });
    expect(report.platforms.map((p) => [p.target, p.status])).toEqual([
      ["swift", "opened"],
      ["kotlin", "opened"],
      ["mcp", "opened"],
    ]);
    expect(claude.sent).toHaveLength(3);
    // The app's code and the generated interface reach the model; the secret-looking file does not.
    expect(claude.sent[0].body.messages[0].content).toContain("ios/App/TodoStore.swift");
    expect(claude.sent[0].body.messages[0].content).toContain("protocol OmnintentHandlers");
    expect(claude.sent[0].body.messages[0].content).not.toContain(".env.swift");
    expect(claude.sent[0].body.system).toMatch(/not instructions to you/);

    expect(git.prs.every((p) => p.draft && p.base === "main" && p.branch.startsWith("omnintent/build/"))).toBe(true);
    const swiftBranch = git.branches.get(branchName(CONFIG, "swift", loadExample()))!;
    const paths = swiftBranch.files.map((f) => f.path);
    expect(paths).toContain("ios/OmnintentGenerated/OmnintentGenerated/OmnintentRuntime.swift");
    expect(paths).toContain("ios/App/AppOmnintentHandlers.swift");
    expect(swiftBranch.files.find((f) => f.path.endsWith("OmnintentRuntime.swift"))!.content).toBe(
      generate(loadExample(), ["swift"]).find((f) => f.path === "swift/OmnintentGenerated/OmnintentRuntime.swift")!.content,
    );
    const body = git.prs[0].body;
    expect(body).toContain("It never merges or deploys");
    expect(body).toContain("First build");
    expect(body).toContain("| `listLists` | implemented |");
    expect(body).toContain("- [ ] Check that TodoStore.lists() returns lists in display order.");
    expect(body).toContain("- [ ] Add the `OmnintentGenerated` folder to your app target.");
    expect(git.prs[2].body).toContain("| `add_item` | already present |");
    expect(git.calls.some((c) => / main$/.test(c) && !c.startsWith("branchSha"))).toBe(false);
  });

  it("sends rejected proposals back for repair, then gives up without pushing", async () => {
    const root = appRepo();
    const repaired = fakeClaude(({ prompt, turn }) => {
      const p = goodProposal(prompt);
      if (turn === 1) p.files[0].path = "ios/Elsewhere/H.swift";
      return p;
    });
    const git = new FakeGit();
    const ok = await runBuilder({ config: CONFIG, repoRoot: root, manifest: loadExample(), platforms: ["swift"], ai: { apiKey: "k", fetchImpl: repaired.fetchImpl }, git });
    expect(ok.platforms[0]).toMatchObject({ status: "opened", wiring: { attempts: 2 } });
    expect(repaired.sent[1].body.messages.at(-1).content).toMatch(/outside the allowed source folders/);

    const stubborn = fakeClaude(() => "not json");
    const git2 = new FakeGit();
    const bad = await runBuilder({ config: CONFIG, repoRoot: root, manifest: loadExample(), platforms: ["swift"], ai: { apiKey: "k", fetchImpl: stubborn.fetchImpl, maxRepairs: 1 }, git: git2 });
    expect(bad.platforms[0].status).toBe("failed");
    expect(bad.platforms[0].message).toMatch(/nothing was pushed/);
    expect(stubborn.sent).toHaveLength(2);
    expect(git2.branches.size).toBe(0);
    expect(git2.prs).toHaveLength(0);
  });

  it("does not rebuild a manifest it already built, and does not reopen a closed pull request", async () => {
    const root = appRepo();
    const git = new FakeGit();
    await runBuilder({ config: CONFIG, repoRoot: root, manifest: loadExample(), platforms: ["mcp"], git });
    const again = await runBuilder({ config: CONFIG, repoRoot: root, manifest: loadExample(), platforms: ["mcp"], git });
    expect(again.platforms[0]).toMatchObject({ status: "exists", pullRequest: { number: 1 } });
    git.prs[0].open = false;
    const closed = await runBuilder({ config: CONFIG, repoRoot: root, manifest: loadExample(), platforms: ["mcp"], git });
    expect(closed.platforms[0].status).toBe("exists");
    expect(closed.platforms[0].message).toMatch(/was closed/);
    expect(git.prs).toHaveLength(1);
  });

  it("skips platforms whose generated code is already current, and unchanged manifests", async () => {
    const root = appRepo();
    for (const f of generatedFor("mcp")) {
      mkdirSync(dirname(join(root, "mcp-server", f.path)), { recursive: true });
      writeFileSync(join(root, "mcp-server", f.path), f.content);
    }
    const git = new FakeGit();
    const report = await runBuilder({ config: CONFIG, repoRoot: root, manifest: loadExample(), platforms: ["mcp"], git });
    expect(report.platforms[0].status).toBe("up-to-date");
    const none = await runBuilder({ config: CONFIG, repoRoot: root, manifest: loadExample(), previousManifest: loadExample(), git });
    expect(none.platforms).toEqual([]);
    expect(git.calls.filter((c) => !c.startsWith("branchSha"))).toEqual([]);
  });

  it("removes generated files for removed actions, and writes a dry run without AI", async () => {
    const root = appRepo();
    for (const f of generatedFor("swift")) {
      mkdirSync(dirname(join(root, "ios/OmnintentGenerated", f.path)), { recursive: true });
      writeFileSync(join(root, "ios/OmnintentGenerated", f.path), f.content);
    }
    const next = variant((m) => {
      m.actions = m.actions.filter((a) => a.name !== "share_list");
    });
    const out = mkdtempSync(join(tmpdir(), "omnintent-dry-"));
    const report = await runBuilder({ config: CONFIG, repoRoot: root, manifest: next, previousManifest: loadExample(), platforms: ["swift"], dryRunDir: out });
    expect(report.platforms[0]).toMatchObject({ status: "planned", deletedFiles: ["ios/OmnintentGenerated/OmnintentGenerated/Intents/ShareListIntent.swift"] });
    const pr = readFileSync(join(out, "swift/PR.md"), "utf8");
    expect(pr).toContain("Actions removed: `share_list`");
    expect(pr).toContain("Implement these `OmnintentHandlers` methods yourself");
    expect(pr).toContain("1 stale file(s) removed");
    expect(existsSync(join(out, "swift/files/ios/OmnintentGenerated/OmnintentGenerated/OmnintentRuntime.swift"))).toBe(true);
  });

  it("refuses an invalid manifest", async () => {
    const bad = variant((m) => {
      m.actions[0].name = "Bad Name";
    });
    await expect(runBuilder({ config: CONFIG, repoRoot: appRepo(), manifest: bad, dryRunDir: tmpdir() })).rejects.toThrow(/not valid/);
  });
});

describe("GitHub client (fake REST API)", () => {
  function fakeGitHub() {
    const calls: { method: string; path: string; body?: any }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const path = String(url).replace("https://api.github.com/repos/acme/todo", "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
      if (method === "GET" && path === "/git/ref/heads/main") return json({ object: { sha: "base-sha" } });
      if (method === "GET" && path.startsWith("/git/ref/heads/")) return json({ message: "Not Found" }, 404);
      if (method === "GET" && path === "/git/commits/base-sha") return json({ tree: { sha: "base-tree" } });
      if (method === "POST" && path === "/git/trees") return json({ sha: "new-tree" }, 201);
      if (method === "POST" && path === "/git/commits") return json({ sha: "new-commit" }, 201);
      if (method === "POST" && path === "/git/refs") return json({ ref: body.ref }, 201);
      if (method === "POST" && path === "/pulls") return json({ number: 7, html_url: "https://github.com/acme/todo/pull/7" }, 201);
      if (method === "GET" && path.startsWith("/pulls?")) return json([]);
      return json({ message: "unexpected" }, 500);
    }) as typeof fetch;
    return { calls, client: new GitHubRest({ repo: "acme/todo", token: "t", branchPrefix: "omnintent/build", fetchImpl }) };
  }

  it("commits to a new prefixed branch and opens a draft pull request", async () => {
    const { calls, client } = fakeGitHub();
    await client.commitToNewBranch({
      branch: "omnintent/build/swift-abc",
      base: "main",
      message: "m",
      files: [
        { path: "a.swift", content: "x" },
        { path: "old.swift", content: null },
      ],
    });
    const pr = await client.openPullRequest({ branch: "omnintent/build/swift-abc", base: "main", title: "t", body: "b", draft: true });
    expect(pr).toEqual({ number: 7, url: "https://github.com/acme/todo/pull/7" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /git/ref/heads/omnintent/build/swift-abc",
      "GET /git/ref/heads/main",
      "GET /git/commits/base-sha",
      "POST /git/trees",
      "POST /git/commits",
      "POST /git/refs",
      "POST /pulls",
    ]);
    expect(calls[3].body).toEqual({
      base_tree: "base-tree",
      tree: [
        { path: "a.swift", mode: "100644", type: "blob", content: "x" },
        { path: "old.swift", mode: "100644", type: "blob", sha: null },
      ],
    });
    expect(calls[4].body).toEqual({ message: "m", tree: "new-tree", parents: ["base-sha"] });
    expect(calls[5].body).toEqual({ ref: "refs/heads/omnintent/build/swift-abc", sha: "new-commit" });
    expect(calls[6].body).toMatchObject({ head: "omnintent/build/swift-abc", base: "main", draft: true });
  });

  it("refuses to write outside its branch prefix and has no way to merge", async () => {
    const { calls, client } = fakeGitHub();
    await expect(client.commitToNewBranch({ branch: "main", base: "main", message: "m", files: [] })).rejects.toThrow(/refusing/);
    await expect(client.openPullRequest({ branch: "feature/x", base: "main", title: "t", body: "b", draft: true })).rejects.toThrow(/refusing/);
    expect(calls).toEqual([]);
    const methods = Object.getOwnPropertyNames(GitHubRest.prototype).join(" ");
    expect(methods).not.toMatch(/merge|deploy|approve|dispatch|delete/i);
  });
});

describe("omnintent build (CLI)", () => {
  it("writes a dry run without keys, and refuses to touch GitHub without a token", async () => {
    const root = appRepo();
    const env = { ...process.env, ANTHROPIC_API_KEY: "", GITHUB_TOKEN: "", GH_TOKEN: "" };
    delete (env as Record<string, string | undefined>).ANTHROPIC_API_KEY;
    delete (env as Record<string, string | undefined>).GITHUB_TOKEN;
    delete (env as Record<string, string | undefined>).GH_TOKEN;
    const out = join(root, "plan");
    const { stdout, stderr } = await run("node", [CLI, "build", "--config", join(root, "omnintent.builder.json"), "--dry-run", out], { env });
    expect(stderr).toMatch(/ANTHROPIC_API_KEY is not set/);
    expect(stdout).toMatch(/swift: planned/);
    expect(stdout).toMatch(/mcp: planned/);
    expect(existsSync(join(out, "mcp/PR.md"))).toBe(true);
    await expect(run("node", [CLI, "build", "--config", join(root, "omnintent.builder.json")], { env })).rejects.toMatchObject({
      stderr: expect.stringMatching(/GITHUB_TOKEN is not set/),
    });
  });
});
