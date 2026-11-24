import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANTHROPIC_VERSION, DEFAULT_MODEL, PROPOSAL_SCHEMA, draftWithAi, type Proposal } from "../src/discover/ai.js";
import { discover } from "../src/discover/index.js";
import { draftFromOpenApi, loadOpenApi } from "../src/discover/openapi.js";
import { generate } from "../src/generators/index.js";
import { toolDefinition } from "../src/generators/mcp.js";
import { validateManifest } from "../src/validate.js";
import { EXAMPLE_DIR, REPO, loadExample } from "./helpers.js";

const OPENAPI = join(EXAMPLE_DIR, "openapi.yaml");
const proposal = () => JSON.parse(readFileSync(resolve(REPO, "packages/cli/test/fixtures/proposal.json"), "utf8")) as Proposal;
const run = promisify(execFile);
const CLI = resolve(REPO, "packages/cli/dist/cli.js");

describe("discover from OpenAPI (deterministic)", () => {
  const { manifest, notes } = draftFromOpenApi(loadOpenApi(OPENAPI));

  it("drafts a valid manifest", () => {
    const result = validateManifest(manifest);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(notes.join(" ")).toMatch(/Sample utterances were templated/);
  });

  it("names actions from operationIds and derives safety from HTTP methods", () => {
    const summary = Object.fromEntries(manifest.actions.map((a) => [a.name, a.safety]));
    expect(summary).toEqual({
      list_lists: "read",
      list_items: "read",
      add_item: "write",
      complete_item: "write",
      delete_item: "destructive",
      share_list: "write",
    });
    expect(manifest.actions.find((a) => a.name === "delete_item")!.confirmation!.prompt).toMatch(/cannot be undone/);
  });

  it("turns parameters, bodies and responses into schemas, entities and backend mappings", () => {
    expect(Object.keys(manifest.entities!)).toEqual(["TodoList", "TodoItem"]);
    expect(manifest.backend).toEqual({ baseUrl: "http://localhost:8788", auth: { type: "bearer", secret: "BACKEND_TOKEN" } });
    const add = manifest.actions.find((a) => a.name === "add_item")!;
    expect(add.inputSchema.required).toEqual(["listId", "title"]);
    expect(add.inputSchema.properties!.listId["x-omnintent-entity"]).toBe("TodoList");
    expect(add.outputSchema).toEqual({ $ref: "#/entities/TodoItem" });
    const share = manifest.actions.find((a) => a.name === "share_list")!;
    expect(share.outputSchema).toMatchObject({ type: "object", required: ["shareUrl", "sharedWith"] });
    expect(manifest.actions.find((a) => a.name === "list_lists")!.title).toBe("List To-do Lists");
  });

  it("maps every action to the same backend call as the hand-written example", () => {
    const example = loadExample();
    for (const action of example.actions) {
      const drafted = manifest.actions.find((a) => a.name === action.name)!;
      expect(toolDefinition(manifest, drafted).backend).toEqual(toolDefinition(example, action).backend);
    }
  });

  it("generates all three targets from the draft", () => {
    expect(generate(manifest, ["swift", "kotlin", "mcp"]).length).toBeGreaterThan(20);
  });
});

describe("discover from a codebase", () => {
  const dir = mkdtempSync(join(tmpdir(), "omnintent-code-"));
  writeFileSync(join(dir, "server.js"), 'app.get("/lists", (req, res) => res.json(lists));\napp.post("/lists/:id/items", add);\n');

  it("needs an OpenAPI file or an API key", async () => {
    await expect(discover(dir, {})).rejects.toThrow(/No OpenAPI file was found/);
  });

  it("uses an OpenAPI file found in the tree", async () => {
    mkdirSync(join(dir, "api"));
    writeFileSync(join(dir, "api/openapi.yaml"), readFileSync(OPENAPI));
    const result = await discover(dir, {});
    expect(result.mode).toBe("openapi");
    expect(result.manifest.actions).toHaveLength(6);
  });
});

