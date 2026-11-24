// A tiny in-memory to-do backend for the Omnintent example. No dependencies.
// Usage: PORT=8788 MOCK_BACKEND_TOKEN=dev-token node server.mjs
// When MOCK_BACKEND_TOKEN is set, requests need "Authorization: Bearer <token>".
// GET /__state and POST /__reset exist for tests.

import http from "node:http";

const PORT = Number(process.env.PORT ?? 8788);
const HOST = process.env.HOST ?? "127.0.0.1";
const TOKEN = process.env.MOCK_BACKEND_TOKEN ?? "";

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

let state = seed();

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

const withCount = (list) => ({ ...list, openCount: state.items.filter((i) => i.listId === list.id && !i.done).length });

const routes = [
  ["GET", /^\/lists$/, () => [200, state.lists.map(withCount)]],
  [
    "GET",
    /^\/lists\/([^/]+)\/items$/,
    (_req, [listId], url) => {
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
    async (req, [listId]) => {
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
    (_req, [itemId]) => {
      const item = state.items.find((i) => i.id === itemId);
      if (!item) return [404, { message: `No item with ID ${itemId}.` }];
      item.done = true;
      return [200, item];
    },
  ],
  [
    "DELETE",
    /^\/items\/([^/]+)$/,
    (_req, [itemId]) => {
      const index = state.items.findIndex((i) => i.id === itemId);
      if (index < 0) return [404, { message: `No item with ID ${itemId}.` }];
      state.items.splice(index, 1);
      return [204, undefined];
    },
  ],
  [
    "POST",
    /^\/lists\/([^/]+)\/share$/,
    async (req, [listId]) => {
      if (!state.lists.some((l) => l.id === listId)) return [404, { message: `No list with ID ${listId}.` }];
      const body = await readJson(req);
      if (!body || typeof body.email !== "string" || !/^[^@\s]+@[^@\s]+$/.test(body.email)) return [400, { message: "email must be an email address." }];
      state.shares.push({ listId, email: body.email });
      return [200, { shareUrl: `http://${HOST}:${server.address().port}/shared/${listId}`, sharedWith: body.email, internalShareId: state.shares.length }];
    },
  ],
  ["GET", /^\/__state$/, () => [200, state]],
  [
    "POST",
    /^\/__reset$/,
    () => {
      state = seed();
      return [204, undefined];
    },
  ],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? HOST}`);
  const testRoute = url.pathname.startsWith("/__");
  if (TOKEN && !testRoute && req.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(res, 401, { message: "Missing or wrong bearer token." });
  }
  for (const [method, pattern, handler] of routes) {
    const match = url.pathname.match(pattern);
    if (match && req.method === method) {
      const [status, body] = await handler(req, match.slice(1).map(decodeURIComponent), url);
      return send(res, status, body);
    }
  }
  send(res, 404, { message: `No route for ${req.method} ${url.pathname}.` });
});

server.listen(PORT, HOST, () => {
  console.log(`Mock backend listening on http://${HOST}:${server.address().port}`);
});
