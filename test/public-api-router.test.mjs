import assert from "node:assert/strict";
import test from "node:test";
import { createPublicApiHandler } from "../server/public-api-router.mjs";

function serviceFixture() {
  return {
    health: () => ({ status: "ok" }),
    home: () => ({ page: "home" }),
    courses: () => ({ items: [] }),
    searchIndex: () => ({ version: "version", items: [], total: 0 }),
    guides: () => ({ items: [], total: 0 }),
    guide: (id) => ({ id }),
    course: (id) => ({ id }),
    resources: (id) => ({ course_id: id, items: [] }),
    reviewGroups: () => ({ items: [] }),
    reviewGroup: (key) => ({ group_key: key, items: [] }),
    assertReviewAttempt: () => {},
    submitReview: async () => ({ submitted: true, pending: true }),
  };
}

async function invoke(handler, method, pathname, headers = {}) {
  const req = { method, headers };
  const response = { status: null, headers: {}, body: "", writableEnded: false, destroyed: false };
  const res = {
    get writableEnded() { return response.writableEnded; },
    get destroyed() { return response.destroyed; },
    writeHead(status, responseHeaders) { response.status = status; response.headers = responseHeaders; },
    end(body = "") { response.body = body; response.writableEnded = true; },
  };
  response.handled = await handler(req, res, new URL(pathname, "https://nkustudy.top"));
  return response;
}

test("public router exposes exactly the documented route set and no management route", async () => {
  const handler = createPublicApiHandler({ service: serviceFixture(), readBody: async () => ({}), clientIp: () => "actor" });
  for (const route of [
    "/api/v1/health", "/api/v1/home", "/api/v1/search-index", "/api/v1/guides", "/api/v1/guides/guide-id", "/api/v1/courses", "/api/v1/courses/course-uid",
    "/api/v1/courses/course-uid/resources", "/api/v1/review-groups", "/api/v1/review-groups/group-key",
  ]) {
    const response = await invoke(handler, "GET", route);
    assert.equal(response.status, 200, route);
  }
  assert.equal((await invoke(handler, "POST", "/api/v1/reviews")).status, 200);
  for (const route of ["/api/v1/admin", "/api/v1/admin-api/manifest", "/api/v1/auth/wechat", "/api/v1/favorites", "/api/v1/reports"]) {
    assert.equal((await invoke(handler, "GET", route)).status, 404, route);
  }
});

test("GET cache emits a stable ETag, honors If-None-Match, and health stays no-store", async () => {
  const handler = createPublicApiHandler({ service: serviceFixture(), readBody: async () => ({}), clientIp: () => "actor" });
  const first = await invoke(handler, "GET", "/api/v1/courses");
  assert.equal(first.headers["cache-control"].startsWith("public"), true);
  assert.equal(typeof first.headers.etag, "string");
  const second = await invoke(handler, "GET", "/api/v1/courses", { "if-none-match": first.headers.etag });
  assert.equal(second.status, 304);
  assert.equal(second.body, "");
  assert.equal((await invoke(handler, "GET", "/api/v1/health")).headers["cache-control"], "no-store");
});

test("unexpected errors are sanitized and never expose exception details", async () => {
  const service = serviceFixture();
  service.health = () => { throw new Error("database-password-and-stack"); };
  const handler = createPublicApiHandler({ service, readBody: async () => ({}), clientIp: () => "actor" });
  const response = await invoke(handler, "GET", "/api/v1/health");
  assert.equal(response.status, 500);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body.includes("database-password-and-stack"), false);
  assert.equal(JSON.parse(response.body).code, "INTERNAL_ERROR");
});
