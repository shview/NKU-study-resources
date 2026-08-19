import { createHmac } from "node:crypto";

const FEISHU_WEBHOOK_PATTERN = /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[0-9a-f-]{8,64}$/i;

export function isValidFeishuWebhookUrl(url) {
  return FEISHU_WEBHOOK_PATTERN.test(String(url || "").trim());
}

export function feishuSign(timestamp, secret) {
  const stringToSign = `${timestamp}\n${String(secret || "")}`;
  return createHmac("sha256", stringToSign).update("").digest("base64");
}

export function buildFeishuCard({ title, lines, url, template = "blue" } = {}) {
  const elements = (lines || []).map((line) => ({
    tag: "div",
    text: { tag: "lark_md", content: String(line).slice(0, 500) },
  }));
  elements.push({ tag: "hr" });
  elements.push({
    tag: "action",
    actions: [{
      tag: "button",
      text: { tag: "plain_text", content: "去后台处理" },
      type: "primary",
      url: url || "https://nkustudy.top/admin/",
    }],
  });
  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: { title: { tag: "plain_text", content: `🔔 ${title}` }, template },
      elements,
    },
  };
}

export class FeishuNotifyService {
  constructor({ readSettings, writeSettings, readSecrets, writeSecrets, fetchImpl = globalThis.fetch, adminUrl = "https://nkustudy.top/admin/" } = {}) {
    for (const [name, fn] of [["readSettings", readSettings], ["writeSettings", writeSettings], ["readSecrets", readSecrets], ["writeSecrets", writeSecrets]]) {
      if (typeof fn !== "function") throw new Error(`FeishuNotifyService requires ${name}.`);
    }
    this.readSettings = readSettings;
    this.writeSettings = writeSettings;
    this.readSecrets = readSecrets;
    this.writeSecrets = writeSecrets;
    this.fetchImpl = fetchImpl;
    this.adminUrl = adminUrl;
  }

  async #effectiveConfig() {
    const settings = (await this.readSettings()) || {};
    const secrets = (await this.readSecrets()) || {};
    const enabled = settings.enabled === true;
    const webhook = String(settings.webhookUrl || "").trim();
    const secret = String(secrets.signSecret || "").trim();
    if (!enabled || !isValidFeishuWebhookUrl(webhook)) return null;
    return { webhook, secret };
  }

  async updateConfig({ enabled, webhookUrl, signSecret }) {
    const settings = { ...((await this.readSettings()) || {}) };
    const secrets = JSON.parse(JSON.stringify((await this.readSecrets()) || {}));
    if (enabled !== undefined) settings.enabled = enabled === true;
    if (webhookUrl !== undefined) {
      const url = String(webhookUrl || "").trim();
      if (url && !isValidFeishuWebhookUrl(url)) throw new Error("Webhook 地址格式不正确。");
      settings.webhookUrl = url;
    }
    if (signSecret !== undefined) {
      const value = String(signSecret || "").trim();
      if (value && !/^[\x21-\x7e]{8,64}$/.test(value)) throw new Error("签名密钥格式不正确。");
      secrets.signSecret = value;
    }
    settings.updated = new Date().toISOString();
    await this.writeSettings(settings);
    await this.writeSecrets(secrets);
    return this.describe();
  }

  async describe() {
    const settings = (await this.readSettings()) || {};
    const secrets = (await this.readSecrets()) || {};
    return {
      enabled: settings.enabled === true,
      webhookUrl: settings.webhookUrl || "",
      signSecretConfigured: Boolean(secrets.signSecret),
      updated: settings.updated || "",
    };
  }

  async send({ title, lines, template, force = false } = {}) {
    const config = force ? { webhook: String((await this.readSettings()).webhookUrl || "").trim(), secret: String((await this.readSecrets()).signSecret || "").trim() } : await this.#effectiveConfig();
    if (!config || !isValidFeishuWebhookUrl(config.webhook)) return { sent: false, reason: "disabled-or-invalid" };
    const body = buildFeishuCard({ title, lines, url: this.adminUrl, template });
    if (config.secret) {
      const timestamp = Math.floor(Date.now() / 1000);
      body.timestamp = String(timestamp);
      body.sign = feishuSign(timestamp, config.secret);
    }
    try {
      const response = await this.fetchImpl(config.webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      const payload = await response.json().catch(() => ({}));
      if (payload?.code !== 0 && payload?.StatusCode !== 0) {
        return { sent: false, reason: `feishu-${payload?.code ?? response.status}` };
      }
      return { sent: true };
    } catch (error) {
      return { sent: false, reason: error.name === "TimeoutError" ? "timeout" : "network" };
    }
  }
}
