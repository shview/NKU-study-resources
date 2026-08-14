import { PublicApiError } from "./public-api-errors.mjs";
import {
  buildReviewGroups,
  isVisibleCourseMetaTag,
  publicCourseDto,
  publicResourceDto,
  publicReviewGroupDto,
} from "./public-api-dto.mjs";

function queryText(value, max = 120) {
  return String(value ?? "").trim().normalize("NFKC").slice(0, max);
}

function positiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(String(value))) throw new PublicApiError(400, "分页参数必须为正整数。", "INVALID_PAGINATION");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new PublicApiError(400, "分页参数超出允许范围。", "INVALID_PAGINATION");
  }
  return number;
}

function matches(value, expected) {
  return !expected || String(value ?? "").normalize("NFKC") === expected;
}

export class PublicApiService {
  constructor({ readManifest, readReviews, readHome, reviewSubmissionService, publicResourceOrigin = "https://resources.nkustudy.top" } = {}) {
    if (!readManifest || !readReviews || !readHome || !reviewSubmissionService) {
      throw new Error("PublicApiService dependencies are required.");
    }
    this.readManifest = readManifest;
    this.readReviews = readReviews;
    this.readHome = readHome;
    this.reviewSubmissionService = reviewSubmissionService;
    this.publicResourceOrigin = publicResourceOrigin;
  }

  snapshot() {
    const manifest = this.readManifest();
    const reviewData = this.readReviews();
    if (!manifest || !Array.isArray(manifest.courses)) throw new Error("Runtime course data is unavailable.");
    return { manifest, reviewData, groups: buildReviewGroups(manifest, reviewData) };
  }

  health() {
    this.snapshot();
    return { status: "ok" };
  }

  home() {
    const { manifest, groups } = this.snapshot();
    const home = this.readHome();
    if (!home || typeof home !== "object") throw new Error("Runtime home data is unavailable.");
    const courses = manifest.courses.map((course) => publicCourseDto(course, groups, manifest));
    const hotCourses = [...courses]
      .sort((left, right) => right.review_count - left.review_count || right.resource_count - left.resource_count || left.name.localeCompare(right.name, "zh-CN"))
      .slice(0, 6);
    const latestUpdates = [...manifest.courses]
      .sort((left, right) => String(right.updated || "").localeCompare(String(left.updated || "")) || left.title.localeCompare(right.title, "zh-CN"))
      .slice(0, 8)
      .map((course) => ({ id: course.uid, title: String(course.title || "").slice(0, 120), summary: String(course.summary || "").slice(0, 500), updated: String(course.updated || "").slice(0, 80) }));
    return {
      announcement: String(home.announcement || "").trim().slice(0, 2000),
      hot_courses: hotCourses,
      latest_updates: latestUpdates,
    };
  }

  courses(searchParams) {
    const { manifest, groups } = this.snapshot();
    const page = positiveInteger(searchParams.get("page"), 1, { max: 1_000_000 });
    const pageSize = positiveInteger(searchParams.get("page_size"), 20, { max: 100 });
    const q = queryText(searchParams.get("q"), 200).toLocaleLowerCase("zh-CN");
    const term = queryText(searchParams.get("term"));
    const group = queryText(searchParams.get("group"));
    const tag = queryText(searchParams.get("tag"));
    const assessment = queryText(searchParams.get("assessment"));

    const allDtos = manifest.courses.map((course) => publicCourseDto(course, groups, manifest));
    const filtered = allDtos.filter((course) => {
      const haystack = [course.name, course.summary, course.term, course.group, course.assessment, ...course.tags, ...course.teachers].join("\n").normalize("NFKC").toLocaleLowerCase("zh-CN");
      return (!q || haystack.includes(q))
        && matches(course.term, term)
        && matches(course.group, group)
        && (!tag || course.tags.includes(tag))
        && matches(course.assessment, assessment);
    }).sort((left, right) => left.term.localeCompare(right.term, "zh-CN") || left.group.localeCompare(right.group, "zh-CN") || left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id));

    const facets = {
      groups: [...new Set(manifest.courses.filter((course) => isVisibleCourseMetaTag(manifest, course, course.group)).map((course) => queryText(course.group)).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN")),
      terms: [...new Set(manifest.courses.filter((course) => isVisibleCourseMetaTag(manifest, course, course.term)).map((course) => queryText(course.term)).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN")),
      tags: [...new Set(allDtos.flatMap((course) => course.tags))].sort((a, b) => a.localeCompare(b, "zh-CN")),
      assessments: [...new Set(manifest.courses.filter((course) => isVisibleCourseMetaTag(manifest, course, course.assessment)).map((course) => queryText(course.assessment)).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN")),
    };
    const offset = (page - 1) * pageSize;
    return { items: filtered.slice(offset, offset + pageSize), total: filtered.length, page, page_size: pageSize, facets };
  }

  course(courseUid) {
    const { manifest, groups } = this.snapshot();
    const course = manifest.courses.find((item) => item.uid === courseUid);
    if (!course) throw new PublicApiError(404, "课程不存在。", "COURSE_NOT_FOUND");
    return publicCourseDto(course, groups, manifest);
  }

  resources(courseUid) {
    const { manifest } = this.snapshot();
    const course = manifest.courses.find((item) => item.uid === courseUid);
    if (!course) throw new PublicApiError(404, "课程不存在。", "COURSE_NOT_FOUND");
    const items = [];
    for (const section of course.sections || []) {
      for (const file of section.files || []) {
        if (String(file.path || "").split("/").at(-1)?.toLowerCase() === ".openlist") continue;
        items.push(publicResourceDto({ manifest, course, section, file, configuredOrigin: this.publicResourceOrigin }));
      }
    }
    items.sort((left, right) => left.section.localeCompare(right.section, "zh-CN") || left.title.localeCompare(right.title, "zh-CN") || left.id.localeCompare(right.id));
    return { course_id: course.uid, items, total: items.length };
  }

  reviewGroups() {
    const { groups } = this.snapshot();
    const items = groups.map((group) => publicReviewGroupDto(group));
    return { items, total: items.length };
  }

  reviewGroup(groupKey) {
    const { groups } = this.snapshot();
    const group = groups.find((item) => item.key === groupKey);
    if (!group) throw new PublicApiError(404, "评价分组不存在。", "REVIEW_GROUP_NOT_FOUND");
    return publicReviewGroupDto(group, { includeReviews: true });
  }

  assertReviewAttempt(clientIp) {
    this.reviewSubmissionService.assertAttempt(clientIp);
  }

  async submitReview(body, context) {
    const { manifest } = this.snapshot();
    const courseUid = queryText(body?.course_id, 80);
    const course = manifest.courses.find((item) => item.uid === courseUid);
    if (!course) throw new PublicApiError(404, "课程不存在。", "COURSE_NOT_FOUND");
    const result = await this.reviewSubmissionService.submit({
      courseTitle: course.title,
      teacher: body?.teacher,
      rating: body?.rating,
      tags: body?.tags,
      content: body?.body,
      website: body?.website,
    }, context);
    return { submitted: true, pending: result.pending };
  }
}
