import { createSign, createVerify, createDecipheriv, randomBytes } from "node:crypto";

/**
 * 微信支付 APIv3 最小客户端：请求签名、JSAPI 下单、小程序支付参数、回调验签与解密。
 * 密钥材料全部来自 DonatePayStore（服务器 0600 存储），绝不进入代码或日志。
 */

export function rsaSignSha256(privateKeyPem, message) {
  return createSign("RSA-SHA256").update(message, "utf8").sign(privateKeyPem, "base64");
}

export function rsaVerifySha256(publicKeyPem, message, signatureBase64) {
  try {
    return createVerify("RSA-SHA256").update(message, "utf8").verify(publicKeyPem, signatureBase64, "base64");
  } catch {
    return false;
  }
}

/** Authorization 头：规范串 = METHOD\nPATH?QUERY\nTIMESTAMP\nNONCE\nBODY\n */
export function buildAuthorization({ mchid, serialNo, privateKeyPem, method, pathWithQuery, timestamp, nonce, body = "" }) {
  const message = `${method}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${body}\n`;
  const signature = rsaSignSha256(privateKeyPem, message);
  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchid}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${serialNo}"`;
}

/** JSAPI 下单：成功返回 prepay_id；失败抛带状态码的错误（不含敏感信息）。 */
export async function jsapiPrepay({ config, appid, description, outTradeNo, amountTotal, openid, notifyUrl, fetchImpl = fetch }) {
  const url = "https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi";
  const body = JSON.stringify({
    appid,
    mchid: config.mchid,
    description,
    out_trade_no: outTradeNo,
    notify_url: notifyUrl,
    amount: { total: amountTotal, currency: "CNY" },
    payer: { openid },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString("hex");
  const authorization = buildAuthorization({
    mchid: config.mchid,
    serialNo: config.serialNo,
    privateKeyPem: config.privateKey,
    method: "POST",
    pathWithQuery: "/v3/pay/transactions/jsapi",
    timestamp,
    nonce,
    body,
  });
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: authorization, "User-Agent": "nkustudy-donate" },
    body,
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!response.ok || !parsed?.prepay_id) {
    const error = new Error(`WXPAY_PREPAY_FAILED:${response.status}:${parsed?.code || "UNKNOWN"}`);
    error.status = response.status;
    error.detail = parsed?.message || text.slice(0, 200);
    throw error;
  }
  return parsed.prepay_id;
}

/** Native 扫码支付下单（网页端）：成功返回 code_url（weixin://wxpay/...），用户扫码付款。 */
export async function nativePrepay({ config, description, outTradeNo, amountTotal, notifyUrl, fetchImpl = fetch }) {
  const url = "https://api.mch.weixin.qq.com/v3/pay/transactions/native";
  const body = JSON.stringify({
    appid: config.appid,
    mchid: config.mchid,
    description,
    out_trade_no: outTradeNo,
    notify_url: notifyUrl,
    amount: { total: amountTotal, currency: "CNY" },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString("hex");
  const authorization = buildAuthorization({
    mchid: config.mchid,
    serialNo: config.serialNo,
    privateKeyPem: config.privateKey,
    method: "POST",
    pathWithQuery: "/v3/pay/transactions/native",
    timestamp,
    nonce,
    body,
  });
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: authorization, "User-Agent": "nkustudy-donate" },
    body,
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!response.ok || !parsed?.code_url) {
    const error = new Error(`WXPAY_NATIVE_FAILED:${response.status}:${parsed?.code || "UNKNOWN"}`);
    error.status = response.status;
    error.detail = parsed?.message || text.slice(0, 200);
    throw error;
  }
  return parsed.code_url;
}

/** 小程序拉起支付参数：paySign = RSA-SHA256(appid\ntimeStamp\nnonceStr\npackage\n)。 */
export function miniPayParams({ appid, prepayId, privateKeyPem }) {
  const timeStamp = String(Math.floor(Date.now() / 1000));
  const nonceStr = randomBytes(16).toString("hex");
  const pkg = `prepay_id=${prepayId}`;
  const message = `${appid}\n${timeStamp}\n${nonceStr}\n${pkg}\n`;
  return { timeStamp, nonceStr, package: pkg, signType: "RSA", paySign: rsaSignSha256(privateKeyPem, message) };
}

/** 回调验签：规范串 = TIMESTAMP\nNONCE\nBODY\n（公钥模式用支付公钥验签，序列号已由部署时固定公钥覆盖）。 */
export function verifyNotifySignature({ publicKeyPem, timestamp, nonce, body, signature }) {
  if (!publicKeyPem || !timestamp || !nonce || !body || !signature) return false;
  return rsaVerifySha256(publicKeyPem, `${timestamp}\n${nonce}\n${body}\n`, signature);
}

/** APIv3 密钥解密回调资源（AES-256-GCM）。 */
export function decryptAes256Gcm(apiV3Key, { nonce, ciphertext, associated_data: associatedData = "" }) {
  const key = Buffer.from(apiV3Key, "utf8");
  // 微信格式：ciphertext = 密文 + 末尾 16 字节 auth tag；Node 需显式 setAuthTag
  const buf = Buffer.from(ciphertext, "base64");
  if (buf.length < 17) throw new Error("ciphertext too short");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "utf8"));
  decipher.setAAD(Buffer.from(associatedData, "utf8"));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  const plain = Buffer.concat([decipher.update(buf.subarray(0, buf.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}
