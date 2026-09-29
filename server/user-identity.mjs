import { PublicApiError } from "./public-api-errors.mjs";

export const WEB_SESSION_COOKIE = "nkustudy_web_session";

/** An explicit Authorization header takes precedence; never fall back after a bad bearer. */
export function authorizationOf(req) {
  const header = String(req.headers.authorization || "");
  if (header) return header;
  const match = String(req.headers.cookie || "").match(new RegExp(`(?:^|;[ \\t]*)${WEB_SESSION_COOKIE}=([A-Za-z0-9_-]+)(?:;|$)`));
  return match ? `Bearer ${match[1]}` : "";
}

export function requirePhoneVerifiedUser(authService, req) {
  if (!authService) throw new PublicApiError(401, "发布内容请先登录。", "AUTH_REQUIRED");
  const user = authService.requireUser(authorizationOf(req));
  if (user.blocked) throw new PublicApiError(403, "该账号已被封禁。", "AUTH_USER_BLOCKED");
  if (!authService.isPhoneVerified(user.id)) {
    const error = new PublicApiError(403, "发布内容需先完成微信小程序手机号授权认证；网页暂不提供短信认证。", "PHONE_VERIFY_REQUIRED");
    error.userId = user.id;
    throw error;
  }
  return user;
}

/** Only fields needed by the signed-in account UI. Never serialize an internal user row. */
export function accountUserDto(row) {
  return {
    id: row.id, nickname: row.nickname || "", avatar_url: row.avatar_url || "",
    email: row.email || "", has_web_password: Boolean(row.web_password_hash),
    phone_verified: Boolean(row.phone_verified_at), created_at: row.created_at,
    last_login_at: row.last_login_at || null,
  };
}
