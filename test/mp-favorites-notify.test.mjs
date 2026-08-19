import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MpFavoritesService } from "../server/mp-favorites-service.mjs";
import { FeishuNotifyService, feishuSign, isValidFeishuWebhookUrl, buildFeishuCard } from "../server/feishu-notify-service.mjs";
import { PublicApiError } from "../server/public-api-errors.mjs";

const manifest = () => ({
  courses: [
    { id: "course-1", title: "高等数学A", term: "大一上", group: "通识必修", sections: [{ files: [{}, {}] }], review_count: 3 },
    { id: "course-2", title: "线性代数", term: "大一上", group: "通识必修", sections: [{ files: [{}] }], review_count: 0 },
  ],
});

function tempFavorites() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nkustudy-fav-"));
  const service = new MpFavoritesService({ dbPath: path.join(dir, "fav.sqlite"), readManifest: manifest });
  return { service, dir };
}

test("favorites add/remove/list round-trip with course summaries", () => {
  const { service } = tempFavorites();
  const user = { id: 7 };
  assert.deepEqual(service.add(user, "course-1"), { favorited: true, created: true, total: 1 });
  assert.deepEqual(service.add(user, "course-1"), { favorited: true, created: false, total: 1 }, "re-adding is idempotent");
  service.add(user, "course-2");
  const list = service.list(user);
  assert.equal(list.total, 2);
  assert.equal(list.items.length, 2);
  assert.equal(list.items.every((item) => item.name && item.term), true);
  assert.equal(service.list(user, { page: 1, pageSize: 1 }).items.length, 1);
  assert.deepEqual(service.remove(user, "course-2"), { favorited: false, removed: true, total: 1 });
  assert.deepEqual(service.remove(user, "course-2"), { favorited: false, removed: false, total: 1 });
  service.close();
});

test("favorites reject unknown or invalid courses", () => {
  const { service } = tempFavorites();
  assert.throws(() => service.add({ id: 1 }, "missing-course"), (error) => {
    assert.ok(error instanceof PublicApiError);
    assert.equal(error.code, "COURSE_NOT_FOUND");
    return true;
  });
  assert.throws(() => service.add({ id: 1 }, ""), (error) => error.statusCode === 400);
  service.close();
});

test("favorites drop entries for deleted courses on list", () => {
  const { service, dir } = tempFavorites();
  const user = { id: 9 };
  service.add(user, "course-1");
  service.add(user, "course-2");
  const shrunk = new MpFavoritesService({ dbPath: path.join(dir, "fav.sqlite"), readManifest: () => ({ courses: [{ id: "course-1", title: "高等数学A", term: "大一", group: "x" }] }) });
  const list = shrunk.list(user);
  assert.equal(list.total, 1);
  assert.equal(list.items[0].course_id, "course-1");
  shrunk.close();
  service.close();
});

test("feishu webhook url validation and signing", () => {
  assert.equal(isValidFeishuWebhookUrl("https://open.feishu.cn/open-apis/bot/v2/hook/59679e7e-2226-484d-b949-12b7610ae06d"), true);
  assert.equal(isValidFeishuWebhookUrl("https://evil.example/hook/abc"), false);
  const sign = feishuSign(1787000000, "secret-value");
  assert.equal(typeof sign, "string");
  assert.equal(sign.length > 10, true);
  const again = feishuSign(1787000000, "secret-value");
  assert.equal(sign, again, "signing is deterministic");
  assert.notEqual(sign, feishuSign(1787000001, "secret-value"), "signature changes with timestamp");
});

test("feishu card builds interactive message with action button", () => {
  const body = buildFeishuCard({ title: "NKUStudy 待审通知", lines: ["**课程**：高数A", "**评分**：★★★★★"], url: "https://nkustudy.top/admin/" });
  assert.equal(body.msg_type, "interactive");
  assert.equal(body.card.header.title.content, "🔔 NKUStudy 待审通知");
  assert.equal(body.card.elements.some((element) => element.tag === "action"), true);
  assert.equal(body.card.elements.at(-1).actions[0].url, "https://nkustudy.top/admin/");
});

function tempNotify(sendResult = { json: async () => ({ code: 0 }) }) {
  const state = { settings: {}, secrets: {}, sent: [] };
  const service = new FeishuNotifyService({
    readSettings: async () => state.settings,
    writeSettings: async (data) => { state.settings = data; },
    readSecrets: async () => state.secrets,
    writeSecrets: async (data) => { state.secrets = data; },
    fetchImpl: async (url, options) => {
      state.sent.push({ url, body: JSON.parse(options.body) });
      return sendResult;
    },
  });
  return { service, state };
}

test("notify config update validates and masks secrets", async () => {
  const { service, state } = tempNotify();
  await assert.rejects(() => service.updateConfig({ webhookUrl: "https://bad.example/x" }), /格式不正确/);
  await service.updateConfig({ enabled: true, webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/59679e7e-2226-484d-b949-12b7610ae06d", signSecret: "aIINp7NYmAJjjK6wpbAKoh" });
  const described = await service.describe();
  assert.equal(described.enabled, true);
  assert.equal(described.signSecretConfigured, true);
  assert.equal("signSecret" in described, false, "describe must not expose the secret");
  const result = await service.send({ title: "测试", lines: ["内容"] });
  assert.equal(result.sent, true);
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0].body.sign.length > 0, true, "signed when secret configured");
});

test("notify skips when disabled and reports upstream failures", async () => {
  const { service } = tempNotify();
  assert.deepEqual(await service.send({ title: "x", lines: [] }), { sent: false, reason: "disabled-or-invalid" });
  const failing = tempNotify({ json: async () => ({ code: 19021, msg: "sign match fail" }) });
  await failing.service.updateConfig({ enabled: true, webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/59679e7e-2226-484d-b949-12b7610ae06d" });
  const failed = await failing.service.send({ title: "x", lines: [] });
  assert.equal(failed.sent, false);
  assert.match(failed.reason, /feishu-19021/);
});
