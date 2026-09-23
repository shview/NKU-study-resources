import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function normalizeName(value) {
  return String(value ?? "").replace(/\s+/g, "").replace(/（/g, "(").replace(/）/g, ")").replace(/[《》]/g, "");
}

export class CourseCatalogService {
  constructor({ catalogPath, writeJson = null } = {}) {
    this.catalogPath = path.resolve(catalogPath);
    this.writeJson = writeJson;
    this.#load();
  }

  #load() {
    this.byNorm = new Map();
    this.byId = new Map();
    if (!fs.existsSync(this.catalogPath)) {
      this.courses = [];
      this.meta = { version: 0, updated: "", sources: [] };
      return;
    }
    const data = JSON.parse(fs.readFileSync(this.catalogPath, "utf8"));
    this.courses = Array.isArray(data.courses) ? data.courses : [];
    this.meta = {
      version: Number(data.version || 1),
      updated: String(data.updated || ""),
      sources: Array.isArray(data.sources) ? data.sources.map(String) : [],
    };
    for (const course of this.courses) {
      if (!course?.name) continue;
      const entry = {
        id: String(course.id || ""),
        name: String(course.name),
        aliases: (Array.isArray(course.aliases) ? course.aliases : []).map(String),
        categories: (Array.isArray(course.categories) ? course.categories : []).map(String),
        modules: (Array.isArray(course.modules) ? course.modules : []).map(String),
        teachers: (Array.isArray(course.teachers) ? course.teachers : []).map(String),
        terms: (Array.isArray(course.terms) ? course.terms : []).map(String),
      };
      this.byId.set(entry.id, entry);
      this.byNorm.set(normalizeName(entry.name), entry);
      for (const alias of entry.aliases) {
        if (!this.byNorm.has(normalizeName(alias))) this.byNorm.set(normalizeName(alias), entry);
      }
    }
  }

  get loaded() {
    return this.courses.length > 0;
  }

  summary() {
    return { ...this.meta, courses: this.courses.length, teachers: new Set(this.courses.flatMap((c) => c.teachers || [])).size };
  }

  find(courseRef) {
    if (!courseRef) return null;
    return this.byId.get(String(courseRef)) || this.byNorm.get(normalizeName(courseRef)) || null;
  }

  search({ q = "", page = 1, pageSize = 20 } = {}) {
    const keyword = String(q || "").trim().toLowerCase();
    let items = this.courses;
    if (keyword) {
      items = items.filter((course) => {
        const haystack = [course.name, ...(course.aliases || []), ...(course.teachers || [])].join(" ").toLowerCase();
        return haystack.includes(keyword);
      });
    }
    const total = items.length;
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
    const slice = items
      .slice((safePage - 1) * safePageSize, safePage * safePageSize)
      .map((course) => ({
        id: course.id,
        name: course.name,
        categories: course.categories || [],
        modules: course.modules || [],
        teachers: course.teachers || [],
        terms: course.terms || [],
      }));
    return { items: slice, total, page: safePage, page_size: safePageSize };
  }

  /** 网页端"往目录池加课程"：校验、去重、追加并热重载。 */
  async addCourse({ name, categories = [], teachers = [], terms = [], manifestTitles = new Set() } = {}) {
    if (typeof this.writeJson !== "function") throw new Error("CourseCatalogService is read-only.");
    const clean = (value) => String(value ?? "").trim();
    const list = (values, maxItems, maxLength) => {
      const raw = Array.isArray(values) ? values : String(values ?? "").split(/[\u3001\uFF0C,\n]/);
      return [...new Set(raw.map((item) => clean(item).slice(0, maxLength)).filter(Boolean))].slice(0, maxItems);
    };
    const courseName = clean(name).slice(0, 120);
    const courseTeachers = list(teachers, 20, 80);
    const courseCategories = list(categories, 5, 80);
    const courseTerms = list(terms, 5, 40);
    if (courseName.length < 2) {
      const error = new Error("请填写课程名称（至少 2 个字）。");
      error.statusCode = 400; error.code = "INVALID_CATALOG_COURSE"; throw error;
    }
    if (!courseTeachers.length) {
      const error = new Error("请至少填写一位任课教师。");
      error.statusCode = 400; error.code = "INVALID_CATALOG_COURSE"; throw error;
    }
    if (this.find(courseName) || manifestTitles.has(courseName)) {
      const error = new Error("该课程已在目录或课程库中，可直接填写课程名提交评价。");
      error.statusCode = 409; error.code = "CATALOG_COURSE_EXISTS"; throw error;
    }
    const id = `cat-${createHash("sha256").update(normalizeName(courseName)).digest("hex").slice(0, 10)}`;
    if (this.byId.has(id)) {
      const error = new Error("该课程已在目录或课程库中，可直接填写课程名提交评价。");
      error.statusCode = 409; error.code = "CATALOG_COURSE_EXISTS"; throw error;
    }
    const entry = { id, name: courseName, aliases: [], categories: courseCategories, modules: [], teachers: courseTeachers, terms: courseTerms, origin: "user" };
    await this.writeJson((current) => {
      const data = current && typeof current === "object" ? current : {};
      data.courses = [...(Array.isArray(data.courses) ? data.courses : []), entry];
      return data;
    });
    this.reload();
    return { id: entry.id, name: entry.name, categories: entry.categories, teachers: entry.teachers, terms: entry.terms };
  }

  reload() {
    this.#load();
  }
}
