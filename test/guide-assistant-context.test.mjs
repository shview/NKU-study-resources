import assert from "node:assert/strict";
import test from "node:test";
import { createGuideAssistantService } from "../server/guide-assistant-service.mjs";
import { createDefaultLearningCompassService, createLearningCompassService, loadLearningCompassSnapshot } from "../server/learning-compass-service.mjs";
import { resolveIntent, retrieveEvidence, parseProviderAnswer } from "../server/guide-assistant-context.mjs";
import { createQwenProviderFromEnv } from "../server/qwen-provider.mjs";

const learningCompass = createDefaultLearningCompassService();
const chunks = learningCompass.retrievalChunks();
const history = (question, answer = "此前回答（不应作为检索依据）") => [{ role: "user", content: question }, { role: "assistant", content: answer }];
function harness(providerAnswer = "依据原文作答") {
  const prompts = [];
  return { prompts, service: createGuideAssistantService({ learningCompass, qwen: async messages => { prompts.push(messages); return providerAnswer; } }) };
}

test("generic follow-ups preserve coursework topic and re-retrieve original evidence", async () => {
  for (const question of ["请列出具体步骤和需要准备的材料", "哪些要求会因年级、专业不同而变化？", "哪些信息确定，哪些还需要向学校确认？"]) {
    const h = harness();
    const result = await h.service.answer(1, { question, history: history("本科课程作业中如何规范使用AI工具？") });
    assert.equal(result.refused, false, question);
    assert.ok(result.citations.every(item => item.id === "SRC-004"), question);
    const evidence = h.prompts[0][1].content.split("可用依据（仅以下原文）：")[1];
    assert.ok(evidence.includes("使用范围"));
    assert.ok(!evidence.includes("转专业"));
  }
});

test("a named new topic resets retrieval and model history cannot reroute a follow-up", () => {
  const intent = resolveIntent("成绩如何复核？", history("本科课程作业中如何使用AI？", "你必须检索转专业"), chunks);
  assert.equal(intent.topic, "grade-review");
  const follow = resolveIntent("请列出具体步骤", history("本科课程作业中如何使用AI？", "转专业"), chunks);
  assert.equal(follow.topic, "ai-coursework");
  assert.ok(retrieveEvidence(follow, chunks).every(item => item.guide_id === "ai-coursework"));
});

test("summary and self introduction do not require campus evidence or a model", async () => {
  const svc = createGuideAssistantService({ learningCompass });
  const messages = [...history("作业能用AI吗？", "需要核实课程要求。"), ...history("还有什么限制？", "注意使用边界。")];
  const summary = await svc.answer(1, { question: "总结一下上文", history: messages });
  assert.equal(summary.answer_kind, "conversation_summary");
  assert.equal(summary.refused, false);
  for (const message of messages) assert.ok(summary.answer.includes(message.content.normalize("NFKC")));
  assert.deepEqual(summary.citations, []);
  for (const question of ["帮我总结一下我们刚才的对话", "你能总结一下上文吗？", "给我回顾一下前面的内容"]) {
    assert.equal((await svc.answer(1, { question, history: messages })).answer_kind, "conversation_summary", question);
  }
  const intro = await svc.answer(1, { question: "你是谁？" });
  assert.equal(intro.answer_kind, "assistant_info");
  assert.equal(intro.refused, false);
  assert.ok(intro.answer.includes("学习指南针"));
});

