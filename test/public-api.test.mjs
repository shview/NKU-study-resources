import assert from "node:assert/strict";
import test from "node:test";
import { PublicApiService } from "../server/public-api-service.mjs";

const uidA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const uidB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function fixture() {
  const manifest = {
    version: 1,
    repository: "private/repository",
    resourceRoot: "https://resources.nkustudy.top/resources/",
    hiddenMetaTags: ["global-hidden"],
    courses: [
      {
        uid: uidA,
        id: "old-route-a",
        title: "中文课程",
        shortName: "中文",
        aliases: ["中文课"],
        summary: "课程摘要",
        term: "大一下",
        group: "通识选修课",
        assessment: "绩点制",
        tags: ["数学", "服务器标签", "global-hidden", "course-hidden"],
        hiddenMetaTags: ["course-hidden"],
        source: "E:\\private\\course",
        basePath: "大一下/通识选修课/中文课程/",
        updated: "2026-08-15",
        sections: [{ title: "往年真题", note: "internal", files: [{ title: "试题 一.pdf", path: "试题 一.pdf", size: 2048, description: "期末试题" }] }],
      },
      {
        uid: uidB,
        id: "old-route-b",
        title: "另一课程",
        summary: "第二门课",
        term: "大二上",
        group: "专业必修课",
        assessment: "通过制",
        tags: ["计算机"],
        hiddenMetaTags: ["大二上", "专业必修课", "通过制", "计算机"],
        basePath: "大二上/专业必修课/另一课程/",
        updated: "2026-08-14",
        sections: [],
      },
    ],
  };
  const reviews = {
    rules: { submissionOpen: true, moderationRequired: true, minLength: 12 },
    reviews: [
      { id: "review-1", courseTitle: "中文课程", teacher: "张老师", rating: 5, tags: ["讲解清晰"], content: "公开评价正文", status: "approved", hidden: false, createdAt: "2026-08-15T00:00:00Z", ipHash: "secret", userAgent: "secret" },
      { id: "review-2", courseTitle: "历史未匹配课程", teacher: "李老师", rating: 4, content: "历史评价正文", status: "通过", hidden: false },
      { id: "review-3", courseTitle: "中文课程", teacher: "待审老师", rating: 1, content: "待审核", status: "pending", hidden: false },
    ],
  };
  const submissions = [];
  const reviewSubmissionService = {
    assertAttempt(ip) { submissions.push({ attempt: ip }); },
    async submit(input, context) { submissions.push({ input, context }); return { pending: true }; },
  };
  const service = new PublicApiService({
    readManifest: () => structuredClone(manifest),
    readReviews: () => structuredClone(reviews),
    readHome: () => ({ announcement: "服务器公告", privateField: "never expose" }),
    readGuides: () => ({
      version: 1,
      updated_at: "2026-08-16T12:00:00+08:00",
      correction_url: "https://nkustudy.top/feedback",
      items: [{
        id: "add-drop-guide",
        title: "退补选流程",
        summary: "退补选时间与操作步骤",
        category: "add-drop",
        tags: ["退补选"],
        updated_at: "2026-08-16T12:00:00+08:00",
        related_course_ids: [uidA],
        steps: [{ title: "第一步", body: "登录选课系统。" }],
        source_title: "公开教务说明",
        source_url: "https://nkustudy.top/about",
      }],
    }),
    reviewSubmissionService,
    publicResourceOrigin: "https://resources.nkustudy.top",
    guideCorrectionUrl: "https://nkustudy.top/feedback",
  });
  return { service, submissions };
}

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

test("public DTOs whitelist fields and preserve server taxonomy", () => {
  const { service } = fixture();
  const result = service.courses(new URLSearchParams("page=1&page_size=20&group=通识选修课&tag=数学&assessment=绩点制"));
  assert.equal(result.total, 1);
  assert.equal(result.items[0].id, uidA);
  assert.equal(result.items[0].group, "通识选修课");
  assert.deepEqual(result.facets.groups, ["通识选修课"]);
  assert.deepEqual(result.facets.terms, ["大一下"]);
  assert.deepEqual(result.facets.assessments, ["绩点制"]);
  assert.deepEqual(result.items[0].tags, ["数学", "服务器标签"]);
  assert.equal(result.facets.tags.includes("global-hidden"), false);
  assert.equal(result.facets.tags.includes("course-hidden"), false);
  assert.deepEqual(result.items[0].teachers, ["张老师"]);
  assert.equal(result.items[0].ratings.average, 5);
  const payload = { home: service.home(), course: service.course(uidA), resources: service.resources(uidA), groups: service.reviewGroups() };
  const keys = collectObjectKeys(payload);
  for (const forbidden of ["basePath", "source", "resourceRoot", "repository", "hiddenMetaTags", "ipHash", "userAgent", "privateField"]) {
    assert.equal(keys.has(forbidden), false, `public JSON leaked key ${forbidden}`);
  }
  assert.equal(JSON.stringify(payload).includes("E:\\\\private"), false, "public JSON leaked a private path value");
});

