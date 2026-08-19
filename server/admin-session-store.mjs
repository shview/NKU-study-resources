import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const DEFAULT_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;

function positiveSafeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return number;
}

export class AdminSessionStore {
  constructor({
    dbPath,
    secret,
    absoluteTtlMs = DEFAULT_ABSOLUTE_TTL_MS,
    idleTtlMs = DEFAULT_IDLE_TTL_MS,
    maxSessions = 20,
  } = {}) {
    if (!dbPath) throw new Error("AdminSessionStore requires dbPath.");
    if (String(secret || "").length < 32) throw new Error("AdminSessionStore requires a secret of at least 32 characters.");
    this.dbPath = path.resolve(dbPath);
    this.secret = String(secret);
    this.absoluteTtlMs = positiveSafeInteger(absoluteTtlMs, "absoluteTtlMs");
    this.idleTtlMs = positiveSafeInteger(idleTtlMs, "idleTtlMs");
    this.maxSessions = positiveSafeInteger(maxSessions, "maxSessions");
    const directory = path.dirname(this.dbPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    this.db = new Database(this.dbPath);
    fs.chmodSync(this.dbPath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        username TEXT
      );
      CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions(expires_at);
    `);
    const columns = this.db.pragma("table_info(admin_sessions)").map((column) => column.name);
    if (!columns.includes("username")) this.db.exec("ALTER TABLE admin_sessions ADD COLUMN username TEXT");
    this.insert = this.db.prepare(`
      INSERT INTO admin_sessions(token_hash, created_at, last_seen_at, expires_at, username)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.select = this.db.prepare("SELECT created_at, last_seen_at, expires_at, username FROM admin_sessions WHERE token_hash = ?");
    this.touch = this.db.prepare("UPDATE admin_sessions SET last_seen_at = ? WHERE token_hash = ?");
    this.remove = this.db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?");
    this.removeExpired = this.db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ? OR last_seen_at + ? <= ?");
    this.removeOldest = this.db.prepare(`
      DELETE FROM admin_sessions WHERE token_hash IN (
        SELECT token_hash FROM admin_sessions ORDER BY created_at ASC LIMIT ?
      )
    `);
    this.count = this.db.prepare("SELECT COUNT(*) AS count FROM admin_sessions");
    this.validateTransaction = this.db.transaction((tokenHash, now) => {
      const row = this.select.get(tokenHash);
      if (!row) return false;
      if (row.expires_at <= now || row.last_seen_at + this.idleTtlMs <= now) {
        this.remove.run(tokenHash);
        return false;
      }
      this.touch.run(now, tokenHash);
      return true;
    });
    this.#secureDatabaseFiles();
  }

  #tokenHash(token) {
    return createHmac("sha256", this.secret).update(token, "utf8").digest("hex");
  }

  #boundedToken(token) {
    const value = String(token || "");
    return value.length >= 32 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value) ? value : "";
  }

  create({ username = null, now = Date.now() } = {}) {
    const timestamp = positiveSafeInteger(now, "now");
    this.removeExpired.run(timestamp, this.idleTtlMs, timestamp);
    const overflow = Number(this.count.get().count) - this.maxSessions + 1;
    if (overflow > 0) this.removeOldest.run(overflow);
    const token = randomBytes(32).toString("base64url");
    this.insert.run(this.#tokenHash(token), timestamp, timestamp, timestamp + this.absoluteTtlMs, username ? String(username) : null);
    this.#secureDatabaseFiles();
    return token;
  }

  validate(token, { now = Date.now() } = {}) {
    const value = this.#boundedToken(token);
    if (!value) return false;
    const timestamp = positiveSafeInteger(now, "now");
    const valid = this.validateTransaction.immediate(this.#tokenHash(value), timestamp);
    this.#secureDatabaseFiles();
    return valid;
  }

  lookup(token, { now = Date.now() } = {}) {
    const value = this.#boundedToken(token);
    if (!value) return null;
    const timestamp = positiveSafeInteger(now, "now");
    const tokenHash = this.#tokenHash(value);
    const row = this.select.get(tokenHash);
    if (!row) return null;
    if (row.expires_at <= timestamp || row.last_seen_at + this.idleTtlMs <= timestamp) {
      this.remove.run(tokenHash);
      this.#secureDatabaseFiles();
      return null;
    }
    this.touch.run(timestamp, tokenHash);
    this.#secureDatabaseFiles();
    return { username: row.username || null };
  }

  revoke(token) {
    const value = this.#boundedToken(token);
    if (!value) return false;
    const removed = this.remove.run(this.#tokenHash(value)).changes > 0;
    this.#secureDatabaseFiles();
    return removed;
  }

  #secureDatabaseFiles() {
    for (const suffix of ["", "-wal", "-shm"]) {
      const filePath = `${this.dbPath}${suffix}`;
      if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
    }
  }

  close() {
    if (this.db?.open) {
      this.db.pragma("wal_checkpoint(PASSIVE)");
      this.db.close();
    }
  }
}
