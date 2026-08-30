/**
 * 从课程目录池（catalog.json，选课手册来源）批量生成课程壳。
 *
 * 用于"占位也建课程"场景：介绍性质课程没有资料也应有条目。一次导入
 * 全部分类下的缺失课程，替代逐门手工新建。幂等：按 basePath 与
 * term+group+规范化标题去重，重复执行 created=0。
 */

const CJK = new RegExp("[\u4e00-\u9fff]");

function isCjkChar(value) {
  return CJK.test(value);
}

/** 仅清理夹在两个中文字符之间的空格（目录数据从手册 PDF 提取的换行伪影）。 */
export function cleanCatalogCourseName(value) {
  const raw = String(value ?? "");
  let out = "";
  for (let index = 0; index < raw.length; index += 1) {
    const ch = raw[index];
    if (/\s/.test(ch) && index > 0 && index < raw.length - 1 && isCjkChar(raw[index - 1]) && isCjkChar(raw[index + 1])) continue;
    out += ch;
  }
  return out.trim();
}

export function normalizeTitle(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

function slugify(title, usedIds) {
  const base = String(title)
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "") || `course-${Date.now()}`;
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

export function buildCatalogCourseImports(snapshot, catalogCourses, { category = "通识选修课", term = "E课", date = "" } = {}) {
  const courses = Array.isArray(snapshot?.courses) ? snapshot.courses : [];
  const usedIds = new Set(courses.map((course) => String(course.id || "")));
  const seenBasePaths = new Set();
  const seenTitles = new Set();
  for (const course of courses) {
    if (String(course.group || "") !== category) continue;
    seenBasePaths.add(String(course.basePath || "").replace(/\/+$/, ""));
    seenTitles.add(normalizeTitle(course.title));
  }
  const created = [];
  let skipped = 0;
  const pool = Array.isArray(catalogCourses) ? catalogCourses : [];
  for (const entry of pool) {
    if (!(entry?.categories || []).includes(category)) continue;
    const title = cleanCatalogCourseName(entry.name);
    if (!title) continue;
    const basePath = `${term}/${category}/${title}`;
    if (seenBasePaths.has(basePath) || seenTitles.has(normalizeTitle(title))) {
      skipped += 1;
      continue;
    }
    seenBasePaths.add(basePath);
    seenTitles.add(normalizeTitle(title));
    const modules = (entry.modules || []).map(String).filter(Boolean);
    created.push({
      id: slugify(title, usedIds),
      term,
      group: category,
      title,
      summary: "待补充课程简介。",
      contributors: [],
      assessment: category === "通识选修课" ? "通过制" : "绩点制",
      updated: date,
      grades: [],
      tags: modules.length ? modules : [category],
      basePath: `${basePath}/`,
      sections: [],
    });
  }
  return { courses: created, created: created.length, skipped, category, term };
}
