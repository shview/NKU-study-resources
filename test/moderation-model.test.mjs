import assert from "node:assert/strict";
import test from "node:test";
import {
  createRulesProvenance, isFeedbackPublicEligible, isPublicEligible, isReviewPublicEligible,
  itemRevision, moderationHash, newFeedbackModerationFields, normalizeFeedbackDocument,
  normalizeReviewsDocument, reviewPublicationFields, settingsRevision,
} from "../server/moderation-model.mjs";

const now = "2026-10-04T10:00:00.000Z";

test("legacy feedback migration preserves evidence and blocks every unreliable historical publication", () => {
  const original = {
    version: 1, title: "反馈", rules: {}, items: [
      { id: "open", title: "一", content: "原文", status: "open", private: false, contact: "私密联系", user_id: 7, reply: "旧回复", replied_by: "client", replied_at: "forged" },
      { id: "approved", title: "二", content: "原文", status: "approved", hidden: false, reviewedBy: "old-server" },
      { id: "completed", title: "三", content: "原文", status: "completed", hidden: true },
      { id: "report", title: "四", content: "投诉原文", type: "report", status: "approved" },
      { id: "complaint", title: "五", content: "投诉原文", type: "complaint", status: "completed" },
      { id: "camel-report", title: "六", content: "投诉原文", type: "other", reportUrl: "https://example.invalid", status: "approved" },
      { id: "snake-report", title: "七", content: "投诉原文", report_target: "举报对象", status: "approved" },
    ],
  };
  const result = normalizeFeedbackDocument(original, { nowIso: now });
  assert.equal(result.version, 2);
  assert.equal(result.schemaVersion, 2);
  assert.deepEqual(result.items.map((item) => item.id), original.items.map((item) => item.id));
  for (let index = 0; index < result.items.length; index += 1) {
    const item = result.items[index];
    assert.equal(item.content, original.items[index].content);
    assert.equal(item.publicationState, "pending");
    assert.equal(item.replyVisibility, "submitter");
    assert.equal(isPublicEligible(item), false);
    if (index < 3) {
      assert.equal(item.publicationBlocked, true);
      assert.equal(item.publicationBlockedReason, "LEGACY_PRIVACY_UNCONFIRMED");
    } else assert.equal(item.private, true);
  }
  assert.equal(result.items[0].contact, "私密联系");
  assert.equal(result.items[0].user_id, 7);
  assert.equal(result.items[0].reply, "旧回复");
  assert.equal(result.items[0].replied_by, undefined);
  assert.equal(result.items[1].reviewedBy, undefined);
  assert.equal(result.items[2].handlingStatus, "completed");
  assert.equal(result.items[2].hidden, true);
  assert.deepEqual(normalizeFeedbackDocument(result, { nowIso: "2027-01-01T00:00:00Z" }), result, "second migration does not manufacture new times or origin");
  assert.equal(original.items[0].schemaVersion, undefined, "migration is pure");
});

test("legacy visible reviews import visibility honestly and keep hidden/text/reactions through two migrations", () => {
  const source = { version: 1, rules: { moderationRequired: true }, reviews: [
    { id: "r1", courseTitle: "中文课程", teacher: "老师", content: "原文", status: "approved", helpfulCount: 3, helpfulBy: [1, 2, 3], reviewed_by: "forged" },
    { id: "r2", courseTitle: "课程", teacher: "老师", content: "旧原文", status: "通过", hidden: true },
    { id: "r3", courseTitle: "课程", teacher: "老师", content: "待审原文", status: "pending" },
  ] };
  const document = normalizeReviewsDocument(source, { nowIso: now });
  assert.equal(document.reviews[0].decisionSource, "legacy_visibility_import");
  assert.equal(document.reviews[0].reviewedBy, "system");
  assert.equal(document.reviews[0].reviewedAt, now);
  assert.equal(document.reviews[0].reviewed_by, undefined);
  assert.equal(isReviewPublicEligible(document.reviews[0]), true);
  assert.equal(isReviewPublicEligible(document.reviews[1]), false);
  assert.equal(isReviewPublicEligible(document.reviews[2]), false);
  assert.deepEqual(document.reviews[0].helpfulBy, [1, 2, 3]);
  assert.deepEqual(normalizeReviewsDocument(document, { nowIso: "2027-01-01T00:00:00Z" }), document);
  assert.equal(document.rulesProvenance.source, "legacy_configuration_import");
  assert.equal(document.rulesProvenance.configuredBy, null);
});

