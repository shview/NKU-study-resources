import assert from "node:assert/strict";
import test from "node:test";
import { FeishuNotifyService } from "../server/feishu-notify-service.mjs";

function fixture(rawSettings = {}) {
  const written = [];
  const service = new FeishuNotifyService({
    readSettings: async () => structuredClone(rawSettings),
    writeSettings: async (data) => { written.push(data); },
    readSecrets: async () => ({}),
    writeSecrets: async () => {},
  });
  return { service, written };
}

test("describe exposes guide_feedback_enabled with default true", async () => {
  const { service } = fixture({ version: 2, updated: "", bots: [] });
  const described = await service.describe();
  assert.equal(described.guide_feedback_enabled, true);
  const off = await fixture({ version: 2, updated: "", guide_feedback_enabled: false, bots: [] }).service.describe();
  assert.equal(off.guide_feedback_enabled, false);
});

test("setGuideFeedbackEnabled persists the flag and keeps bots", async () => {
  const { service, written } = fixture({ version: 2, updated: "old", bots: [{ id: "b1", name: "A", webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/59679e7e-2226-484d-b949-12b7610ae06d", enabled: true, purposes: ["moderation"] }] });
  const result = await service.setGuideFeedbackEnabled(false);
  assert.equal(result.guide_feedback_enabled, false);
  assert.equal(written.length, 1);
  assert.equal(written[0].bots.length, 1, "机器人配置必须保留");
  assert.equal(written[0].bots[0].id, "b1");
  assert.equal(written[0].guide_feedback_enabled, false);
  const roundTrip = await fixture(structuredClone(written[0])).service.describe();
  assert.equal(roundTrip.guide_feedback_enabled, false);
});
