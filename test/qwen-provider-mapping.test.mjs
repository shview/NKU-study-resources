import assert from "node:assert/strict";
import test from "node:test";
import { createQwenProviderFromSettings, createQwenProviderFromEnv } from "../server/qwen-provider.mjs";

function withFetchStub(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = original;
  });
}

test("settings provider maps snake_case runtime config to client fields (regression: Bearer undefined 401)", async () => {
  const runtime = {
    enabled: true,
    api_key: "sk-runtime-key",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.7-plus",
    max_tokens: 3000,
  };
  const seen = [];
  await withFetchStub(async (url, init) => {
    seen.push({ url: String(url), auth: init.headers.authorization, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
  }, async () => {
    const provider = createQwenProviderFromSettings(() => runtime);
    const output = await provider([{ role: "user", content: "hi" }], { timeoutMs: 1000 });
    assert.equal(output, "ok");
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.equal(seen[0].auth, "Bearer sk-runtime-key", "运行时 api_key 必须正确映射为 Bearer");
  assert.equal(seen[0].body.model, "qwen3.7-plus");
  assert.equal(seen[0].body.max_tokens, 3000);
  assert.equal(seen[0].body.stream, false);
  assert.deepEqual(Object.keys(seen[0].body).sort(), ["max_tokens", "messages", "model", "stream"], "不使用 response_format/JSON mode/额外参数");
});

test("settings provider returns null when disabled or key missing", async () => {
  const disabled = createQwenProviderFromSettings(() => ({ enabled: false, api_key: "sk", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "m", max_tokens: 100 }));
  assert.equal(await disabled([{ role: "user", content: "x" }]), null);
  const noKey = createQwenProviderFromSettings(() => ({ enabled: true, api_key: "", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "m", max_tokens: 100 }));
  assert.equal(await noKey([{ role: "user", content: "x" }]), null);
});

test("provider errors carry http status and non-sensitive provider code", async () => {
  await withFetchStub(async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: { code: "invalid_api_key", message: "sensitive detail" } }),
  }), async () => {
    const provider = createQwenProviderFromEnv({ DASHSCOPE_API_KEY: "sk-bad" });
    await assert.rejects(
      () => provider([{ role: "user", content: "hi" }]),
      (error) => error.status === 401 && error.providerCode === "invalid_api_key" && /qwen http 401/.test(error.message),
    );
  });
});
