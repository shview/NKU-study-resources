/**
 * 千问（DashScope OpenAI 兼容模式）provider。
 * 密钥只从环境变量读取：DASHSCOPE_API_KEY（或 QWEN_API_KEY）。
 * Base URL 必须是阿里云 HTTPS 地址，防止把密钥发往任意主机。
 */
const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen-plus";
const DEFAULT_MAX_TOKENS = 1200;

export function createQwenProviderFromEnv(env = process.env) {
  const apiKey = String(env.DASHSCOPE_API_KEY || env.QWEN_API_KEY || "").trim();
  if (!apiKey) return null;
  const baseUrl = String(env.QWEN_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  const model = String(env.QWEN_MODEL || DEFAULT_MODEL).trim();
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("QWEN_BASE_URL is not a valid URL.");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !(hostname === "aliyuncs.com" || hostname.endsWith(".aliyuncs.com"))) {
    throw new Error("QWEN_BASE_URL must be an HTTPS aliyuncs.com endpoint.");
  }
  const maxTokens = Number(env.QWEN_MAX_TOKENS) || DEFAULT_MAX_TOKENS;

  return async function qwen(messages, { timeoutMs = 20_000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
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
