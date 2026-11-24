// End-to-end: run the generated MCP server (Node adapter and wrangler dev),
// start the example's mock backend, connect with the official MCP client and
// check that tool calls change backend state as the manifest says.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateMcp } from "../src/generators/mcp.js";
import { writeFiles } from "../src/generators/index.js";
import { EXAMPLE_DIR, GENERATED_DIR, REPO, paymentManifest } from "./helpers.js";

const MCP_DIR = join(GENERATED_DIR, "mcp");
const WRANGLER = resolve(REPO, "node_modules/.bin/wrangler");
const BACKEND_TOKEN = "test-backend-token";
const MCP_TOKEN = "test-mcp-token";
const procs: ChildProcess[] = [];

function start(cmd: string, args: string[], opts: { cwd: string; env: Record<string, string>; ready: RegExp }): Promise<{ proc: ChildProcess; match: RegExpMatchArray }> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(proc);
    let output = "";
    const timer = setTimeout(() => reject(new Error(`${cmd} did not start:\n${output}`)), 90_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      // Strip ANSI colour codes that wrangler prints.
      const match = output.replace(/\u001b\[[0-9;]*m/g, "").match(opts.ready);
      if (match) {
        clearTimeout(timer);
        resolvePromise({ proc, match });
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} exited with ${code}:\n${output}`));
    });
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  await new Promise((r) => server.close(r));
  return port;
}

afterAll(() => {
  for (const p of procs) p.kill("SIGTERM");
});

interface ClientOptions {
  era?: "modern" | "legacy";
  elicit?: "accept" | "decline" | false;
  prompts?: string[];
}

async function connect(url: string, opts: ClientOptions = {}): Promise<Client> {
  const era = opts.era ?? "modern";
  const client = new Client(
    { name: "omnintent-e2e", version: "0.1.0" },
    {
      capabilities: opts.elicit ? { elicitation: { form: {} } } : {},
      ...(era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {}),
    },
  );
  if (opts.elicit) {
    const answer = opts.elicit;
    client.setRequestHandler("elicitation/create", async (request) => {
      opts.prompts?.push(String(request.params.message));
      return answer === "accept" ? { action: "accept", content: { confirm: true } } : { action: "decline" };
    });
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } }));
  return client;
}

type Item = { id: string; listId: string; title: string; done: boolean; notes?: string };

const runtimes = [
  { name: "node adapter", available: true },
  { name: "wrangler dev (workerd)", available: existsSync(WRANGLER) && process.env.OMNINTENT_SKIP_WRANGLER !== "1" },
];

for (const runtime of runtimes) {
  describe.runIf(runtime.available)(`generated MCP server end to end: ${runtime.name}`, () => {
    let backend = "";
    let mcpUrl = "";

    const state = async () => (await (await fetch(`${backend}/__state`)).json()) as { items: Item[]; shares: unknown[] };

    beforeAll(async () => {
      const mock = await start("node", [join(EXAMPLE_DIR, "mock-backend/server.mjs")], {
        cwd: EXAMPLE_DIR,
        env: { PORT: "0", MOCK_BACKEND_TOKEN: BACKEND_TOKEN },
        ready: /listening on (http:\/\/127\.0\.0\.1:\d+)/,
      });
      backend = mock.match[1];
      const vars = { BACKEND_BASE_URL: backend, BACKEND_TOKEN, MCP_ACCESS_TOKEN: MCP_TOKEN };
      if (runtime.name === "node adapter") {
        const server = await start("node", ["scripts/serve-node.mjs"], {
          cwd: MCP_DIR,
          env: { ...vars, PORT: "0" },
          ready: /listening on (http:\/\/127\.0\.0\.1:\d+\/mcp)/,
        });
        mcpUrl = server.match[1];
      } else {
        const port = await freePort();
        const args = ["dev", "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(await freePort())];
        for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
        await start(WRANGLER, args, { cwd: MCP_DIR, env: { WRANGLER_SEND_METRICS: "false" }, ready: /Ready on (http:\/\/127\.0\.0\.1:\d+)/ });
        mcpUrl = `http://127.0.0.1:${port}/mcp`;
      }
    }, 120_000);

    it("rejects requests without the access token", async () => {
      const response = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(401);
    });

    it("lists the manifest's actions as tools with annotations and schemas", async () => {
      const client = await connect(mcpUrl);
      const { tools } = await client.listTools();
      await client.close();
      expect(tools.map((t) => t.name)).toEqual(["list_lists", "add_item", "list_items", "complete_item", "delete_item", "share_list"]);
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      expect(byName.list_items.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(byName.delete_item.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
      expect(byName.share_list.annotations).toMatchObject({ openWorldHint: true });
      expect((byName.list_items.inputSchema.properties as Record<string, { enum?: string[] }>).status.enum).toEqual(["open", "done", "all"]);
      expect(byName.add_item.title).toBe("Add Item");
    });

    it("adds, lists and completes items, changing backend state", async () => {
      await fetch(`${backend}/__reset`, { method: "POST" });
      const client = await connect(mcpUrl);
      const added = await client.callTool({ name: "add_item", arguments: { listId: "groceries", title: "Buy bread", dueDate: "2027-01-31" } });
      expect(added.isError).toBeFalsy();
      const item = added.structuredContent as Item;
      expect(item).toMatchObject({ listId: "groceries", title: "Buy bread", done: false });
      expect((await state()).items.find((i) => i.id === item.id)).toMatchObject({ title: "Buy bread", dueDate: "2027-01-31" });

      const listed = await client.callTool({ name: "list_items", arguments: { listId: "groceries" } });
      const items = (listed.structuredContent as { items: Item[] }).items;
      expect(items.map((i) => i.title)).toEqual(["Buy milk", "Buy bread"]);
      expect(items.every((i) => i.notes === undefined)).toBe(true); // internal field stripped

      const completed = await client.callTool({ name: "complete_item", arguments: { itemId: item.id } });
      expect((completed.structuredContent as Item).done).toBe(true);
      expect((await state()).items.find((i) => i.id === item.id)!.done).toBe(true);
      await client.close();
    });

    it("asks for confirmation before deleting and respects a decline", async () => {
      await fetch(`${backend}/__reset`, { method: "POST" });
      const prompts: string[] = [];
      const declining = await connect(mcpUrl, { elicit: "decline", prompts });
      const declined = await declining.callTool({ name: "delete_item", arguments: { itemId: "item-1" } });
      await declining.close();
      expect(declined.isError).toBe(true);
      expect(prompts).toEqual(['Delete "item-1" permanently?']);
      expect((await state()).items.some((i) => i.id === "item-1")).toBe(true);

      const accepting = await connect(mcpUrl, { elicit: "accept", prompts });
      const deleted = await accepting.callTool({ name: "delete_item", arguments: { itemId: "item-1" } });
      await accepting.close();
      expect(deleted.isError).toBeFalsy();
      expect((await state()).items.some((i) => i.id === "item-1")).toBe(false);
    });

    it("confirms opted-in write actions and returns only declared fields", async () => {
      await fetch(`${backend}/__reset`, { method: "POST" });
      const prompts: string[] = [];
      const client = await connect(mcpUrl, { elicit: "accept", prompts });
      const shared = await client.callTool({ name: "share_list", arguments: { listId: "groceries", email: "sam@example.com" } });
      await client.close();
      expect(prompts).toEqual(["Share this list with sam@example.com?"]);
      expect(shared.structuredContent).toEqual({ shareUrl: `${backend}/shared/groceries`, sharedWith: "sam@example.com" });
      expect((await state()).shares).toHaveLength(1);
    });

    it("reports bad arguments and backend errors as tool errors", async () => {
      const client = await connect(mcpUrl);
      const before = (await state()).items.length;
      const invalid = await client.callTool({ name: "add_item", arguments: { listId: "groceries" } });
      expect(invalid.isError).toBe(true);
      expect((await state()).items.length).toBe(before);
      const missing = await client.callTool({ name: "complete_item", arguments: { itemId: "nope" } });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing.content)).toMatch(/Not found \(404\): No item with ID nope/);
      await client.close();
    });

    it("serves 2025-era clients through the stateless fallback", async () => {
      await fetch(`${backend}/__reset`, { method: "POST" });
      const legacy = await connect(mcpUrl, { era: "legacy" });
      const { tools } = await legacy.listTools();
      expect(tools).toHaveLength(6);
      const lists = await legacy.callTool({ name: "list_lists", arguments: {} });
      expect((lists.structuredContent as { items: { id: string; openCount: number }[] }).items).toEqual([
        { id: "groceries", name: "Groceries", openCount: 1 },
        { id: "work", name: "Work", openCount: 1 },
      ]);
      // No elicitation on this era: destructive tools fall back to the host's confirmation.
      const deleted = await legacy.callTool({ name: "delete_item", arguments: { itemId: "item-2" } });
      expect(deleted.isError).toBeFalsy();
      expect((await state()).items.some((i) => i.id === "item-2")).toBe(false);
      await legacy.close();
    });
  });
}

