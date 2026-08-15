import assert from "node:assert/strict";
import test from "node:test";
import { documentedRoutes, sourceRoutes } from "../scripts/api-route-extractor.mjs";

test("route extractor supports standard verbs, condition order, lists, and registered dynamic routes", () => {
  const source = `
    if (req.method === "GET" && url.pathname === "/plain") {}
    if (url.pathname === '/reverse' && req.method === 'POST') {}
    if (req.method === "PATCH" && url.pathname === "/patch") {}
    if (req.method === "DELETE" && ["/old-a", "/old-b"].includes(url.pathname)) {}
    let match = url.pathname.match(/^\\/items\\/([^/]+)$/);
    if (req.method === "PUT" && match) {}
    match = url.pathname.match(/^\\/groups\\/([^/]+)\\/members$/);
    if (req.method === "HEAD" && match) {}
    if (req.method === "OPTIONS" && url.pathname === "/options") {}
  `;
  assert.deepEqual([...sourceRoutes(source)].sort(), [
    "DELETE /old-a",
    "DELETE /old-b",
    "GET /plain",
    "HEAD /groups/:param/members",
    "OPTIONS /options",
    "PATCH /patch",
    "POST /reverse",
    "PUT /items/:param",
  ]);
});

test("documentation registry accepts every standard HTTP verb and normalizes parameter names", () => {
  const docs = `
<!-- api-route-registry:start -->
| \`GET\` | \`/items/:itemId\` | public |
| \`HEAD\` | \`/items/:id\` | public |
| \`PUT\` | \`/items/:id\` | public |
| \`PATCH\` | \`/items/:id\` | public |
| \`DELETE\` | \`/items/:id\` | public |
| \`OPTIONS\` | \`/items/:id\` | public |
| \`CONNECT\` | \`/tunnel\` | public |
| \`TRACE\` | \`/trace\` | public |
<!-- api-route-registry:end -->`;
  assert.deepEqual([...documentedRoutes(docs)].sort(), [
    "CONNECT /tunnel",
    "DELETE /items/:param",
    "GET /items/:param",
    "HEAD /items/:param",
    "OPTIONS /items/:param",
    "PATCH /items/:param",
    "PUT /items/:param",
    "TRACE /trace",
  ]);
});

test("unsupported dynamic route regex fails closed", () => {
  assert.throws(() => sourceRoutes(`
    const match = url.pathname.match(/^\\/items\\/(.+)$/);
    if (req.method === "GET" && match) {}
  `), /cannot be represented/);
});

test("cross-line exact method and path conditions are extracted", () => {
  assert.deepEqual([...sourceRoutes(`
    if (
      req.method === "PATCH" &&
      url.pathname === "/cross-line"
    ) {}
  `)], ["PATCH /cross-line"]);
});

test("variable paths and startsWith route candidates fail closed", () => {
  assert.throws(() => sourceRoutes(`
    if (req.method === "GET" && url.pathname === routePath) {}
  `), /Unsupported req\.method\/url\.pathname route candidate/);
  assert.throws(() => sourceRoutes(`
    if (req.method === "GET" && url.pathname.startsWith("/prefix/")) {}
  `), /Unsupported req\.method\/url\.pathname route candidate/);
  assert.throws(() => sourceRoutes(`
    const match = url.pathname.match(routePattern);
    if (req.method === "GET" && match) {}
  `), /Unsupported url\.pathname\.match route candidate/);
});
