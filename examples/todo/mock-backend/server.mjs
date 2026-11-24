// A tiny in-memory to-do backend for the Omnintent example. No dependencies.
// Usage: PORT=8788 node server.mjs
//
// Every user has their own lists and items. Requests need a bearer token:
// - an OAuth access token from this server's own OAuth 2.1 server (below), or
// - MOCK_BACKEND_TOKEN, if set, which acts as the user "demo".
//
// OAuth (for the generated MCP server's per-user sign-in):
//   GET/POST /oauth/authorize  sign-in page (type any user name; no password)
//   POST /oauth/token          authorization_code (PKCE S256 required) and refresh_token
//   GET /me                    the signed-in user: {"id", "name"}
// The OAuth client is MOCK_OAUTH_CLIENT_ID / MOCK_OAUTH_CLIENT_SECRET
// (default "todo-mcp" / "todo-mcp-secret"); MOCK_TOKEN_TTL sets the access
// token lifetime in seconds (default 3600).
//
// For tests: GET /__state?user=<id>, POST /__reset (data only; sign-ins stay),
// POST /__revoke?user=<id>, POST /__config?tokenTtl=<seconds>, and GET /__seen
// (the Authorization headers the API received).

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8788);
const HOST = process.env.HOST ?? "127.0.0.1";
const TOKEN = process.env.MOCK_BACKEND_TOKEN ?? "";
const CLIENT_ID = process.env.MOCK_OAUTH_CLIENT_ID ?? "todo-mcp";
const CLIENT_SECRET = process.env.MOCK_OAUTH_CLIENT_SECRET ?? "todo-mcp-secret";
let tokenTtl = Number(process.env.MOCK_TOKEN_TTL ?? 3600);

function seed() {
  return {
    lists: [
      { id: "groceries", name: "Groceries" },
      { id: "work", name: "Work" },
    ],
    items: [
      { id: "item-1", listId: "groceries", title: "Buy milk", done: false, notes: "Two percent only", dueDate: null },
      { id: "item-2", listId: "groceries", title: "Buy eggs", done: true, notes: "", dueDate: null },
      { id: "item-3", listId: "work", title: "Send report", done: false, notes: "", dueDate: "2026-12-01" },
    ],
    shares: [],
    nextId: 4,
  };
}

/** Per-user data, created on first use. */
let users = new Map();
const stateFor = (user) => {
  if (!users.has(user)) users.set(user, seed());
  return users.get(user);
};

// OAuth records: code -> {user, clientId, redirectUri, challenge}; token -> {user, expiresAt}.
const codes = new Map();
const accessTokens = new Map();
const refreshTokens = new Map();
let seenAuthorization = [];
let refreshCount = 0;

const randomId = () => randomBytes(24).toString("base64url");

function issueTokens(user) {
  const access = randomId();
  const refresh = randomId();
  accessTokens.set(access, { user, expiresAt: Date.now() + tokenTtl * 1000 });
  refreshTokens.set(refresh, { user });
  return { access_token: access, token_type: "Bearer", expires_in: tokenTtl, refresh_token: refresh, scope: "todo" };
}

