// End-to-end: run the generated MCP server (Node adapter and wrangler dev),
// start the example's mock backend, sign users in with OAuth through the
// official MCP client, and check that tool calls change each user's backend
// state as the manifest says. A second, shared-token server covers payments.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateMcp } from "../src/generators/mcp.js";
import { writeFiles } from "../src/generators/index.js";
import { EXAMPLE_DIR, GENERATED_DIR, REPO, paymentManifest } from "./helpers.js";

const MCP_DIR = join(GENERATED_DIR, "mcp");
const WRANGLER = resolve(REPO, "node_modules/.bin/wrangler");
const TSC = resolve(REPO, "node_modules/.bin/tsc");
const MCP_TOKEN = "test-mcp-token";
const BACKEND_CLIENT = { id: "todo-mcp", secret: "todo-mcp-secret" };
const CLIENT_NAME = 'E2E <b>"client"</b>';
const REDIRECT_URL = "http://127.0.0.1:1/callback";
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

// ---------------------------------------------------------------- OAuth client side

/** An MCP client's OAuth state, kept in memory. Registers by DCR as a public client. */
class TestOAuthClient implements OAuthClientProvider {
  authorizationUrl?: URL;
  #client?: StoredOAuthClientInformation;
  #tokens?: StoredOAuthTokens;
  #verifier = "";
  get redirectUrl() {
    return REDIRECT_URL;
  }
  get clientMetadata() {
    return {
      client_name: CLIENT_NAME,
      redirect_uris: [REDIRECT_URL],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation() {
    return this.#client;
  }
  saveClientInformation(info: StoredOAuthClientInformation) {
    this.#client = info;
  }
  tokens() {
    return this.#tokens;
  }
  saveTokens(tokens: StoredOAuthTokens) {
    this.#tokens = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.#verifier = verifier;
  }
  codeVerifier() {
    return this.#verifier;
  }
}

/** A minimal browser: follows the sign-in redirects by hand and keeps cookies. */
class Browser {
  #cookies = new Map<string, string>();
  pages: { url: string; status: number; headers: Headers; html: string }[] = [];

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.#cookies.size) headers.set("cookie", [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const at = pair.indexOf("=");
      const value = pair.slice(at + 1);
      if (/max-age=0/i.test(cookie) || value === "") this.#cookies.delete(pair.slice(0, at));
      else this.#cookies.set(pair.slice(0, at), value);
    }
    if (response.status === 200) {
      this.pages.push({ url, status: 200, headers: response.headers, html: await response.clone().text() });
    }
    return response;
  }

  async post(url: string, fields: [string, string][]): Promise<Response> {
    return this.request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
  }
}

interface SignInOptions {
  write?: boolean;
  decision?: "approve" | "deny";
}

/**
 * Plays the person: opens the client's authorization URL, answers the consent
 * page, signs in to the mock backend as `user`, and returns the parameters the
 * client's redirect URI receives.
 */
async function authorizeInBrowser(authorizationUrl: URL, user: string, opts: SignInOptions = {}) {
  const browser = new Browser();
  const consent = await browser.request(authorizationUrl.toString());
  expect(consent.status).toBe(200);
  const handle = (await consent.text()).match(/name=handle value="([^"]+)"/)![1];
  const fields: [string, string][] = [
    ["handle", handle],
    ["decision", opts.decision ?? "approve"],
  ];
  if (opts.write !== false) fields.push(["scope", "mcp:write"]);
  let response = await browser.post(new URL("/authorize", authorizationUrl).toString(), fields);
  expect(response.status).toBe(302);
  let location = response.headers.get("location")!;
  if (opts.decision !== "deny") {
    // Now at the backend's own sign-in page.
    const signIn = await browser.request(location);
    expect(signIn.status).toBe(200);
    const hidden = [...(await signIn.text()).matchAll(/name="([^"]+)" value="([^"]*)"/g)].map(
      (m) => [m[1], m[2].replace(/&#(\d+);/g, (_, c: string) => String.fromCharCode(Number(c)))] as [string, string],
    );
    response = await browser.post(new URL("/oauth/authorize", location).toString(), [...hidden, ["username", user]]);
    expect(response.status).toBe(302);
    // Back at the MCP server's callback, which finishes the grant.
    response = await browser.request(response.headers.get("location")!);
    expect(response.status).toBe(302);
    location = response.headers.get("location")!;
  }
  expect(location.startsWith(REDIRECT_URL)).toBe(true);
  return { params: new URL(location).searchParams, browser };
}

/** Signs `user` in with the official client's OAuth support (discovery, DCR, PKCE). */
async function signIn(mcpUrl: string, user: string, opts: SignInOptions = {}) {
  const auth = new TestOAuthClient();
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: auth });
  const client = new Client({ name: "omnintent-e2e", version: "0.1.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await expect(client.connect(transport)).rejects.toThrow();
  expect(auth.authorizationUrl).toBeDefined();
  const { params, browser } = await authorizeInBrowser(auth.authorizationUrl!, user, opts);
  await transport.finishAuth(params);
  await transport.close();
  return { auth, browser };
}

// ---------------------------------------------------------------- MCP client side

interface ClientOptions {
  era?: "modern" | "legacy";
  elicit?: "accept" | "decline" | false;
  prompts?: string[];
  /** Signed-in OAuth state; without it the shared MCP_ACCESS_TOKEN is sent. */
  auth?: TestOAuthClient;
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
  const transport = opts.auth
    ? new StreamableHTTPClientTransport(new URL(url), { authProvider: opts.auth })
    : new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } });
  await client.connect(transport);
  return client;
}

