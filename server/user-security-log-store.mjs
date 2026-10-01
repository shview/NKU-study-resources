import { DurableLog, ensureEventId, archiveRows, archivedRows, pruneArchives } from "./durable-log.mjs";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * 普通用户侧安全日志（公安安全评估）：
 * 记录用户发布/修改/删除/举报等关键操作，含原始 IP（依法调取需要）与 UA。
 * 保留策略：仅清理 400 天以前的记录（既有工程配置，不代表统一法律期限）。
 */
export const SECURITY_LOG_KEEP_DAYS = 400;

export class UserSecurityLogStore {
  constructor({ dbPath, journalDir = path.join(path.dirname(dbPath), "log-queue", "user"), archiveDir = path.join(path.dirname(dbPath), "security-archive"), fault, alert, keepRows = 10000, threshold = 20000 }) {
    if (!dbPath) throw new Error("UserSecurityLogStore requires dbPath.");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    fs.chmodSync(dbPath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_security_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        user_id INTEGER,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL DEFAULT '',
        target_id TEXT NOT NULL DEFAULT '',
        path TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL DEFAULT '',
        ip_hash TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL DEFAULT '',
        result TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS usl_user_idx ON user_security_logs(user_id, at);
      CREATE INDEX IF NOT EXISTS usl_target_idx ON user_security_logs(target_type, target_id);
      CREATE INDEX IF NOT EXISTS usl_at_idx ON user_security_logs(at);
    `);
    this.archiveDir = archiveDir; this.keepRows = keepRows; this.threshold = threshold;
    ensureEventId(this.db, "user_security_logs");
    this.insert = this.db.prepare("INSERT OR IGNORE INTO user_security_logs (at, user_id, action, target_type, target_id, path, ip, ip_hash, user_agent, result, detail, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    this.writer = new DurableLog({ directory: journalDir, kind: "user", fault, alert,
      insert: (row, id, pending) => this.insert.run(...(pending ? [...row.slice(0, 9), "interrupted", "outcome=unknown; inspect persisted business state"] : row), id) });
  }

  static hashIp(ip) {
    return createHash("sha256").update(String(ip || "")).digest("hex").slice(0, 24);
  }

  normalize({ at = Date.now(), userId = null, action, targetType = "", targetId = "", path: route = "", ip = "", userAgent = "", result = "ok", detail = "" } = {}) {
    return [at, Number.isSafeInteger(Number(userId)) && Number(userId) > 0 ? Number(userId) : null,
      String(action).slice(0, 64), String(targetType).slice(0, 32), String(targetId).slice(0, 80),
      String(route).split("?")[0].slice(0, 200), String(ip).slice(0, 64), UserSecurityLogStore.hashIp(ip),
      String(userAgent).slice(0, 300), String(result).slice(0, 24), String(detail).slice(0, 500)];
  }
  begin(event) { return this.writer.begin(this.normalize(event)); }
  record(event) { return this.writer.write(this.normalize(event), event.eventId); }
  maintain(now = Date.now()) {
    this.writer.replay();
    archiveRows({ db: this.db, table: "user_security_logs", directory: this.archiveDir, keepRows: this.keepRows, threshold: this.threshold });
    this.prune(now);
    this.writer.maintenanceError = null;
  }
  query({ userId, targetType, targetId, action, from = 0, to = Date.now(), page = 1, pageSize = 100 } = {}) {
    const unique = new Map([...archivedRows(this.archiveDir, "user_security_logs"), ...this.db.prepare("SELECT * FROM user_security_logs").all()].map(row => [row.event_id || `legacy-${row.id}`, row]));
    const rows = [...unique.values()].filter(row => (userId === undefined || row.user_id === Number(userId)) && (!targetType || row.target_type === targetType) && (!targetId || row.target_id === String(targetId)) && (!action || row.action === action) && row.at >= Number(from) && row.at <= Number(to)).sort((a, b) => b.id - a.id);
    page = Math.max(1, Math.floor(Number(page) || 1)); pageSize = Math.min(1000, Math.max(1, Math.floor(Number(pageSize) || 100)));
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, page_size: pageSize };
  }

  byUser(userId, { limit = 200 } = {}) {
    return this.db.prepare("SELECT * FROM user_security_logs WHERE user_id = ? ORDER BY at DESC LIMIT ?").all(Number(userId), Math.min(1000, Math.max(1, Number(limit) || 200)));
  }

  byTarget(targetType, targetId, { limit = 200 } = {}) {
    return this.db.prepare("SELECT * FROM user_security_logs WHERE target_type = ? AND target_id = ? ORDER BY at DESC LIMIT ?").all(String(targetType), String(targetId), Math.min(1000, Math.max(1, Number(limit) || 200)));
  }

  /** 清理超过保留期的记录；返回删除条数。 */
  prune(now = Date.now()) {
    const cutoff = now - SECURITY_LOG_KEEP_DAYS * 24 * 3600 * 1000;
    pruneArchives(this.archiveDir, "user_security_logs", cutoff);
    return this.db.prepare("DELETE FROM user_security_logs WHERE at < ?").run(cutoff).changes;
  }

  count() {
    return this.db.prepare("SELECT COUNT(*) AS c FROM user_security_logs").get().c;
  }

  close() {
    this.db.close();
  }
}
