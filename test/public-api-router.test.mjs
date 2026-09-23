import assert from "node:assert/strict";
import test from "node:test";
import { createPublicApiHandler } from "../server/public-api-router.mjs";
import { PublicApiError } from "../server/public-api-errors.mjs";

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
    searchData: () => ({ courses: [], catalog: [], groups: [] }),
    reviewGroup: (key) => ({ group_key: key, items: [] }),
    assertReviewAttempt: () => {},
    assertMpAuthAttempt: () => true,
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
    "/api/v1/health", "/api/v1/home", "/api/v1/search-index", "/api/v1/guides", "/api/v1/guides/guide-id", "/api/v1/courses", "/api/v1/courses/course-uid", "/api/v1/search-data",
    "/api/v1/courses/course-uid/resources", "/api/v1/review-groups", "/api/v1/review-groups/group-key",
  ]) {
    const response = await invoke(handler, "GET", route);
    assert.equal(response.status, 200, route);
  }
  assert.equal((await invoke(handler, "POST", "/api/v1/reviews")).status, 401, "未登录禁止发布评价（公安合规）");
  {
    const authedHandler = createPublicApiHandler({
      service: serviceFixture(),
      mpAuthService: {
        verifyToken: (auth) => (/^Bearer ok/.test(String(auth || "")) ? { id: 9, nickname: "u" } : null),
        isPhoneVerified: () => true,
      },
      readBody: async () => ({}),
      clientIp: () => "actor",
    });
    const req2 = { method: "POST", headers: { authorization: "Bearer " + "ok".repeat(20) } };
    const res2 = { headers: {}, writableEnded: false, destroyed: false, status: 0, body: "", writeHead(s, h) { this.status = s; }, end(b) { this.body = b; this.writableEnded = true; } };
    await authedHandler(req2, res2, new URL("/api/v1/reviews", "https://nkustudy.top"));
    assert.equal(res2.status, 200, "已登录且手机号已验证可投稿");
  }
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

test("web login issues an httpOnly session cookie, restores via empty call, and logout clears it", async () => {
  const sessions = new Map();
  let nextId = 1;
  const mpAuthService = {
    verifyToken: (authorization) => {
      const match = String(authorization || "").match(/^Bearer (token-\d+)$/);
      return match ? { id: sessions.get(match[1]), nickname: "网页用户", email: "", web_password_hash: "x" } : null;
    },
    requireUser: (authorization) => {
      const user = mpAuthService.verifyToken(authorization);
      if (!user) throw new PublicApiError(401, "未登录或会话已过期。", "AUTH_REQUIRED");
      return user;
    },
    webLogin: (body) => {
      if (body?.nickname !== "网页用户" || body?.password !== "password-123") {
        throw new PublicApiError(401, "昵称或密码不正确。", "AUTH_INVALID_CREDENTIALS");
      }
      const token = `token-${nextId}`;
      sessions.set(token, nextId);
      nextId += 1;
      return { token, expires_in: 2592000, user: { id: sessions.get(token), nickname: "网页用户", email: "", has_web_password: true } };
    },
    revoke: () => true,
  };
  let pendingBody = {};
  const handler = createPublicApiHandler({ service: serviceFixture(), mpAuthService, readBody: async () => pendingBody, clientIp: () => "actor" });

  // 未登录时空请求返回 401，而不是 400（会话恢复语义）
  const restoreAnonymous = await invoke(handler, "POST", "/api/v1/auth/web-login");
  assert.equal(restoreAnonymous.status, 401);
  assert.equal(JSON.parse(restoreAnonymous.body).code, "AUTH_REQUIRED");

  // 凭据登录：签发 httpOnly SameSite=Lax cookie
  pendingBody = { nickname: "网页用户", password: "password-123" };
  const login = await invoke(handler, "POST", "/api/v1/auth/web-login");
  assert.equal(login.status, 200);
  const cookie = String(login.headers["set-cookie"] || "");
  assert.match(cookie, /nkustudy_web_session=token-\d+/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);

  // 带 cookie 的空请求恢复会话，且不重复下发 cookie
  pendingBody = {};
  const token = cookie.match(/nkustudy_web_session=(token-\d+)/)[1];
  const restore = await invoke(handler, "POST", "/api/v1/auth/web-login", { cookie: `other=1; nkustudy_web_session=${token}` });
  assert.equal(restore.status, 200);
  assert.equal(JSON.parse(restore.body).data.user.nickname, "网页用户");
  assert.equal(restore.headers["set-cookie"], undefined, "恢复会话不应重复下发 cookie");

  // 错误密码仍 401
  pendingBody = { nickname: "网页用户", password: "nope" };
  const bad = await invoke(handler, "POST", "/api/v1/auth/web-login");
  assert.equal(bad.status, 401);

  // 登出清理 cookie
  const logout = await invoke(handler, "POST", "/api/v1/auth/logout", { cookie: `nkustudy_web_session=${token}` });
  assert.equal(logout.status, 200);
  assert.match(String(logout.headers["set-cookie"] || ""), /nkustudy_web_session=;.*Max-Age=0/);
});

test("web password change routes require a session and proxy to the service", async () => {
  let changed = null;
  const mpAuthService = {
    verifyToken: () => null,
    requireUser: () => ({ id: 7, nickname: "用户", email: "" }),
    changeWebPassword: (userId, { currentPassword, newPassword }) => {
      if (currentPassword !== "old-password-1") throw new PublicApiError(401, "当前密码不正确。", "AUTH_INVALID_CREDENTIALS");
      changed = { userId, newPassword };
      return true;
    },
  };
  const handler = createPublicApiHandler({
    service: serviceFixture(), mpAuthService,
    readBody: async () => ({ current_password: "old-password-1", new_password: "new-password-1" }),
    clientIp: () => "actor",
  });
  const response = await invoke(handler, "POST", "/api/v1/me/web-password/change");
  assert.equal(response.status, 200);
  assert.deepEqual(changed, { userId: 7, newPassword: "new-password-1" });
});

test("search-data returns compact searchable payload", async () => {
  const service = serviceFixture();
  service.searchData = () => ({
    courses: [{ id: "uid-1", name: "高等数学A（上）" }],
    catalog: [{ id: "cat-1", name: "中国近现代史纲要", teachers: ["朱洪斌"] }],
    groups: [{ name: "高等数学A（上）", teacher: "祝文壮" }],
  });
  const handler = createPublicApiHandler({ service, readBody: async () => ({}), clientIp: () => "actor" });
  const response = await invoke(handler, "GET", "/api/v1/search-data");
  assert.equal(response.status, 200);
  const data = JSON.parse(response.body).data;
  assert.deepEqual(Object.keys(data), ["courses", "catalog", "groups"]);
  assert.deepEqual(data.courses, [{ id: "uid-1", name: "高等数学A（上）" }]);
  assert.match(String(response.headers.etag || ""), /^".+"$/);
});
