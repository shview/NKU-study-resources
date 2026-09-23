import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AtomicJsonStore } from "../server/atomic-json-store.mjs";
import { AiProviderStore } from "../server/ai-provider-store.mjs";

function fixture(seedEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ai-provider-"));
  const store = new AtomicJsonStore({ allowedRoot: dir });
  const ai = new AiProviderStore({ store, filePath: path.join(dir, "ai-settings.json"), seedEnv });
  return { dir, store, ai };
}

test("defaults come from env seed and never leak into masked reads", () => {
  const { ai } = fixture({ DASHSCOPE_API_KEY: "sk-test-1234", QWEN_MODEL: "qwen-max" });
  const masked = ai.masked();
  assert.equal(masked.has_api_key, true);
  assert.equal(masked.api_key_masked, "••••1234");
  assert.equal(masked.model, "qwen-max");
  assert.equal("api_key" in masked, false, "明文 Key 不得出现在掩码读取");
  assert.equal(ai.runtime().api_key, "sk-test-1234");
});

test("update persists settings and key, keeping previous key when omitted", async () => {
  const { ai, dir } = fixture({});
  await ai.update({ settings: { model: "qwen-turbo", daily_limit_per_user: 5 }, apiKey: "sk-abc9999xyz" });
  let masked = ai.masked();
  assert.equal(masked.model, "qwen-turbo");
  assert.equal(masked.daily_limit_per_user, 5);
  assert.equal(masked.api_key_masked, "••••9xyz");
  await ai.update({ settings: { model: "qwen-plus" } });
  masked = ai.masked();
  assert.equal(masked.model, "qwen-plus");
  assert.equal(masked.has_api_key, true, "未提供新 Key 时保留旧 Key");
  const raw = JSON.parse(readFileSync(path.join(dir, "ai-settings.json"), "utf8"));
  assert.equal(raw.api_key, "sk-abc9999xyz");
  if (process.platform !== "win32") {
    const mode = statSync(path.join(dir, "ai-settings.json")).mode & 0o777;
    assert.equal(mode, 0o600, "配置文件必须 0600");
  }
});

test("clearApiKey removes the key and clamps invalid values", async () => {
  const { ai } = fixture({});
  await ai.update({ apiKey: "sk-x", settings: { max_tokens: 999999, daily_limit_per_user: -3, base_url: "http://evil.example.com/v1" } });
  const runtime = ai.runtime();
  assert.equal(runtime.max_tokens, 8192);
  assert.equal(runtime.daily_limit_per_user, 1);
  assert.equal(runtime.base_url, "https://dashscope.aliyuncs.com/compatible-mode/v1", "非阿里云 HTTP 地址回退默认");
  const masked = await ai.update({ clearApiKey: true });
  assert.equal(masked.has_api_key, false);
  assert.equal(ai.runtime().api_key, "");
});

test("disabled flag is honored by runtime projection", async () => {
  const { ai } = fixture({ DASHSCOPE_API_KEY: "sk-live" });
  await ai.update({ settings: { enabled: false } });
  const runtime = ai.runtime();
  assert.equal(runtime.enabled, false);
  assert.equal(runtime.api_key, "sk-live");
});

test("cleanup temp dirs", () => {
  // node:test 每个用例独立 fixture；此处仅确保删除 API 存在且不抛错
  const { dir } = fixture({});
  rmSync(dir, { recursive: true, force: true });
});
