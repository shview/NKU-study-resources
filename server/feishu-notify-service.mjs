import { createHmac, randomBytes } from "node:crypto";

const FEISHU_WEBHOOK_PATTERN = /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[0-9a-f-]{8,64}$/i;

export function isValidFeishuWebhookUrl(url) {
  return FEISHU_WEBHOOK_PATTERN.test(String(url || "").trim());
}

function feishuSign(timestamp, secret) {
  const stringToSign = `${timestamp}\n${String(secret || "")}`;
  return createHmac("sha256", stringToSign).update("").digest("base64");
}

export { feishuSign };

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

function normalizeSettings(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  if (Array.isArray(data.bots)) {
    return {
      version: 2,
      updated: data.updated || "",
      bots: data.bots.filter((bot) => bot && isValidFeishuWebhookUrl(bot.webhookUrl)).map((bot) => ({
        id: String(bot.id || `bot-${randomBytes(4).toString("hex")}`),
        name: String(bot.name || "机器人").slice(0, 40),
        webhookUrl: String(bot.webhookUrl),
        enabled: bot.enabled !== false,
        purposes: normalizePurposes(bot.purposes),
      })),
    };
  }
  // 旧单机器人配置自动迁移为列表。
  if (isValidFeishuWebhookUrl(data.webhookUrl)) {
    return {
      version: 2,
      updated: data.updated || "",
      bots: [{ id: "default", name: "默认机器人", webhookUrl: String(data.webhookUrl), enabled: data.enabled === true, purposes: ["moderation"] }],
    };
  }
  return { version: 2, updated: data.updated || "", bots: [] };
}

const KNOWN_PURPOSES = new Set(["moderation", "digest"]);

function normalizePurposes(value) {
  const list = Array.isArray(value) ? value : ["moderation"];
  const filtered = list.map((item) => String(item)).filter((item) => KNOWN_PURPOSES.has(item));
  return filtered.length ? [...new Set(filtered)] : ["moderation"];
}

function normalizeSecrets(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  const bots = data.bots && typeof data.bots === "object" ? data.bots : {};
  if (!Object.keys(bots).length && typeof data.signSecret === "string" && data.signSecret) {
    return { bots: { default: data.signSecret } };
  }
  return { bots };
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

  async #state() {
    return { settings: normalizeSettings(await this.readSettings()), secrets: normalizeSecrets(await this.readSecrets()) };
  }

  async describe() {
    const { settings, secrets } = await this.#state();
    return {
      bots: settings.bots.map((bot) => ({ ...bot, signSecretConfigured: Boolean(secrets.bots[bot.id]) })),
      updated: settings.updated,
    };
  }

  async upsertBot({ id, name, webhookUrl, signSecret, enabled = true, purposes }) {
    const { settings, secrets } = await this.#state();
    const url = String(webhookUrl || "").trim();
    if (!isValidFeishuWebhookUrl(url)) throw new Error("Webhook 地址格式不正确。");
    let secretValue;
    if (signSecret !== undefined && String(signSecret || "") !== "") {
      secretValue = String(signSecret).trim();
      if (!/^[\x21-\x7e]{8,64}$/.test(secretValue)) throw new Error("签名密钥格式不正确。");
    }
    const botId = id ? String(id) : `bot-${randomBytes(4).toString("hex")}`;
    const existing = settings.bots.find((bot) => bot.id === botId);
    const next = {
      id: botId,
      name: String(name || existing?.name || "机器人").slice(0, 40),
      webhookUrl: url,
      enabled: enabled !== false,
      purposes: normalizePurposes(purposes ?? existing?.purposes),
    };
    const others = settings.bots.filter((bot) => bot.id !== botId);
    if (secretValue) secrets.bots[botId] = secretValue;
    await this.writeSettings({ version: 2, updated: new Date().toISOString(), bots: [...others, next] });
    await this.writeSecrets({ bots: secrets.bots });
    return { ...next, signSecretConfigured: Boolean(secrets.bots[botId]) };
  }

  async removeBot(id) {
    const { settings, secrets } = await this.#state();
    const botId = String(id || "");
    const bots = settings.bots.filter((bot) => bot.id !== botId);
    delete secrets.bots[botId];
    await this.writeSettings({ version: 2, updated: new Date().toISOString(), bots });
    await this.writeSecrets({ bots: secrets.bots });
    return { removed: bots.length !== settings.bots.length };
  }

  async #sendToBot(bot, secret, { title, lines, template }) {
    const body = buildFeishuCard({ title, lines, url: this.adminUrl, template });
    if (secret) {
      const timestamp = Math.floor(Date.now() / 1000);
      body.timestamp = String(timestamp);
      body.sign = feishuSign(timestamp, secret);
    }
    try {
      const response = await this.fetchImpl(bot.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      const payload = await response.json().catch(() => ({}));
      if (payload?.code !== 0 && payload?.StatusCode !== 0) {
        return { bot: bot.id, sent: false, reason: `feishu-${payload?.code ?? response.status}` };
      }
      return { bot: bot.id, sent: true };
    } catch (error) {
      return { bot: bot.id, sent: false, reason: error.name === "TimeoutError" ? "timeout" : "network" };
    }
  }

  async broadcast({ title, lines, template }, { includeDisabled = false, purpose = "moderation" } = {}) {
    const { settings, secrets } = await this.#state();
    const pool = includeDisabled ? settings.bots : settings.bots.filter((bot) => bot.enabled);
    const targets = pool.filter((bot) => !purpose || (bot.purposes || ["moderation"]).includes(purpose));
    if (!targets.length) return { sent: false, results: [], reason: "no-enabled-bots" };
    const results = [];
    for (const bot of targets) {
      results.push(await this.#sendToBot(bot, secrets.bots[bot.id] || "", { title, lines, template }));
    }
    return { sent: results.some((result) => result.sent), results };
  }
}
