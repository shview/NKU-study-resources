/**
 * AI 问答（学习指南针）运行配置存储。
 *
 * 管理页可配置：启停、DashScope API Key（密文落盘 0600，读取只回掩码）、
 * Base URL、模型、max_tokens 与三档限流。运行时每次调用动态读取，
 * 修改保存后无需重启即生效；未配置 Key 或停用时问答稳定 503。
 */
const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "qwen-plus",
  max_tokens: 1200,
  daily_limit_per_user: 20,
  minute_limit_per_user: 3,
  daily_limit_global: 2000,
});

const ALLOWED_BASE_HOSTS = (host) => host === "aliyuncs.com" || host.endsWith(".aliyuncs.com");

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function clampSettings(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  let baseUrl = String(source.base_url ?? DEFAULT_SETTINGS.base_url).trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !ALLOWED_BASE_HOSTS(parsed.hostname.toLowerCase())) {
      baseUrl = DEFAULT_SETTINGS.base_url;
    }
  } catch {
    baseUrl = DEFAULT_SETTINGS.base_url;
  }
  const model = String(source.model ?? DEFAULT_SETTINGS.model).trim().slice(0, 80) || DEFAULT_SETTINGS.model;
  return {
    enabled: source.enabled === undefined ? true : Boolean(source.enabled),
    base_url: baseUrl,
    model,
    max_tokens: clampInteger(source.max_tokens, DEFAULT_SETTINGS.max_tokens, 64, 8192),
    daily_limit_per_user: clampInteger(source.daily_limit_per_user, DEFAULT_SETTINGS.daily_limit_per_user, 1, 10_000),
    minute_limit_per_user: clampInteger(source.minute_limit_per_user, DEFAULT_SETTINGS.minute_limit_per_user, 1, 1000),
    daily_limit_global: clampInteger(source.daily_limit_global, DEFAULT_SETTINGS.daily_limit_global, 1, 1_000_000),
  };
}

export class AiProviderStore {
  constructor({ store, filePath, seedEnv = process.env } = {}) {
    if (!store || !filePath) throw new Error("AiProviderStore requires store and filePath.");
    this.store = store;
    this.filePath = filePath;
    const seededKey = String(seedEnv.DASHSCOPE_API_KEY || seedEnv.QWEN_API_KEY || "").trim();
    this.seed = {
      settings: clampSettings({
        base_url: seedEnv.QWEN_BASE_URL,
        model: seedEnv.QWEN_MODEL,
        max_tokens: seedEnv.QWEN_MAX_TOKENS,
      }),
      api_key: seededKey || "",
    };
  }

  read() {
    let data;
    try {
      data = this.store.readSync(this.filePath);
    } catch {
      data = null;
    }
    if (!data || typeof data !== "object") {
      return { version: 1, settings: { ...this.seed.settings }, api_key: this.seed.api_key, seeded_from_env: Boolean(this.seed.api_key) };
    }
    return {
      version: 1,
      settings: clampSettings(data.settings),
      api_key: String(data.api_key || "") || this.seed.api_key,
      seeded_from_env: Boolean(data.seeded_from_env) && !data.api_key,
    };
  }

  /** 读取运行时配置（含明文 Key，仅服务器内部使用）。 */
  runtime() {
    const data = this.read();
    return { ...data.settings, api_key: data.api_key };
  }

  /** 读取管理页展示配置：Key 只回是否存在与尾 4 位掩码。 */
  masked() {
    const data = this.read();
    const apiKey = data.api_key;
    return {
      ...data.settings,
      has_api_key: Boolean(apiKey),
      api_key_masked: apiKey ? `••••${apiKey.slice(-4)}` : "",
      seeded_from_env: data.seeded_from_env,
    };
  }

  async update({ settings, apiKey, clearApiKey = false } = {}) {
    const current = this.read();
    const nextSettings = clampSettings(settings === undefined ? current.settings : { ...current.settings, ...settings });
    let nextKey = current.api_key;
    if (clearApiKey) nextKey = "";
    else if (apiKey !== undefined && apiKey !== null && String(apiKey).trim()) nextKey = String(apiKey).trim();
    const payload = { version: 1, settings: nextSettings, api_key: nextKey };
    await this.store.update(this.filePath, () => payload, { initialize: { version: 1, settings: DEFAULT_SETTINGS, api_key: "" }, mode: 0o600 });
    return this.masked();
  }
}
