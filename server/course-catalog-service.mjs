import fs from "node:fs";
import path from "node:path";

function normalizeName(value) {
  return String(value ?? "").replace(/\s+/g, "").replace(/（/g, "(").replace(/）/g, ")").replace(/[《》]/g, "");
}

export class CourseCatalogService {
  constructor({ catalogPath }) {
    this.catalogPath = path.resolve(catalogPath);
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

  reload() {
    this.#load();
  }
}