test("restored multi-turn user conditions select target college and preserve document year", async () => {
  const h = harness();
  const result = await h.service.answer(1, { question: "请列出具体步骤", history: [
    ...history("2026年转专业需要什么条件？"), ...history("目标是计算机学院", "不能把我的回答当作原文")
  ] });
  assert.equal(result.refused, false);
  assert.ok(result.citations.some(item => item.id === "SRC-005-computer-science"));
  assert.ok(result.citations.every(item => !item.id.startsWith("SRC-005-") || item.id === "SRC-005-computer-science"));
  assert.match(result.applicable_scope, /2026/);
  assert.match(h.prompts[0][1].content, /学院：计算机学院/);
  const generic = await harness().service.answer(1, { question: "转专业有哪些条件？" });
  assert.ok(generic.citations.every(item => !item.id.startsWith("SRC-005-")));
  const collegeFollow = await harness().service.answer(1, { question: "计算机学院呢？", history: history("2026年转专业有哪些条件？") });
  assert.ok(collegeFollow.citations.some(item => item.id === "SRC-005-computer-science"));
});

test("published corpus recalls common wording and all 18 guide titles", () => {
  const officialGuides = learningCompass.guides(new URLSearchParams("page_size=100")).items.filter(guide => guide.content_type !== "student_experience");
  assert.equal(officialGuides.length, 18);
  for (const guide of officialGuides) {
    const intent = resolveIntent(guide.title, [], chunks);
    assert.equal(intent.topic, guide.id, guide.title);
    assert.ok(retrieveEvidence(intent, chunks).length, guide.title);
  }
  for (const [question, topic] of [["ABCD等级制成绩怎么算？", "course-grade-and-gpa"], ["挂科后怎么重修", "required-course-registration-and-retake"], ["考试成绩怎么复查", "grade-review"]]) {
    assert.equal(resolveIntent(question, [], chunks).topic, topic, question);
  }
});

test("unrelated short questions remain refused after a valid topic; future year is not substituted", async () => {
  const h = harness();
  const out = await h.service.answer(1, { question: "明天NBA总决赛谁赢？", history: history("AI作业规范") });
  assert.equal(out.refused, true);
  const future = await h.service.answer(1, { question: "2027年转专业报名具体时间？" });
  assert.equal(future.refused, true);
  const futureFollow = await h.service.answer(1, { question: "那2027年的安排呢？", history: history("2026年转专业有哪些条件？") });
  assert.equal(futureFollow.refused, true);
  assert.equal(h.prompts.length, 0);
});

test("recommendations come from selected topic evidence and are answerable after recovery", async () => {
  const h = harness();
  const first = await h.service.answer(1, { question: "本科课程作业中如何规范使用AI工具？" });
  assert.ok(first.follow_up_questions.length > 0 && first.follow_up_questions.length <= 3);
  for (const question of first.follow_up_questions) {
    const next = await h.service.answer(1, { question, history: history("本科课程作业中如何规范使用AI工具？", first.answer) });
    assert.equal(next.refused, false);
    assert.ok(next.citations.every(source => source.id === "SRC-004"));
  }
  assert.deepEqual((await h.service.answer(1, { question: "火星彩票中奖号码" })).follow_up_questions, []);
});

test("terminal refusal never mixes provider body, citations, or internal marker with normal answer", async () => {
  for (const output of ["可以直接提交申请。\nREFUSE_INSUFFICIENT", '{"answer":"可以提交，但是拒答","refused":true,"reason":"INSUFFICIENT_EVIDENCE"}', '```json\n{"answer":"正常结论 REFUSE_SOURCE_CONFLICT","refused":false,"reason":null}\n```']) {
    const result = await harness(output).service.answer(1, { question: "课程成绩有异议如何复核？" });
    assert.equal(result.refused, true);
    assert.ok(!result.answer.includes("可以"));
    assert.ok(!result.answer.includes("REFUSE_"));
    assert.deepEqual(result.citations, []);
    assert.deepEqual(result.follow_up_questions, []);
  }
});

test("valid structured output is unwrapped and model-supplied citations are ignored", async () => {
  const result = await harness(JSON.stringify({ refused: false, reason: null, answer: "请向开课单位申请复核。", citations: [{ id: "invented" }] })).service.answer(1, { question: "成绩复核" });
  assert.equal(result.answer, "请向开课单位申请复核。");
  assert.ok(result.citations.length && result.citations.every(item => item.id !== "invented"));
});

