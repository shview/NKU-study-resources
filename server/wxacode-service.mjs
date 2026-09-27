/**
 * 小程序码生成（网页扫码登录用）：
 * access_token 用稳定令牌接口并内存缓存（与 wechat-phone 同一模式）；
 * 凭据复用小程序 WECHAT_APPID/WECHAT_APPSECRET，仅服务器持有。
 */
export function createWxacodeService({ appid, secret, fetchImpl = fetch, now = () => Date.now(), apiBase = process.env.MP_WXAPI_BASE || "https://api.weixin.qq.com" } = {}) {
  if (!appid || !secret) {
    return {
      configured: false,
      async unlimitedQr() { throw new Error("WXACODE_NOT_CONFIGURED"); },
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
    /**
     * getwxacodeunlimit：scene ≤ 32 字符；check_path=false 允许页面未发布（正式生效需小程序发版）。
     * 成功返回图片字节，失败时微信返回 JSON errcode。
     */
    async unlimitedQr({ scene, page, width = 430, envVersion = "release" } = {}) {
      const sceneText = String(scene || "");
      if (!sceneText || sceneText.length > 32) throw new Error("WXACODE_SCENE_INVALID");
      const token = await accessToken();
      const response = await fetchImpl(`${apiBase}/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene: sceneText, page, check_path: false, env_version: envVersion, width }),
      });
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("json")) {
        const data = await response.json();
        const error = new Error(`WXACODE_FAILED:${data?.errcode || "UNKNOWN"}`);
        error.detail = data?.errmsg || "";
        throw error;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) throw new Error("WXACODE_EMPTY_RESPONSE");
      return { contentType: contentType.split(";")[0] || "image/png", base64: buffer.toString("base64") };
    },
  };
}
