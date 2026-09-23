import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * 普通用户侧安全日志（公安安全评估）：
 * 记录用户发布/修改/删除/举报等关键操作，含原始 IP（依法调取需要）与 UA。
 * 保留策略：仅清理 400 天以前的记录（≥6 个月法定留存）。
 */
export const SECURITY_LOG_KEEP_DAYS = 400;

export class UserSecurityLogStore {
  constructor({ dbPath }) {
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
    this.insert = this.db.prepare(
      "INSERT INTO user_security_logs (at, user_id, action, target_type, target_id, path, ip, ip_hash, user_agent, result, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
  }

  static hashIp(ip) {
    return createHash("sha256").update(String(ip || "")).digest("hex").slice(0, 24);
  }

  /** 记录一条安全日志；写入失败不影响业务（只打错误）。 */
  record({ at = Date.now(), userId = null, action, targetType = "", targetId = "", path = "", ip = "", userAgent = "", result = "ok", detail = "" } = {}) {
    try {
      this.insert.run(
        at,
        Number.isSafeInteger(Number(userId)) && Number(userId) > 0 ? Number(userId) : null,
        String(action).slice(0, 64),
        String(targetType).slice(0, 32),
        String(targetId).slice(0, 80),
        String(path).slice(0, 200),
        String(ip).slice(0, 64),
        UserSecurityLogStore.hashIp(ip),
        String(userAgent).slice(0, 300),
        String(result).slice(0, 24),
        String(detail).slice(0, 500)
      );
      return true;
    } catch (error) {
      console.error(`[security-log] write failed: ${error.message}`);
      return false;
    }
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
    return this.db.prepare("DELETE FROM user_security_logs WHERE at < ?").run(cutoff).changes;
  }

  count() {
    return this.db.prepare("SELECT COUNT(*) AS c FROM user_security_logs").get().c;
  }

  close() {
    this.db.close();
  }
}
