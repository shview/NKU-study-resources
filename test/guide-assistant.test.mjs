import assert from "node:assert/strict";
import test from "node:test";
import { createGuideAssistantService } from "../server/guide-assistant-service.mjs";
import { createDefaultLearningCompassService } from "../server/learning-compass-service.mjs";

const learningCompass = createDefaultLearningCompassService();

function service({ qwen = async () => "根据《南开大学本科课程考试与成绩管理规定》，成绩复核应在下一学期开学3周内向开课单位提出书面申请。", limiter = null } = {}) {
  return createGuideAssistantService({ learningCompass, qwen, limiter });
}

test("rejects invalid question, history, and profile before any provider call", async () => {
  const svc = service({ qwen: async () => { throw new Error("provider must not be called"); } });
  await assert.rejects(() => svc.answer(1, {}), /question/);
  await assert.rejects(() => svc.answer(1, { question: " ".repeat(5) }), /question/);
  await assert.rejects(() => svc.answer(1, { question: "成绩复核怎么办", extra: 1 }), /不允许的字段/);
  await assert.rejects(() => svc.answer(1, { question: "成绩复核怎么办", history: [{ role: "system", content: "x" }] }), /role/);
  await assert.rejects(() => svc.answer(1, { question: "成绩复核怎么办", profile: { admission_year: 1999 } }), /admission_year/);
  await assert.rejects(() => svc.answer(1, { question: "成绩复核怎么办", profile: { major: "x".repeat(101) } }), /major/);
  await assert.rejects(() => svc.answer(null, { question: "成绩复核怎么办" }), /登录/);
});

test("conflict topic refuses with SOURCE_CONFLICT without calling provider", async () => {
  const svc = service({ qwen: async () => { throw new Error("provider must not be called"); } });
  const result = await svc.answer(1, { question: "自修课程的GPA和门数怎么算？" });
  assert.equal(result.refused, true);
  assert.equal(result.reason, "SOURCE_CONFLICT");
  assert.deepEqual(result.citations, []);
});

test("out-of-scope question refuses with INSUFFICIENT_EVIDENCE", async () => {
  const svc = service({ qwen: async () => { throw new Error("provider must not be called"); } });
  const result = await svc.answer(1, { question: "明天NBA总决赛谁会赢？" });
  assert.equal(result.refused, true);
  assert.equal(result.reason, "INSUFFICIENT_EVIDENCE");
});

test("evidence-backed answer returns citations from matched sources", async () => {
  const calls = [];
  const svc = service({
    qwen: async (messages, options) => {
      calls.push({ messages, options });
      return "根据规定，学生可在下一学期开学3周内向开课单位提出书面复核申请。";
    },
  });
  const result = await svc.answer(1, {
    question: "课程成绩有异议，如何申请复核？",
    history: [{ role: "user", content: "上一轮问了选课" }, { role: "assistant", content: "上一轮回答" }],
    profile: { admission_year: 2025, major: "计算机科学与技术" },
  });
  assert.equal(result.refused, false);
  assert.equal(result.reason, null);
  assert.ok(result.answer.includes("3周"));
  assert.ok(result.citations.length >= 1);
  assert.equal(result.citations[0].file_url.startsWith("https://resources.nkustudy.top/guide-sources/"), true);
  assert.equal(Object.hasOwn(result.citations[0], "markdown_file"), false);
  const prompt = calls[0].messages[1].content;
  assert.ok(prompt.includes("【依据1"));
  assert.ok(prompt.includes("计算机科学与技术"));
  assert.ok(calls[0].messages[0].content.includes("只能依据"));
});

test("provider failure retries once then maps to 503 AI_UNAVAILABLE", async () => {
  let attempts = 0;
  const svc = service({
    qwen: async () => {
      attempts += 1;
      throw new Error("boom");
    },
  });
  await assert.rejects(() => svc.answer(1, { question: "课程成绩有异议，如何申请复核？" }), (error) => error.statusCode === 503 && error.code === "AI_UNAVAILABLE");
  assert.equal(attempts, 2);
});

test("missing provider is a stable 503 instead of a crash", async () => {
  const svc = createGuideAssistantService({ learningCompass, qwen: null });
  await assert.rejects(() => svc.answer(1, { question: "课程成绩有异议，如何申请复核？" }), (error) => error.statusCode === 503 && error.code === "AI_UNAVAILABLE");
});

test("limiter is consulted per user and maps to 429", async () => {
  const seen = [];
  const svc = service({ limiter: (userId) => { seen.push(userId); return false; } });
  await assert.rejects(() => svc.answer(42, { question: "课程成绩有异议，如何申请复核？" }), (error) => error.statusCode === 429 && error.code === "RATE_LIMITED");
  assert.deepEqual(seen, [42]);
});
