import { createHash } from "node:crypto";
import path from "node:path";
import { strictR2BasePath, strictR2Path } from "./r2-mutation-plan.mjs";

const APPROVED_STATUSES = new Set(["approved", "通过"]);
const BLOCKED_META_TAG = "无固定年级";

function text(value, max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

function stringList(value, maxItems = 30, maxLength = 80) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => text(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function hiddenMetaTags(manifest, course) {
  return new Set([...(manifest?.hiddenMetaTags || []), ...(course?.hiddenMetaTags || [])].map((tag) => text(tag, 80)).filter(Boolean));
}

export function isVisibleCourseMetaTag(manifest, course, value) {
  const tag = text(value, 80);
  return Boolean(tag) && tag !== BLOCKED_META_TAG && !hiddenMetaTags(manifest, course).has(tag);
}

function approvedReview(review) {
  return APPROVED_STATUSES.has(text(review?.status, 20)) && review?.hidden !== true;
}

export function normalizeReviewKeyPart(value) {
  return text(value, 120);
}

// 分组键专用：抹平空格与顿号/逗号/中点等符号差异，
// 避免同一门课因「、/，」「多一个空格」被拆成两个评价组。
function groupKeyPart(value) {
  return normalizeReviewKeyPart(value)
    .replace(/\s+/g, "")
    .replace(/[、，,．。：:；;·—\-_/\\]/g, "")
    .replace(/（/g, "(")
    .replace(/）/g, ")");
}

export function reviewGroupKey(courseTitle, teacher) {
  return createHash("sha256")
    .update(`${groupKeyPart(courseTitle)}\0${groupKeyPart(teacher)}`, "utf8")
    .digest("base64url")
    .slice(0, 24);
}

export function resourceId(courseUid, relativePath) {
  return createHash("sha256").update(`${courseUid}\0${relativePath}`, "utf8").digest("base64url").slice(0, 24);
}

export function teacherId(name) {
  return createHash("sha256").update(`teacher\0${text(name, 80).normalize("NFKC")}`, "utf8").digest("base64url").slice(0, 24);
}

function extensionFor(title) {
  const extension = path.posix.extname(text(title, 500)).replace(/^\./, "").toUpperCase();
  return extension || "FILE";
}

function sizeLabel(size) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function encodeSegments(value) {
  return String(value).split("/").filter(Boolean).map((segment) => encodeURIComponent(segment)).join("/");
}

export function publicResourceBase(manifest, configuredOrigin) {
  const root = new URL(manifest.resourceRoot);
  const expected = new URL(configuredOrigin);
  if (root.protocol !== "https:" || expected.protocol !== "https:" || root.origin !== expected.origin) {
    throw new Error("manifest.resourceRoot must use the configured HTTPS public resource origin.");
  }
  root.hash = "";
  root.search = "";
  if (!root.pathname.endsWith("/")) root.pathname += "/";
  return root;
}

export function buildResourceUrl({ manifest, course, file, configuredOrigin }) {
  const root = publicResourceBase(manifest, configuredOrigin);
  const basePath = strictR2BasePath(course.basePath, `${course.title}: basePath`);
  const filePath = strictR2Path(file.path, `${course.title}: resource path`);
  const relativePath = `${basePath}${filePath}`;
  const url = new URL(`${root.pathname}${encodeSegments(relativePath)}`, root.origin);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) {
    throw new Error("Generated resource URL escaped the configured public resource root.");
  }
  return { downloadUrl: url.href, relativePath: filePath };
}

export function publicReviewDto(review, { viewerId = null } = {}) {
  const helpfulBy = Array.isArray(review.helpfulBy) ? review.helpfulBy.map(Number) : [];
  return {
    id: text(review.id, 160),
    teacher_name: text(review.teacher, 80),
    rating: Number(review.rating) || 0,
    tags: stringList(review.tags, 12, 40),
    body: text(review.content, 2000),
    helpful_count: Math.max(0, Number(review.helpfulCount || 0) || 0),
    viewer_reaction: viewerId && helpfulBy.includes(Number(viewerId)) ? "up" : null,
    created_at: text(review.createdAt, 80),
  };
}

export function buildReviewGroups(manifest, reviewData, courseCatalog = null, { viewerId = null } = {}) {
  const coursesByTitle = new Map();
  for (const course of manifest.courses || []) {
    const title = normalizeReviewKeyPart(course.title);
    if (!coursesByTitle.has(title)) coursesByTitle.set(title, course);
  }
  const resolveCourse = (courseTitle) => {
    const direct = coursesByTitle.get(courseTitle);
    if (direct) return direct;
    // 经课程目录解析：评价课程名 -> 目录条目（含别名） -> 再尝试其规范名与别名匹配课程库
    const entry = courseCatalog?.find?.(courseTitle);
    if (!entry) return null;
    for (const candidate of [entry.name, ...(entry.aliases || [])]) {
      const hit = coursesByTitle.get(normalizeReviewKeyPart(candidate));
      if (hit) return hit;
    }
    return null;
  };
  const groups = new Map();
  for (const review of reviewData?.reviews || []) {
    if (!approvedReview(review)) continue;
    const courseTitle = normalizeReviewKeyPart(review.courseTitle);
    const teacher = normalizeReviewKeyPart(review.teacher);
    if (!courseTitle || !teacher) continue;
    const key = reviewGroupKey(courseTitle, teacher);
    const course = resolveCourse(courseTitle);
    const catalogCourse = courseCatalog?.find?.(courseTitle) || null;
    if (!groups.has(key)) {
      groups.set(key, { key, courseTitle, teacher, course, catalogCourse, reviews: [] });
    }
    groups.get(key).reviews.push(publicReviewDto(review, { viewerId }));
  }
  for (const group of groups.values()) {
    group.reviews.sort((left, right) => right.created_at.localeCompare(left.created_at) || left.id.localeCompare(right.id));
  }
  return [...groups.values()].sort((left, right) => {
    const leftRatings = left.reviews.map((review) => review.rating).filter((rating) => rating >= 1 && rating <= 5);
    const rightRatings = right.reviews.map((review) => review.rating).filter((rating) => rating >= 1 && rating <= 5);
    const leftAverage = leftRatings.length ? leftRatings.reduce((sum, rating) => sum + rating, 0) / leftRatings.length : 0;
    const rightAverage = rightRatings.length ? rightRatings.reduce((sum, rating) => sum + rating, 0) / rightRatings.length : 0;
    return right.reviews.length - left.reviews.length || rightAverage - leftAverage || `${left.courseTitle}-${left.teacher}`.localeCompare(`${right.courseTitle}-${right.teacher}`, "zh-CN");
  });
}

export function publicReviewGroupDto(group, { includeReviews = false } = {}) {
  const ratings = group.reviews.map((review) => review.rating).filter((value) => value >= 1 && value <= 5);
  const dto = {
    group_key: group.key,
    course_id: group.course?.uid || null,
    catalog_course_id: group.catalogCourse?.id || null,
    course_name: group.course?.title || group.courseTitle,
    teacher_name: group.teacher,
    matched: Boolean(group.course),
    // course_title 提交路径覆盖全部已有评价组，因此所有组都可投稿
    submittable: true,
    review_count: group.reviews.length,
    rating_average: ratings.length ? Number((ratings.reduce((sum, value) => sum + value, 0) / ratings.length).toFixed(1)) : null,
  };
  if (includeReviews) dto.items = group.reviews;
  return dto;
}

function teacherGroupsFor(course, reviewGroups) {
  return reviewGroups
    .filter((group) => group.course?.uid === course.uid)
    .map((group) => ({
      id: group.key,
      group_key: group.key,
      teacher_name: group.teacher,
      teacher_name_short: Array.from(group.teacher).slice(-2).join(""),
      review_count: group.reviews.length,
    }));
}

function courseRating(course, reviewGroups) {
  const ratings = reviewGroups
    .filter((group) => group.course?.uid === course.uid)
    .flatMap((group) => group.reviews.map((review) => review.rating))
    .filter((rating) => rating >= 1 && rating <= 5);
  return {
    average: ratings.length ? Number((ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length).toFixed(1)) : null,
    count: ratings.length,
    show_aggregate: ratings.length > 0,
  };
}

export function countResources(course) {
  return (course.sections || []).reduce((sum, section) => sum + (section.files || []).length, 0);
}

export function publicCourseDto(course, reviewGroups, manifest) {
  const teacherGroups = teacherGroupsFor(course, reviewGroups);
  const ratings = courseRating(course, reviewGroups);
  return {
    id: course.uid,
    name: text(course.title, 120),
    short_name: text(course.shortName, 80),
    aliases: stringList(course.aliases, 20, 80),
    summary: text(course.summary, 2000),
    description: text(course.summary, 2000),
    term: text(course.term, 80),
    group: text(course.group, 120),
    category_name: text(course.group, 120),
    tags: stringList(course.tags, 30, 80).filter((tag) => isVisibleCourseMetaTag(manifest, course, tag)),
    assessment: text(course.assessment, 120),
    teachers: teacherGroups.map((group) => group.teacher_name),
    teacher_groups: teacherGroups,
    resource_count: countResources(course),
    review_count: ratings.count,
    offering_count: teacherGroups.length,
    ratings,
    contributors: stringList(course.contributors, 20, 40),
    updated: text(course.updated, 80),
  };
}

export function publicResourceDto({ manifest, course, section, file, configuredOrigin }) {
  const { downloadUrl, relativePath } = buildResourceUrl({ manifest, course, file, configuredOrigin });
  const title = text(file.title, 500);
  const size = Math.max(0, Number(file.size) || 0);
  return {
    id: resourceId(course.uid, relativePath),
    course_id: course.uid,
    course_name: text(course.title, 120),
    title,
    size,
    size_label: sizeLabel(size),
    description: text(file.description, 2000),
    section: text(section.title, 160),
    type: text(section.title, 160),
    term_label: text(course.term, 80),
    extension: extensionFor(title),
    download_url: downloadUrl,
  };
}