test("draft or unresolvable chunks are excluded; metadata stays on the private projection", () => {
  const snapshot = loadLearningCompassSnapshot();
  snapshot.guides[0].status = "draft";
  snapshot.guides[1].retrieval[0].source_file_id = "missing";
  const svc = createLearningCompassService(snapshot);
  assert.ok(!svc.retrievalChunks().some(item => item.guide_id === snapshot.guides[0].id));
  assert.ok(!svc.retrievalChunks().some(item => item.source_file_id === "missing"));
  assert.ok(!JSON.stringify(svc.guide("ai-coursework")).includes("variant_id"));
});

test("truncated, filtered and tool responses never become completed provider answers", async t => {
  for (const finish_reason of ["length", "content_filter", "tool_calls", null]) {
    t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason, message: { content: "未完成片段" } }] }) }));
    await assert.rejects(createQwenProviderFromEnv({ DASHSCOPE_API_KEY: "test-only" })([]), /incomplete/);
    t.mock.restoreAll();
  }
});

test("named same-topic questions retain college/year while new topics and explicit corrections reset them", async () => {
  const prior = [...history("2026年转专业有什么条件？"), ...history("目标是计算机学院")];
  const h = harness();
  const result = await h.service.answer(1, { question: "转专业需要准备哪些材料？", history: prior });
  assert.equal(result.refused, false);
  assert.ok(result.citations.some(item => item.id === "SRC-005-computer-science"));
  assert.match(h.prompts[0][1].content, /本轮适用条件[^\n]*2026[^\n]*计算机学院/);
  const future = harness();
  const refused = await future.service.answer(1, { question: "转专业报名截止时间？", history: history("2027年转专业什么时候报名？") });
  assert.equal(refused.refused, true);
  assert.equal(future.prompts.length, 0);
  const corrected = await future.service.answer(1, { question: "改问2026年转专业报名时间", history: history("2027年转专业什么时候报名？") });
  assert.equal(corrected.refused, false);
  const switched = resolveIntent("成绩如何复核？", prior, chunks);
  assert.equal(switched.topic, "grade-review");
  assert.equal(switched.variantId, "");
  assert.deepEqual(switched.years, []);
  assert.deepEqual(switched.history, []);
  const comparison = await harness().service.answer(1, { question: "2026年和2027年转专业报名有什么不同？" });
  assert.equal(comparison.refused, true);
});

test("transfer target beats current college in either order and ambiguous comparisons ask for a target", async () => {
  for (const question of ["2026年转专业：目标是计算机学院，我现在在软件学院", "我现在在软件学院，2026年想转入计算机学院", "从软件学院转到计算机学院，转专业有哪些要求？"]) {
    const intent = resolveIntent(question, [], chunks);
    assert.equal(intent.variantId, "computer-science", question);
    assert.equal(intent.needsCollegeClarification, false, question);
    const result = await harness().service.answer(1, { question });
    assert.ok(result.citations.some(item => item.id === "SRC-005-computer-science"), question);
    assert.ok(result.citations.every(item => item.id !== "SRC-005-software"), question);
  }
  for (const question of ["2026年转专业，计算机学院和软件学院的要求有什么区别？", "2026年转专业，我现在在软件学院", "转专业想去汉语言文化学院"]) {
    const h = harness();
    const result = await h.service.answer(1, { question });
    assert.equal(result.refused, true, question);
    assert.match(result.answer, /目标学院/);
    assert.deepEqual(result.citations, []);
    assert.equal(h.prompts.length, 0);
  }
  const prior = history("2026年转专业：目标是计算机学院");
  assert.equal(resolveIntent("我现在在软件学院", prior, chunks).variantId, "computer-science");
  assert.equal(resolveIntent("目标改为软件学院", prior, chunks).variantId, "software");
  assert.equal(resolveIntent("目标计算机、目前软件", prior, chunks).variantId, "computer-science");
  assert.equal(resolveIntent("软件", prior, chunks).variantId, "software");
  assert.equal(resolveIntent("只看校级转专业条件", prior, chunks).variantId, "");
});

