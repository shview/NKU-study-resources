import { AtomicJsonStore } from "./atomic-json-store.mjs";
import path from "node:path";

const DEFAULTS = Object.freeze({ version: 1, enabled: false, mchid: "", appid: "", serialNo: "", privateKey: "" });

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
    return c.enabled === true && Boolean(c.mchid) && Boolean(c.appid) && Boolean(c.serialNo) && Boolean(c.privateKey);
  }

  masked() {
    const c = this.#read();
    const mask = (value) => (value ? `${String(value).slice(0, 3)}••••${String(value).slice(-4)}` : "");
    return { enabled: c.enabled === true, mchid: mask(c.mchid), appid: mask(c.appid), serialNo: mask(c.serialNo), hasPrivateKey: Boolean(c.privateKey) };
  }

  config() {
    const c = this.#read();
    return { mchid: String(c.mchid || ""), appid: String(c.appid || ""), serialNo: String(c.serialNo || ""), privateKey: String(c.privateKey || "") };
  }

  async update(next = {}) {
    const current = this.#read();
    const pick = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : undefined);
    const nextKey = pick(next.privateKey, 8000);
    const payload = {
      version: 1,
      enabled: next.enabled === true,
      mchid: pick(next.mchid, 32) ?? current.mchid,
      appid: pick(next.appid, 32) ?? current.appid,
      serialNo: pick(next.serialNo, 64) ?? current.serialNo,
      // 私钥不回显：传空字符串表示保持不变，传新值则覆盖
      privateKey: nextKey === undefined ? current.privateKey : (nextKey || current.privateKey),
    };
    await this.store.update(this.filePath, () => payload, { initialize: { ...DEFAULTS }, mode: 0o600 });
    return this.masked();
  }
}
