import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MpAuthService } from "../server/mp-auth-service.mjs";
import { PublicApiError } from "../server/public-api-errors.mjs";

function stubFetch() {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const code = new URL(String(url)).searchParams.get("js_code");
    if (code === "good-code-1" || code === "good-code-2") {
      return { json: async () => ({ openid: code === "good-code-1" ? "openid-alpha" : "openid-beta" }) };
    }
    if (code === "expired-code") return { json: async () => ({ errcode: 40029, errmsg: "invalid code" }) };
    if (code === "flooded-code") return { json: async () => ({ errcode: 45011, errmsg: "api minute-quota reach limit" }) };
    throw new Error("network down");
  };
  return { impl, calls };
}

function tempService(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nkustudy-mpauth-"));
  const fetchStub = stubFetch();
  const service = new MpAuthService({
    dbPath: path.join(dir, "mp.sqlite"),
    appid: "wx-test-appid",
    secret: "test-secret-value",
    fetchImpl: fetchStub.impl,
    ...options,
  });
  return { service, dir, fetchStub };
}

test("login exchanges code, returns token and user without openid", async () => {
  const { service } = tempService();
  const result = await service.loginWithCode("good-code-1");
  assert.match(result.token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(typeof result.expires_in, "number");
  assert.equal(result.user.nickname, "");
  assert.equal("openid" in result.user, false, "openid must never leak to the client");
  assert.equal(Object.keys(result.user).includes("openid"), false);
  service.close();
});

test("same openid reuses the user and bumps login_count", async () => {
  const { service } = tempService();
  const first = await service.loginWithCode("good-code-1");
  const second = await service.loginWithCode("good-code-1");
  assert.equal(second.user.id, first.user.id);
  const overview = service.adminOverview();
  assert.equal(overview.total, 1);
  assert.equal(overview.users[0].login_count, 2);
  assert.equal(overview.users[0].openid_masked.includes("openid-alpha"), false, "mask must not reveal the full openid");
  service.close();
});

test("verifyToken accepts Bearer tokens and rejects everything else", async () => {
  const { service } = tempService();
  const { token } = await service.loginWithCode("good-code-1");
  assert.equal(service.verifyToken(`Bearer ${token}`)?.id >= 1, true);
  assert.equal(service.verifyToken(`bearer ${token}`), null);
  assert.equal(service.verifyToken(`Bearer ${token}extra`), null);
  assert.equal(service.verifyToken(""), null);
  const other = await service.loginWithCode("good-code-2");
  assert.equal(service.verifyToken(`Bearer ${other.token}`)?.id >= 1, true);
  service.close();
});

test("expired code and upstream failures map to public errors", async () => {
  const { service } = tempService();
  await assert.rejects(() => service.loginWithCode("expired-code"), (error) => {
    assert.ok(error instanceof PublicApiError);
    assert.equal(error.statusCode, 401);
    assert.equal(error.code, "AUTH_INVALID_CODE");
    return true;
  });
  await assert.rejects(() => service.loginWithCode("flooded-code"), (error) => {
    assert.equal(error.statusCode, 429);
    return true;
  });
  service.close();
});

test("network failure becomes MP_AUTH_UPSTREAM", async () => {
  const { service } = tempService();
  await assert.rejects(() => service.loginWithCode("network-fail-code"), (error) => {
    assert.ok(error instanceof PublicApiError);
    assert.equal(error.code, "MP_AUTH_UPSTREAM");
    return true;
  });
  service.close();
});

test("malformed codes are rejected before hitting WeChat", async () => {
  const { service, fetchStub } = tempService();
  await assert.rejects(() => service.loginWithCode("short"), (error) => {
    assert.equal(error.statusCode, 400);
    return true;
  });
  await assert.rejects(() => service.loginWithCode(""), (error) => error.statusCode === 400);
  assert.equal(fetchStub.calls.length, 0, "no upstream call for invalid formats");
  service.close();
});

test("unconfigured service refuses login with 503", async () => {
  const { service } = tempService({ appid: "", secret: "" });
  await assert.rejects(() => service.loginWithCode("good-code-1"), (error) => {
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "MP_AUTH_NOT_CONFIGURED");
    return true;
  });
  service.close();
});

test("updateProfile sanitizes nickname and avatar url", async () => {
  const { service } = tempService();
  const { user, token } = await service.loginWithCode("good-code-1");
  const updated = service.updateProfile(user, { nickname: "  弋皓  ", avatarUrl: "https://example.com/a.png" });
  assert.equal(updated.nickname, "弋皓");
  assert.equal(updated.avatar_url, "https://example.com/a.png");
  const reloaded = service.verifyToken(`Bearer ${token}`);
  const cleared = service.updateProfile(reloaded, { avatarUrl: "http://insecure.example/x.png" });
  assert.equal(cleared.avatar_url, "", "non-https avatar urls are dropped");
  service.close();
});

test("revoke invalidates the token server-side", async () => {
  const { service } = tempService();
  const { token } = await service.loginWithCode("good-code-1");
  assert.equal(service.revoke(`Bearer ${token}`), true);
  assert.equal(service.verifyToken(`Bearer ${token}`), null);
  assert.equal(service.revoke(`Bearer ${token}`), false);
  service.close();
});

test("requireUser raises AUTH_REQUIRED when missing", async () => {
  const { service } = tempService();
  assert.throws(() => service.requireUser(undefined), (error) => {
    assert.equal(error.statusCode, 401);
    assert.equal(error.code, "AUTH_REQUIRED");
    return true;
  });
  service.close();
});

test("blocked users cannot log in and their sessions die", async () => {
  const { service } = tempService();
  const first = await service.loginWithCode("good-code-1");
  const blocked = service.setUserBlocked(first.user.id, true);
  assert.equal(blocked.blocked, 1);
  await assert.rejects(() => service.loginWithCode("good-code-1"), (error) => {
    assert.ok(error instanceof PublicApiError);
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, "AUTH_USER_BLOCKED");
    return true;
  });
  assert.equal(service.verifyToken(`Bearer ${first.token}`), null, "existing sessions are revoked by the block");
  service.setUserBlocked(first.user.id, false);
  const again = await service.loginWithCode("good-code-1");
  assert.equal(again.user.id, first.user.id);
  assert.throws(() => service.setUserBlocked(9999, true), (error) => error.statusCode === 404);
  service.close();
});

test("admin overview includes blocked flag", async () => {
  const { service } = tempService();
  const { user } = await service.loginWithCode("good-code-1");
  service.setUserBlocked(user.id, true);
  const overview = service.adminOverview();
  assert.equal(overview.users[0].blocked, true);
  service.close();
});

test("keyword flagged reviews are forced pending with a hit record", async () => {
  const { reviewKeywordMatch } = await import("../server/review-keyword-filter.mjs");
  assert.equal(reviewKeywordMatch("这老师电话 13812345678 人很好").length > 0, true);
  assert.equal(reviewKeywordMatch("加微信 nkustudy2026 拿资料").length > 0, true);
  assert.equal(reviewKeywordMatch("邮箱 a.b@nankai.edu.cn").length > 0, true);
  assert.equal(reviewKeywordMatch("课程内容扎实，考核合理，推荐。").length, 0);
  assert.equal(reviewKeywordMatch("这个老师真的 傻逼 吧").length > 0, true);
  assert.equal(reviewKeywordMatch("正常评价", ["代写", "刷分"]).length, 0);
  assert.equal(reviewKeywordMatch("可以代写作业", ["代写"]).length > 0, true);
});
