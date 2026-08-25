import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export const ADMIN_PERMISSION_POINTS = Object.freeze([
  "accounts.manage",
  "ai.manage",
  "audit.read",
  "backup.manage",
  "content.edit",
  "content.moderate",
  "content.read",
  "services.manage",
  "storage.delete",
  "storage.manage",
]);

export const ADMIN_ROLE_PRESETS = Object.freeze({
  super_admin: ADMIN_PERMISSION_POINTS.slice(),
  service_admin: ["services.manage"],
  ai_admin: ["ai.manage"],
  content_admin: ["content.read", "content.edit", "content.moderate"],
  reviewer: ["content.read", "content.moderate"],
  viewer: ["content.read"],
});

const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{2,31}$/;
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 128;
const SCRYPT_N = 16384;
const SCRYPT_KEYLEN = 32;

function positiveSafeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return number;
}

export function normalizeAdminPermissions(input) {
  const valid = new Set(ADMIN_PERMISSION_POINTS);
  const requested = Array.isArray(input) ? input : [];
  const normalized = [...new Set(requested.map((item) => String(item)))].filter((item) => valid.has(item));
  normalized.sort();
  return Object.freeze(normalized);
}

export function hasAdminPermission(account, permission) {
  return Boolean(account && account.enabled && Array.isArray(account.permissions) && account.permissions.includes(permission));
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

// 未知用户名也执行一次等成本的哈希计算，抹平「用户是否存在」的时序侧信道。
const DUMMY_PASSWORD_HASH = "scrypt$16384$bmt1c3R1ZHktdGltaW5nLWVxdWFsaXplci12MQ$LWGHWAaV2zPx2PPOZjp5TedlFPoK4XaOWjQEGrhtFvw";

function verifyPasswordHash(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  if (!Number.isSafeInteger(n) || n <= 0) return false;
  try {
    const salt = Buffer.from(parts[2], "base64url");
    const expected = Buffer.from(parts[3], "base64url");
    const actual = scryptSync(String(password), salt, expected.length, { N: n });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function validateUsername(username) {
  const value = String(username ?? "");
  if (!USERNAME_PATTERN.test(value)) throw new Error("用户名需以字母开头，3-32 位，仅限字母、数字、下划线和中划线。");
  return value;
}

function validatePassword(password) {
  const value = String(password ?? "");
  if (value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH) {
    throw new Error(`密码长度需在 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位之间。`);
  }
  return value;
}

function rowToAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    permissions: normalizeAdminPermissions(JSON.parse(row.permissions || "[]")),
    enabled: Boolean(row.enabled),
    mustChangePassword: Boolean(row.must_change_password),
    createdBy: row.created_by || "",
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at || null,
  };
}

export class AdminAccountsStore {
  constructor({ dbPath, keepAuditRows = 10_000, archiveThreshold = 20_000, archiveDir = null, onArchive = null } = {}) {
    if (!dbPath) throw new Error("AdminAccountsStore requires dbPath.");
    this.dbPath = path.resolve(dbPath);
    this.keepAuditRows = positiveSafeInteger(keepAuditRows, "keepAuditRows");
    this.archiveThreshold = Math.max(positiveSafeInteger(archiveThreshold, "archiveThreshold"), this.keepAuditRows * 2);
    this.archiveDir = archiveDir ? path.resolve(archiveDir) : null;
    this.onArchive = typeof onArchive === "function" ? onArchive : null;
    if (this.archiveDir) fs.mkdirSync(this.archiveDir, { recursive: true, mode: 0o700 });
    const directory = path.dirname(this.dbPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new Database(this.dbPath);
    fs.chmodSync(this.dbPath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admin_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        permissions TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        last_login_at INTEGER,
        failed_attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        username TEXT NOT NULL,
        action TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT '',
        path TEXT NOT NULL DEFAULT '',
        status INTEGER NOT NULL DEFAULT 0,
        target TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS admin_audit_log_at_idx ON admin_audit_log(at);
      CREATE INDEX IF NOT EXISTS admin_audit_log_username_idx ON admin_audit_log(username);
    `);
    this.insertAccount = this.db.prepare(`
      INSERT INTO admin_accounts(username, password_hash, permissions, enabled, must_change_password, created_by, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.selectById = this.db.prepare("SELECT * FROM admin_accounts WHERE id = ?");
    this.selectByUsername = this.db.prepare("SELECT * FROM admin_accounts WHERE username = ?");
    this.listAccounts = this.db.prepare("SELECT * FROM admin_accounts ORDER BY created_at ASC, id ASC");
    this.countAccounts = this.db.prepare("SELECT COUNT(*) AS count FROM admin_accounts");
    this.updateAccountSettingsStmt = this.db.prepare(`
      UPDATE admin_accounts SET permissions = ?, enabled = ?, must_change_password = ? WHERE id = ?
    `);
    this.updatePassword = this.db.prepare(`
      UPDATE admin_accounts SET password_hash = ?, must_change_password = 0 WHERE id = ?
    `);
    this.updatePasswordForceChange = this.db.prepare(
      "UPDATE admin_accounts SET password_hash = ?, must_change_password = 1 WHERE id = ?",
    );
    this.markLogin = this.db.prepare("UPDATE admin_accounts SET last_login_at = ?, failed_attempts = 0 WHERE id = ?");
    this.markFailure = this.db.prepare("UPDATE admin_accounts SET failed_attempts = failed_attempts + 1 WHERE id = ?");
    this.removeAccount = this.db.prepare("DELETE FROM admin_accounts WHERE id = ?");
    this.insertAudit = this.db.prepare(`
      INSERT INTO admin_audit_log(at, username, action, method, path, status, target, detail, ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.countAudit = this.db.prepare("SELECT COUNT(*) AS count FROM admin_audit_log");
    this.trimAudit = this.db.prepare(`
      DELETE FROM admin_audit_log WHERE id IN (
        SELECT id FROM admin_audit_log ORDER BY id DESC LIMIT -1 OFFSET ?
      )
    `);
    this.#secureDatabaseFiles();
  }

  count() {
    return Number(this.countAccounts.get().count);
  }

  list() {
    return this.listAccounts.all().map(rowToAccount);
  }

  getById(id) {
    return rowToAccount(this.selectById.get(Number(id)));
  }

  getByUsername(username) {
    return rowToAccount(this.selectByUsername.get(String(username ?? "")));
  }

  create({ username, password, permissions, enabled = true, mustChangePassword = false, createdBy = "", now = Date.now() }) {
    const name = validateUsername(username);
    const secret = validatePassword(password);
    if (this.selectByUsername.get(name)) throw new Error("用户名已存在。");
    const normalized = normalizeAdminPermissions(permissions);
    if (!normalized.length) throw new Error("至少需要选择一个权限。");
    const result = this.insertAccount.run(
      name,
      hashPassword(secret),
      JSON.stringify(normalized),
      enabled ? 1 : 0,
      mustChangePassword ? 1 : 0,
      String(createdBy || ""),
      positiveSafeInteger(now, "now"),
      null,
    );
    this.#secureDatabaseFiles();
    return this.getById(result.lastInsertRowid);
  }

  verify(username, password, { now = Date.now() } = {}) {
    const row = this.selectByUsername.get(String(username ?? ""));
    if (!row) {
      verifyPasswordHash(String(password ?? ""), DUMMY_PASSWORD_HASH);
      return null;
    }
    if (!verifyPasswordHash(String(password ?? ""), row.password_hash)) {
      this.markFailure.run(row.id);
      return null;
    }
    if (!row.enabled) return null;
    this.markLogin.run(positiveSafeInteger(now, "now"), row.id);
    this.#secureDatabaseFiles();
    return rowToAccount(this.selectById.get(row.id));
  }

  updateSettings(id, { permissions, enabled, mustChangePassword }) {
    const account = this.getById(id);
    if (!account) throw new Error("账号不存在。");
    const nextPermissions = permissions === undefined ? account.permissions : normalizeAdminPermissions(permissions);
    if (!nextPermissions.length) throw new Error("至少需要选择一个权限。");
    const nextEnabled = enabled === undefined ? account.enabled : Boolean(enabled);
    const nextMustChange = mustChangePassword === undefined ? account.mustChangePassword : Boolean(mustChangePassword);
    if (
      account.permissions.includes("accounts.manage") &&
      (!nextPermissions.includes("accounts.manage") || !nextEnabled) &&
      this.countEnabledPermissionHolders("accounts.manage") <= 1
    ) {
      throw new Error("不能停用或降级最后一个拥有账号管理权限的管理员。");
    }
    this.updateAccountSettingsStmt.run(JSON.stringify(nextPermissions), nextEnabled ? 1 : 0, nextMustChange ? 1 : 0, account.id);
    return this.getById(account.id);
  }

  setPassword(id, password, { forceChangeNextLogin = false } = {}) {
    const account = this.getById(id);
    if (!account) throw new Error("账号不存在。");
    const secret = validatePassword(password);
    if (forceChangeNextLogin) {
      this.updatePasswordForceChange.run(hashPassword(secret), account.id);
    } else {
      this.updatePassword.run(hashPassword(secret), account.id);
    }
    this.#secureDatabaseFiles();
    return this.getById(account.id);
  }

  remove(id, { actorUsername = "" } = {}) {
    const account = this.getById(id);
    if (!account) throw new Error("账号不存在。");
    if (actorUsername && account.username.toLowerCase() === String(actorUsername).toLowerCase()) {
      throw new Error("不能删除自己的账号。");
    }
    if (account.permissions.includes("accounts.manage") && this.countEnabledPermissionHolders("accounts.manage") <= 1) {
      throw new Error("不能删除最后一个拥有账号管理权限的管理员。");
    }
    this.removeAccount.run(account.id);
    this.#secureDatabaseFiles();
    return true;
  }

  countEnabledPermissionHolders(permission) {
    let count = 0;
    for (const row of this.listAccounts.all()) {
      const account = rowToAccount(row);
      if (account.enabled && account.permissions.includes(permission)) count += 1;
    }
    return count;
  }

  audit({ username, action, method = "", path = "", status = 0, target = "", detail = "", ip = "", userAgent = "", now = Date.now() } = {}) {
    this.insertAudit.run(
      positiveSafeInteger(now, "now"),
      String(username || "unknown"),
      String(action || "").slice(0, 128),
      String(method || "").slice(0, 8),
      String(path || "").slice(0, 256),
      Number(status) || 0,
      String(target || "").slice(0, 128),
      String(detail || "").slice(0, 512),
      String(ip || "").slice(0, 64),
      String(userAgent || "").slice(0, 256),
    );
    const count = Number(this.countAudit.get().count);
    if (count < this.archiveThreshold) return;
    // 达到阈值后按批归档：只保留最新 keepAuditRows 条，更早的一批落盘等待上传 R2。
    const overflow = count - this.keepAuditRows;
    const spilled = this.db.prepare("SELECT * FROM admin_audit_log ORDER BY id ASC LIMIT ?").all(overflow);
    if (!spilled.length) return;
    if (this.archiveDir) {
      const first = spilled[0].id;
      const last = spilled[spilled.length - 1].id;
      const filePath = `${this.archiveDir}/audit-${first}-${last}-${positiveSafeInteger(now, "now")}.json`;
      fs.writeFileSync(filePath, JSON.stringify({ archived_at: positiveSafeInteger(now, "now"), rows: spilled }, null, 2), { mode: 0o600 });
      fs.chmodSync(filePath, 0o600);
    }
    this.db.prepare("DELETE FROM admin_audit_log WHERE id <= ?").run(spilled[spilled.length - 1].id);
    if (this.onArchive) {
      try {
        this.onArchive();
      } catch {
        // 归档回调失败不影响审计写入；待传文件会在下次归档或重启时重试。
      }
    }
  }

  queryAudit({ page = 1, pageSize = 50, username = "", action = "" } = {}) {
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.min(200, Math.max(1, Number(pageSize) || 50));
    const conditions = [];
    const params = [];
    if (username) {
      conditions.push("username = ?");
      params.push(String(username));
    }
    if (action) {
      conditions.push("action LIKE ?");
      params.push(`%${String(action)}%`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM admin_audit_log ${where}`).get(...params).count);
    const rows = this.db
      .prepare(`SELECT * FROM admin_audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, safePageSize, (safePage - 1) * safePageSize);
    return { items: rows, total, page: safePage, page_size: safePageSize };
  }

  exportForBackup() {
    return {
      accounts: this.listAccounts.all().map((row) => ({
        username: row.username,
        password_hash: row.password_hash,
        permissions: JSON.parse(row.permissions || "[]"),
        enabled: Boolean(row.enabled),
        must_change_password: Boolean(row.must_change_password),
        created_by: row.created_by || "",
        created_at: row.created_at,
        last_login_at: row.last_login_at || null,
      })),
      audit: this.db.prepare("SELECT * FROM admin_audit_log ORDER BY id ASC").all(),
    };
  }

  restoreFromBackup(payload, { now = Date.now() } = {}) {
    if (!payload || !Array.isArray(payload.accounts)) throw new Error("备份账号数据格式不正确。");
    const restored = [];
    for (const entry of payload.accounts) {
      if (this.selectByUsername.get(entry.username)) continue;
      const result = this.insertAccount.run(
        entry.username,
        entry.password_hash,
        JSON.stringify(normalizeAdminPermissions(entry.permissions)),
        entry.enabled ? 1 : 0,
        entry.must_change_password ? 1 : 0,
        String(entry.created_by || "restore"),
        Number(entry.created_at) || positiveSafeInteger(now, "now"),
        entry.last_login_at || null,
      );
      restored.push(result.lastInsertRowid);
    }
    if (restored.length) this.#secureDatabaseFiles();
    return restored.length;
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
