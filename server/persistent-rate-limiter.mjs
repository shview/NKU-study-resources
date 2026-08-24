import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

function positiveSafeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return number;
}

function nonNegativeSafeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative safe integer.`);
  return number;
}

function boundedKey(value, label) {
  const text = String(value || "").trim();
  if (!text || text.length > 128 || /[\u0000-\u001f]/.test(text)) throw new Error(`${label} must be a non-empty bounded string.`);
  return text;
}

export class PersistentRateLimiter {
  constructor({ dbPath, cleanupIntervalMs = 60 * 60 * 1000, retentionMs = 8 * 24 * 60 * 60 * 1000 } = {}) {
    if (!dbPath) throw new Error("PersistentRateLimiter requires dbPath.");
    this.dbPath = path.resolve(dbPath);
    this.cleanupIntervalMs = positiveSafeInteger(cleanupIntervalMs, "cleanupIntervalMs");
    this.retentionMs = positiveSafeInteger(retentionMs, "retentionMs");
    const directory = path.dirname(this.dbPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    this.db = new Database(this.dbPath);
    fs.chmodSync(this.dbPath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("wal_autocheckpoint = 1000");
    this.db.pragma("auto_vacuum = INCREMENTAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        scope TEXT NOT NULL,
        actor_hash TEXT NOT NULL,
        window_ms INTEGER NOT NULL,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, actor_hash, window_ms, window_start)
      );
      CREATE INDEX IF NOT EXISTS rate_limits_updated_at_idx ON rate_limits(updated_at);
    `);
    this.#secureDatabaseFiles();
    this.lastCleanupAt = 0;
    this.selectActive = this.db.prepare(`
      SELECT window_start, count FROM rate_limits
      WHERE scope = ? AND actor_hash = ? AND window_ms = ? AND window_start + window_ms > ?
      ORDER BY window_start DESC LIMIT 1
    `);
    this.incrementActive = this.db.prepare(`
      UPDATE rate_limits SET count = count + 1, updated_at = ?
      WHERE scope = ? AND actor_hash = ? AND window_ms = ? AND window_start = ?
    `);
    this.deleteCounterWindows = this.db.prepare(`
      DELETE FROM rate_limits WHERE scope = ? AND actor_hash = ? AND window_ms = ?
    `);
    this.insertCounter = this.db.prepare(`
      INSERT INTO rate_limits(scope, actor_hash, window_ms, window_start, count, updated_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `);
    this.cleanup = this.db.prepare("DELETE FROM rate_limits WHERE updated_at < ?");
    this.consumeTransaction = this.db.transaction((scope, actorHash, limits, now) => {
      const normalized = limits.map(({ windowMs, max }) => {
        const normalizedWindow = positiveSafeInteger(windowMs, "windowMs");
        return {
          windowMs: normalizedWindow,
          max: positiveSafeInteger(max, "max"),
          active: this.selectActive.get(scope, actorHash, normalizedWindow, now),
        };
      });
      for (const limit of normalized) {
        if (Number(limit.active?.count || 0) >= limit.max) return { allowed: false, retryAfterMs: limit.active.window_start + limit.windowMs - now };
      }
      for (const limit of normalized) {
        if (limit.active) {
          this.incrementActive.run(now, scope, actorHash, limit.windowMs, limit.active.window_start);
        } else {
          this.deleteCounterWindows.run(scope, actorHash, limit.windowMs);
          this.insertCounter.run(scope, actorHash, limit.windowMs, now, now);
        }
      }
      return { allowed: true, retryAfterMs: 0 };
    });
    this.consumeLayeredTransaction = this.db.transaction((scope, actorHash, actorLimits, globalActorHash, globalLimits, now) => {
      const normalizeLimits = (limits) => limits.map(({ windowMs, max }) => {
        const normalizedWindow = positiveSafeInteger(windowMs, "windowMs");
        return {
          windowMs: normalizedWindow,
          max: positiveSafeInteger(max, "max"),
          active: null,
        };
      });
      const actor = normalizeLimits(actorLimits);
      const global = normalizeLimits(globalLimits);
      const rejected = [];
      for (const [key, limits] of [[actorHash, actor], [globalActorHash, global]]) {
        for (const limit of limits) {
          limit.active = this.selectActive.get(scope, key, limit.windowMs, now);
          if (Number(limit.active?.count || 0) >= limit.max) rejected.push(limit.active.window_start + limit.windowMs - now);
        }
      }
      if (rejected.length) return { allowed: false, retryAfterMs: Math.max(...rejected) };
      for (const [key, limits] of [[actorHash, actor], [globalActorHash, global]]) {
        for (const limit of limits) {
          if (limit.active) {
            this.incrementActive.run(now, scope, key, limit.windowMs, limit.active.window_start);
          } else {
            this.deleteCounterWindows.run(scope, key, limit.windowMs);
            this.insertCounter.run(scope, key, limit.windowMs, now, now);
          }
        }
      }
      return { allowed: true, retryAfterMs: 0 };
    });
  }

  /** 只读查询当前窗口计数（服务间限流接口返回 remaining 用），不会消耗配额。 */
  peek({ scope, actorHash, windowMs, now = Date.now() }) {
    const row = this.selectActive.get(boundedKey(scope, "scope"), boundedKey(actorHash, "actorHash"), positiveSafeInteger(windowMs, "windowMs"), nonNegativeSafeInteger(now, "now"));
    return row ? { count: Number(row.count), window_start: Number(row.window_start) } : null;
  }

  consume({ scope, actorHash, limits, now = Date.now() }) {
    const normalizedScope = boundedKey(scope, "scope");
    const normalizedActor = boundedKey(actorHash, "actorHash");
    if (!Array.isArray(limits) || !limits.length || limits.length > 8) throw new Error("Between one and eight rate-limit windows are required.");
    const normalizedNow = nonNegativeSafeInteger(now, "now");
    const result = this.consumeTransaction.immediate(normalizedScope, normalizedActor, limits, normalizedNow);
    if (normalizedNow - this.lastCleanupAt >= this.cleanupIntervalMs) {
      this.cleanup.run(normalizedNow - this.retentionMs);
      this.db.pragma("incremental_vacuum(64)");
      this.lastCleanupAt = normalizedNow;
    }
    this.#secureDatabaseFiles();
    return result;
  }

  consumeLayered({ scope, actorHash, actorLimits, globalLimits, globalActorHash = "__global__", now = Date.now() }) {
    const normalizedScope = boundedKey(scope, "scope");
    const normalizedActor = boundedKey(actorHash, "actorHash");
    const normalizedGlobalActor = boundedKey(globalActorHash, "globalActorHash");
    if (normalizedActor === normalizedGlobalActor) throw new Error("actorHash and globalActorHash must differ.");
    if (!Array.isArray(actorLimits) || !actorLimits.length || actorLimits.length > 8) throw new Error("Between one and eight actor rate-limit windows are required.");
    if (!Array.isArray(globalLimits) || !globalLimits.length || globalLimits.length > 8) throw new Error("Between one and eight global rate-limit windows are required.");
    const normalizedNow = nonNegativeSafeInteger(now, "now");
    const result = this.consumeLayeredTransaction.immediate(
      normalizedScope,
      normalizedActor,
      actorLimits,
      normalizedGlobalActor,
      globalLimits,
      normalizedNow,
    );
    if (normalizedNow - this.lastCleanupAt >= this.cleanupIntervalMs) {
      this.cleanup.run(normalizedNow - this.retentionMs);
      this.db.pragma("incremental_vacuum(64)");
      this.lastCleanupAt = normalizedNow;
    }
    this.#secureDatabaseFiles();
    return result;
  }

  #secureDatabaseFiles() {
    for (const suffix of ["", "-wal", "-shm"]) {
      const filePath = `${this.dbPath}${suffix}`;
      if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
    }
  }

  close() {
    if (this.db?.open) {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
      this.db.close();
    }
  }
}