type Item = { id: string; listId: string; title: string; done: boolean; notes?: string };

const runtimes = [
  { name: "node adapter", available: true },
  { name: "wrangler dev (workerd)", available: existsSync(WRANGLER) && process.env.OMNINTENT_SKIP_WRANGLER !== "1" },
];

for (const runtime of runtimes) {
  describe.runIf(runtime.available)(`generated MCP server with OAuth sign-in, end to end: ${runtime.name}`, () => {
    let backend = "";
    let origin = "";
    let mcpUrl = "";
    let alice: TestOAuthClient;

    const state = async (user: string) => (await (await fetch(`${backend}/__state?user=${user}`)).json()) as { items: Item[]; shares: unknown[]; refreshCount: number };
    const reset = () => fetch(`${backend}/__reset`, { method: "POST" });

    beforeAll(async () => {
      const mock = await start("node", [join(EXAMPLE_DIR, "mock-backend/server.mjs")], {
        cwd: EXAMPLE_DIR,
        env: { PORT: "0", MOCK_OAUTH_CLIENT_ID: BACKEND_CLIENT.id, MOCK_OAUTH_CLIENT_SECRET: BACKEND_CLIENT.secret },
        ready: /listening on (http:\/\/127\.0\.0\.1:\d+)/,
      });
      backend = mock.match[1];
      const port = await freePort();
      origin = `http://127.0.0.1:${port}`;
      mcpUrl = `${origin}/mcp`;
      const vars = {
        MCP_SERVER_URL: origin,
        BACKEND_BASE_URL: backend,
        BACKEND_OAUTH_AUTHORIZATION_URL: `${backend}/oauth/authorize`,
        BACKEND_OAUTH_TOKEN_URL: `${backend}/oauth/token`,
        BACKEND_OAUTH_CLIENT_ID: BACKEND_CLIENT.id,
        BACKEND_OAUTH_CLIENT_SECRET: BACKEND_CLIENT.secret,
      };
      if (runtime.name === "node adapter") {
        await start("node", ["scripts/serve-node.mjs"], {
          cwd: MCP_DIR,
          env: { ...vars, PORT: String(port) },
          ready: /listening on (http:\/\/127\.0\.0\.1:\d+\/mcp)/,
        });
      } else {
        const args = ["dev", "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(await freePort())];
        for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
        await start(WRANGLER, args, { cwd: MCP_DIR, env: { WRANGLER_SEND_METRICS: "false" }, ready: /Ready on (http:\/\/127\.0\.0\.1:\d+)/ });
      }
    }, 120_000);

    it("answers unauthenticated requests with a pointer to its Protected Resource Metadata", async () => {
      const response = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(401);
      const challenge = response.headers.get("www-authenticate")!;
      expect(challenge).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
      expect(challenge).toContain('scope="mcp:read"');

      const resource = await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json();
      expect(resource).toMatchObject({ resource: mcpUrl, authorization_servers: [origin], scopes_supported: ["mcp:read"] });
      const server = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
      expect(server).toMatchObject({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["mcp:read", "mcp:write"],
      });
      // A made-up token is refused too.
      const forged = await fetch(mcpUrl, { method: "POST", headers: { authorization: "Bearer not-a-token", "content-type": "application/json" }, body: "{}" });
      expect(forged.status).toBe(401);
    });

    it("signs a user in through a consent page and the backend, then lists tools", async () => {
      const signedIn = await signIn(mcpUrl, "alice");
      alice = signedIn.auth;
      const consent = signedIn.browser.pages[0];
      // The page names the client (escaped), where access goes, and warns about a local app.
      expect(consent.html).toContain("E2E &#60;b&#62;&#34;client&#34;&#60;/b&#62;");
      expect(consent.html).not.toContain("<b>");
      expect(consent.html).toContain("Access will be sent to <strong>127.0.0.1</strong>");
      expect(consent.html).toContain("an app on this computer");
      expect(consent.html).toContain("Add Item, Complete Item, Delete Item, Share List");
      expect(consent.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      // The second page is the backend's own sign-in.
      expect(signedIn.browser.pages[1].html).toContain("Sign in to Todo Example");
      const tokens = alice.tokens()!;
      expect(tokens.scope?.split(" ").sort()).toEqual(["mcp:read", "mcp:write"]);

      const client = await connect(mcpUrl, { auth: alice });
      const { tools } = await client.listTools();
      await client.close();
      expect(tools.map((t) => t.name)).toEqual(["list_lists", "add_item", "list_items", "complete_item", "delete_item", "share_list"]);
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      expect(byName.list_items.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(byName.delete_item.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
      expect((byName.list_items.inputSchema.properties as Record<string, { enum?: string[] }>).status.enum).toEqual(["open", "done", "all"]);
    });

    it("adds, lists and completes items in the signed-in user's own account", async () => {
      await reset();
      const client = await connect(mcpUrl, { auth: alice });
      const added = await client.callTool({ name: "add_item", arguments: { listId: "groceries", title: "Buy bread", dueDate: "2027-01-31" } });
      expect(added.isError).toBeFalsy();
      const item = added.structuredContent as Item;
      expect(item).toMatchObject({ listId: "groceries", title: "Buy bread", done: false });
      expect((await state("alice")).items.find((i) => i.id === item.id)).toMatchObject({ title: "Buy bread", dueDate: "2027-01-31" });

      const listed = await client.callTool({ name: "list_items", arguments: { listId: "groceries" } });
      const items = (listed.structuredContent as { items: Item[] }).items;
      expect(items.map((i) => i.title)).toEqual(["Buy milk", "Buy bread"]);
      expect(items.every((i) => i.notes === undefined)).toBe(true); // internal field stripped

      const completed = await client.callTool({ name: "complete_item", arguments: { itemId: item.id } });
      expect((completed.structuredContent as Item).done).toBe(true);
      expect((await state("alice")).items.find((i) => i.id === item.id)!.done).toBe(true);
      await client.close();

      // Another person only sees their own data.
      const bob = (await signIn(mcpUrl, "bob")).auth;
      const bobClient = await connect(mcpUrl, { auth: bob });
      const bobItems = await bobClient.callTool({ name: "list_items", arguments: { listId: "groceries", status: "all" } });
      await bobClient.close();
      expect((bobItems.structuredContent as { items: Item[] }).items.map((i) => i.title)).toEqual(["Buy milk", "Buy eggs"]);
      expect((await state("bob")).items.some((i) => i.title === "Buy bread")).toBe(false);
    });

    it("never passes the MCP token to the backend", async () => {
      const seen = (await (await fetch(`${backend}/__seen`)).json()) as string[];
      expect(seen.length).toBeGreaterThan(0);
      expect(seen).not.toContain(`Bearer ${alice.tokens()!.access_token}`);
      expect(seen.every((header) => header.startsWith("Bearer ") && !header.includes(":"))).toBe(true);
      // ...and the client never sees the backend's token: what it holds is the MCP server's.
      expect(alice.tokens()!.access_token.split(":")).toHaveLength(3);
    });

    it("asks for confirmation before deleting and respects a decline", async () => {
      await reset();
      const prompts: string[] = [];
      const declining = await connect(mcpUrl, { auth: alice, elicit: "decline", prompts });
      const declined = await declining.callTool({ name: "delete_item", arguments: { itemId: "item-1" } });
      await declining.close();
      expect(declined.isError).toBe(true);
      expect(prompts).toEqual(['Delete "item-1" permanently?']);
      expect((await state("alice")).items.some((i) => i.id === "item-1")).toBe(true);

      const accepting = await connect(mcpUrl, { auth: alice, elicit: "accept", prompts });
      const deleted = await accepting.callTool({ name: "delete_item", arguments: { itemId: "item-1" } });
      await accepting.close();
      expect(deleted.isError).toBeFalsy();
      expect((await state("alice")).items.some((i) => i.id === "item-1")).toBe(false);
    });

    it("confirms opted-in write actions and returns only declared fields", async () => {
      await reset();
      const prompts: string[] = [];
      const client = await connect(mcpUrl, { auth: alice, elicit: "accept", prompts });
      const shared = await client.callTool({ name: "share_list", arguments: { listId: "groceries", email: "sam@example.com" } });
      await client.close();
      expect(prompts).toEqual(["Share this list with sam@example.com?"]);
      expect(shared.structuredContent).toEqual({ shareUrl: `${backend}/shared/groceries`, sharedWith: "sam@example.com" });
      expect((await state("alice")).shares).toHaveLength(1);
    });

    it("reports bad arguments and backend errors as tool errors", async () => {
      const client = await connect(mcpUrl, { auth: alice });
      const before = (await state("alice")).items.length;
      const invalid = await client.callTool({ name: "add_item", arguments: { listId: "groceries" } });
      expect(invalid.isError).toBe(true);
      expect((await state("alice")).items.length).toBe(before);
      const missing = await client.callTool({ name: "complete_item", arguments: { itemId: "nope" } });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing.content)).toMatch(/Not found \(404\): No item with ID nope/);
      await client.close();
    });

    it("gives read-only access when the person unticks Make changes", async () => {
      await reset();
      const carol = (await signIn(mcpUrl, "carol", { write: false })).auth;
      expect(carol.tokens()!.scope).toBe("mcp:read");
      const client = await connect(mcpUrl, { auth: carol });
      const lists = await client.callTool({ name: "list_lists", arguments: {} });
      expect(lists.isError).toBeFalsy();
      await expect(client.callTool({ name: "add_item", arguments: { listId: "groceries", title: "Nope" } })).rejects.toThrow();
      await client.close().catch(() => {});
      expect((await state("carol")).items.some((i) => i.title === "Nope")).toBe(false);

      // On the wire: 403 insufficient_scope naming both scopes, so the client can ask for more.
      const response = await fetch(mcpUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${carol.tokens()!.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add_item", arguments: { listId: "groceries", title: "Nope" } } }),
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("www-authenticate")).toMatch(/error="insufficient_scope".*scope="mcp:read mcp:write"/);
    });

    it("sends access_denied back to the client when the person clicks Deny", async () => {
      const auth = new TestOAuthClient();
      const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: auth });
      const client = new Client({ name: "omnintent-e2e", version: "0.1.0" });
      await expect(client.connect(transport)).rejects.toThrow();
      const { params } = await authorizeInBrowser(auth.authorizationUrl!, "dave", { decision: "deny" });
      expect(params.get("error")).toBe("access_denied");
      expect(params.get("iss")).toBe(origin);
      expect(params.get("code")).toBeNull();
    });

    it("refreshes the backend token with the client's token, and revokes the grant when the backend does", async () => {
      // Backend tokens that expire within the refresh margin are renewed on every refresh.
      await fetch(`${backend}/__config?tokenTtl=120`, { method: "POST" });
      const erin = (await signIn(mcpUrl, "erin")).auth;
      await fetch(`${backend}/__config?tokenTtl=3600`, { method: "POST" });
      const refresh = () =>
        fetch(`${origin}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: erin.tokens()!.refresh_token!, client_id: erin.clientInformation()!.client_id }),
        });
      expect(erin.tokens()!.expires_in).toBeLessThanOrEqual(90);
      const before = (await state("erin")).refreshCount;
      const response = await refresh();
      expect(response.status).toBe(200);
      const tokens = (await response.json()) as StoredOAuthTokens;
      expect((await state("erin")).refreshCount).toBe(before + 1);
      erin.saveTokens(tokens);
      const client = await connect(mcpUrl, { auth: erin });
      expect((await client.callTool({ name: "list_lists", arguments: {} })).isError).toBeFalsy();
      await client.close();

      await fetch(`${backend}/__revoke?user=erin`, { method: "POST" });
      // The new backend token is long-lived, so force the next refresh to reach the backend.
      await fetch(`${backend}/__config?tokenTtl=120`, { method: "POST" });
      const erin2 = (await signIn(mcpUrl, "erin")).auth;
      await fetch(`${backend}/__config?tokenTtl=3600`, { method: "POST" });
      await fetch(`${backend}/__revoke?user=erin`, { method: "POST" });
      const revoked = await fetch(`${origin}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: erin2.tokens()!.refresh_token!, client_id: erin2.clientInformation()!.client_id }),
      });
      expect(revoked.status).toBe(400);
      expect(((await revoked.json()) as { error: string }).error).toBe("invalid_grant");
      // The grant is gone: its access token no longer works either.
      const after = await fetch(mcpUrl, { method: "POST", headers: { authorization: `Bearer ${erin2.tokens()!.access_token}`, "content-type": "application/json" }, body: "{}" });
      expect(after.status).toBe(401);
    });

    it("serves 2025-era clients through the stateless fallback", async () => {
      await reset();
      const legacy = await connect(mcpUrl, { auth: alice, era: "legacy" });
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
      expect((await state("alice")).items.some((i) => i.id === "item-2")).toBe(false);
      await legacy.close();
    });
  });
}

describe("generated MCP server with a shared token: payment actions", () => {
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

  it("type-checks", () => {
    const result = spawnSync(TSC, ["--noEmit", "-p", dir], { encoding: "utf8" });
    expect(result.stdout + result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("rejects requests without the access token", async () => {
    const response = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(401);
    const wrong = await fetch(mcpUrl, { method: "POST", headers: { authorization: "Bearer wrong", "content-type": "application/json" }, body: "{}" });
    expect(wrong.status).toBe(401);
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
