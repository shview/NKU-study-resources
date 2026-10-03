import { DurableLog, ensureEventId, archiveRows, pruneArchives } from "./durable-log.mjs";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/** 依法调取留痕：每一次内部查询/导出都必须记录（查询人、条件、结果概要）。 */
export class LawEnforcementLogStore {
  constructor({ dbPath, archiveDir = path.join(path.dirname(dbPath), "law-archive"), journalDir = path.join(path.dirname(dbPath), "log-queue", "law") }) {
    if (!dbPath) throw new Error("LawEnforcementLogStore requires dbPath.");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.archiveDir = archiveDir;
    this.db = new Database(dbPath);
    fs.chmodSync(dbPath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS law_enforcement_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        queried_by TEXT NOT NULL,
        query_type TEXT NOT NULL,
        query_value TEXT NOT NULL,
        exported INTEGER NOT NULL DEFAULT 0,
        result_summary TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS lel_at_idx ON law_enforcement_logs(at);
    `);
    ensureEventId(this.db, "law_enforcement_logs");
    this.insert = this.db.prepare(
      "INSERT OR IGNORE INTO law_enforcement_logs (at, queried_by, query_type, query_value, exported, result_summary, event_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    this.writer = new DurableLog({ directory: journalDir, kind: "law", insert: (row, id) => this.insert.run(...row, id) });
  }

  record({ at = Date.now(), queriedBy, queryType, queryValue, exported = false, resultSummary = "" }) {
    this.writer.write([at, String(queriedBy).slice(0, 64), String(queryType).slice(0, 32), String(queryValue).slice(0, 120), exported ? 1 : 0, String(resultSummary).slice(0, 500)]);
  }

  maintain(now = Date.now()) {
    this.writer.replay();
    archiveRows({ db: this.db, table: "law_enforcement_logs", directory: this.archiveDir, keepRows: 10000, threshold: 20000 });
    const cutoff = now - 400 * 86400000;
    pruneArchives(this.archiveDir, "law_enforcement_logs", cutoff);
    this.db.prepare("DELETE FROM law_enforcement_logs WHERE at < ?").run(cutoff);
    this.writer.maintenanceError = null;
  }

  listRecent(limit = 100) {
    return this.db.prepare("SELECT * FROM law_enforcement_logs ORDER BY at DESC LIMIT ?").all(Math.min(500, Math.max(1, Number(limit) || 100)));
  }

  close() {
    this.db.close();
  }
}
