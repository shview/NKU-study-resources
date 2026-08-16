const GUIDE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,79}$/;

export const GUIDE_CATEGORIES = Object.freeze([
  "course-selection",
  "training-program",
  "add-drop",
  "exam-grade",
]);

function text(value, max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

function stringList(value, maxItems = 30, maxLength = 80) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => text(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function publicHttpsUrl(value, field, errors) {
  const normalized = text(value, 1000);
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("not public HTTPS");
    parsed.hash = "";
    return parsed.href;
  } catch {
    errors.push(`${field} must be a public HTTPS URL.`);
    return "";
  }
}

function isoTimestamp(value, field, errors) {
  const normalized = text(value, 80);
  if (!normalized || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(normalized) || !Number.isFinite(Date.parse(normalized))) {
    errors.push(`${field} must be an ISO 8601 timestamp with a timezone.`);
    return "";
  }
  return normalized;
}

export function normalizeGuideData(raw, { courseIds = new Set(), fallbackCorrectionUrl = "" } = {}) {
  const errors = [];
  const source = raw && typeof raw === "object" ? raw : {};
  const parsedVersion = source.version === undefined ? 1 : Number(source.version);
  if (!Number.isSafeInteger(parsedVersion) || parsedVersion < 1) errors.push("guides.version must be a positive integer.");
  const fallback = publicHttpsUrl(fallbackCorrectionUrl, "fallback correction_url", errors);
  const correctionUrl = publicHttpsUrl(source.correction_url, "guides.correction_url", errors) || fallback;
  const seen = new Set();
  const items = [];

  if (!Array.isArray(source.items)) errors.push("guides.items must be an array.");
  for (const [index, guide] of (Array.isArray(source.items) ? source.items : []).entries()) {
    if (guide?.hidden === true || guide?.published === false || (guide?.status && String(guide.status).trim() !== "published")) continue;
    const prefix = `guides.items[${index}]`;
    const id = text(guide?.id, 80);
    const title = text(guide?.title, 160);
    const summary = text(guide?.summary, 1000);
    const category = text(guide?.category, 40);
    if (!GUIDE_ID_PATTERN.test(id)) errors.push(`${prefix}.id must match ${GUIDE_ID_PATTERN}.`);
    if (seen.has(id)) errors.push(`${prefix}.id is duplicated.`);
    seen.add(id);
    if (!title) errors.push(`${prefix}.title is required.`);
    if (!GUIDE_CATEGORIES.includes(category)) errors.push(`${prefix}.category is not allowed.`);
    const updatedAt = isoTimestamp(guide?.updated_at, `${prefix}.updated_at`, errors);
    const relatedCourseIds = stringList(guide?.related_course_ids, 100, 80);
    if (guide?.related_course_ids !== undefined && (!Array.isArray(guide.related_course_ids) || guide.related_course_ids.some((id) => typeof id !== "string"))) {
      errors.push(`${prefix}.related_course_ids must be an array of strings.`);
    }
    if (guide?.aliases !== undefined && (!Array.isArray(guide.aliases) || guide.aliases.some((alias) => typeof alias !== "string"))) {
      errors.push(`${prefix}.aliases must be an array of strings.`);
    }
    if (guide?.tags !== undefined && (!Array.isArray(guide.tags) || guide.tags.some((tag) => typeof tag !== "string"))) {
      errors.push(`${prefix}.tags must be an array of strings.`);
    }
    for (const courseId of relatedCourseIds) {
      if (!courseIds.has(courseId)) errors.push(`${prefix}.related_course_ids contains unknown course ${courseId}.`);
    }
    const steps = (Array.isArray(guide?.steps) ? guide.steps : []).slice(0, 100).map((step, stepIndex) => {
      const stepTitle = text(step?.title, 160);
      const body = text(step?.body, 8000);
      if (!stepTitle || !body) errors.push(`${prefix}.steps[${stepIndex}] requires title and body.`);
      return { title: stepTitle, body };
    });
    items.push({
      id,
      title,
      short_name: text(guide?.short_name, 80),
      aliases: stringList(guide?.aliases, 20, 80),
      summary,
      category,
      tags: stringList(guide?.tags, 30, 80),
      updated_at: updatedAt,
      applicable_scope: text(guide?.applicable_scope, 500),
      steps,
      related_course_ids: relatedCourseIds,
      source_title: text(guide?.source_title, 200),
      source_url: publicHttpsUrl(guide?.source_url, `${prefix}.source_url`, errors),
      correction_url: publicHttpsUrl(guide?.correction_url, `${prefix}.correction_url`, errors) || correctionUrl,
    });
  }

  return {
    data: {
      version: Number.isSafeInteger(parsedVersion) && parsedVersion >= 1 ? parsedVersion : 1,
      updated_at: source.updated_at ? isoTimestamp(source.updated_at, "guides.updated_at", errors) : "",
      correction_url: correctionUrl,
      items,
    },
    errors,
  };
}
