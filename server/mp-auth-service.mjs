import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { PublicApiError } from "./public-api-errors.mjs";

const DEFAULT_CODE2SESSION_URL = "https://api.weixin.qq.com/sns/jscode2session";
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NICKNAME_MAX = 32;
const AVATAR_MAX = 500;

function positiveSafeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return number;
}

function tokenHash(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

function validCode(code) {
  return typeof code === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(code);
}

function cleanNickname(value) {
  return String(value ?? "").trim().slice(0, NICKNAME_MAX);
}

function cleanAvatar(value) {
  const text = String(value ?? "").trim().slice(0, AVATAR_MAX);
  if (!text) return "";
  return /^https:\/\//.test(text) ? text : "";
}

function maskOpenid(openid) {
  const value = String(openid || "");
  if (value.length <= 8) return `${value.slice(0, 2)}****`;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function publicUser(row) {
  return {
    id: row.id,
    nickname: row.nickname || "",
    avatar_url: row.avatar_url || "",
    email: row.email || "",
    has_web_password: Boolean(row.web_password_hash),
    created_at: row.created_at,
    last_login_at: row.last_login_at || null,
  };
}

const WEB_PASSWORD_MIN = 8;

function validateWebPassword(password) {
  const value = String(password ?? "");
  if (value.length < WEB_PASSWORD_MIN || value.length > 128) {
    throw new PublicApiError(400, `密码长度需在 ${WEB_PASSWORD_MIN}-128 位之间。`, "INVALID_PASSWORD");
  }
  return value;
}

function hashWebPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 32, { N: 16384 });
  return `scrypt$16384$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

function verifyWebPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  try {
    const salt = Buffer.from(parts[2], "base64url");
    const expected = Buffer.from(parts[3], "base64url");
    const actual = scryptSync(password, salt, expected.length, { N: Number(parts[1]) || 16384 });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

export class MpAuthService {
  constructor({
    dbPath,
    appid = "",
    secret = "",
    code2SessionUrl = process.env.MP_CODE2SESSION_URL || DEFAULT_CODE2SESSION_URL,
    fetchImpl = globalThis.fetch,
    tokenTtlMs = TOKEN_TTL_MS,
    now = Date.now,
  } = {}) {
    if (!dbPath) throw new Error("MpAuthService requires dbPath.");
    this.dbPath = path.resolve(dbPath);
    this.appid = String(appid || "");
    this.secret = String(secret || "");
    this.code2SessionUrl = String(code2SessionUrl || DEFAULT_CODE2SESSION_URL);
    this.fetchImpl = fetchImpl;
    this.tokenTtlMs = positiveSafeInteger(tokenTtlMs, "tokenTtlMs");
    this.now = now;
    const directory = path.dirname(this.dbPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new Database(this.dbPath);
    fs.chmodSync(this.dbPath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mp_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        openid TEXT UNIQUE,
        nickname TEXT NOT NULL DEFAULT '',
        avatar_url TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        last_login_at INTEGER,
        login_count INTEGER NOT NULL DEFAULT 0,
        blocked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS mp_auth_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mp_auth_tokens_user_idx ON mp_auth_tokens(user_id);
      CREATE INDEX IF NOT EXISTS mp_auth_tokens_expiry_idx ON mp_auth_tokens(expires_at);
    `);
    const userColumns = this.db.pragma("table_info(mp_users)").map((column) => column.name);
    if (!userColumns.includes("blocked")) this.db.exec("ALTER TABLE mp_users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0");
    if (!userColumns.includes("web_password_hash")) this.db.exec("ALTER TABLE mp_users ADD COLUMN web_password_hash TEXT");
    if (!userColumns.includes("email")) this.db.exec("ALTER TABLE mp_users ADD COLUMN email TEXT NOT NULL DEFAULT ''");
    this.insertUser = this.db.prepare("INSERT INTO mp_users(openid, created_at) VALUES (?, ?)");
    this.selectUserByOpenid = this.db.prepare("SELECT * FROM mp_users WHERE openid = ?");
    this.selectUserById = this.db.prepare("SELECT * FROM mp_users WHERE id = ?");
    this.markLogin = this.db.prepare("UPDATE mp_users SET last_login_at = ?, login_count = login_count + 1 WHERE id = ?");
    this.updateProfileStmt = this.db.prepare("UPDATE mp_users SET nickname = ?, avatar_url = ? WHERE id = ?");
    this.selectByNickname = this.db.prepare("SELECT * FROM mp_users WHERE nickname = ? COLLATE NOCASE");
    this.updateNickname = this.db.prepare("UPDATE mp_users SET nickname = ? WHERE id = ?");
    this.updateWebPassword = this.db.prepare("UPDATE mp_users SET web_password_hash = ? WHERE id = ?");
    this.bindOpenid = this.db.prepare("UPDATE mp_users SET openid = ? WHERE id = ?");
    this.setBlockedStmt = this.db.prepare("UPDATE mp_users SET blocked = ? WHERE id = ?");
    this.listUsers = this.db.prepare("SELECT * FROM mp_users ORDER BY created_at DESC, id DESC");
    this.countUsers = this.db.prepare("SELECT COUNT(*) AS count FROM mp_users");
    this.countLoginsSince = this.db.prepare("SELECT COUNT(*) AS count FROM mp_users WHERE last_login_at >= ?");
    this.insertToken = this.db.prepare("INSERT INTO mp_auth_tokens(token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)");
    this.selectToken = this.db.prepare("SELECT * FROM mp_auth_tokens WHERE token_hash = ?");
    this.touchToken = this.db.prepare("UPDATE mp_auth_tokens SET last_seen_at = ? WHERE token_hash = ?");
    this.removeToken = this.db.prepare("DELETE FROM mp_auth_tokens WHERE token_hash = ?");
    this.removeExpiredTokens = this.db.prepare("DELETE FROM mp_auth_tokens WHERE expires_at <= ?");
    this.#secureDatabaseFiles();
  }

  get configured() {
    return Boolean(this.appid && this.secret);
  }

  async #exchangeCode(code) {
    const params = new URLSearchParams({
      appid: this.appid,
      secret: this.secret,
      js_code: code,
      grant_type: "authorization_code",
    });
    let payload;
    try {
      const response = await this.fetchImpl(`${this.code2SessionUrl}?${params.toString()}`, {
        signal: AbortSignal.timeout(10_000),
        headers: { accept: "application/json" },
      });
      payload = await response.json();
    } catch {
      throw new PublicApiError(502, "微信登录服务暂时不可用，请稍后重试。", "MP_AUTH_UPSTREAM");
    }
    if (!payload || typeof payload !== "object" || !payload.openid) {
      const errcode = Number(payload?.errcode || 0);
      if (errcode === 40029 || errcode === 40163) {
        throw new PublicApiError(401, "登录凭证无效或已过期，请重新进入小程序。", "AUTH_INVALID_CODE");
      }
      if (errcode === 45011) {
        throw new PublicApiError(429, "登录过于频繁，请稍后再试。", "AUTH_RATE_LIMITED");
      }
      if (errcode === 40226) {
        throw new PublicApiError(403, "该微信账号暂时无法登录。", "AUTH_USER_BLOCKED");
      }
      throw new PublicApiError(502, "微信登录服务返回异常，请稍后重试。", "MP_AUTH_UPSTREAM");
    }
    return { openid: String(payload.openid) };
  }

  async loginWithCode(code, { now = this.now() } = {}) {
    if (!this.configured) {
      throw new PublicApiError(503, "小程序登录暂未开放。", "MP_AUTH_NOT_CONFIGURED");
    }
    if (!validCode(code)) {
      throw new PublicApiError(400, "登录凭证格式无效。", "AUTH_INVALID_CODE");
    }
    const { openid } = await this.#exchangeCode(code);
    const timestamp = positiveSafeInteger(now, "now");
    const existingRow = this.selectUserByOpenid.get(openid);
    if (existingRow?.blocked) {
      throw new PublicApiError(403, "该账号已被封禁，如有疑问请联系管理员。", "AUTH_USER_BLOCKED");
    }
    if (!existingRow) {
      const created = this.db.transaction(() => {
        const result = this.insertUser.run(openid, timestamp);
        const row = this.selectUserById.get(result.lastInsertRowid);
        this.markLogin.run(timestamp, row.id);
        return row;
      })();
      return this.#issueToken(created, timestamp);
    }
    const user = this.db.transaction(() => {
      this.markLogin.run(timestamp, existingRow.id);
      return this.selectUserById.get(existingRow.id);
    })();
    return this.#issueToken(user, timestamp);
  }

  #issueToken(user, timestamp) {
    this.removeExpiredTokens.run(timestamp);
    const token = randomBytes(32).toString("base64url");
    this.insertToken.run(tokenHash(token), user.id, timestamp, timestamp, timestamp + this.tokenTtlMs);
    this.#secureDatabaseFiles();
    return { token, expires_in: Math.floor(this.tokenTtlMs / 1000), user: publicUser(user) };
  }

  webRegister({ nickname, password, email = "" }, { now = this.now() } = {}) {
    const name = cleanNickname(nickname);
    const secret = validateWebPassword(password);
    if (!name) throw new PublicApiError(400, "请填写昵称。", "INVALID_NICKNAME");
    const timestamp = positiveSafeInteger(now, "now");
    const clash = this.selectByNickname.get(name);
    if (clash) throw new PublicApiError(409, `昵称「${name}」已被使用，请换一个。`, "NICKNAME_TAKEN");
    const row = this.db.transaction(() => {
      const result = this.insertUser.run(null, timestamp);
      const created = this.selectUserById.get(result.lastInsertRowid);
      this.updateNickname.run(name, created.id);
      this.updateWebPassword.run(hashWebPassword(secret), created.id);
      if (email) this.db.prepare("UPDATE mp_users SET email = ? WHERE id = ?").run(email.slice(0, 200), created.id);
      this.markLogin.run(timestamp, created.id);
      return this.selectUserById.get(created.id);
    })();
    this.#secureDatabaseFiles();
    return row;
  }

  webLogin({ nickname, password }, { now = this.now() } = {}) {
    const name = cleanNickname(nickname);
    if (!name || !password) throw new PublicApiError(400, "请填写昵称和密码。", "INVALID_CREDENTIALS");
    const row = this.selectByNickname.get(name);
    if (!row || !row.web_password_hash) {
      throw new PublicApiError(401, "昵称或密码不正确。", "AUTH_INVALID_CREDENTIALS");
    }
    if (!verifyWebPassword(String(password ?? ""), row.web_password_hash)) {
      throw new PublicApiError(401, "昵称或密码不正确。", "AUTH_INVALID_CREDENTIALS");
    }
    if (row.blocked) {
      throw new PublicApiError(403, "该账号已被封禁，如有疑问请联系管理员。", "AUTH_USER_BLOCKED");
    }
    const timestamp = positiveSafeInteger(now, "now");
    this.markLogin.run(timestamp, row.id);
    return this.selectUserById.get(row.id);
  }

  deleteAccount(userId) {
    const account = this.selectUserById.get(Number(userId));
    if (!account) throw new PublicApiError(404, "账号不存在。", "USER_NOT_FOUND");
    // 删除所有会话 token
    this.db.prepare("DELETE FROM mp_auth_tokens WHERE user_id = ?").run(account.id);
    // 清除绑定信息（保留评价/反馈内容，解除关联）
    this.db.prepare("UPDATE mp_users SET openid = NULL, web_password_hash = NULL, nickname = nickname || '_已注销', avatar_url = '', email = '' WHERE id = ?").run(account.id);
    this.#secureDatabaseFiles();
    return true;
  }

  setWebPassword(userId, password) {
    const account = this.selectUserById.get(Number(userId));
    if (!account) throw new PublicApiError(404, "账号不存在。", "USER_NOT_FOUND");
    const secret = validateWebPassword(password);
    this.updateWebPassword.run(hashWebPassword(secret), account.id);
    this.#secureDatabaseFiles();
    return true;
  }

  bindOpenidToUser(userId, openid) {
    const account = this.selectUserById.get(Number(userId));
    if (!account) throw new PublicApiError(404, "账号不存在。", "USER_NOT_FOUND");
    if (account.openid) throw new PublicApiError(409, "该账号已绑定微信，无法重复绑定。", "ALREADY_BOUND");
    const existing = this.selectUserByOpenid.get(openid);
    if (existing) throw new PublicApiError(409, "该微信已绑定其他账号。", "OPENID_TAKEN");
    this.bindOpenid.run(openid, account.id);
    this.#secureDatabaseFiles();
    return this.selectUserById.get(account.id);
  }

  verifyToken(authorizationHeader, { now = this.now() } = {}) {
    const header = String(authorizationHeader || "");
    const match = header.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/);
    if (!match) return null;
    const timestamp = positiveSafeInteger(now, "now");
    const row = this.selectToken.get(tokenHash(match[1]));
    if (!row || row.expires_at <= timestamp) return null;
    const user = this.selectUserById.get(row.user_id);
    if (!user || user.blocked) return null;
    this.touchToken.run(timestamp, row.token_hash);
    return user;
  }

  requireUser(authorizationHeader) {
    const user = this.verifyToken(authorizationHeader);
    if (!user) {
      throw new PublicApiError(401, "请先登录后再操作。", "AUTH_REQUIRED");
    }
    return user;
  }

  updateProfile(user, { nickname, avatarUrl } = {}) {
    const nextNickname = nickname === undefined ? user.nickname : cleanNickname(nickname);
    const nextAvatar = avatarUrl === undefined ? user.avatar_url : cleanAvatar(avatarUrl);
    this.updateProfileStmt.run(nextNickname, nextAvatar, user.id);
    this.#secureDatabaseFiles();
    return publicUser(this.selectUserById.get(user.id));
  }

  revoke(authorizationHeader) {
    const header = String(authorizationHeader || "");
    const match = header.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/);
    if (!match) return false;
    return this.removeToken.run(tokenHash(match[1])).changes > 0;
  }

  setUserBlocked(id, blocked) {
    const account = this.selectUserById.get(Number(id));
    if (!account) throw new PublicApiError(404, "用户不存在。", "USER_NOT_FOUND");
    this.setBlockedStmt.run(blocked ? 1 : 0, account.id);
    return this.selectUserById.get(account.id);
  }

  adminOverview({ dayStartMs } = {}) {
    const users = this.listUsers.all().map((row) => ({
      ...publicUser(row),
      login_count: row.login_count,
      blocked: row.blocked === 1,
      openid_masked: maskOpenid(row.openid),
    }));
    const timestamp = positiveSafeInteger(dayStartMs ?? this.now(), "dayStartMs");
    return {
      users,
      total: Number(this.countUsers.get().count),
      logins_since: Number(this.countLoginsSince.get(timestamp).count),
    };
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
