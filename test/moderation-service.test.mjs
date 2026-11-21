import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AtomicJsonStore } from "../server/atomic-json-store.mjs";
import { ModerationService } from "../server/moderation-service.mjs";
import { isFeedbackPublicEligible, itemRevision, newFeedbackModerationFields, normalizeFeedbackDocument, normalizeReviewsDocument } from "../server/moderation-model.mjs";
import { ReviewSubmissionService } from "../server/review-submission-service.mjs";

const now = "2026-10-04T10:00:00.000Z";
const actor = "real-admin";
const item = (id, extra = {}) => ({ id, title: `标题${id}`, content: `不可改变的正文${id}`, contact: "私密联系", user_id: 7, createdAt: now, ...newFeedbackModerationFields({ type: "general", now }), ...extra });

async function fixture(t, { kind = "feedback", data, beforeWrite } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s3-moderation-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, `${kind}.json`);
  const store = new AtomicJsonStore({ allowedRoot: directory });
  const source = data || { title: "反馈", announcement: "旧说明", rules: { submissionOpen: true, hourlyLimit: 3, dailyLimit: 15, minLength: 5, notes: "说明" }, items: [item("a"), item("b")] };
  await store.write(filePath, kind === "reviews" ? normalizeReviewsDocument(source, { nowIso: now }) : normalizeFeedbackDocument(source, { nowIso: now }));
  const service = new ModerationService({ store, filePath, kind, nowIso: () => now, beforeWrite });
  return { store, filePath, service, read: () => store.read(filePath) };
}

test("single-item update persists only allowed changes with real metadata and redacted audit", async (t) => {
  let prepared;
  const f = await fixture(t, { beforeWrite: (payload) => { prepared = payload; } });
  const base = await f.service.read();
  assert.equal(base.data.items[0].publicEligible, false);
  const result = await f.service.patchItem("a", { expectedItemRevision: base.itemRevisions.a, changes: { handlingStatus: "completed", reply: "已处理，联系方式仅本人可读" } }, { username: actor });
  const persisted = await f.read();
  const a = persisted.items[0];
  assert.equal(a.handlingStatus, "completed");
  assert.equal(a.publicationState, "pending");
  assert.equal(a.replyVisibility, "submitter");
  assert.equal(a.repliedBy, actor);
  assert.equal(a.handledBy, actor);
  assert.equal(a.updatedBy, actor);
  assert.equal(a.repliedAt, now);
  assert.equal(a.content, base.data.items[0].content);
  const unchangedB = structuredClone(base.data.items[1]);
  delete unchangedB.publicEligible;
  assert.deepEqual(persisted.items[1], unchangedB);
  assert.equal(result.publicEligible, false);
  assert.equal(result.data.publicEligible, false);
  assert.equal(a.publicEligible, undefined, "derived UI metadata is never persisted");
  assert.equal(prepared.previous.reply, undefined);
  assert.equal(prepared.next.reply, "已处理，联系方式仅本人可读");
  assert.deepEqual(prepared.changes, result.changes);
  const audit = JSON.stringify(result.changes);
  assert.ok(!audit.includes("联系方式") && !audit.includes(actor) && !audit.includes("不可改变"));
});

test("privacy, report aliases and uncertain legacy feedback cannot be approved or given public replies", async (t) => {
  const f = await fixture(t, { data: { rules: {}, items: [
    item("private", { private: true }), item("report", { type: "report" }), item("alias", { reportUrl: "https://example.invalid" }),
    { id: "legacy", title: "旧隐藏", content: "正文", status: "approved", hidden: true, private: false, reply: "旧回复" },
  ] } });
  const base = await f.service.read();
  for (const id of ["private", "report", "alias", "legacy"]) {
    await assert.rejects(f.service.patchItem(id, { expectedItemRevision: base.itemRevisions[id], changes: { publicationDecision: "approve" } }, actor), { code: "PUBLICATION_BLOCKED", statusCode: 400 });
    await assert.rejects(f.service.patchItem(id, { expectedItemRevision: base.itemRevisions[id], changes: { replyVisibility: "public" } }, actor), { code: "PUBLIC_REPLY_NOT_ALLOWED" });
    const result = await f.service.patchItem(id, { expectedItemRevision: base.itemRevisions[id], changes: { handlingStatus: "completed", hidden: false, reply: "可处理，仍然私密" } }, actor);
    assert.equal(result.publicEligible, false);
    assert.equal(result.data.publicationState, "pending");
  }
  assert.ok((await f.read()).items.every((row) => !isFeedbackPublicEligible(row)));
});

