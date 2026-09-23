#!/usr/bin/env node
/**
 * 学习指南针内容快照构建脚本。
 *
 * 输入：content/learning-compass.generated.json（小程序侧交付的已验证生成数据，
 *       由学校 Markdown 原文经 SOURCE_FILE_MAP 构建，版本 6a8ddab4…）。
 * 输出：server/data/learning-compass-snapshot.json（生产公共指南数据源）。
 *
 * 转换规则（对照交接文档 LEARNING_COMPASS_BACKEND_API_HANDOFF.md）：
 * - 中文分类 → 稳定五分类 value；
 * - 来源组 → source_files 原件映射，file_url 指向 R2 公网域名 guide-sources/ 前缀；
 * - 转专业指南只保留校级章节，29 个学院变体按需从 chunk 预生成 sections；
 * - 逐字 chunk 保留在私有 retrieval 区供 AI 问答检索，绝不进入公共 DTO；
 * - 冲突证据（自修差异）保留 topic 与 chunk 文本，仅用于 AI 拒答；
 * - 校验计数：5 分类、18 篇 published、29 变体、205 公开 chunk、35 原件。
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const inputPath = process.argv[2] || path.join(here, "..", "content", "learning-compass.generated.json");
const outputPath = process.argv[3] || path.join(here, "..", "server", "data", "learning-compass-snapshot.json");
const publicOrigin = process.env.PUBLIC_RESOURCE_ORIGIN || "https://resources.nkustudy.top";
const guidePrefix = process.env.GUIDE_SOURCES_PREFIX || "guide-sources";

const CATEGORY_DEFINITIONS = [
  { value: "course-study", label: "选课与修读", order: 1 },
  { value: "exam-grade", label: "考试与成绩", order: 2 },
  { value: "student-status-graduation", label: "学籍与毕业", order: 3 },
  { value: "academic-development", label: "学业拓展", order: 4 },
  { value: "rules-rights", label: "规范与权益", order: 5 },
];
const CATEGORY_BY_LABEL = new Map(CATEGORY_DEFINITIONS.map((item) => [item.label, item]));
const TRANSFER_GUIDE_ID = "transfer-major-2026";
const TRANSFER_COLLEGE_SOURCE_GROUP = "SRC-005";

const PRESENTATION_OVERRIDES = {
  "course-selection-2026-fall": { time_status: "current", applicable_scope: "2025级本科生，2026—2027学年第一学期" },
  "course-selection-rules-2026-fall": { time_status: "current", applicable_scope: "南开大学本科生，2026—2027学年第一学期" },
  "micro-major-2026": { time_status: "ended", applicable_scope: "南开大学2026年微专业招生" },
  "minor-study-2026": { time_status: "ended", applicable_scope: "南开大学2026年本科生辅修申请" },
  [TRANSFER_GUIDE_ID]: { time_status: "current", applicable_scope: "南开大学2026年本科生转专业申请" },
  "ai-coursework": { time_status: "long_term", applicable_scope: "南开大学本科教学" },
};

function fail(code, message) {
  throw new Error(`[${code}] ${message}`);
}

function publicFileUrl(fileName) {
  return `${publicOrigin}/${guidePrefix}/${encodeURIComponent(fileName)}`;
}

function publicSource(sourceFile, locationLabel) {
  return {
    id: sourceFile.id,
    title: sourceFile.title,
    document_no: String(sourceFile.document_no || ""),
    publisher: String(sourceFile.publisher || ""),
    published_at: String(sourceFile.published_at || ""),
    file_type: sourceFile.file_type,
    file_name: sourceFile.file_name,
    file_url: publicFileUrl(sourceFile.file_name),
    official_page_url: String(sourceFile.official_page_url || ""),
    location_label: String(locationLabel || ""),
  };
}

const raw = JSON.parse(readFileSync(inputPath, "utf8"));
const sourceFiles = new Map(raw.source_files.map((file) => [file.id, file]));
const groupToFile = new Map(raw.source_files.filter((file) => !file.variant_id).map((file) => [file.source_group_id, file]));
const markdownToFile = new Map(raw.source_files.map((file) => [file.markdown_file, file]));

const published = (raw.guides || []).filter((guide) => guide.status === "published");
if (published.length !== 18) fail("GUIDE_COUNT", `published 指南数量应为 18，实际 ${published.length}`);
if (raw.source_files.length !== 35) fail("SOURCE_COUNT", `原件映射应为 35，实际 ${raw.source_files.length}`);

const guides = [];
let chunkCount = 0;
for (const guide of published) {
  const category = CATEGORY_BY_LABEL.get(guide.category);
  if (!category) fail("CATEGORY", `${guide.id} 分类「${guide.category}」无稳定值映射`);
  const override = PRESENTATION_OVERRIDES[guide.id] || {};
  const isTransfer = guide.id === TRANSFER_GUIDE_ID;

  const locationsBySource = new Map();
  for (const citation of guide.citations || []) {
    if (isTransfer && citation.source_id === TRANSFER_COLLEGE_SOURCE_GROUP) continue;
    const list = locationsBySource.get(citation.source_id) || [];
    if (!list.includes(citation.location_label)) list.push(citation.location_label);
    locationsBySource.set(citation.source_id, list);
  }

  const visibleSections = (guide.sections || []).filter((section) =>
    !(isTransfer && (section.citation_ids || []).some((id) => id === TRANSFER_COLLEGE_SOURCE_GROUP)),
  );
  const sections = visibleSections.map((section) => ({
    id: section.id,
    title: section.title,
    body_format: "markdown",
    body: section.body,
    source_ids: (section.citation_ids || []).map((id) => {
      const file = groupToFile.get(id);
      if (!file) fail("SOURCE_GROUP", `${guide.id} 章节 ${section.id} 引用未知来源组 ${id}`);
      return file.id;
    }),
  }));

  const sourceIds = [...new Set(sections.flatMap((section) => section.source_ids))];
  const sources = sourceIds.map((id) => {
    const file = sourceFiles.get(id);
    if (!file) fail("SOURCE_FILE", `原件 ${id} 不存在`);
    return publicSource(file, (locationsBySource.get(file.source_group_id) || []).join("；"));
  });

  const variants = [];
  if (isTransfer) {
    const chunksById = new Map((guide.chunks || []).map((chunk) => [chunk.chunk_id, chunk]));
    const collegeFiles = raw.source_files
      .filter((file) => file.source_group_id === TRANSFER_COLLEGE_SOURCE_GROUP && file.variant_id)
      .sort((left, right) => left.order - right.order);
    if (collegeFiles.length !== 29) fail("VARIANT_COUNT", `转专业变体应为 29，实际 ${collegeFiles.length}`);
    for (const file of collegeFiles) {
      const matched = (guide.chunks || []).filter((chunk) => chunk.source_file === file.markdown_file);
      if (!matched.length) fail("VARIANT_CHUNKS", `${file.id} 没有对应原文块`);
      variants.push({
        id: file.variant_id,
        title: file.variant_title,
        order: file.order,
        source_file_id: file.id,
        sections: matched.map((chunk, index) => ({
          id: `${file.variant_id}-${index + 1}`,
          title: chunk.location,
          body_format: "markdown",
          body: chunk.text,
          source_ids: [file.id],
        })),
      });
    }
  }

  const retrieval = (guide.chunks || []).map((chunk) => {
    const file = markdownToFile.get(chunk.source_file);
    if (!file) fail("CHUNK_SOURCE", `${guide.id} 原文块 ${chunk.chunk_id} 的来源文件未登记：${chunk.source_file}`);
    return { id: chunk.chunk_id, source_file_id: file.id, location: chunk.location, text: chunk.text };
  });
  chunkCount += (guide.chunks || []).length;

  const variantTitles = variants.map((variant) => variant.title);
  guides.push({
    id: guide.id,
    title: guide.title,
    summary: String(guide.summary || ""),
    category: category.value,
    category_label: category.label,
    content_type: isTransfer ? "multi_variant" : "standard",
    applicable_scope: override.applicable_scope || "南开大学本科生",
    time_status: override.time_status || "long_term",
    updated_at: raw.content_updated_at,
    read_minutes: Number(guide.read_minutes) || 0,
    aliases: [],
    tags: variantTitles,
    sections,
    sources,
    variants: variants.map(({ id, title, order }) => ({ id, title, order, source_count: 1 })),
    variant_details: variants,
    retrieval,
  });
}

if (chunkCount !== 205) fail("CHUNK_COUNT", `公开原文块应为 205，实际 ${chunkCount}`);
const categoriesInUse = new Set(guides.map((guide) => guide.category));
if (categoriesInUse.size !== 5) fail("CATEGORY_COUNT", `使用中的分类应为 5，实际 ${categoriesInUse.size}`);

const conflicts = (raw.conflicts || []).map((conflict) => ({
  topic: String(conflict.topic || conflict.id || ""),
  keywords: ["自修", "自修课程", "自修GPA"],
}));

const version = createHash("sha256")
  .update(JSON.stringify({ categories: CATEGORY_DEFINITIONS, guides, conflicts }))
  .digest("base64url")
  .slice(0, 24);

const snapshot = {
  version,
  source_build_version: raw.version,
  generated_at: new Date().toISOString(),
  content_updated_at: raw.content_updated_at,
  public_origin: publicOrigin,
  guide_sources_prefix: guidePrefix,
  categories: CATEGORY_DEFINITIONS,
  sources: raw.source_files.map((file) => publicSource(file, "")),
  guides,
  conflicts,
};

writeFileSync(outputPath, JSON.stringify(snapshot, null, 1) + "\n");
console.log(`snapshot written: ${outputPath}`);
console.log(`version=${version} guides=${guides.length} variants=${guides.find((g) => g.id === TRANSFER_GUIDE_ID).variants.length} chunks=${chunkCount} sources=${raw.source_files.length} conflicts=${conflicts.length}`);
