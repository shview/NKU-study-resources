import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * 服务间密钥存储：其他服务（队友的机器人、指南/AI 服务等）持密钥调用
 * 本站的登录校验、黑名单与限流接口。密钥只在创建时完整返回一次，
 * 落盘只存 SHA-256 哈希与前缀（用于识别）。
 */
function hashKey(key) {
  return createHash("sha256").update(String(key), "utf8").digest("hex");
}

function safeId(value) {
  return String(value || "").trim().slice(0, 64);
}

export class ServiceAuthStore {
  constructor({ store, filePath, nowIso = () => new Date().toISOString() } = {}) {
    if (!store || !filePath) throw new Error("ServiceAuthStore requires store and filePath.");
    this.store = store;
    this.filePath = filePath;
    this.nowIso = nowIso;
  }

  async #read() {
    const data = await this.store.read(this.filePath).catch(() => null);
    return data && Array.isArray(data.services) ? data : { version: 1, updated: "", services: [] };
  }

  #public(row) {
    return { id: row.id, name: row.name, key_prefix: row.key_prefix, enabled: row.enabled !== false, note: row.note || "", created_at: row.created_at };
  }

  async list() {
    const data = await this.#read();
    return { services: data.services.map((row) => this.#public(row)) };
  }

  async create({ name, note = "" }) {
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
    await this.store.update(this.filePath, (current) => {
      const data = current && Array.isArray(current.services) ? current : { version: 1, services: [] };
      if (data.services.some((row) => row.name === entry.name)) throw new Error("同名服务已存在。");
      data.services = [...data.services, entry];
      data.updated = this.nowIso();
      return data;
    }, { mode: 0o600 });
    return { ...this.#public(entry), key };
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
    }, { mode: 0o600 });
    if (!found) throw new Error("服务不存在。");
    return true;
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
    }, { mode: 0o600 });
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
        return row.enabled === false ? null : this.#public(row);
      }
    }
    return null;
  }
}
