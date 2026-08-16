import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGuideData } from "../server/public-guide-data.mjs";

const courseUid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("guide data exposes only the explicit public schema", () => {
  const result = normalizeGuideData({
    version: 2,
    updated_at: "2026-08-16T12:00:00+08:00",
    correction_url: "https://nkustudy.top/feedback#private-fragment",
    items: [{
      id: "course-selection-guide",
      title: "选课流程",
      summary: "公开摘要",
      category: "course-selection",
      updated_at: "2026-08-16T12:00:00+08:00",
      related_course_ids: [courseUid],
      steps: [{ title: "第一步", body: "公开正文" }],
      internal_notes: "must not leak",
      source_url: "https://nkustudy.top/about",
    }],
  }, { courseIds: new Set([courseUid]) });
  assert.deepEqual(result.errors, []);
  assert.equal(result.data.correction_url, "https://nkustudy.top/feedback");
  assert.equal(Object.hasOwn(result.data.items[0], "internal_notes"), false);
});

test("invalid guide sources fail validation instead of being compatibility-coerced", () => {
  const result = normalizeGuideData({
    version: 1.5,
    items: [{
      id: "Bad ID",
      title: "无效指南",
      category: "dorm-life",
      updated_at: "2026-08-16",
      related_course_ids: ["missing-course", 3],
      aliases: "not-an-array",
      source_url: "file:///etc/passwd",
      correction_url: "http://internal.example",
      steps: [{ title: "", body: "" }],
    }],
  }, { courseIds: new Set() });
  assert.equal(result.errors.length >= 7, true);
  assert.equal(result.data.items[0].source_url, "");
  assert.equal(result.data.items[0].correction_url, "");
});

test("hidden and unpublished guides never enter the public collection", () => {
  const result = normalizeGuideData({
    items: [
      { id: "hidden-guide", hidden: true },
      { id: "draft-guide", status: "draft" },
      { id: "disabled-guide", published: false },
    ],
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.data.items, []);
});
