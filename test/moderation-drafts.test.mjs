import test from "node:test";
import assert from "node:assert/strict";
import { createModerationDraftStore } from "../src/lib/moderation-drafts.js";

const fixtures = () => {
  const rows = createModerationDraftStore({ fields: ["handlingStatus", "hidden", "publicationDecision", "reply", "replyVisibility"] });
  rows.hydrate([{ id: "a", title: "original", type: "report", user_id: 9, reply: "", handlingStatus: "open", private: true }, { id: "b", hidden: true, handlingStatus: "open" }], { a: "a1", b: "b1" });
  const settings = createModerationDraftStore({ fields: ["rules"], revisionField: "expectedSettingsRevision" });
  settings.hydrate([{ id: "settings", rules: { notes: "saved" } }], { settings: "s1" });
  return { rows, settings };
};

test("one-row save serializes only allowed explicit changes; rows and settings stay independent", () => {
  const { rows, settings } = fixtures();
  rows.change("a", "reply", "answer");
  rows.change("b", "handlingStatus", "completed");
  settings.change("settings", "rules", { notes: "draft" });
  for (const field of ["title", "type", "user_id", "private", "handledBy", "handled_by", "updatedAt"]) assert.throws(() => rows.change("a", field, "forged"));
  assert.deepEqual(rows.begin("a"), { expectedItemRevision: "a1", changes: { reply: "answer" } });
  rows.succeed("a", { id: "a", reply: "answer", private: true, repliedBy: "real" }, "a2");
  assert.equal(rows.read("a").dirty, false);
  assert.deepEqual(rows.read("b").changes, { handlingStatus: "completed" });
  assert.deepEqual(settings.read("settings").changes, { rules: { notes: "draft" } });
  assert.equal(rows.read("a").value.repliedBy, "real");
});

test("cancel and rerender hydration do not discard another row or settings draft", () => {
  const { rows, settings } = fixtures();
  rows.change("a", "reply", "a draft");
  rows.change("b", "handlingStatus", "processing");
  settings.change("settings", "rules", { notes: "draft" });
  rows.hydrate([{ id: "a", reply: "server changed" }, { id: "b", handlingStatus: "rejected" }], { a: "a2", b: "b2" });
  assert.equal(rows.read("a").value.reply, "a draft");
  assert.equal(rows.read("a").revision, "a1");
  rows.cancel("a");
  assert.equal(rows.read("a").value.reply, "");
  assert.equal(rows.read("b").value.handlingStatus, "processing");
  assert.equal(settings.hasUnsaved(), true);
});

test("HTTP, HTML, timeout, and rejected network saves exit saving and retain draft", () => {
  for (const message of ["HTTP 500", "HTML error", "Timeout", "Network reject"]) {
    const { rows } = fixtures();
    rows.change("a", "reply", message);
    rows.begin("a");
    rows.fail("a", new Error(message));
    assert.equal(rows.read("a").saving, false);
    assert.equal(rows.read("a").value.reply, message);
    assert.equal(rows.read("a").error, message);
    assert.equal(rows.begin("a").changes.reply, message);
  }
});

test("conflict requires explicit field decisions before saving latest revision", () => {
  const { rows } = fixtures();
  rows.change("a", "reply", "my reply");
  rows.change("a", "handlingStatus", "completed");
  rows.begin("a");
  rows.fail("a", "ITEM_CONFLICT", { item: { id: "a", reply: "other reply", handlingStatus: "processing" }, revision: "a2" });
  assert.equal(rows.read("a").saving, false);
  assert.equal(rows.read("a").value.reply, "my reply");
  assert.throws(() => rows.begin("a"), /冲突/);
  assert.throws(() => rows.resolve("a", { reply: "mine" }), /每个/);
  rows.resolve("a", { reply: "mine", handlingStatus: "server" });
  assert.deepEqual(rows.begin("a"), { expectedItemRevision: "a2", changes: { reply: "my reply" } });
});

test("drop conflicted draft loads server record only for that row", () => {
  const { rows } = fixtures();
  rows.change("a", "reply", "mine");
  rows.change("b", "hidden", false);
  rows.begin("a");
  rows.fail("a", "conflict", { item: { id: "a", reply: "server" }, revision: "a2" });
  rows.cancel("a");
  assert.equal(rows.read("a").value.reply, "server");
  assert.equal(rows.read("a").revision, "a2");
  assert.equal(rows.read("b").dirty, true);
});

test("saving does not lose changes made while request was in flight", () => {
  const { rows } = fixtures();
  rows.change("a", "reply", "first");
  rows.begin("a");
  rows.change("a", "reply", "second");
  rows.succeed("a", { id: "a", reply: "first" }, "a2");
  assert.deepEqual(rows.read("a").changes, { reply: "second" });
  assert.equal(rows.read("a").revision, "a2");
});

test("returning a submitted field to the old saved value during saving remains a newer draft", () => {
  const settings = createModerationDraftStore({ fields: ["rules"], revisionField: "expectedSettingsRevision" });
  settings.hydrate([{ id: "settings", rules: { submissionOpen: true } }], { settings: "s1" });
  settings.change("settings", "rules", { submissionOpen: false });
  assert.deepEqual(settings.begin("settings"), { expectedSettingsRevision: "s1", changes: { rules: { submissionOpen: false } } });
  settings.change("settings", "rules", { submissionOpen: true });
  assert.equal(settings.read("settings").value.rules.submissionOpen, true);
  settings.succeed("settings", { id: "settings", rules: { submissionOpen: false } }, "s2");
  assert.equal(settings.read("settings").saved.rules.submissionOpen, false);
  assert.equal(settings.read("settings").value.rules.submissionOpen, true);
  assert.equal(settings.read("settings").dirty, true);
  assert.deepEqual(settings.begin("settings"), { expectedSettingsRevision: "s2", changes: { rules: { submissionOpen: true } } });
});

test("failed save preserves the explicit return to the old value during saving", () => {
  const { rows } = fixtures();
  rows.change("b", "hidden", false);
  rows.begin("b");
  rows.change("b", "hidden", true);
  rows.fail("b", "connection lost");
  assert.equal(rows.read("b").value.hidden, true);
  assert.equal(rows.read("b").dirty, true);
  assert.deepEqual(rows.begin("b"), { expectedItemRevision: "b1", changes: { hidden: true } });
});

test("missing save acknowledgement or overlong reply never clears the draft", () => {
  const { rows } = fixtures();
  rows.change("a", "reply", "x".repeat(2001));
  assert.throws(() => rows.begin("a"), /2000/);
  assert.equal(rows.read("a").saving, false);
  rows.change("a", "reply", "x".repeat(2000));
  rows.begin("a");
  assert.throws(() => rows.succeed("a", null, ""), /草稿已保留/);
  rows.fail("a", "invalid response");
  assert.equal(rows.read("a").value.reply.length, 2000);
  assert.equal(rows.read("a").saving, false);
});