test("course search, pagination, and bounds are deterministic", () => {
  const { service } = fixture();
  assert.equal(service.courses(new URLSearchParams("q=张老师")).items[0].id, uidA);
  assert.equal(service.courses(new URLSearchParams("page=2&page_size=1")).items.length, 1);
  assert.throws(() => service.courses(new URLSearchParams("page=0")), /分页参数/);
  assert.throws(() => service.courses(new URLSearchParams("page_size=101")), /分页参数/);
  assert.throws(() => service.course("missing"), /课程不存在/);
});

test("complete search index exposes four whitelisted result types with a stable version", () => {
  const { service } = fixture();
  const first = service.searchIndex();
  const second = service.searchIndex();
  assert.equal(first.version, second.version);
  assert.equal(first.generated_at, "2026-08-16T04:00:00.000Z");
  assert.deepEqual([...new Set(first.items.map((item) => item.type))], ["course", "teacher", "resource", "guide"]);
  const course = first.items.find((item) => item.type === "course" && item.id === uidA);
  assert.equal(course.short_name, "中文");
  assert.deepEqual(course.aliases, ["中文课"]);
  const teacher = first.items.find((item) => item.type === "teacher");
  assert.equal(teacher.name, "张老师");
  assert.deepEqual(teacher.related_course_ids, [uidA]);
  const resource = first.items.find((item) => item.type === "resource");
  assert.equal(resource.course_id, uidA);
  assert.equal(Object.hasOwn(resource, "download_url"), false);
  const keys = collectObjectKeys(first);
  for (const forbidden of ["basePath", "path", "source", "resourceRoot", "ipHash", "userAgent"]) assert.equal(keys.has(forbidden), false);
});

test("guide list and detail validate categories, related courses, and correction URL", () => {
  const { service } = fixture();
  const list = service.guides(new URLSearchParams("category=add-drop&page=1&page_size=20"));
  assert.equal(list.total, 1);
  assert.deepEqual(list.facets.categories, ["add-drop"]);
  assert.equal(list.items[0].id, "add-drop-guide");
  const detail = service.guide("add-drop-guide");
  assert.deepEqual(detail.related_courses, [{ id: uidA, name: "中文课程" }]);
  assert.equal(detail.correction_url, "https://nkustudy.top/feedback");
  assert.throws(() => service.guides(new URLSearchParams("category=life")), /指南分类无效/);
  assert.throws(() => service.guide("missing"), /指南不存在/);
});

test("review groups use website courseTitle + teacher and preserve unmatched groups", () => {
  const { service } = fixture();
  const groups = service.reviewGroups();
  assert.equal(groups.total, 2);
  const matched = groups.items.find((group) => group.matched);
  const unmatched = groups.items.find((group) => !group.matched);
  assert.equal(matched.course_id, uidA);
  assert.equal(matched.teacher_name, "张老师");
  assert.equal(unmatched.course_id, null);
  assert.equal(unmatched.course_name, "历史未匹配课程");
  const detail = service.reviewGroup(unmatched.group_key);
  assert.equal(detail.items.length, 1);
  assert.deepEqual(Object.keys(detail.items[0]).sort(), ["body", "created_at", "helpful_count", "id", "rating", "tags", "teacher_name"]);
  assert.throws(() => service.reviewGroup("missing"), /评价分组不存在/);
});

test("resource URLs are HTTPS, segment encoded, origin constrained, and path-free", () => {
  const { service } = fixture();
  const first = service.resources(uidA).items[0];
  assert.equal(first.download_url, "https://resources.nkustudy.top/resources/%E5%A4%A7%E4%B8%80%E4%B8%8B/%E9%80%9A%E8%AF%86%E9%80%89%E4%BF%AE%E8%AF%BE/%E4%B8%AD%E6%96%87%E8%AF%BE%E7%A8%8B/%E8%AF%95%E9%A2%98%20%E4%B8%80.pdf");
  assert.equal(first.size_label, "2.0 KB");
  assert.equal(Object.hasOwn(first, "path"), false);
  assert.equal(first.id.length, 24);
  const wrongOrigin = fixture().service;
  wrongOrigin.publicResourceOrigin = "https://cdn.example.invalid";
  assert.throws(() => wrongOrigin.resources(uidA), /configured HTTPS public resource origin/);
});

test("mini-program review body maps into the shared submission service", async () => {
  const { service, submissions } = fixture();
  service.assertReviewAttempt("actor");
  const result = await service.submitReview({ course_id: uidA, teacher: "张老师", rating: 5, tags: ["讲解清晰"], body: "足够长的课程评价正文内容。", anonymous: true }, { clientIp: "actor", userAgent: "wx" });
  assert.deepEqual(result, { submitted: true, pending: true });
  assert.equal(submissions[0].attempt, "actor");
  assert.equal(submissions[1].input.courseTitle, "中文课程");
  assert.equal(submissions[1].input.content, "足够长的课程评价正文内容。");
  assert.equal(Object.hasOwn(submissions[1].input, "anonymous"), false);
});
