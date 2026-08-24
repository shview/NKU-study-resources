import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ServiceAuthStore } from "../server/service-auth-store.mjs";
import { PersistentRateLimiter } from "../server/persistent-rate-limiter.mjs";
import { PublicApiService } from "../server/public-api-service.mjs";
import { PublicApiError } from "../server/public-api-errors.mjs";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nkustudy-svc-"));
}

function fakeStore(dir) {
  const root = dir;
  return {
    async read(file) {
      const full = path.join(root, path.basename(file));
      return JSON.parse(fs.readFileSync(full, "utf8"));
    },
    async update(file, updater, options = {}) {
      const full = path.join(root, path.basename(file));
      let current = {};
      try {
        current = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch {
        current = {};
      }
      const next = updater(JSON.parse(JSON.stringify(current)));
      fs.writeFileSync(full, JSON.stringify(next), { mode: options.mode || 0o600 });
      return next;
    },
  };
}

function serviceFixture() {
  const dir = tempDir();
  const limiter = new PersistentRateLimiter({ dbPath: path.join(dir, "limits.sqlite") });
  const reviewSubmissionService = {
    assertAttempt() { return true; },
    readRules() { return { submissionOptions: {} }; },
    async submit() { return { pending: true }; },
  };
  const service = new PublicApiService({
    readManifest: () => ({ courses: [] }),
    readReviews: () => ({ reviews: [] }),
    readHome: () => ({}),
    reviewSubmissionService,
    mpAuthService: {
      introspectToken(token) {
        if (token === "Bearer good-token") return { active: true, user_id: 7, nickname: "同学", blocked: false, expires_at: 1893456000000 };
        if (token === "Bearer blocked-token") return { active: false, reason: "blocked", user_id: 8, nickname: "违规", blocked: true, expires_at: 1893456000000 };
        if (token === "Bearer expired-token") return { active: false, reason: "expired", expires_at: 1 };
        return { active: false, reason: "revoked" };
      },
      blacklistStatus(ids) {
        return ids.map((id) => ({ user_id: id, exists: id !== 404, blocked: id === 8 }));
      },
    },
    serviceRateLimiter: limiter,
  });
  return { service, limiter, dir };
}

test("service keys are created once, verified by hash, and revocable", async () => {
  const dir = tempDir();
  const store = new ServiceAuthStore({ store: fakeStore(dir), filePath: "service-keys.json" });
  const created = await store.create({ name: "guide-bot", note: "邵游堃的指南服务", dailyQuota: 123 });
  assert.match(created.key, /^nkusvc_[A-Za-z0-9_-]{32}$/);

  const caller = await store.verify(created.key);
  assert.equal(caller.name, "guide-bot");
  assert.equal(caller.limits.daily_quota, 123, "创建时指定的每日额度生效");
  await store.setDailyQuota(created.id, 456);
  assert.equal((await store.verify(created.key)).limits.daily_quota, 456, "额度可修改");
  assert.equal(await store.verify("nkusvc_wrong-key-value"), null);
  assert.equal(await store.verify(""), null);

  await assert.rejects(() => store.create({ name: "guide-bot" }), /同名服务/);
  await store.setEnabled(created.id, false);
  assert.equal(await store.verify(created.key), null, "disabled keys stop working immediately");
  await store.setEnabled(created.id, true);
  assert.ok(await store.verify(created.key));

  await store.remove(created.id);
  assert.equal(await store.verify(created.key), null);
  const listed = await store.list();
  assert.equal(listed.services.length, 0);
  assert.equal(JSON.stringify(listed).includes(created.key), false, "listing never leaks the raw key");
});

test("introspection distinguishes active, blocked, expired and revoked tokens", () => {
  const { service } = serviceFixture();
  assert.equal(service.serviceVerifyToken("good-token").user_id, 7);
  const blocked = service.serviceVerifyToken("blocked-token");
  assert.equal(blocked.active, false);
  assert.equal(blocked.reason, "blocked");
  assert.equal(service.serviceVerifyToken("expired-token").reason, "expired");
  assert.equal(service.serviceVerifyToken("Bearer revoked").reason, "revoked");
});

test("blacklist bulk check caps input and reports blocked state", () => {
  const { service } = serviceFixture();
  const result = service.serviceBlacklist([7, 8, 404, "9"]);
  const byId = Object.fromEntries(result.users.map((row) => [row.user_id, row]));
  assert.equal(byId[7].blocked, false);
  assert.equal(byId[8].blocked, true);
  assert.equal(byId[404].exists, false);
  assert.equal(result.users.length, 4);
  assert.equal(service.serviceBlacklist([...Array(200).keys()]).users.length, 100, "超过 100 个只取前 100");
});

test("service rate limit namespaces scopes, counts down and resets", () => {
  const { service } = serviceFixture();
  const svcTest = { id: "svc-test", settings: { max_limit: 10_000, max_window_ms: 86_400_000, default_daily_quota: 50_000 }, limits: { daily_quota: 1000 } };
  const svcOther = { id: "svc-other", settings: svcTest.settings, limits: svcTest.limits };
  const call = (caller, body) => service.serviceRateLimit(caller, body);
  const first = call(svcTest, { scope: "chat", key: "user-7", limit: 2, window_ms: 60_000 });
  assert.equal(first.allowed, true);
  assert.equal(first.remaining, 1);
  const second = call(svcTest, { scope: "chat", key: "user-7", limit: 2, window_ms: 60_000 });
  assert.equal(second.allowed, true);
  assert.equal(second.remaining, 0);
  const third = call(svcTest, { scope: "chat", key: "user-7", limit: 2, window_ms: 60_000 });
  assert.equal(third.allowed, false);
  assert.ok(third.retry_after_ms > 0);

  const otherKey = call(svcTest, { scope: "chat", key: "user-8", limit: 2, window_ms: 60_000 });
  assert.equal(otherKey.allowed, true, "不同 key 互不影响");
  const otherService = call(svcOther, { scope: "chat", key: "user-7", limit: 2, window_ms: 60_000 });
  assert.equal(otherService.allowed, true, "不同服务命名空间互不影响");

  assert.throws(() => call(svcTest, { scope: "x", key: "y", limit: 0, window_ms: 1000 }), PublicApiError);
  assert.throws(() => call(svcTest, { scope: "x", key: "y", limit: 5, window_ms: 10 }), PublicApiError);
  assert.throws(() => call(svcTest, { scope: "", key: "y", limit: 5, window_ms: 1000 }), PublicApiError);
});

test("settings caps are persisted and shrink rate-limit validation", async () => {
  const dir = tempDir();
  const store = new ServiceAuthStore({ store: fakeStore(dir), filePath: "service-keys.json" });
  await store.writeSettings({ max_limit: 5, max_window_ms: 10_000, default_daily_quota: 999 });
  const listed = await store.list();
  assert.equal(listed.settings.max_limit, 5);
  assert.equal(listed.settings.max_window_ms, 10_000);
  assert.equal(listed.settings.default_daily_quota, 999);
  const created = await store.create({ name: "capped" });
  assert.equal(created.limits.daily_quota, 999, "新服务使用默认每日额度");
  const verified = await store.verify(created.key);
  assert.equal(verified.settings.max_limit, 5, "verify 携带 settings 供限额校验");

  const limiter = new PersistentRateLimiter({ dbPath: path.join(dir, "l.sqlite") });
  const reviewSubmissionService = { assertAttempt() { return true; }, readRules() { return { submissionOptions: {} }; }, async submit() { return { pending: true }; } };
  const service = new PublicApiService({
    readManifest: () => ({ courses: [] }), readReviews: () => ({ reviews: [] }), readHome: () => ({}),
    reviewSubmissionService,
    mpAuthService: { introspectToken: () => ({ active: false }), blacklistStatus: () => [] },
    serviceRateLimiter: limiter,
  });
  assert.throws(() => service.serviceRateLimit(verified, { scope: "s", key: "k", limit: 6, window_ms: 10_000 }), /limit 需在 1-5/, "超过配置上限被拒");
  assert.throws(() => service.serviceRateLimit(verified, { scope: "s", key: "k", limit: 5, window_ms: 20_000 }), /window_ms 需在/, "超过窗口上限被拒");
  const ok = service.serviceRateLimit(verified, { scope: "s", key: "k", limit: 5, window_ms: 10_000 });
  assert.equal(ok.allowed, true);
});

test("rate limiter peek is read-only", () => {
  const dir = tempDir();
  const limiter = new PersistentRateLimiter({ dbPath: path.join(dir, "peek.sqlite") });
  limiter.consume({ scope: "s", actorHash: "a", limits: [{ windowMs: 60_000, max: 5 }] });
  const peeked = limiter.peek({ scope: "s", actorHash: "a", windowMs: 60_000 });
  assert.equal(peeked.count, 1);
  assert.equal(limiter.peek({ scope: "s", actorHash: "a", windowMs: 60_000 }).count, 1, "peek does not consume");
});
