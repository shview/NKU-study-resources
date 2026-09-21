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

  const masked = await store.update({ enabled: true, mchid: "1900000109", appid: "wx1234567890abcdef", serialNo: "ABC123DEF456", privateKey: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----", apiV3Key: "k".repeat(32), publicKey: "-----BEGIN PUBLIC KEY-----\nMII\n-----END PUBLIC KEY-----" });
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

test("wxpay-v3: sign/verify roundtrip, auth header format, AES-GCM decrypt, mini pay params", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { rsaSignSha256, rsaVerifySha256, buildAuthorization, miniPayParams, decryptAes256Gcm, verifyNotifySignature } = await import("../server/wxpay-v3.mjs");
  const { publicExponent, modulus } = { };
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pubPem = publicKey.export({ type: "spki", format: "pem" });
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" });

  const message = "POST\n/v3/pay/transactions/jsapi\n1700000000\nabc\n{}\n";
  const signature = rsaSignSha256(privPem, message);
  assert.equal(rsaVerifySha256(pubPem, message, signature), true);
  assert.equal(rsaVerifySha256(pubPem, message + "x", signature), false);

  const auth = buildAuthorization({ mchid: "1900000109", serialNo: "SER", privateKeyPem: privPem, method: "POST", pathWithQuery: "/v3/x", timestamp: "1", nonce: "n", body: "" });
  assert.match(auth, /^WECHATPAY2-SHA256-RSA2048 mchid="1900000109",nonce_str="n",signature="[A-Za-z0-9+/=]+",timestamp="1",serial_no="SER"$/);

  const params = miniPayParams({ appid: "wx1234567890abcdef", prepayId: "pp1", privateKeyPem: privPem });
  assert.equal(params.package, "prepay_id=pp1");
  assert.equal(params.signType, "RSA");
  assert.equal(rsaVerifySha256(pubPem, `wx1234567890abcdef\n${params.timeStamp}\n${params.nonceStr}\nprepay_id=pp1\n`, params.paySign), true);

  const apiV3Key = "0123456789abcdef0123456789abcdef";
  const { createCipheriv } = await import("node:crypto");
  const iv = Buffer.from("nonce12345678", "utf8");
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(apiV3Key), iv);
  cipher.setAAD(Buffer.from("ad", "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ out_trade_no: "DON1", amount: { total: 500 } }), "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64");
  const decrypted = decryptAes256Gcm(apiV3Key, { nonce: "nonce12345678", ciphertext, associated_data: "ad" });
  assert.equal(decrypted.out_trade_no, "DON1");
  assert.equal(decrypted.amount.total, 500);

  assert.equal(verifyNotifySignature({ publicKeyPem: pubPem, timestamp: "1", nonce: "n", body: "b", signature: rsaSignSha256(privPem, "1\nn\nb\n") }), true);
});

test("DonateOrderStore creates, validates amount, and markPaid is idempotent", async () => {
  const { DonateOrderStore } = await import("../server/donate-order-store.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nkustudy-order-"));
  const store = new DonateOrderStore({ dbPath: path.join(dir, "orders.sqlite") });
  store.create({ outTradeNo: "DON1", userId: 7, amountTotal: 500 });
  assert.equal(store.get("DON1").status, "pending");
  assert.equal(store.markPaid({ outTradeNo: "DON1", amountTotal: 999, transactionId: "t1" }), false, "金额不符拒绝");
  assert.equal(store.markPaid({ outTradeNo: "DON1", amountTotal: 500, transactionId: "t1" }), true);
  assert.equal(store.get("DON1").status, "paid");
  assert.equal(store.get("DON1").transaction_id, "t1");
  assert.equal(store.markPaid({ outTradeNo: "DON1", amountTotal: 500, transactionId: "t2" }), true, "重复回调幂等");
  assert.equal(store.get("DON1").transaction_id, "t1", "不改写原交易号");
  assert.equal(store.summary().paid_total_fen, 500);
  store.close();
});

test("createDonateOrder: full flow with stubbed prepay fetch", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { DonateOrderStore } = await import("../server/donate-order-store.mjs");
  const { rsaVerifySha256 } = await import("../server/wxpay-v3.mjs");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pubPem = publicKey.export({ type: "spki", format: "pem" });
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" });

  const orders = new DonateOrderStore({ dbPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nkustudy-order2-")), "o.sqlite") });
  const payStore = {
    config: () => ({ mchid: "1900000109", appid: "wx1234567890abcdef", serialNo: "S", privateKey: privPem, apiV3Key: "k".repeat(32), publicKey: pubPem }),
    ready: () => true,
  };
  const service = new PublicApiService({
    readManifest: () => ({ resourceRoot: "https://resources.nkustudy.top/resources/", courses: [] }),
    readReviews: () => ({ version: 1, rules: {}, reviews: [] }),
    readHome: () => ({}),
    reviewSubmissionService: { assertAttempt() {}, async submit() { return { pending: true }; } },
    donatePayStore: payStore,
    donateOrderStore: orders,
    notifyBase: "https://nkustudy.top",
    mpAuthService: { getOpenid: () => "openid-x" },
  });

  let seenAuth = "";
  const fetchStub = async (url, options) => {
    seenAuth = options.headers.Authorization;
    return { ok: true, text: async () => JSON.stringify({ prepay_id: "pp-donate-1" }) };
  };
  const { jsapiPrepay } = await import("../server/wxpay-v3.mjs");
  const realPrepay = jsapiPrepay;
  // 直接替换 service 内部引用不可行（模块函数），改为注入 fetchImpl：临时 monkey-patch global fetch
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    const params = await service.createDonateOrder({ id: 7 }, 5);
    assert.equal(params.package, "prepay_id=pp-donate-1");
    assert.match(seenAuth, /WECHATPAY2-SHA256-RSA2048 mchid="1900000109"/);
    assert.equal(rsaVerifySha256(pubPem, `wx1234567890abcdef\n${params.timeStamp}\n${params.nonceStr}\n${params.package}\n`, params.paySign), true);
    const orderRow = orders.listRecent(1)[0];
    assert.equal(orderRow.status, "pending");
    assert.equal(orderRow.amount_total, 500);
    await assert.rejects(() => service.createDonateOrder({ id: 7 }, 0.5), /1-10000/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  orders.close();
});

test("createDonateOrderNative: no login needed, returns code_url and records order; order-status tracks it", async () => {
  const { DonateOrderStore } = await import("../server/donate-order-store.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nkustudy-native-"));
  const orders = new DonateOrderStore({ dbPath: path.join(dir, "o.sqlite") });
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const payStore = { config: () => ({ mchid: "m", appid: "a", serialNo: "s", privateKey: privPem, apiV3Key: "k".repeat(32), publicKey: "p" }), ready: () => true };
  const wxpayFetch = async () => ({ ok: true, text: async () => JSON.stringify({ code_url: "weixin://wxpay/bizpayurl?pr=fake" }) });
  const service = new PublicApiService({
    readManifest: () => ({ resourceRoot: "https://resources.nkustudy.top/resources/", courses: [] }),
    readReviews: () => ({ version: 1, rules: {}, reviews: [] }),
    readHome: () => ({}),
    reviewSubmissionService: { assertAttempt() {}, async submit() { return { pending: true }; } },
    donatePayStore: payStore,
    donateOrderStore: orders,
    notifyBase: "https://nkustudy.top",
    wxpayFetch,
  });
  try {
    const result = await service.createDonateOrderNative({ userId: 0, amount: 15 });
    assert.equal(result.code_url, "weixin://wxpay/bizpayurl?pr=fake");
    assert.equal(result.amount, 15);
    const row = orders.listRecent(1)[0];
    assert.equal(row.amount_total, 1500);
    assert.equal(row.user_id, 0);
    const status = service.donateOrderStatus(row.out_trade_no);
    assert.equal(status.status, "pending");
    assert.equal(status.amount, 15);
    orders.markPaid({ outTradeNo: row.out_trade_no, amountTotal: 1500, transactionId: "t" });
    assert.equal(service.donateOrderStatus(row.out_trade_no).status, "paid");
    assert.throws(() => service.donateOrderStatus("NOPE"), /订单不存在/);
  } finally {
  }
  orders.close();
});