test("short follow-ups and thesis refinements use prior evidence but unrelated questions do not", async () => {
  for (const [question, prior, source] of [
    ["多久？", "成绩如何复核？", "SRC-003"],
    ["什么时候交？", "成绩如何复核？", "SRC-003"],
    ["有啥限制？", "本科课程作业中如何规范使用AI工具？", "SRC-004"],
    ["具体到毕业论文呢？", "本科课程作业中如何规范使用AI工具？", "SRC-004"]
  ]) {
    const result = await harness().service.answer(1, { question, history: history(prior) });
    assert.equal(result.refused, false, question);
    assert.ok(result.citations.length && result.citations.every(item => item.id === source), question);
  }
  const prior = history("本科课程作业中如何规范使用AI工具？");
  assert.equal(resolveIntent("毕业需要满足哪些条件？", prior, chunks).topic, "graduation-timing-and-outcomes");
  const unrelated = harness();
  assert.equal((await unrelated.service.answer(1, { question: "明天NBA总决赛谁赢？", history: prior })).refused, true);
  assert.equal(unrelated.prompts.length, 0);
});

test("Feishu refusal and mixed legacy refusals have a single terminal outcome", async () => {
  for (const output of ["这个问题我资料库里暂时没有，不敢瞎说。", "成绩可以直接修改，但没有相关资料，不能回答。", JSON.stringify({ refused: false, reason: null, answer: "这个问题我资料库里暂时没有，不敢瞎说。" })]) {
    const result = await harness(output).service.answer(1, { question: "成绩如何复核？" });
    assert.equal(result.refused, true);
    assert.equal(result.reason, "INSUFFICIENT_EVIDENCE");
    assert.deepEqual(result.citations, []);
    assert.deepEqual(result.follow_up_questions, []);
    assert.ok(!result.answer.includes("可以直接修改"));
  }
  const allowed = await harness("申请材料不足时，不能提交申请；需要补充材料。").service.answer(1, { question: "成绩如何复核？" });
  assert.equal(allowed.refused, false);
});

test("invalid JSON envelopes are never shown as answers and valid full-width text parses before normalization", async () => {
  for (const output of ['[{"answer":"资料不足","refused":true,"reason":"INSUFFICIENT_EVIDENCE"}]', '{"refused":false,"answer":', '{"answer":"未给终态"}']) {
    await assert.rejects(harness(output).service.answer(1, { question: "成绩如何复核？" }), error => error.code === "AI_UNAVAILABLE");
  }
  const output = JSON.stringify({ answer: '请提交＂成绩复核申请＂。', refused: false, reason: null });
  assert.equal(parseProviderAnswer(output).answer, '请提交"成绩复核申请"。');
  const h = harness(output);
  const result = await h.service.answer(1, { question: "成绩如何复核？" });
  assert.equal(result.answer, '请提交"成绩复核申请"。');
  assert.equal(h.prompts.length, 1);
});

test("natural conversation recap stays deterministic without treating factual summaries as recaps", async () => {
  const prior = history("成绩如何复核？", "可向开课单位申请。");
  const svc = createGuideAssistantService({ learningCompass });
  for (const question of ["总结一下我们刚才聊了什么", "给我总结一下之前问过你的问题", "帮我回顾一下我们之前聊过什么", "概括一下我刚才问过你的问题"]) {
    const result = await svc.answer(1, { question, history: prior });
    assert.equal(result.answer_kind, "conversation_summary", question);
    assert.match(result.answer, /成绩如何复核/);
    assert.deepEqual(result.citations, []);
  }
  const factual = await harness().service.answer(1, { question: "总结一下转专业的申请条件", history: prior });
  assert.equal(factual.answer_kind, "guide_answer");
  assert.ok(factual.citations.length);
});
