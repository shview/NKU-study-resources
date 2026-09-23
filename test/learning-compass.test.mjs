import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultLearningCompassService } from "../server/learning-compass-service.mjs";

const service = createDefaultLearningCompassService();

function collectObjectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectObjectKeys(item, keys);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key);
      collectObjectKeys(item, keys);
    }
  }
  return keys;
}

test("snapshot has validated counts: 5 categories, 18 guides, 29 variants, 205 chunks, 35 sources", () => {
  assert.equal(service.categories().length, 5);
  const list = service.guides(new URLSearchParams("page=1&page_size=100"));
  assert.equal(list.total, 18);
  const counts = Object.fromEntries(list.facets.categories.map((item) => [item.value, item.count]));
  assert.deepEqual(counts, {
    "course-study": 3,
    "exam-grade": 3,
    "student-status-graduation": 4,
    "academic-development": 5,
    "rules-rights": 3,
  });
  assert.equal(service.retrievalChunks().length, 205);
  const transfer = service.guide("transfer-major-2026");
  assert.equal(transfer.variants.length, 29);
  assert.equal(transfer.content_type, "multi_variant");
  assert.equal(new Set(transfer.variants.map((variant) => variant.id)).size, 29);
});

test("guide list summaries expose new taxonomy without legacy fields", () => {
  const list = service.guides(new URLSearchParams("page=1&page_size=5"));
  assert.equal(list.page_size, 5);
  assert.equal(list.items.length, 5);
  for (const item of list.items) {
    assert.equal(Object.hasOwn(item, "steps"), false);
    assert.equal(Object.hasOwn(item, "source_title"), false);
    assert.ok(item.category_label);
    assert.ok(["long_term", "current", "ended", "historical"].includes(item.time_status));
    assert.ok(["standard", "multi_variant"].includes(item.content_type));
  }
  assert.throws(() => service.guides(new URLSearchParams("category=training-program")), /指南分类无效/);
});

test("guide detail returns sections/sources and transfer overview keeps college payload light", () => {
  const detail = service.guide("grade-review");
  assert.ok(detail.sections.length >= 1);
  assert.ok(detail.sections[0].body_format === "markdown");
  assert.ok(detail.sources[0].file_url.startsWith("https://resources.nkustudy.top/guide-sources/"));
  const keys = collectObjectKeys(detail);
  for (const forbidden of ["steps", "source_title", "source_url", "retrieval", "variant_details", "chunks", "chunk_ids", "citation_ids", "source_file", "markdown_file", "original_file", "location"]) {
    assert.equal(keys.has(forbidden), false, `detail leaked key ${forbidden}`);
  }
  const transfer = service.guide("transfer-major-2026");
  assert.equal(keys.has("sections"), true);
  assert.ok(transfer.sections.length < 5, "转专业概览不应携带 29 个学院的正文");
  assert.equal(transfer.variants.every((variant) => !Object.hasOwn(variant, "sections")), true);
  assert.throws(() => service.guide("missing-guide"), /指南不存在/);
});

test("variant endpoint isolates college content and validates ids", () => {
  const materials = service.guideVariant("transfer-major-2026", "materials-science");
  const chemistry = service.guideVariant("transfer-major-2026", "chemistry");
  assert.equal(materials.guide_id, "transfer-major-2026");
  assert.ok(materials.variant.sections.length >= 1);
  assert.equal(materials.variant.sections[0].source_ids[0], "SRC-005-materials-science");
  assert.equal(materials.variant.sources[0].id, "SRC-005-materials-science");
  assert.notEqual(materials.variant.sections[0].body, chemistry.variant.sections[0].body);
  assert.throws(() => service.guideVariant("transfer-major-2026", "no-such-college"), /学院变体不存在/);
  assert.throws(() => service.guideVariant("grade-review", "materials-science"), /学院变体/);
  assert.throws(() => service.guideVariant("missing-guide", "x"), /指南不存在/);
});

test("search projection lists 18 top-level guides with transfer exactly once", () => {
  const items = service.searchItems();
  assert.equal(items.length, 18);
  assert.equal(items.filter((item) => item.id === "transfer-major-2026").length, 1);
  const transfer = items.find((item) => item.id === "transfer-major-2026");
  assert.ok(transfer.tags.some((tag) => tag.includes("学院")), "学院名应进入搜索标签");
});

test("retrieval and conflicts stay private but available for AI batch", () => {
  const chunks = service.retrievalChunks();
  assert.equal(chunks.length, 205);
  assert.ok(chunks.every((chunk) => chunk.text && chunk.source_file_id));
  const conflicts = service.conflictTopics();
  assert.equal(conflicts.length, 1);
  assert.ok(conflicts[0].keywords.includes("自修"));
  const source = service.sourceFileById("SRC-005-materials-science");
  assert.equal(source.file_name.includes("材料"), true);
  assert.equal(service.sourceFileById("nope"), null);
});
