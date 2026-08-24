import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const DEFAULT_SETTINGS = Object.freeze({ max_limit: 10_000, max_window_ms: 86_400_000, default_daily_quota: 50_000 });

function clampSettings(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const clamp = (value, fallback, min, max) => {
    const number = Number(value);
    return Number.isSafeInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
  };
  return {
    max_limit: clamp(source.max_limit, DEFAULT_SETTINGS.max_limit, 1, 1_000_000),
    max_window_ms: clamp(source.max_window_ms, DEFAULT_SETTINGS.max_window_ms, 1_000, 604_800_000),
    default_daily_quota: clamp(source.default_daily_quota, DEFAULT_SETTINGS.default_daily_quota, 1, 10_000_000),
  };
}

function normalizeLimits(raw, settings) {
  const source = raw && typeof raw === "object" ? raw : {};
  const number = Number(source.daily_quota);
  return {
    daily_quota: Number.isSafeInteger(number) && number > 0
      ? Math.min(10_000_000, number)
      : settings.default_daily_quota,
  };
}

function hashKey(key) {
  return createHash("sha256").update(String(key), "utf8").digest("hex");
}

function safeId(value) {
  return String(value || "").trim().slice(0, 64);
}

/**
 * 服务间密钥存储：其他服务（队友的机器人、指南/AI 服务等）持密钥调用
 * 本站的登录校验、黑名单与限流接口。密钥只在创建时完整返回一次，
 * 落盘只存 SHA-256 哈希与前缀（用于识别）。
 * settings（单次限流上限）与每个服务的每日调用额度由管理员配置，不写死在代码里。
 */
export class ServiceAuthStore {
  constructor({ store, filePath, nowIso = () => new Date().toISOString() } = {}) {
    if (!store || !filePath) throw new Error("ServiceAuthStore requires store and filePath.");
    this.store = store;
    this.filePath = filePath;
    this.nowIso = nowIso;
  }

  async #read() {
    const data = await this.store.read(this.filePath).catch(() => null);
    if (!data || !Array.isArray(data.services)) return { version: 1, updated: "", settings: DEFAULT_SETTINGS, services: [] };
    return { ...data, settings: clampSettings(data.settings), services: data.services };
  }

  #public(row) {
    return {
      id: row.id,
      name: row.name,
      key_prefix: row.key_prefix,
      enabled: row.enabled !== false,
      note: row.note || "",
      limits: normalizeLimits(row.limits, DEFAULT_SETTINGS),
      created_at: row.created_at,
    };
  }

  async list() {
    const data = await this.#read();
    return { settings: data.settings, services: data.services.map((row) => this.#public(row)) };
  }

  async create({ name, note = "", dailyQuota = null }) {
    const cleanName = safeId(name);
    if (!cleanName) throw new Error("服务名称不能为空。");
    const key = `nkusvc_${randomBytes(24).toString("base64url")}`;
    const entry = {
      id: `svc-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
      name: cleanName,
      key_hash: hashKey(key),
      key_prefix: key.slice(0, 14),
      enabled: true,
      note: safeId(note).slice(0, 200),
      created_at: this.nowIso(),
    };
    let created;
    await this.store.update(this.filePath, (current) => {
      const base = current && Array.isArray(current.services) ? current : { version: 1, services: [] };
      if (base.services.some((row) => row.name === entry.name)) throw new Error("同名服务已存在。");
      const settings = clampSettings(base.settings);
      entry.limits = normalizeLimits({ daily_quota: dailyQuota }, settings);
      base.services = [...base.services, entry];
      base.settings = settings;
      base.updated = this.nowIso();
      created = entry;
      return base;
    }, { initialize: { version: 1, settings: DEFAULT_SETTINGS, services: [] }, mode: 0o600 });
    return { ...this.#public(created), key };
  }

  async setEnabled(id, enabled) {
    const cleanId = safeId(id);
    let found = false;
    await this.store.update(this.filePath, (current) => {
      const data = current && Array.isArray(current.services) ? current : { version: 1, services: [] };
      data.services = data.services.map((row) => {
        if (row.id !== cleanId) return row;
        found = true;
        return { ...row, enabled: enabled === true };
      });
      data.updated = this.nowIso();
      return data;
    }, { initialize: { version: 1, settings: DEFAULT_SETTINGS, services: [] }, mode: 0o600 });
    if (!found) throw new Error("服务不存在。");
    return true;
  }

  async setDailyQuota(id, dailyQuota) {
    const cleanId = safeId(id);
    const number = Number(dailyQuota);
    if (!Number.isSafeInteger(number) || number < 1 || number > 10_000_000) throw new Error("每日额度需在 1-10000000 之间。");
    let found = false;
    await this.store.update(this.filePath, (current) => {
      const data = current && Array.isArray(current.services) ? current : { version: 1, services: [] };
      data.services = data.services.map((row) => {
        if (row.id !== cleanId) return row;
        found = true;
        return { ...row, limits: normalizeLimits({ daily_quota: number }, clampSettings(data.settings)) };
      });
      data.updated = this.nowIso();
      return data;
    }, { initialize: { version: 1, settings: DEFAULT_SETTINGS, services: [] }, mode: 0o600 });
    if (!found) throw new Error("服务不存在。");
    return true;
  }

  async writeSettings(rawSettings) {
    const next = clampSettings(rawSettings);
    await this.store.update(this.filePath, (current) => {
      const data = current && Array.isArray(current.services) ? current : { version: 1, services: [] };
      data.settings = next;
      data.updated = this.nowIso();
      return data;
    }, { initialize: { version: 1, settings: DEFAULT_SETTINGS, services: [] }, mode: 0o600 });
    return next;
  }

  async remove(id) {
    const cleanId = safeId(id);
    let found = false;
    await this.store.update(this.filePath, (current) => {
      const data = current && Array.isArray(current.services) ? current : { version: 1, services: [] };
      const before = data.services.length;
      data.services = data.services.filter((row) => row.id !== cleanId);
      found = data.services.length < before;
      data.updated = this.nowIso();
      return data;
    }, { initialize: { version: 1, settings: DEFAULT_SETTINGS, services: [] }, mode: 0o600 });
    if (!found) throw new Error("服务不存在。");
    return true;
  }

  async verify(rawKey) {
    const header = String(rawKey || "");
    if (!header.startsWith("nkusvc_")) return null;
    const data = await this.#read();
    const wanted = Buffer.from(hashKey(header), "hex");
    for (const row of data.services) {
      const stored = Buffer.from(String(row.key_hash || ""), "hex");
      if (stored.length === wanted.length && timingSafeEqual(stored, wanted)) {
        if (row.enabled === false) return null;
        return { ...this.#public(row), settings: data.settings };
      }
    }
    return null;
  }
}
