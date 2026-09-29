import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * 头像资源登记表（SQLite）：
 * - upload：登记归属用户与审核状态，产出不可猜的版本化资源 ID；
 * - 绑定校验：avatar_url 必须指向本站 avatars 根且登记为本人已过审资源；
 * - 孤立回收：未绑定超期的登记条目由 avatar-service 懒清理。
 */
export class AvatarStore {
  constructor({ dbPath }) {
    if (!dbPath) throw new Error("AvatarStore requires dbPath.");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS avatars (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'approved',
        content_type TEXT NOT NULL DEFAULT 'image/jpeg',
        bytes INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        bound_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_avatars_user ON avatars(user_id);
      CREATE INDEX IF NOT EXISTS idx_avatars_created ON avatars(created_at);
    `);
  }

  register({ id, userId, bytes, contentType = "image/jpeg", now = Date.now(), status = "approved" }) {
    this.db.prepare("INSERT INTO avatars (id, user_id, status, content_type, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(String(id), Number(userId), status, contentType, Number(bytes) || 0, Number(now));
    return this.getById(id);
  }

  getById(id) {
    return this.db.prepare("SELECT * FROM avatars WHERE id = ?").get(String(id || "")) || null;
  }

  markBound(id, { now = Date.now() } = {}) {
    this.db.prepare("UPDATE avatars SET bound_at = ? WHERE id = ?").run(Number(now), String(id));
  }

  /** 校验可绑定：返回登记行或 null（非本站资源 / 不存在 / 未过审 / 非本人）。 */
  bindable({ userId, id }) {
    const row = this.getById(id);
    if (!row) return null;
    if (row.user_id !== Number(userId)) return null;
    if (row.status !== "approved") return null;
    return row;
  }

  /** 未绑定且超过 ttlMs 的登记（孤立资源候选），最多 limit 条。 */
  orphanIds({ before, ttlMs = 24 * 60 * 60 * 1000, limit = 20 } = {}) {
    const cutoff = (before ?? Date.now()) - ttlMs;
    return this.db.prepare("SELECT id FROM avatars WHERE bound_at IS NULL AND created_at <= ? ORDER BY created_at ASC LIMIT ?")
      .all(cutoff, Number(limit) || 20).map((row) => row.id);
  }

  remove(id) {
    this.db.prepare("DELETE FROM avatars WHERE id = ?").run(String(id));
  }
}
