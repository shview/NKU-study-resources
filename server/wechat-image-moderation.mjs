/**
 * 微信小程序同步图片审核（wxa/img_sec_check）：
 * access_token 用稳定令牌接口并内存缓存（与 wechat-phone/wxacode 同一模式）。
 * 仅审核通过（errcode 0）返回 true；87014 为内容违规；其余视为审核服务异常。
 */
export function createWechatImageModeration({ appid, secret, fetchImpl = fetch, now = () => Date.now(), apiBase = process.env.MP_WXAPI_BASE || "https://api.weixin.qq.com", timeoutMs = 10_000 } = {}) {
  if (!appid || !secret) {
    return {
      configured: false,
      async check() { throw new Error("MODERATION_NOT_CONFIGURED"); },
    };
  }
  let cachedToken = null; // { token, expiresAt }
  let pendingToken = null;

  async function accessToken() {
    if (cachedToken && cachedToken.expiresAt > now() + 60_000) return cachedToken.token;
    if (pendingToken) return pendingToken;
    pendingToken = (async () => {
      const response = await fetchImpl(`${apiBase}/cgi-bin/stable_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "client_credential", appid, secret, force_refresh: false }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await response.json();
      if (!data?.access_token) {
        const error = new Error(`WX_TOKEN_FAILED:${data?.errcode || "UNKNOWN"}`);
        error.detail = data?.errmsg || "";
        throw error;
      }
      cachedToken = { token: data.access_token, expiresAt: now() + (Number(data.expires_in) || 7200) * 1000 };
      return data.access_token;
    })();
    try {
      return await pendingToken;
    } finally {
      pendingToken = null;
    }
  }

  return {
    configured: true,
    /** @returns {Promise<{approved: boolean}>} 拒绝/异常通过抛错区分 */
    async check(imageBuffer, { filename = "a.jpg", contentType = "image/jpeg" } = {}) {
      const token = await accessToken();
      const form = new FormData();
      form.append("media", new Blob([imageBuffer], { type: contentType }), filename);
      const response = await fetchImpl(`${apiBase}/wxa/img_sec_check?access_token=${encodeURIComponent(token)}`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await response.json();
      if (data?.errcode === 0) return { approved: true };
      if (data?.errcode === 87014) return { approved: false };
      const error = new Error(`MODERATION_SERVICE_ERROR:${data?.errcode ?? "HTTP" + response.status}`);
      error.detail = data?.errmsg || "";
      throw error;
    },
  };
}
