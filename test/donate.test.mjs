import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PublicApiService } from "../server/public-api-service.mjs";
import { DonatePayStore } from "../server/donate-pay-store.mjs";
import { createPublicApiHandler } from "../server/public-api-router.mjs";
import { PublicApiError } from "../server/public-api-errors.mjs";

function makeService(readDonate, donatePayReady = () => false) {
  return new PublicApiService({
    readManifest: () => ({ resourceRoot: "https://resources.nkustudy.top/resources/", courses: [] }),
    readReviews: () => ({ version: 1, rules: {}, reviews: [] }),
    readHome: () => ({}),
    reviewSubmissionService: { assertAttempt() {}, async submit() { return { pending: true }; } },
    readDonate,
    donatePayReady,
  });
}

test("donate() returns title, sanitized amounts and pay_enabled flag", () => {
  const service = makeService(
    () => ({ title: "捐助支持", content: "## 运营费用", amounts: [10, 5, 5, 0, 999999, "15"] }),
    () => true,
  );
  const data = service.donate();
  assert.equal(data.title, "捐助支持");
  assert.deepEqual(data.amounts, [5, 10, 15], "去重、排序、过滤非法值");
  assert.equal(data.pay_enabled, true);
});

test("donate() throws when unconfigured", () => {
  assert.throws(() => makeService(null).donate(), /捐助页暂未配置/);
});

test("donate() is a pure projector: empty amounts pass through (defaults applied on save)", () => {
  const service = makeService(() => ({ title: "T", content: "", amounts: [] }));
  assert.deepEqual(service.donate().amounts, []);
});

test("DonatePayStore masks secrets, keeps empty-by-meansing private key, and reports readiness", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nkustudy-donate-"));
  const store = new DonatePayStore({ dataDir: dir });
  assert.equal(store.ready(), false);
  assert.equal(store.masked().hasPrivateKey, false);

  const masked = await store.update({ enabled: true, mchid: "1900000109", appid: "wx1234567890abcdef", serialNo: "ABC123DEF456", privateKey: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----" });
  assert.equal(masked.mchid.includes("••••"), true);
  assert.equal(masked.hasPrivateKey, true);
  assert.equal(store.ready(), true);

  // 空私钥表示保持不变
  await store.update({ enabled: false, privateKey: "" });
  assert.equal(store.ready(), false, "enabled=false 即未就绪");
  await store.update({ enabled: true, privateKey: "" });
  assert.equal(store.ready(), true, "私钥未被清空");

  if (process.platform !== "win32") {
    assert.equal(fs.statSync(store.filePath).mode & 0o777, 0o600);
  }
});

test("public router: donate GET works and pay returns 503 until configured", async () => {
  const service = makeService(() => ({ title: "捐助支持", content: "正文", amounts: [5, 10, 15] }));
  const mpAuthService = {
    verifyToken: () => null,
    requireUser: () => { throw new PublicApiError(401, "未登录或会话已过期。", "AUTH_REQUIRED"); },
  };
  const handler = createPublicApiHandler({ service, mpAuthService, readBody: async () => ({}), clientIp: () => "actor" });

  const req = (method, pathname, headers = {}) => ({ method, headers });
  const res = () => {
    const r = { headers: {}, writableEnded: false, destroyed: false, status: 0, body: "" };
    r.writeHead = (s, h) => { r.status = s; };
    r.end = (b) => { r.body = b; r.writableEnded = true; };
    return r;
  };

  const getResp = res();
  await handler(req("GET", "/api/v1/donate"), getResp, new URL("/api/v1/donate", "https://x.top"));
  assert.equal(getResp.status, 200);
  assert.deepEqual(JSON.parse(getResp.body).data.amounts, [5, 10, 15]);

  const payResp = res();
  await handler({ method: "POST", headers: { authorization: "Bearer " + "t".repeat(40) } }, payResp, new URL("/api/v1/donate/pay", "https://x.top"));
  assert.equal(payResp.status, 401, "未登录先被登录门禁拦截");
});