function fakeAnthropic(responses: unknown[]) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify({ type: "message", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(next) }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const BASE = { slug: "todo-example", baseUrl: "http://localhost:8788", auth: { type: "bearer", secret: "BACKEND_TOKEN" } } as const;

describe("discover with Claude (AI path, fake API)", () => {
  it("uses a closed JSON Schema for structured output", () => {
    const open: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== "object") return;
      const n = node as Record<string, unknown>;
      if (n.type === "object") {
        if (n.additionalProperties !== false) open.push(path);
        expect(new Set(n.required as string[])).toEqual(new Set(Object.keys(n.properties as object)));
      }
      for (const [k, v] of Object.entries(n)) walk(v, `${path}/${k}`);
    };
    walk(PROPOSAL_SCHEMA, "");
    expect(open).toEqual([]);
  });

  it("sends a Messages API request and returns a validated manifest", async () => {
    const { fetchImpl, calls } = fakeAnthropic([proposal()]);
    const result = await draftWithAi("context", undefined, BASE, { apiKey: "sk-test", fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].headers).toMatchObject({ "x-api-key": "sk-test", "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" });
    expect(calls[0].body).toMatchObject({ model: DEFAULT_MODEL, output_config: { format: { type: "json_schema" } } });
    expect(DEFAULT_MODEL).toBe("claude-opus-5-5");
    expect(validateManifest(result.manifest).ok).toBe(true);
    const list = result.manifest.actions.find((a) => a.name === "list_items")!;
    expect(list.examples[1].arguments).toEqual({ listId: "work", status: "done", limit: 5 });
    expect(list.backend).toEqual({ method: "GET", path: "/lists/{listId}/items", query: ["status", "limit"] });
    expect(result.manifest.entities!.TodoItem.properties.notes.visibility).toBe("internal");
  });

  it("sends validation errors back to the model and accepts the repaired proposal", async () => {
    const broken = proposal();
    broken.actions[2].confirmationPrompt = "";
    broken.actions[0].name = "addItem";
    const { fetchImpl, calls } = fakeAnthropic([broken, proposal()]);
    const result = await draftWithAi("context", undefined, BASE, { apiKey: "sk-test", fetchImpl });
    expect(result.attempts).toBe(2);
    const repair = (calls[1].body.messages as { role: string; content: string }[]).at(-1)!;
    expect(repair.role).toBe("user");
    expect(repair.content).toMatch(/snake_case/);
    expect(repair.content).toMatch(/confirmation\.prompt/);
  });

  it("gives up rather than return an invalid manifest", async () => {
    const broken = proposal();
    broken.actions[0].name = "addItem";
    const { fetchImpl, calls } = fakeAnthropic([broken]);
    await expect(draftWithAi("context", undefined, BASE, { apiKey: "sk-test", fetchImpl, maxRepairs: 2 })).rejects.toThrow(/still invalid after 2 repair rounds/);
    expect(calls).toHaveLength(3);
  });

  it("passes the deterministic draft as context when discovering from OpenAPI", async () => {
    const { fetchImpl, calls } = fakeAnthropic([proposal()]);
    const result = await discover(OPENAPI, { apiKey: "sk-test", fetchImpl });
    expect(result.mode).toBe("ai");
    const prompt = (calls[0].body.messages as { content: string }[])[0].content;
    expect(prompt).toContain("<mechanical_draft>");
    expect(prompt).toContain("operationId=addItem");
    expect(result.manifest.backend!.baseUrl).toBe("http://localhost:8788");
  });
});

describe("discover CLI never writes an invalid manifest", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    const broken = proposal();
    broken.actions[0].name = "addItem";
    server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(broken) }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());

  it("exits 1 and leaves no file when the AI draft stays invalid", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "omnintent-out-")), "omnintent.json");
    const env = { ...process.env, ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" };
    const error = await run("node", [CLI, "discover", OPENAPI, "--out", out], { env }).then(
      () => undefined,
      (e: { code: number; stderr: string }) => e,
    );
    expect(error?.code).toBe(1);
    expect(error?.stderr).toMatch(/still invalid/);
    expect(existsSync(out)).toBe(false);
  });

  it("writes a valid manifest on the deterministic path", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "omnintent-out-")), "omnintent.json");
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const { stdout } = await run("node", [CLI, "discover", OPENAPI, "--out", out], { env });
    expect(stdout).toMatch(/openapi draft, 6 actions/);
    expect(validateManifest(JSON.parse(readFileSync(out, "utf8"))).ok).toBe(true);
  });
});
