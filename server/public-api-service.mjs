import { createHash } from "node:crypto";
import { PublicApiError } from "./public-api-errors.mjs";
import { GUIDE_CATEGORIES, normalizeGuideData } from "./public-guide-data.mjs";
import {
  buildReviewGroups,
  isVisibleCourseMetaTag,
  publicCourseDto,
  publicResourceDto,
  publicReviewGroupDto,
  teacherId,
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

function uniqueStrings(values) {
  return [...new Set(values.map((value) => queryText(value)).filter(Boolean))];
}

function generatedAt(values) {
  const timestamps = values.map((value) => Date.parse(String(value || ""))).filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : "";
}

function indexItemBase({ id, type, name, shortName = "", aliases = [], tags = [], teachers = [], searchText = "", subtitle = "" }) {
  const typeLabels = { course: "课", teacher: "师", resource: "资", guide: "指" };
  return {
    id,
    type,
    type_label: typeLabels[type],
    badge: typeLabels[type],
    name: queryText(name, 500),
    short_name: queryText(shortName, 80),
    aliases: uniqueStrings(aliases).slice(0, 20),
    tags: uniqueStrings(tags).slice(0, 30),
    teachers: uniqueStrings(teachers).slice(0, 50),
    search_text: queryText(searchText, 4000),
    subtitle: queryText(subtitle, 500),
  };
}

export class PublicApiService {
  constructor({ readManifest, readReviews, readHome, readGuides = () => ({ version: 1, items: [] }), readVisitStats = () => null, courseCatalog = null, reviewSubmissionService, publicResourceOrigin = "https://resources.nkustudy.top", guideCorrectionUrl = "", assertMpAuthAttempt = () => true } = {}) {
    if (!readManifest || !readReviews || !readHome || !reviewSubmissionService) {
      throw new Error("PublicApiService dependencies are required.");
    }
    this.readManifest = readManifest;
    this.readReviews = readReviews;
    this.readHome = readHome;
    this.readGuides = readGuides;
    this.readVisitStats = readVisitStats;
    this.courseCatalog = courseCatalog;
    this.reviewSubmissionService = reviewSubmissionService;
    this.publicResourceOrigin = publicResourceOrigin;
    this.guideCorrectionUrl = guideCorrectionUrl;
    this.assertMpAuthAttempt = assertMpAuthAttempt;
  }

  snapshot() {
    const manifest = this.readManifest();
    const reviewData = this.readReviews();
    if (!manifest || !Array.isArray(manifest.courses)) throw new Error("Runtime course data is unavailable.");
    const groups = buildReviewGroups(manifest, reviewData);
    const normalizedGuides = normalizeGuideData(this.readGuides(), {
      courseIds: new Set(manifest.courses.map((course) => course.uid)),
      fallbackCorrectionUrl: this.guideCorrectionUrl,
    });
    if (normalizedGuides.errors.length) throw new Error(`Runtime guide data is invalid: ${normalizedGuides.errors.join(" ")}`);
    return { manifest, reviewData, groups, guides: normalizedGuides.data };
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
      trending: this.trending(manifest),
    };
  }

  // 按最近 30 天课程详情页访问量取 TOP10，无访问数据时回退为空列表。
  trending(manifest) {
    const stats = this.readVisitStats ? this.readVisitStats() : null;
    const pages = stats?.pages;
    if (!pages || typeof pages !== "object") return [];
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const visits = new Map();
    for (const [path, item] of Object.entries(pages)) {
      const name = (() => {
        try {
          return decodeURIComponent(String(path)).replace(/\/+$/, "").split("/")[2];
        } catch {
          return "";
        }
      })();
      if (!name) continue;
      let count = 0;
      for (const [day, value] of Object.entries(item?.days || {})) {
        if (day >= cutoff) count += Number(value || 0);
      }
      if (count > 0) visits.set(name, (visits.get(name) || 0) + count);
    }
    if (!visits.size) return [];
    const courses = [...manifest.courses];
    return [...visits.entries()]
      .map(([name, count]) => {
        const course = courses.find((item) => String(item.title) === name || String(item.id) === name);
        if (!course) return null;
        return {
          id: course.uid,
          title: String(course.title || "").slice(0, 120),
          visits: count,
          resource_count: (course.sections || []).reduce((sum, section) => sum + (section.files || []).length, 0),
          review_count: Number(course.reviewCount || course.review_count || 0),
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.visits - left.visits)
      .slice(0, 10);
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
      const haystack = [course.name, course.short_name, ...course.aliases, course.summary, course.term, course.group, course.assessment, ...course.tags, ...course.teachers].join("\n").normalize("NFKC").toLocaleLowerCase("zh-CN");
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

  searchIndex() {
    const { manifest, groups, guides } = this.snapshot();
    const coursesById = new Map(manifest.courses.map((course) => [course.uid, course]));
    const courseDtos = new Map(manifest.courses.map((course) => [course.uid, publicCourseDto(course, groups, manifest)]));
    const items = [];

    for (const course of manifest.courses) {
      const dto = courseDtos.get(course.uid);
      items.push(indexItemBase({
        id: dto.id,
        type: "course",
        name: dto.name,
        shortName: dto.short_name,
        aliases: dto.aliases,
        tags: dto.tags,
        teachers: dto.teachers,
        searchText: [dto.summary, dto.term, dto.group, dto.assessment].join(" "),
        subtitle: [dto.group, dto.term].filter(Boolean).join(" · "),
      }));
    }

    const teachers = new Map();
    for (const group of groups) {
      if (!group.course || !group.teacher) continue;
      const key = group.teacher.normalize("NFKC");
      if (!teachers.has(key)) teachers.set(key, { name: group.teacher, courseIds: new Set() });
      teachers.get(key).courseIds.add(group.course.uid);
    }
    for (const teacher of teachers.values()) {
      const relatedCourseIds = [...teacher.courseIds].sort();
      const relatedNames = relatedCourseIds.map((id) => coursesById.get(id)?.title).filter(Boolean);
      items.push({
        ...indexItemBase({
          id: teacherId(teacher.name),
          type: "teacher",
          name: teacher.name,
          teachers: [teacher.name],
          searchText: [teacher.name, ...relatedNames].join(" "),
          subtitle: `相关课程 ${relatedCourseIds.length} 门`,
        }),
        related_course_ids: relatedCourseIds,
      });
    }

    for (const course of manifest.courses) {
      const courseDto = courseDtos.get(course.uid);
      for (const section of course.sections || []) {
        for (const file of section.files || []) {
          if (String(file.path || "").split("/").at(-1)?.toLowerCase() === ".openlist") continue;
          const resource = publicResourceDto({ manifest, course, section, file, configuredOrigin: this.publicResourceOrigin });
          items.push({
            ...indexItemBase({
              id: resource.id,
              type: "resource",
              name: resource.title,
              tags: [resource.type, ...courseDto.tags],
              teachers: courseDto.teachers,
              searchText: [resource.description, resource.type, resource.course_name, resource.term_label].join(" "),
              subtitle: [resource.course_name, resource.type].filter(Boolean).join(" · "),
            }),
            course_id: resource.course_id,
            course_name: resource.course_name,
            resource_type: resource.type,
            term_label: resource.term_label,
          });
        }
      }
    }

    for (const guide of guides.items) {
      items.push({
        ...indexItemBase({
          id: guide.id,
          type: "guide",
          name: guide.title,
          shortName: guide.short_name,
          aliases: guide.aliases,
          tags: guide.tags,
          searchText: [guide.summary, guide.category, guide.applicable_scope].join(" "),
          subtitle: [guide.category, `${guide.updated_at.slice(0, 10)} 更新`].filter(Boolean).join(" · "),
        }),
        category: guide.category,
        updated_at: guide.updated_at,
      });
    }

    const typeOrder = { course: 0, teacher: 1, resource: 2, guide: 3 };
    items.sort((left, right) => typeOrder[left.type] - typeOrder[right.type] || left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id));
    const version = createHash("sha256").update(JSON.stringify(items), "utf8").digest("base64url").slice(0, 24);
    const timestamps = [
      manifest.updated,
      ...manifest.courses.map((course) => course.updated),
      guides.updated_at,
      ...guides.items.map((guide) => guide.updated_at),
      ...groups.flatMap((group) => group.reviews.map((review) => review.created_at)),
    ];
    return { version, generated_at: generatedAt(timestamps), items, total: items.length };
  }

  guides(searchParams) {
    const { guides } = this.snapshot();
    const page = positiveInteger(searchParams.get("page"), 1, { max: 1_000_000 });
    const pageSize = positiveInteger(searchParams.get("page_size"), 20, { max: 100 });
    const category = queryText(searchParams.get("category"), 40);
    if (category && !GUIDE_CATEGORIES.includes(category)) throw new PublicApiError(400, "指南分类无效。", "INVALID_GUIDE_CATEGORY");
    const filtered = guides.items.filter((guide) => !category || guide.category === category);
    const offset = (page - 1) * pageSize;
    return {
      items: filtered.slice(offset, offset + pageSize).map((guide) => ({
        id: guide.id,
        title: guide.title,
        summary: guide.summary,
        category: guide.category,
        updated_at: guide.updated_at,
        applicable_scope: guide.applicable_scope,
        related_course_ids: guide.related_course_ids,
      })),
      total: filtered.length,
      page,
      page_size: pageSize,
      facets: { categories: GUIDE_CATEGORIES.filter((value) => guides.items.some((guide) => guide.category === value)) },
      data_updated_at: guides.updated_at,
    };
  }

  guide(guideId) {
    const { manifest, guides } = this.snapshot();
    const guide = guides.items.find((item) => item.id === guideId);
    if (!guide) throw new PublicApiError(404, "指南不存在。", "GUIDE_NOT_FOUND");
    const coursesById = new Map(manifest.courses.map((course) => [course.uid, course]));
    return {
      id: guide.id,
      title: guide.title,
      summary: guide.summary,
      category: guide.category,
      updated_at: guide.updated_at,
      applicable_scope: guide.applicable_scope,
      steps: guide.steps,
      related_courses: guide.related_course_ids.map((id) => ({ id, name: queryText(coursesById.get(id)?.title, 120) })),
      source_title: guide.source_title,
      source_url: guide.source_url,
      correction_url: guide.correction_url,
    };
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

  catalog(searchParams) {
    if (!this.courseCatalog?.loaded) throw new PublicApiError(503, "课程目录暂未开放。", "CATALOG_NOT_CONFIGURED");
    return {
      summary: this.courseCatalog.summary(),
      ...this.courseCatalog.search({
        q: searchParams.get("q") || "",
        page: searchParams.get("page"),
        pageSize: searchParams.get("page_size"),
      }),
    };
  }

  async submitReview(body, context) {
    const { manifest } = this.snapshot();
    const courseUid = queryText(body?.course_id, 80);
    let course = manifest.courses.find((item) => item.uid === courseUid);
    let courseTitle;
    let catalogCourse = null;
    if (!course && this.courseCatalog?.loaded && body?.catalog_course_id) {
      catalogCourse = this.courseCatalog.find(queryText(body.catalog_course_id, 80));
      if (!catalogCourse) throw new PublicApiError(404, "课程目录中不存在该课程。", "CATALOG_COURSE_NOT_FOUND");
      courseTitle = catalogCourse.name;
    } else if (course) {
      courseTitle = course.title;
    } else {
      throw new PublicApiError(404, "课程不存在。", "COURSE_NOT_FOUND");
    }
    if (catalogCourse) {
      const teacher = queryText(body?.teacher, 80);
      if (catalogCourse.teachers.length) {
        const wanted = String(teacher || "").replace(/\s+/g, "");
        const hit = catalogCourse.teachers.find((t) => String(t).replace(/\s+/g, "") === wanted);
        if (!hit) {
          throw new PublicApiError(400, `请从该课程的授课教师中选择（${catalogCourse.teachers.slice(0, 30).join("、")}）。`, "TEACHER_NOT_IN_CATALOG");
        }
      }
    }
    const result = await this.reviewSubmissionService.submit({
      courseTitle,
      teacher: body?.teacher,
      rating: body?.rating,
      tags: body?.tags,
      content: body?.body,
      website: body?.website,
    }, context);
    if (typeof context?.notify === "function" && result.pending && result.notify) {
      Promise.resolve(context.notify({ type: "review.pending", ...result.notify })).catch(() => {});
    }
    return { submitted: true, pending: result.pending };
  }
}
