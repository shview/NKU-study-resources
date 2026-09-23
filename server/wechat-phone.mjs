import { randomBytes } from "node:crypto";

/**
 * 微信手机号验证（企业小程序 getPhoneNumber → code 换手机号）：
 * access_token 用稳定令牌接口并内存缓存；凭据来自环境变量（仅服务器）。
 */
export function createWechatPhoneVerifier({ appid, secret, fetchImpl = fetch, now = () => Date.now(), apiBase = process.env.MP_WXAPI_BASE || "https://api.weixin.qq.com" } = {}) {
  if (!appid || !secret) {
    return {
      configured: false,
      async getPhoneNumber() { throw new Error("WECHAT_PHONE_NOT_CONFIGURED"); },
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
    async getPhoneNumber(code) {
      const token = await accessToken();
      const response = await fetchImpl(`${apiBase}/wxa/business/getuserphonenumber?access_token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: String(code || "") }),
      });
      const data = await response.json();
      const phone = data?.phone_info?.phoneNumber;
      if (Number(data?.errcode) === 0 && phone) return phone;
      const error = new Error(`WX_PHONE_FAILED:${data?.errcode || "UNKNOWN"}`);
      error.detail = data?.errmsg || "";
      throw error;
    },
  };
}

export function maskPhone(phone) {
  const value = String(phone || "");
  return value.length >= 7 ? `${value.slice(0, 3)}****${value.slice(-4)}` : "****";
}
