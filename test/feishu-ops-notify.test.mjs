import assert from "node:assert/strict";
import test from "node:test";
import { FeishuNotifyService } from "../server/feishu-notify-service.mjs";

const hook = (number) => `https://open.feishu.cn/open-apis/bot/v2/hook/aaaaaaaa-bbbb-cccc-dddd-${String(number).padStart(12, "0")}`;
const message = { title: "Synthetic operation alert", lines: ["Synthetic operation status"] };

function fixture({ settings = {}, fetchImpl = async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }) } = {}) {
  const state = { settings: structuredClone(settings), secrets: {}, requests: [] };
  const service = new FeishuNotifyService({
    readSettings: async () => structuredClone(state.settings),
    writeSettings: async (value) => { state.settings = structuredClone(value); },
    readSecrets: async () => structuredClone(state.secrets),
    writeSecrets: async (value) => { state.secrets = structuredClone(value); },
    fetchImpl: async (url, options) => {
      state.requests.push({ url, options });
      return fetchImpl(url, options);
    },
  });
  return { service, state };
}

test("ops notifications require an explicit enabled ops recipient and preserve purpose filtering", async () => {
  const { service, state } = fixture();
  await service.upsertBot({ id: "moderation", webhookUrl: hook(1), purposes: ["moderation"] });
  await service.upsertBot({ id: "digest", webhookUrl: hook(2), purposes: ["digest"] });
  await service.upsertBot({ id: "default", webhookUrl: hook(3) });
  await service.upsertBot({ id: "unknown", webhookUrl: hook(4), purposes: ["future-purpose"] });
  await service.upsertBot({ id: "disabled", webhookUrl: hook(5), purposes: ["ops"], enabled: false });
  assert.deepEqual(await service.broadcast(message, { purpose: "ops" }), { sent: false, results: [], reason: "no-enabled-bots" });
  assert.equal(state.requests.length, 0);
  await service.upsertBot({ id: "ops", webhookUrl: hook(6), purposes: ["ops", "ops", "future-purpose"] });
  const described = await service.describe();
  assert.deepEqual(described.bots.find((bot) => bot.id === "ops").purposes, ["ops"]);
  assert.deepEqual(described.bots.find((bot) => bot.id === "unknown").purposes, ["moderation"], "unknown-purpose normalization stays compatible");
  const ops = await service.broadcast(message, { purpose: "ops" });
  assert.deepEqual(ops.results, [{ bot: "ops", sent: true }]);
  assert.deepEqual(state.requests.map((request) => request.url), [hook(6)]);
  state.requests.length = 0;
  assert.deepEqual((await service.broadcast(message)).results.map((result) => result.bot).sort(), ["default", "moderation", "unknown"]);
  assert.deepEqual((await service.broadcast(message, { purpose: "digest" })).results.map((result) => result.bot), ["digest"]);
  const count = state.requests.length;
  assert.deepEqual(await service.broadcast(message, { purpose: "future-purpose" }), { sent: false, results: [], reason: "no-enabled-bots" });
  assert.equal(state.requests.length, count, "unknown broadcasts must not silently fall back to ops");
});

test("legacy single-bot settings remain moderation-only", async () => {
  const { service, state } = fixture({ settings: { enabled: true, webhookUrl: hook(1) } });
  assert.deepEqual((await service.describe()).bots[0].purposes, ["moderation"]);
  assert.equal((await service.broadcast(message, { purpose: "ops" })).sent, false);
  assert.equal(state.requests.length, 0);
  assert.equal((await service.broadcast(message)).sent, true);
  assert.equal(state.requests.length, 1);
});

test("non-2xx HTTP status is a failed notification even when the payload claims success", async () => {
  for (const status of [302, 401, 429, 500, 503]) {
    for (const payload of [{ code: 0 }, { StatusCode: 0 }]) {
      const { service } = fixture({ fetchImpl: async () => new Response(JSON.stringify(payload), { status }) });
      await service.upsertBot({ id: "ops", webhookUrl: hook(1), purposes: ["ops"] });
      const result = await service.broadcast(message, { purpose: "ops" });
      assert.equal(result.sent, false);
      assert.deepEqual(result.results, [{ bot: "ops", sent: false, reason: `feishu-http-${status}` }]);
    }
  }
  for (const payload of [{ code: 0 }, { StatusCode: 0 }]) {
    const { service } = fixture({ fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }) });
    await service.upsertBot({ id: "ops", webhookUrl: hook(1), purposes: ["ops"] });
    assert.equal((await service.broadcast(message, { purpose: "ops" })).sent, true);
  }
});

test("notification network failures remain non-throwing and omit raw transport errors", async () => {
  for (const error of [new Error("SYNTHETIC-SECRET-URL"), new DOMException("SYNTHETIC-SECRET-URL", "TimeoutError"), null]) {
    const { service } = fixture({ fetchImpl: async () => { throw error; } });
    await service.upsertBot({ id: "ops", webhookUrl: hook(1), purposes: ["ops"] });
    const result = await service.broadcast(message, { purpose: "ops" });
    assert.equal(result.sent, false);
    assert.equal(result.results[0].reason, error?.name === "TimeoutError" ? "timeout" : "network");
    assert.equal(JSON.stringify(result).includes("SYNTHETIC-SECRET"), false);
  }
});
