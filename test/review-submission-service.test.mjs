import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AtomicJsonStore } from "../server/atomic-json-store.mjs";
import { ModerationService } from "../server/moderation-service.mjs";
import { isReviewPublicEligible, normalizeReviewsDocument } from "../server/moderation-model.mjs";
import { ReviewSubmissionService } from "../server/review-submission-service.mjs";

const now = "2026-10-04T10:00:00.000Z";
const input = { courseTitle: "中文课程", teacher: "老师", rating: 5, content: "这是一条足够长的课程体验评价。" };

async function fixture(t, rules = {}, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s3-review-submission-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new AtomicJsonStore({ allowedRoot: directory });
  const filePath = path.join(directory, "reviews.json");
  const initial = normalizeReviewsDocument({ rules: { submissionOpen: true, moderationRequired: false, minLength: 12, hourlyLimit: 3, dailyLimit: 10, ...rules }, reviews: [] }, { nowIso: now });
  await store.write(filePath, initial);
  const consumedRules = [];
  let id = 0;
  const service = new ReviewSubmissionService({ store, reviewsPath: filePath, readReviews: options.staleRead ? () => structuredClone(initial) : () => store.readSync(filePath), consumeAttempt: () => true, consumeSubmission: (_ip, actualRules) => { consumedRules.push(structuredClone(actualRules)); return options.limitAllowed !== false; }, actorHash: (ip) => `hash:${ip}`, nowIso: () => now, today: () => "2026-10-04", createId: () => `review-${++id}`, ...options.dependencies });
  const moderation = new ModerationService({ store, filePath, kind: "reviews", nowIso: () => now });
  return { store, filePath, service, moderation, consumedRules, read: () => store.read(filePath) };
}

test("submission automatically publishes only under the actual existing rules and stores provenance", async (t) => {
  for (const { moderationRequired, enabled, content, pending } of [
    { moderationRequired: false, enabled: false, content: "联系方式 13800138000，请联系我了解课程情况。", pending: false },
    { moderationRequired: false, enabled: true, content: "联系方式 13800138000，请联系我了解课程情况。", pending: true },
    { moderationRequired: true, enabled: false, content: input.content, pending: true },
    { moderationRequired: false, enabled: true, content: input.content, pending: false },
  ]) {
    const f = await fixture(t, { moderationRequired, keywordFilter: { enabled, words: [] } });
    const result = await f.service.submit({ ...input, content }, { clientIp: "ip", userId: 7 });
    assert.equal(result.accepted, true);
    assert.equal(result.pending, pending);
    const review = (await f.read()).reviews[0];
    assert.equal(review.user_id, 7);
    assert.equal(review.decisionSource, "automatic_rules");
    assert.equal(review.reviewedBy, "system");
    assert.equal(review.reviewedAt, now);
    assert.equal(review.ruleSnapshot.moderationRequired, moderationRequired);
    assert.equal(review.ruleSnapshot.keywordFilter.enabled, enabled);
    assert.equal(review.ruleSource, "legacy_configuration_import");
    assert.equal(isReviewPublicEligible(review), !pending);
  }
});

test("settings changed since the initial read govern publication and limits inside the same write lock", async (t) => {
  const f = await fixture(t, { moderationRequired: true }, { staleRead: true });
  const base = await f.moderation.read();
  const settings = await f.moderation.patchSettings({ expectedSettingsRevision: base.settingsRevision, changes: { rules: { moderationRequired: false, hourlyLimit: 9, keywordFilter: { enabled: true, words: ["合成关键词"] } } } }, "settings-admin");
  const result = await f.service.submit(input, { clientIp: "ip" });
  assert.equal(result.pending, false, "stale pre-lock moderationRequired=true cannot force a different decision");
  const review = (await f.read()).reviews[0];
  assert.deepEqual(review.ruleSnapshot, settings.data.rules);
  assert.equal(review.ruleHash, settings.rulesProvenance.hash);
  assert.equal(review.ruleSource, "admin_settings");
  assert.equal(review.ruleConfiguredBy, "settings-admin");
  assert.equal(review.ruleConfiguredAt, now);
  assert.equal(f.consumedRules[0].hourlyLimit, 9);
  const flagged = await f.service.submit({ ...input, content: "这条评价含有合成关键词，仍然进入待审。" }, { clientIp: "ip" });
  assert.equal(flagged.pending, true);
});

