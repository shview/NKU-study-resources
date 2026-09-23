import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicApiError } from "./public-api-errors.mjs";

/**
 * 学习指南针公共指南服务：从版本化内容快照投影公共 DTO。
 *
 * 数据源 server/data/learning-compass-snapshot.json 由
 * scripts/build-learning-compass-snapshot.mjs 生成（5 分类、18 篇 published、
 * 29 转专业学院变体、205 公开原文块、35 份 R2 原件映射）。
 * 私有字段（retrieval 逐字块、variant_details 原文、conflicts）只供
 * AI 问答检索与拒答使用，任何公共 DTO 不得展开。
 */
const DEFAULT_SNAPSHOT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "learning-compass-snapshot.json");
const TIME_STATUS = new Set(["long_term", "current", "ended", "historical"]);

function positiveInteger(value, fallback, { max = 1_000_000 } = {}) {
  const parsed = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isInteger(parsed) || parsed < 1 || parsed > max) return fallback;
  return parsed;
}

function queryText(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

export function createLearningCompassService(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.guides) || !snapshot.guides.length) {
    throw new Error("learning-compass snapshot is empty or invalid");
  }
  const categories = Object.freeze((snapshot.categories || []).map((item) => ({ ...item })));
  const categoryValues = new Set(categories.map((item) => item.value));
  const guidesById = new Map(snapshot.guides.map((guide) => [guide.id, guide]));
  const sourcesById = new Map((snapshot.sources || []).map((source) => [source.id, source]));
  const transferGuide = snapshot.guides.find((guide) => guide.content_type === "multi_variant");

  function categoryFacets(filteredGuides) {
    return categories
      .map((category) => ({ ...category, count: filteredGuides.filter((guide) => guide.category === category.value).length }))
      .filter((category) => category.count > 0);
  }

  function summaryDto(guide) {
    return {
      id: guide.id,
      title: guide.title,
      summary: guide.summary,
      category: guide.category,
      category_label: guide.category_label,
      applicable_scope: guide.applicable_scope,
      updated_at: guide.updated_at,
      time_status: guide.time_status,
      content_type: guide.content_type,
      read_minutes: guide.read_minutes,
      source_count: guide.sources.length + (guide.content_type === "multi_variant" ? guide.variants.length : 0),
      aliases: guide.aliases.slice(),
      tags: guide.tags.slice(),
    };
  }

  function detailDto(guide) {
    return {
      id: guide.id,
      title: guide.title,
      summary: guide.summary,
      category: guide.category,
      category_label: guide.category_label,
      applicable_scope: guide.applicable_scope,
      updated_at: guide.updated_at,
      time_status: guide.time_status,
      content_type: guide.content_type,
      read_minutes: guide.read_minutes,
      sections: guide.sections.map((section) => ({
        id: section.id,
        title: section.title,
        body_format: section.body_format,
        body: section.body,
        source_ids: section.source_ids.slice(),
      })),
      sources: guide.sources.map((source) => ({ ...source })),
      variants: guide.variants.map((variant) => ({ ...variant })),
      related_courses: [],
      correction_url: "",
    };
  }

  return {
    categories: () => categories.map((category) => ({ ...category })),
    contentUpdatedAt: () => snapshot.content_updated_at || "",
    version: () => snapshot.version || "",

    guides(searchParams) {
      const page = positiveInteger(searchParams.get("page"), 1);
      const pageSize = positiveInteger(searchParams.get("page_size"), 20, { max: 100 });
      const category = queryText(searchParams.get("category"), 40);
      if (category && !categoryValues.has(category)) throw new PublicApiError(400, "指南分类无效。", "INVALID_GUIDE_CATEGORY");
      const filtered = snapshot.guides.filter((guide) => !category || guide.category === category);
      const offset = (page - 1) * pageSize;
      return {
        items: filtered.slice(offset, offset + pageSize).map(summaryDto),
        total: filtered.length,
        page,
        page_size: pageSize,
        facets: { categories: categoryFacets(filtered) },
        data_updated_at: snapshot.content_updated_at || "",
      };
    },

    guide(guideId) {
      const guide = guidesById.get(guideId);
      if (!guide) throw new PublicApiError(404, "指南不存在。", "GUIDE_NOT_FOUND");
      return detailDto(guide);
    },

    guideVariant(guideId, variantId) {
      const guide = guidesById.get(guideId);
      if (!guide) throw new PublicApiError(404, "指南不存在。", "GUIDE_NOT_FOUND");
      if (guide.content_type !== "multi_variant") throw new PublicApiError(404, "该指南没有学院变体。", "GUIDE_VARIANT_NOT_FOUND");
      const variant = (guide.variant_details || []).find((item) => item.id === variantId);
      if (!variant) throw new PublicApiError(404, "学院变体不存在。", "GUIDE_VARIANT_NOT_FOUND");
      const sourceIds = [...new Set(variant.sections.flatMap((section) => section.source_ids))];
      const variantSources = sourceIds.map((id) => {
        const base = sourcesById.get(id) || guide.sources.find((source) => source.id === id);
        if (!base) throw new PublicApiError(500, "指南来源数据不完整。", "INTERNAL_ERROR");
        const locationLabel = variant.sections.filter((section) => section.source_ids.includes(id)).map((section) => section.title).join("；");
        return { ...base, location_label: locationLabel };
      });
      return {
        guide_id: guide.id,
        variant: {
          id: variant.id,
          title: variant.title,
          order: variant.order,
          sections: variant.sections.map((section) => ({
            id: section.id,
            title: section.title,
            body_format: section.body_format,
            body: section.body,
            source_ids: section.source_ids.slice(),
          })),
          sources: variantSources,
        },
      };
    },

    searchItems() {
      return snapshot.guides.map((guide) => ({
        id: guide.id,
        title: guide.title,
        summary: guide.summary,
        category: guide.category,
        category_label: guide.category_label,
        updated_at: guide.updated_at,
        aliases: guide.aliases.slice(),
        tags: guide.tags.slice(),
        applicable_scope: guide.applicable_scope,
        read_minutes: guide.read_minutes,
      }));
    },

    transferGuideId: () => (transferGuide ? transferGuide.id : ""),

    /** 供 AI 问答（B 批）检索：返回全部 published 指南的逐字原文块投影。 */
    retrievalChunks() {
      return snapshot.guides.flatMap((guide) =>
        (guide.retrieval || []).map((chunk) => ({
          guide_id: guide.id,
          guide_title: guide.title,
          chunk_id: chunk.id,
          source_file_id: chunk.source_file_id,
          location: chunk.location,
          text: chunk.text,
        })),
      );
    },

    /** 供 AI 问答：公开来源（含变体原件）映射，用于把命中块映射成整份原文件 citation。 */
    sourceFileById(sourceFileId) {
      const base = sourcesById.get(sourceFileId);
      return base ? { ...base } : null;
    },

    /** 供 AI 问答拒答：来源冲突主题关键词。 */
    conflictTopics() {
      return (snapshot.conflicts || []).map((conflict) => ({ topic: conflict.topic, keywords: conflict.keywords.slice() }));
    },
  };
}

export function loadLearningCompassSnapshot(snapshotPath = DEFAULT_SNAPSHOT_PATH) {
  return JSON.parse(readFileSync(snapshotPath, "utf8"));
}

export function createDefaultLearningCompassService(snapshotPath = DEFAULT_SNAPSHOT_PATH) {
  return createLearningCompassService(loadLearningCompassSnapshot(snapshotPath));
}

export const LEARNING_COMPASS_TIME_STATUS = TIME_STATUS;
