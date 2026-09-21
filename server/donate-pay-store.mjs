import { AtomicJsonStore } from "./atomic-json-store.mjs";
import path from "node:path";

const DEFAULTS = Object.freeze({ version: 1, enabled: false, mchid: "", appid: "", serialNo: "", privateKey: "", apiV3Key: "", publicKey: "" });

/**
 * 微信支付（APIv3）商户配置：仅服务器持有，0600 落盘，读取一律脱敏。
 * 填齐 mchid/appid/serialNo/privateKey 且 enabled 后，捐助支付接口才真正下单。
 * 构造不落盘（同 AiProviderStore 模式），缺文件时读到默认空配置。
 */
export class DonatePayStore {
  constructor({ dataDir }) {
    this.filePath = path.join(dataDir, "donate-pay-settings.json");
    this.store = new AtomicJsonStore({ allowedRoot: path.dirname(this.filePath) });
  }

  #read() {
    let data;
    try {
      data = this.store.readSync(this.filePath);
    } catch {
      data = null;
    }
    return data && typeof data === "object" ? { ...DEFAULTS, ...data } : { ...DEFAULTS };
  }

  /** 是否具备下单条件（不暴露配置内容）。 */
  ready() {
    const c = this.#read();
    return c.enabled === true && Boolean(c.mchid) && Boolean(c.appid) && Boolean(c.serialNo) && Boolean(c.privateKey) && Boolean(c.apiV3Key) && Boolean(c.publicKey);
  }

  masked() {
    const c = this.#read();
    const mask = (value) => (value ? `${String(value).slice(0, 3)}••••${String(value).slice(-4)}` : "");
    return { enabled: c.enabled === true, mchid: mask(c.mchid), appid: mask(c.appid), serialNo: mask(c.serialNo), hasPrivateKey: Boolean(c.privateKey), hasApiV3Key: Boolean(c.apiV3Key), hasPublicKey: Boolean(c.publicKey) };
  }

  config() {
    const c = this.#read();
    return { mchid: String(c.mchid || ""), appid: String(c.appid || ""), serialNo: String(c.serialNo || ""), privateKey: String(c.privateKey || ""), apiV3Key: String(c.apiV3Key || ""), publicKey: String(c.publicKey || "") };
  }

  async update(next = {}) {
    const current = this.#read();
    const pick = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : undefined);
    const keepOrOverride = (field, max) => {
      const value = pick(next[field], max);
      return value === undefined ? current[field] : (value || current[field]);
    };
    const payload = {
      version: 1,
      enabled: next.enabled === true,
      mchid: pick(next.mchid, 32) ?? current.mchid,
      appid: pick(next.appid, 32) ?? current.appid,
      serialNo: pick(next.serialNo, 64) ?? current.serialNo,
      // 私钥/APIv3密钥/支付公钥不回显：传空字符串表示保持不变，传新值则覆盖
      privateKey: keepOrOverride("privateKey", 8000),
      apiV3Key: keepOrOverride("apiV3Key", 64),
      publicKey: keepOrOverride("publicKey", 4000),
    };
    await this.store.update(this.filePath, () => payload, { initialize: { ...DEFAULTS }, mode: 0o600 });
    return this.masked();
  }
}