test("historical public feedback keeps its existing reply while later decisions survive service restart", async (t) => {
  const repliedAt = "2026-08-28T00:00:00Z";
  const original = { id: "old", title: "旧公开反馈", content: "不可改变的历史正文", type: "feature", status: "completed", reply: "已公开的历史回复", repliedAt };
  const f = await fixture(t, { data: { items: [original] } });
  let current = await f.service.get("old");
  assert.equal(current.publicEligible, true);
  assert.equal(current.data.replyVisibility, "public");
  assert.equal(current.data.reply, original.reply);
  assert.equal(current.data.repliedAt, original.repliedAt);
  assert.equal(current.data.reviewedBy, undefined);
  assert.equal(current.data.reviewedAt, undefined);
  const migratedAt = current.data.legacyVisibilityImportedAt;

  current = await f.service.patchItem("old", { expectedItemRevision: current.itemRevision, changes: { hidden: true } }, actor);
  assert.equal(current.publicEligible, false);
  assert.equal(current.data.replyVisibility, "submitter");
  const restarted = new ModerationService({ store: f.store, filePath: f.filePath, nowIso: () => "2027-01-01T00:00:00Z" });
  current = await restarted.get("old");
  assert.equal(current.publicEligible, false, "restart cannot undo a later hide");
  assert.equal(current.data.hidden, true);
  assert.equal(current.data.legacyVisibilityImportedAt, migratedAt);

  current = await restarted.patchItem("old", { expectedItemRevision: current.itemRevision, changes: { hidden: false, replyVisibility: "public" } }, actor);
  assert.equal(current.publicEligible, true, "an explicit unhide can use the retained historical publication");
  current = await restarted.patchItem("old", { expectedItemRevision: current.itemRevision, changes: { publicationDecision: "revoke" } }, actor);
  assert.equal(current.publicEligible, false);
  assert.equal(current.data.publicationState, "pending");
  assert.equal(current.data.reviewedBy, actor);
  assert.equal(current.data.replyVisibility, "submitter");
  current = await f.service.get("old");
  assert.equal(current.publicEligible, false, "restart cannot restore revoked historical visibility from completed/legacyStatus");
  assert.equal(current.data.handlingStatus, "completed");
  assert.equal(current.data.legacyStatus, "completed");
  current = await f.service.patchItem("old", { expectedItemRevision: current.itemRevision, changes: { handlingStatus: "completed", reply: "撤销后的新回复" } }, actor);
  assert.equal(current.publicEligible, false);
  assert.equal(current.data.publicationState, "pending");
  await assert.rejects(f.service.patchItem("old", { expectedItemRevision: current.itemRevision, changes: { replyVisibility: "public" } }, actor), { code: "PUBLIC_REPLY_NOT_ALLOWED" });

  current = await f.service.patchItem("old", { expectedItemRevision: current.itemRevision, changes: { publicationDecision: "approve", replyVisibility: "public" } }, actor);
  assert.equal(current.publicEligible, true, "a real later administrator approval accepts verified historical origin");
  assert.equal(current.data.decisionSource, "admin_decision");
  assert.equal(current.data.reviewedBy, actor);
  assert.equal(current.data.reviewedAt, now);
  assert.equal(current.data.legacyVisibilitySource, "legacy_feedback_visibility_import");
  assert.equal(current.data.legacyVisibilityImportedAt, migratedAt);
  assert.equal(current.data.id, original.id);
  assert.equal(current.data.content, original.content);
  current = await f.service.patchItem("old", { expectedItemRevision: current.itemRevision, changes: { publicationDecision: "reject" } }, actor);
  assert.equal((await restarted.get("old")).publicEligible, false, "restart cannot undo a later rejection");
  assert.equal(current.data.publicationState, "rejected");
});

test("editing an imported public reply requires an explicit public choice for the replacement", async (t) => {
  const f = await fixture(t, { data: { items: [{ id: "old", title: "旧公开", content: "原文", status: "approved", reply: "旧回复" }] } });
  let current = await f.service.get("old");
  assert.equal(current.publicEligible, true);
  current = await f.service.patchItem("old", { expectedItemRevision: current.itemRevision, changes: { handlingStatus: "completed" } }, actor);
  assert.equal(current.publicEligible, true);
  assert.equal(current.data.replyVisibility, "public");
  assert.equal(current.data.reviewedBy, undefined, "handling a historically public item does not invent an approval");
  current = await f.service.patchItem("old", { expectedItemRevision: current.itemRevision, changes: { reply: "新回复默认仅本人" } }, actor);
  assert.equal(current.publicEligible, true);
  assert.equal(current.data.replyVisibility, "submitter");
  current = await f.service.patchItem("old", { expectedItemRevision: current.itemRevision, changes: { reply: "明确公开的新回复", replyVisibility: "public" } }, actor);
  assert.equal(current.data.replyVisibility, "public");
  assert.equal(current.data.repliedBy, actor);
});

