import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { PublicApiError } from "./public-api-errors.mjs";

function positiveSafeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return number;
}

export class MpFavoritesService {
  constructor({ dbPath, readManifest, now = Date.now } = {}) {
    if (!dbPath) throw new Error("MpFavoritesService requires dbPath.");
    if (typeof readManifest !== "function") throw new Error("MpFavoritesService requires readManifest.");
    this.dbPath = path.resolve(dbPath);
    this.readManifest = readManifest;
    this.now = now;
    const directory = path.dirname(this.dbPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new Database(this.dbPath);
    fs.chmodSync(this.dbPath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mp_favorites (
        user_id INTEGER NOT NULL,
        course_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, course_id)
      );
      CREATE INDEX IF NOT EXISTS mp_favorites_user_idx ON mp_favorites(user_id, created_at DESC);
    `);
    this.insertFavorite = this.db.prepare("INSERT OR IGNORE INTO mp_favorites(user_id, course_id, created_at) VALUES (?, ?, ?)");
    this.removeFavorite = this.db.prepare("DELETE FROM mp_favorites WHERE user_id = ? AND course_id = ?");
    this.listFavorites = this.db.prepare("SELECT course_id, created_at FROM mp_favorites WHERE user_id = ? ORDER BY created_at DESC, course_id ASC");
    this.countFavorites = this.db.prepare("SELECT COUNT(*) AS count FROM mp_favorites WHERE user_id = ?");
    this.removeMissingCourses = this.db.prepare("DELETE FROM mp_favorites WHERE user_id = ? AND course_id NOT IN (SELECT value FROM json_each(?))");
    this.#secureDatabaseFiles();
  }

  // 公开 API 的课程 ID 即 uid；兼容历史 manifest 内部 id。
  #resolveCourse(courseId, manifest) {
    const wanted = String(courseId ?? "");
    if (!wanted || wanted.length > 160) return null;
    for (const course of manifest.courses || []) {
      if (String(course.uid) === wanted) return course;
    }
    for (const course of manifest.courses || []) {
      if (String(course.id) === wanted) return course;
    }
    return null;
  }

  #canonicalId(course) {
    return String(course.uid || course.id);
  }

  #courseIds() {
    const manifest = this.readManifest() || {};
    return JSON.stringify((manifest.courses || []).map((course) => this.#canonicalId(course)).filter(Boolean));
  }

  add(user, courseId, { now = this.now() } = {}) {
    const manifest = this.readManifest() || {};
    const course = this.#resolveCourse(courseId, manifest);
    if (!course) {
      if (!String(courseId ?? "")) throw new PublicApiError(400, "课程 ID 无效。", "INVALID_COURSE");
      throw new PublicApiError(404, "课程不存在。", "COURSE_NOT_FOUND");
    }
    const id = this.#canonicalId(course);
    const inserted = this.insertFavorite.run(user.id, id, positiveSafeInteger(now, "now")).changes > 0;
    return { favorited: true, created: inserted, total: Number(this.countFavorites.get(user.id).count) };
  }

  remove(user, courseId) {
    const manifest = this.readManifest() || {};
    const course = this.#resolveCourse(courseId, manifest);
    const id = course ? this.#canonicalId(course) : String(courseId ?? "");
    const removed = this.removeFavorite.run(user.id, id).changes > 0 || (!course && this.removeFavorite.run(user.id, String(courseId ?? "")).changes > 0);
    return { favorited: false, removed, total: Number(this.countFavorites.get(user.id).count) };
  }

  list(user, { page = 1, pageSize = 20 } = {}) {
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
    this.removeMissingCourses.run(user.id, this.#courseIds());
    const rows = this.listFavorites.all(user.id);
    const manifest = this.readManifest() || {};
    const byId = new Map((manifest.courses || []).map((course) => [String(course.uid || course.id), course]));
    const items = rows
      .filter((row) => byId.has(row.course_id))
      .map((row) => {
        const course = byId.get(row.course_id);
        return {
          course_id: row.course_id,
          favorited_at: row.created_at,
          name: course.title,
          term: course.term,
          group: course.group,
          resource_count: course.resource_count ?? (course.sections || []).reduce((sum, section) => sum + (section.files || []).length, 0),
          review_count: course.review_count ?? 0,
        };
      });
    const total = items.length;
    const offset = (safePage - 1) * safePageSize;
    return { items: items.slice(offset, offset + safePageSize), total, page: safePage, page_size: safePageSize };
  }

  #secureDatabaseFiles() {
    for (const suffix of ["", "-wal", "-shm"]) {
      const filePath = `${this.dbPath}${suffix}`;
      if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
    }
  }

  deleteAllForUser(userId) {
    this.db.prepare("DELETE FROM mp_favorites WHERE user_id = ?").run(Number(userId));
    this.#secureDatabaseFiles();
    return true;
  }

  close() {
    if (this.db?.open) {
      this.db.pragma("wal_checkpoint(PASSIVE)");
      this.db.close();
    }
  }
}