function userForToken(header) {
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return undefined;
  if (TOKEN && token === TOKEN) return "demo";
  const record = accessTokens.get(token);
  return record && record.expiresAt > Date.now() ? record.user : undefined;
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function readForm(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function signInPage(params) {
  const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope"]
    .map((name) => `<input type="hidden" name="${name}" value="${escapeHtml(params.get(name) ?? "")}">`)
    .join("");
  return `<!doctype html><meta charset="utf-8"><title>Sign in to Todo Example</title>
<h1>Sign in to Todo Example</h1><p>This is a mock backend: any user name works, and there is no password.</p>
<form method="post" action="/oauth/authorize">${hidden}<label>User name <input name="username" required></label> <button>Sign in</button></form>`;
}

async function oauthAuthorize(req, res, url) {
  const params = req.method === "POST" ? await readForm(req) : url.searchParams;
  if (params.get("client_id") !== CLIENT_ID) return send(res, 400, { error: "invalid_client", message: "Unknown client_id." });
  const redirectUri = params.get("redirect_uri") ?? "";
  if (!/^https?:\/\//.test(redirectUri)) return send(res, 400, { error: "invalid_request", message: "redirect_uri is required." });
  if (params.get("code_challenge_method") !== "S256" || !params.get("code_challenge")) {
    return send(res, 400, { error: "invalid_request", message: "PKCE with S256 is required." });
  }
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(signInPage(params));
  }
  const back = new URL(redirectUri);
  const user = (params.get("username") ?? "").trim();
  if (params.get("deny") || !user) back.searchParams.set("error", "access_denied");
  else {
    const code = randomId();
    codes.set(code, { user, redirectUri, challenge: params.get("code_challenge"), expiresAt: Date.now() + 60_000 });
    back.searchParams.set("code", code);
  }
  if (params.get("state")) back.searchParams.set("state", params.get("state"));
  res.writeHead(302, { location: back.toString() });
  res.end();
}

async function oauthToken(req, res) {
  const form = await readForm(req);
  let clientId = form.get("client_id");
  let clientSecret = form.get("client_secret");
  const basic = req.headers.authorization?.startsWith("Basic ") ? Buffer.from(req.headers.authorization.slice(6), "base64").toString() : "";
  if (basic) {
    const [id, secret] = basic.split(":").map((part) => decodeURIComponent(part.replace(/\+/g, " ")));
    clientId = id;
    clientSecret = secret;
  }
  if (clientId !== CLIENT_ID || clientSecret !== CLIENT_SECRET) return send(res, 401, { error: "invalid_client" });
  const grant = form.get("grant_type");
  if (grant === "authorization_code") {
    const record = codes.get(form.get("code") ?? "");
    codes.delete(form.get("code") ?? "");
    const verifier = form.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (!record || record.expiresAt < Date.now() || record.redirectUri !== form.get("redirect_uri") || record.challenge !== challenge) {
      return send(res, 400, { error: "invalid_grant" });
    }
    return send(res, 200, issueTokens(record.user));
  }
  if (grant === "refresh_token") {
    const record = refreshTokens.get(form.get("refresh_token") ?? "");
    if (!record) return send(res, 400, { error: "invalid_grant" });
    refreshTokens.delete(form.get("refresh_token"));
    refreshCount++;
    return send(res, 200, issueTokens(record.user));
  }
  send(res, 400, { error: "unsupported_grant_type" });
}

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status);
    return res.end();
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

const withCount = (state, list) => ({ ...list, openCount: state.items.filter((i) => i.listId === list.id && !i.done).length });

const routes = [
  ["GET", /^\/lists$/, (state) => [200, state.lists.map((list) => withCount(state, list))]],
  [
    "GET",
    /^\/lists\/([^/]+)\/items$/,
    (state, _req, [listId], url) => {
      if (!state.lists.some((l) => l.id === listId)) return [404, { message: `No list with ID ${listId}.` }];
      const status = url.searchParams.get("status") ?? "open";
      if (!["open", "done", "all"].includes(status)) return [400, { message: "status must be open, done or all." }];
      const items = state.items.filter((i) => i.listId === listId && (status === "all" || i.done === (status === "done")));
      return [200, items];
    },
  ],
  [
    "POST",
    /^\/lists\/([^/]+)\/items$/,
    async (state, req, [listId]) => {
      if (!state.lists.some((l) => l.id === listId)) return [404, { message: `No list with ID ${listId}.` }];
      const body = await readJson(req);
      if (!body || typeof body.title !== "string" || !body.title.trim()) return [400, { message: "title is required." }];
      const item = { id: `item-${state.nextId++}`, listId, title: body.title.trim(), done: false, notes: "", dueDate: body.dueDate ?? null };
      state.items.push(item);
      return [201, item];
    },
  ],
  [
    "POST",
    /^\/items\/([^/]+)\/complete$/,
    (state, _req, [itemId]) => {
      const item = state.items.find((i) => i.id === itemId);
      if (!item) return [404, { message: `No item with ID ${itemId}.` }];
      item.done = true;
      return [200, item];
    },
  ],
  [
    "DELETE",
    /^\/items\/([^/]+)$/,
    (state, _req, [itemId]) => {
      const index = state.items.findIndex((i) => i.id === itemId);
      if (index < 0) return [404, { message: `No item with ID ${itemId}.` }];
      state.items.splice(index, 1);
      return [204, undefined];
    },
  ],
  [
    "POST",
    /^\/lists\/([^/]+)\/share$/,
    async (state, req, [listId]) => {
      if (!state.lists.some((l) => l.id === listId)) return [404, { message: `No list with ID ${listId}.` }];
      const body = await readJson(req);
      if (!body || typeof body.email !== "string" || !/^[^@\s]+@[^@\s]+$/.test(body.email)) return [400, { message: "email must be an email address." }];
      state.shares.push({ listId, email: body.email });
      return [200, { shareUrl: `http://${HOST}:${server.address().port}/shared/${listId}`, sharedWith: body.email, internalShareId: state.shares.length }];
    },
  ],
  ["GET", /^\/me$/, (_state, _req, _match, _url, user) => [200, { id: user, name: user }]],
];

const testRoutes = [
  ["GET", /^\/__state$/, (_req, url) => [200, { ...stateFor(url.searchParams.get("user") ?? "demo"), refreshCount }]],
  ["GET", /^\/__seen$/, () => [200, seenAuthorization]],
  [
    "POST",
    /^\/__revoke$/,
    (_req, url) => {
      const user = url.searchParams.get("user");
      for (const map of [accessTokens, refreshTokens]) for (const [token, record] of map) if (record.user === user) map.delete(token);
      return [204, undefined];
    },
  ],
  [
    "POST",
    /^\/__config$/,
    (_req, url) => {
      if (url.searchParams.has("tokenTtl")) tokenTtl = Number(url.searchParams.get("tokenTtl"));
      return [204, undefined];
    },
  ],
  [
    "POST",
    /^\/__reset$/,
    () => {
      users = new Map();
      seenAuthorization = [];
      return [204, undefined];
    },
  ],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? HOST}`);
  if (url.pathname === "/oauth/authorize" && (req.method === "GET" || req.method === "POST")) return oauthAuthorize(req, res, url);
  if (url.pathname === "/oauth/token" && req.method === "POST") return oauthToken(req, res);
  for (const [method, pattern, handler] of testRoutes) {
    if (req.method === method && pattern.test(url.pathname)) {
      const [status, body] = await handler(req, url);
      return send(res, status, body);
    }
  }
  seenAuthorization.push(req.headers.authorization ?? "");
  const user = userForToken(req.headers.authorization);
  if (!user) return send(res, 401, { message: "Missing, expired or wrong bearer token." });
  for (const [method, pattern, handler] of routes) {
    const match = url.pathname.match(pattern);
    if (match && req.method === method) {
      const [status, body] = await handler(stateFor(user), req, match.slice(1).map(decodeURIComponent), url, user);
      return send(res, status, body);
    }
  }
  send(res, 404, { message: `No route for ${req.method} ${url.pathname}.` });
});

server.listen(PORT, HOST, () => {
  console.log(`Mock backend listening on http://${HOST}:${server.address().port}`);
});