test("automatic review decisions faithfully honor moderation and enabled keyword rules", () => {
  const examples = [
    { required: false, enabled: false, content: "联系方式 13800138000", pending: false },
    { required: false, enabled: true, content: "联系方式 13800138000", pending: true },
    { required: true, enabled: false, content: "正常课程体验", pending: true },
    { required: false, enabled: true, content: "正常课程体验", pending: false },
    { required: false, enabled: true, content: "含合成关键词", words: ["合成关键词"], pending: true },
  ];
  for (const sample of examples) {
    const rules = { moderationRequired: sample.required, keywordFilter: { enabled: sample.enabled, words: sample.words || [] } };
    const rulesProvenance = createRulesProvenance(rules, { nowIso: now, actor: "real-admin" });
    const item = { id: "r", courseTitle: "课", teacher: "老师", content: sample.content, hidden: false, ...reviewPublicationFields({ rules, rulesProvenance, content: sample.content, now }) };
    assert.equal(item.publicationState, sample.pending ? "pending" : "approved");
    assert.equal(isReviewPublicEligible(item), !sample.pending);
    assert.equal(item.ruleHash, moderationHash(rules));
    assert.equal(item.ruleSource, "admin_settings");
    assert.equal(item.ruleConfiguredBy, "real-admin");
    rules.keywordFilter.enabled = !sample.enabled;
    assert.equal(item.ruleSnapshot.keywordFilter.enabled, sample.enabled, "snapshot cannot change with later settings");
  }
});

test("public gates require genuine schema and provenance; privacy wins over approval", () => {
  const item = { id: "new", title: "普通", content: "正文", ...newFeedbackModerationFields({ type: "general", now }), publicationState: "approved", reviewedBy: "admin", reviewedAt: now, decisionSource: "admin_decision" };
  assert.equal(isFeedbackPublicEligible(item), true);
  for (const fields of [{ schemaVersion: 1 }, { decisionSource: "unknown" }, { reviewedAt: "yesterday" }, { reviewedBy: "" }, { private: true }, { type: "report" }, { report_url: "url" }, { publicationBlocked: true }, { hidden: true }]) {
    assert.equal(isFeedbackPublicEligible({ ...item, ...fields }), false, JSON.stringify(fields));
  }
  assert.equal(isPublicEligible({ id: "legacy", status: "approved", hidden: false }), false);
  const noOrigin = { ...item };
  delete noOrigin.privacySource;
  assert.equal(isPublicEligible(noOrigin), false, "a version marker alone cannot prove a feedback privacy origin");
  const fakeReview = { id: "forged", courseTitle: "课程", content: "电话 13800138000", ...reviewPublicationFields({ rules: { moderationRequired: false, keywordFilter: { enabled: true } }, content: "正常文本", now }) };
  assert.equal(isPublicEligible(fakeReview), false, "the actual text must still satisfy the saved automatic policy");
  fakeReview.ruleHash = "forged";
  assert.equal(isPublicEligible(fakeReview), false);
});

test("item and settings revisions isolate helpful counts and unrelated rows", () => {
  const item = { id: "r", content: "原文", publicationState: "pending", status: "pending", helpfulCount: 1, helpfulBy: [7] };
  const token = itemRevision(item);
  assert.equal(itemRevision({ ...item, status: "approved", helpfulCount: 4, helpfulBy: [7, 8, 9, 10], publicEligible: false }), token);
  assert.notEqual(itemRevision({ ...item, hidden: true }), token);
  const document = { title: "反馈", announcement: "说明", rules: { submissionOpen: true }, items: [item], updated: "2026-10-04" };
  assert.equal(settingsRevision({ ...document, items: [], updated: "2027-01-01" }), settingsRevision(document));
  assert.notEqual(settingsRevision({ ...document, title: "新标题" }), settingsRevision(document));
});

test("invalid item identity and unsupported schema cannot silently migrate", () => {
  assert.throws(() => normalizeFeedbackDocument({ version: 3, items: [] }, { nowIso: now }), { code: "INVALID_MODERATION_DOCUMENT" });
  assert.throws(() => normalizeFeedbackDocument({ items: [{ content: "没有ID" }] }, { nowIso: now }), { code: "INVALID_MODERATION_DOCUMENT" });
  assert.throws(() => normalizeReviewsDocument({ reviews: [{ id: "duplicate" }, { id: "duplicate" }] }, { nowIso: now }), { code: "INVALID_MODERATION_DOCUMENT" });
  assert.throws(() => normalizeFeedbackDocument({ items: {} }, { nowIso: now }), { code: "INVALID_MODERATION_DOCUMENT" });
  for (const field of ["private", "hidden", "publicationBlocked"]) {
    assert.throws(() => normalizeFeedbackDocument({ items: [{ id: "malformed", [field]: "true" }] }, { nowIso: now }), { code: "INVALID_MODERATION_DOCUMENT" });
  }
});