test("a closed submission switch or stricter validation applied while waiting cannot be bypassed", async (t) => {
  const closed = await fixture(t, {}, { staleRead: true });
  let base = await closed.moderation.read();
  await closed.moderation.patchSettings({ expectedSettingsRevision: base.settingsRevision, changes: { rules: { submissionOpen: false } } }, "admin");
  await assert.rejects(closed.service.submit(input, { clientIp: "ip" }), { code: "SUBMISSION_CLOSED" });
  assert.equal((await closed.read()).reviews.length, 0);
  assert.equal(closed.consumedRules.length, 0);
  const strict = await fixture(t, {}, { staleRead: true });
  base = await strict.moderation.read();
  await strict.moderation.patchSettings({ expectedSettingsRevision: base.settingsRevision, changes: { rules: { minLength: 200 } } }, "admin");
  await assert.rejects(strict.service.submit(input, { clientIp: "ip" }), { code: "INVALID_REVIEW" });
  assert.equal((await strict.read()).reviews.length, 0);
  assert.equal(strict.consumedRules.length, 0);
});

test("honeypot and rate failures never claim a durable accepted submission", async (t) => {
  const f = await fixture(t, {}, { limitAllowed: false });
  const bot = await f.service.submit({ ...input, website: "bot" }, { clientIp: "ip" });
  assert.deepEqual(bot, { pending: true, accepted: false });
  assert.equal(f.consumedRules.length, 0);
  await assert.rejects(f.service.submit(input, { clientIp: "ip" }), { code: "RATE_LIMITED", statusCode: 429 });
  assert.equal((await f.read()).reviews.length, 0);
});

test("queued takedown prevents reaction counts leaking even if a former public copy exists", async (t) => {
  const f = await fixture(t);
  const submitted = await f.service.submit(input, { clientIp: "ip", userId: 7 });
  const initial = await f.moderation.get(submitted.reviewId);
  await f.service.reactHelpful(submitted.reviewId, 8, "up");
  assert.equal((await f.read()).reviews[0].helpfulCount, 1);
  const writes = await Promise.all([
    f.moderation.patchItem(submitted.reviewId, { expectedItemRevision: initial.itemRevision, changes: { hidden: true } }, "admin"),
    f.service.reactHelpful(submitted.reviewId, 9, "up"),
  ]);
  assert.equal(writes[1], null);
  assert.equal((await f.read()).reviews[0].helpfulCount, 1);
  assert.equal(await f.service.reactHelpful(submitted.reviewId, 8, null), null, "even former voters receive no hidden count");
  await f.store.update(f.filePath, (current) => { current.reviews[0].hidden = false; current.reviews[0].private = true; return current; });
  assert.equal(await f.service.reactHelpful(submitted.reviewId, 9, "up"), null);
});

test("owner review status uses publicationState and rejects invalid pagination", async (t) => {
  const f = await fixture(t, { moderationRequired: true });
  await f.service.submit(input, { clientIp: "ip", userId: 7 });
  await f.service.submit(input, { clientIp: "ip", userId: 8 });
  const owned = f.service.listByUser(7, { page: null, pageSize: null });
  assert.equal(owned.total, 1);
  assert.equal(owned.items[0].publicationState, "pending");
  assert.equal(owned.items[0].status, "pending");
  assert.equal(owned.items[0].ruleHash, undefined);
  assert.equal(owned.items[0].reviewedBy, undefined);
  for (const options of [{ page: 0 }, { page: -1 }, { page: 1.5 }, { page: "1e2" }, { pageSize: 101 }, { pageSize: "-2" }]) {
    assert.throws(() => f.service.listByUser(7, options), { code: "INVALID_PAGINATION" });
  }
  assert.throws(() => f.service.listByUser(null), { code: "AUTH_REQUIRED" });
});
