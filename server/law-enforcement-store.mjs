import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/** 依法调取留痕：每一次内部查询/导出都必须记录（查询人、条件、结果概要）。 */
export class LawEnforcementLogStore {
  constructor({ dbPath }) {
    if (!dbPath) throw new Error("LawEnforcementLogStore requires dbPath.");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
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
    this.insert = this.db.prepare(
      "INSERT INTO law_enforcement_logs (at, queried_by, query_type, query_value, exported, result_summary) VALUES (?, ?, ?, ?, ?, ?)"
    );
  }

  record({ at = Date.now(), queriedBy, queryType, queryValue, exported = false, resultSummary = "" }) {
    this.insert.run(at, String(queriedBy).slice(0, 64), String(queryType).slice(0, 32), String(queryValue).slice(0, 120), exported ? 1 : 0, String(resultSummary).slice(0, 500));
  }

  listRecent(limit = 100) {
    return this.db.prepare("SELECT * FROM law_enforcement_logs ORDER BY at DESC LIMIT ?").all(Math.min(500, Math.max(1, Number(limit) || 100)));
  }

  close() {
    this.db.close();
  }
}