describe("generated MCP server: payment actions", () => {
  const dir = resolve(REPO, "packages/cli/test/.tmp/coffee-mcp");
  let fakeBackend: Server;
  let mcpUrl = "";
  let orders = 0;

  beforeAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    writeFiles(dir, generateMcp(paymentManifest()));
    fakeBackend = createServer((req, res) => {
      req.resume();
      orders++;
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `order-${orders}`, summary: "Latte", cardLast4: "4242" }));
    });
    await new Promise<void>((r) => fakeBackend.listen(0, "127.0.0.1", r));
    const port = (fakeBackend.address() as { port: number }).port;
    const server = await start("node", ["scripts/serve-node.mjs"], {
      cwd: dir,
      env: { PORT: "0", BACKEND_BASE_URL: `http://127.0.0.1:${port}`, BACKEND_TOKEN: "t", MCP_ACCESS_TOKEN: MCP_TOKEN },
      ready: /listening on (http:\/\/127\.0\.0\.1:\d+\/mcp)/,
    });
    mcpUrl = server.match[1];
  }, 60_000);

  afterAll(() => {
    fakeBackend?.close();
    rmSync(resolve(REPO, "packages/cli/test/.tmp"), { recursive: true, force: true });
  });

  it("refuses to pay when the client cannot ask the user", async () => {
    for (const era of ["modern", "legacy"] as const) {
      const client = await connect(mcpUrl, { era });
      const result = await client.callTool({ name: "place_order", arguments: { drink: "latte" } });
      await client.close();
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/needs the user's confirmation/);
    }
    expect(orders).toBe(0);
  });

  it("pays after the user confirms, and never returns sensitive fields", async () => {
    const prompts: string[] = [];
    const client = await connect(mcpUrl, { elicit: "accept", prompts });
    const result = await client.callTool({ name: "place_order", arguments: { drink: "latte" } });
    await client.close();
    expect(prompts).toEqual(["Pay for latte now?"]);
    expect(result.structuredContent).toEqual({ id: "order-1", summary: "Latte" });
    expect(orders).toBe(1);
  });
});
