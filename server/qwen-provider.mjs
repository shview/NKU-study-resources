/**
 * 千问（DashScope OpenAI 兼容模式）provider。
 * 配置来源（按优先级）：管理页落盘的 ai-provider-store 运行时配置 →
 * 环境变量 DASHSCOPE_API_KEY / QWEN_API_KEY（初始种子）。
 * Base URL 必须是阿里云 HTTPS 地址，防止把密钥发往任意主机。
 */
const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen-plus";
const DEFAULT_MAX_TOKENS = 1200;

export function validateQwenEndpoint(baseUrl) {
  const normalized = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("QWEN_BASE_URL is not a valid URL.");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !(hostname === "aliyuncs.com" || hostname.endsWith(".aliyuncs.com"))) {
    throw new Error("QWEN_BASE_URL must be an HTTPS aliyuncs.com endpoint.");
  }
  return `${normalized}/chat/completions`;
}

function createQwenClient({ apiKey, baseUrl, model, maxTokens }) {
  const endpoint = validateQwenEndpoint(baseUrl);
  const normalizedModel = String(model || DEFAULT_MODEL).trim();
  const normalizedMaxTokens = Number(maxTokens) || DEFAULT_MAX_TOKENS;
  return async function qwenClient(messages, { timeoutMs = 20_000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: normalizedModel,
          messages,
          max_tokens: normalizedMaxTokens,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`qwen http ${response.status}`);
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part?.type === "text" ? part.text : "")).join("\n") : "";
      if (!text.trim()) throw new Error("qwen returned empty content");
      return text;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createQwenProviderFromEnv(env = process.env) {
  const apiKey = String(env.DASHSCOPE_API_KEY || env.QWEN_API_KEY || "").trim();
  if (!apiKey) return null;
  return createQwenClient({
    apiKey,
    baseUrl: String(env.QWEN_BASE_URL || DEFAULT_BASE_URL),
    model: String(env.QWEN_MODEL || DEFAULT_MODEL),
    maxTokens: Number(env.QWEN_MAX_TOKENS) || DEFAULT_MAX_TOKENS,
  });
}

/**
 * 每次调用前动态读取运行时配置的 provider：未配置 Key 或停用时返回 null。
 * readRuntime 必须返回 { enabled, api_key, base_url, model, max_tokens }。
 */
export function createQwenProviderFromSettings(readRuntime) {
  return async function qwen(messages, options = {}) {
    const runtime = readRuntime();
    if (!runtime || !runtime.enabled || !String(runtime.api_key || "").trim()) return null;
    return createQwenClient(runtime)(messages, options);
  };
}