test("reply limits reject 2001 intact, clear explicitly, and only eligible items allow public reply", async (t) => {
  const f = await fixture(t);
  let a = await f.service.get("a");
  await assert.rejects(f.service.patchItem("a", { expectedItemRevision: a.itemRevision, changes: { reply: "字".repeat(2001) } }, actor), { code: "REPLY_TOO_LONG" });
  assert.equal((await f.service.get("a")).data.reply, undefined);
  a = await f.service.patchItem("a", { expectedItemRevision: a.itemRevision, changes: { publicationDecision: "approve", reply: "字".repeat(2000), replyVisibility: "public" } }, actor);
  assert.equal(a.publicEligible, true);
  assert.equal(a.data.reply.length, 2000);
  assert.equal(a.data.replyVisibility, "public");
  a = await f.service.patchItem("a", { expectedItemRevision: a.itemRevision, changes: { hidden: true } }, actor);
  assert.equal(a.publicEligible, false);
  assert.equal(a.data.replyVisibility, "submitter");
  a = await f.service.patchItem("a", { expectedItemRevision: a.itemRevision, changes: { reply: "" } }, actor);
  assert.equal(a.data.reply, "");
  assert.equal(a.data.repliedBy, actor);
});

test("PATCH rejects immutable content, every server actor alias and direct publication state", async (t) => {
  const f = await fixture(t);
  const before = await f.read();
  const base = await f.service.get("a");
  for (const [field, value] of Object.entries({ id: "different", content: "new", title: "new", type: "other", contact: "new", private: false, user_id: 9, createdAt: now, ipHash: "new", userAgent: "new", publicationState: "approved", reviewedBy: "forged", reviewed_by: "forged", repliedAt: now, replied_at: now, updated_by: "forged", publicationBlocked: false, privacySource: "server_feedback_submission", legacyStatus: "completed", legacyVisibilitySource: "legacy_feedback_visibility_import", legacyVisibilityImportedAt: now, decisionSource: "legacy_feedback_visibility_import" })) {
    await assert.rejects(f.service.patchItem("a", { expectedItemRevision: base.itemRevision, changes: { [field]: value } }, actor), { code: "IMMUTABLE_FIELD" }, field);
  }
  await assert.rejects(f.service.patchItem("a", { expectedItemRevision: base.itemRevision, changes: {}, updated_by: "forged" }, actor), { code: "IMMUTABLE_FIELD" });
  assert.deepEqual(await f.read(), before);
});

test("same-item competing administrators compare CAS inside the atomic updater", async (t) => {
  const f = await fixture(t);
  const initial = await f.service.get("a");
  const writes = await Promise.allSettled([
    f.service.patchItem("a", { expectedItemRevision: initial.itemRevision, changes: { reply: "first" } }, "admin-one"),
    f.service.patchItem("a", { expectedItemRevision: initial.itemRevision, changes: { handlingStatus: "completed" } }, "admin-two"),
  ]);
  assert.equal(writes[0].status, "fulfilled");
  assert.equal(writes[1].status, "rejected");
  assert.equal(writes[1].reason.code, "ITEM_CONFLICT");
  assert.equal(writes[1].reason.currentItem.reply, "first");
  assert.equal(writes[1].reason.currentItem.publicEligible, false);
  assert.equal(writes[1].reason.currentItemRevision, writes[0].value.itemRevision);
  assert.equal((await f.read()).items[0].handlingStatus, "open");
});

test("item A, item B and settings have independent tokens and preserve one another", async (t) => {
  const f = await fixture(t);
  const base = await f.service.read();
  const results = await Promise.all([
    f.service.patchItem("a", { expectedItemRevision: base.itemRevisions.a, changes: { reply: "A reply" } }, actor),
    f.service.patchItem("b", { expectedItemRevision: base.itemRevisions.b, changes: { handlingStatus: "completed" } }, actor),
    f.service.patchSettings({ expectedSettingsRevision: base.settingsRevision, changes: { rules: { notes: "新配置" } } }, actor),
  ]);
  const persisted = await f.read();
  assert.equal(persisted.items[0].reply, "A reply");
  assert.equal(persisted.items[1].handlingStatus, "completed");
  assert.equal(persisted.rules.notes, "新配置");
  assert.equal(persisted.rulesProvenance.source, "admin_settings");
  assert.equal(persisted.rulesProvenance.configuredBy, actor);
  assert.equal(persisted.rulesProvenance.configuredAt, now);
  assert.equal(results[2].data.items, undefined);
  await assert.rejects(f.service.patchSettings({ expectedSettingsRevision: base.settingsRevision, changes: { title: "wrong" } }, actor), { code: "SETTINGS_CONFLICT", statusCode: 409 });
  const settings = await f.service.read();
  assert.equal(settings.data.title, "反馈");
});

test("legacy adapter accepts one reply with forged metadata discarded, rejects mixed/multiple writes", async (t) => {
  const f = await fixture(t);
  let base = await f.service.read();
  const incoming = structuredClone(base.data);
  incoming.items[0].reply = "legacy reply";
  incoming.items[0].replied_by = "forged";
  incoming.items[0].updatedBy = "forged";
  incoming.items[0].publicEligible = true;
  const result = await f.service.patchLegacy({ data: incoming, expectedRevision: base.revision }, actor);
  assert.equal(result.data.repliedBy, actor);
  assert.ok(result.compatibilityWarnings.length);
  assert.equal((await f.read()).items[0].replied_by, undefined);
  base = await f.service.read();
  for (const mutate of [
    (data) => { data.items[0].reply = "a"; data.items[1].hidden = true; },
    (data) => { data.items[0].reply = "a"; data.rules.notes = "settings"; },
    (data) => { data.items[0].content = "rewritten"; },
    (data) => { data.items.pop(); },
    (data) => { data.items[0].id = "changed"; },
    (data) => { data.items[0].status = "approved"; },
    (data) => { data.items[0].publicationState = "approved"; },
  ]) {
    const data = structuredClone(base.data);
    mutate(data);
    await assert.rejects(f.service.patchLegacy({ data, expectedRevision: base.revision }, actor), (error) => error.statusCode === 400);
  }
  assert.equal((await f.read()).items[0].reply, "legacy reply");
});

test("legacy handling completion and unhide never approve, settings-only adapter preserves rows", async (t) => {
  const f = await fixture(t);
  let base = await f.service.read();
  let incoming = structuredClone(base.data);
  incoming.items[0].status = "completed";
  incoming.items[0].hidden = false;
  const done = await f.service.patchLegacy({ data: incoming, expectedRevision: base.revision }, actor);
  assert.equal(done.data.handlingStatus, "completed");
  assert.equal(done.data.publicationState, "pending");
  assert.equal(done.publicEligible, false);
  base = await f.service.read();
  const rows = (await f.read()).items;
  incoming = structuredClone(base.data);
  incoming.rules.notes = "新说明";
  const settings = await f.service.patchLegacy({ data: incoming, expectedRevision: base.revision }, actor);
  assert.equal(settings.data.rules.notes, "新说明");
  assert.deepEqual((await f.read()).items, rows);
});

test("helpful reactions, a new submission and settings do not invalidate item moderation or lose rows", async (t) => {
  const f = await fixture(t, { kind: "reviews", data: { rules: { submissionOpen: true, moderationRequired: false, minLength: 5, hourlyLimit: 3, dailyLimit: 10 }, reviews: [
    { id: "a", courseTitle: "课程A", teacher: "老师", content: "原文", status: "approved", helpfulBy: [], helpfulCount: 0 },
    { id: "b", courseTitle: "课程B", teacher: "老师", content: "原文", status: "approved" },
  ] } });
  const reviewService = new ReviewSubmissionService({ store: f.store, reviewsPath: f.filePath, readReviews: () => f.store.readSync(f.filePath), consumeAttempt: () => true, consumeSubmission: () => true, actorHash: () => "hash", nowIso: () => now, createId: () => "new" });
  const base = await f.service.read();
  await Promise.all([
    reviewService.reactHelpful("a", 8, "up"),
    f.service.patchItem("b", { expectedItemRevision: base.itemRevisions.b, changes: { hidden: true } }, actor),
    f.service.patchSettings({ expectedSettingsRevision: base.settingsRevision, changes: { rules: { notes: "新设置" } } }, actor),
    reviewService.submit({ courseTitle: "新课", teacher: "老师", content: "正常课程体验内容", rating: 5 }, { clientIp: "ip", userId: 7 }),
  ]);
  const result = await f.service.patchItem("a", { expectedItemRevision: base.itemRevisions.a, changes: { hidden: true } }, actor);
  assert.equal(result.data.helpfulCount, 1);
  assert.deepEqual(result.data.helpfulBy, [8]);
  const persisted = await f.read();
  assert.equal(persisted.reviews.length, 3);
  assert.equal(persisted.reviews.find((row) => row.id === "b").hidden, true);
  assert.equal(persisted.rules.notes, "新设置");
  assert.equal(persisted.reviews.find((row) => row.id === "new").publicationState, "approved");
  assert.notEqual(itemRevision(result.data), base.itemRevisions.a);
});

test("failed locked audit preparation leaves persistent item untouched", async (t) => {
  const f = await fixture(t, { beforeWrite: () => { throw new Error("audit unavailable"); } });
  const before = await f.read();
  const base = await f.service.get("a");
  await assert.rejects(f.service.patchItem("a", { expectedItemRevision: base.itemRevision, changes: { reply: "attempt" } }, actor), /audit unavailable/);
  assert.deepEqual(await f.read(), before);
});
