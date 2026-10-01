import { createHash } from "node:crypto";
import { authorizationOf, WEB_SESSION_COOKIE, accountUserDto, requirePhoneVerifiedUser } from "./user-identity.mjs";
import { PublicApiError } from "./public-api-errors.mjs";

export const USER_EVENT_ACTIONS = Object.freeze({
      "POST /api/v1/auth/web-register": "auth.register",
      "POST /api/v1/auth/web-login": "auth.web_login",
      "POST /api/v1/auth/wechat": "auth.wechat_login",
      "POST /api/v1/auth/phone-verify": "phone.verify",
      "POST /api/v1/auth/web-login/start": "weblogin.start",
      "POST /api/v1/auth/web-login/confirm": "weblogin.confirm",
      "GET /api/v1/auth/web-login/status": "weblogin.status",
      "POST /api/v1/auth/logout": "auth.logout",
      "POST /api/v1/me/delete-account": "account.delete",
      "POST /api/v1/me/profile": "profile.update",
      "POST /api/v1/me/avatar": "avatar.upload",
      "POST /api/v1/me/web-password": "password.set",
      "POST /api/v1/me/web-password/change": "password.change",
      "POST /api/v1/reviews": "review.submit",
});

function responseBody(data) {
  return JSON.stringify({ code: 0, data });
}

function writeJson(req, res, statusCode, body, { cache = false, setCookies = [] } = {}) {
  if (res.writableEnded || res.destroyed) return;
  const headers = { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" };
  if (cache && statusCode === 200 && req.method === "GET") {
    const etag = `\"${createHash("sha256").update(body).digest("base64url").slice(0, 24)}\"`;
    headers.etag = etag;
    headers["cache-control"] = "public, max-age=60, stale-while-revalidate=300";
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
  } else {
    headers["cache-control"] = "no-store";
  }
  if (setCookies.length) headers["set-cookie"] = setCookies;
  res.writeHead(statusCode, headers);
  res.end(body);
}

function webSessionCookie(token, expiresIn) {
  return `${WEB_SESSION_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(expiresIn)}; HttpOnly; Secure; SameSite=Lax`;
}

function clearWebSessionCookie() {
  return `${WEB_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function decodePathPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new PublicApiError(400, "请求路径无效。", "INVALID_PATH");
  }
}

export function createPublicApiHandler({ service, mpAuthService = null, mpFavoritesService = null, serviceAuthStore = null, consumeServiceQuota = null, notify = null, readBody, clientIp, securityLog = null, phoneVerifier = null, webLoginTickets = null, wxacode = null, webLoginPagePath = "pages/login-confirm/index", wxacodeEnvVersion = "release", avatarService = null, avatarStore = null, readAvatarUpload = null } = {}) {
  if (!service || !readBody || !clientIp) throw new Error("Public API router dependencies are required.");
  async function requireService(req) {
    if (!serviceAuthStore) throw new PublicApiError(503, "服务间接口暂未开放。", "SERVICE_AUTH_NOT_CONFIGURED");
    const caller = await serviceAuthStore.verify(req.headers["x-service-key"]);
    if (!caller) throw new PublicApiError(401, "服务密钥无效。", "SERVICE_KEY_REQUIRED");
    if (consumeServiceQuota && !consumeServiceQuota(caller)) {
      throw new PublicApiError(429, "该服务今日调用额度已用完。", "SERVICE_QUOTA_EXCEEDED");
    }
    return caller;
  }
  async function readJsonBody(req) {
    try {
      return await readBody(req);
    } catch {
      throw new PublicApiError(400, "请求正文必须是有效的 JSON。", "INVALID_JSON");
    }
  }
  return async function handlePublicApi(req, res, url) {
    if (url.pathname !== "/api/v1" && !url.pathname.startsWith("/api/v1/")) return false;

    let identityAction = USER_EVENT_ACTIONS[`${req.method} ${url.pathname}`];
    let identityUserId = null;
    let identityStatus = 200;
    let identityCode = "OK";
    let eventResult = "ok";
    let eventTargetId = "";
    let response;
    // Persist an intent before identity or content can change. On a hard stop it
    // becomes an interrupted event on restart, not a fabricated successful result.
    const eventId = identityAction ? securityLog?.begin?.({ action: identityAction, path: url.pathname,
      userId: !["auth.register", "auth.web_login", "auth.wechat_login", "weblogin.start", "weblogin.status"].includes(identityAction) ? mpAuthService?.auditUserId?.(authorizationOf(req)) : null,
      ip: clientIp(req), userAgent: req.headers["user-agent"] || "" }) : undefined;
    try {
      let data;
      const setCookies = [];
      const authUser = mpAuthService ? mpAuthService.verifyToken(authorizationOf(req)) : null;
      // Capture the authenticated actor before logout/deletion can revoke it.
      // Login/register events must identify their resulting account, not an old cookie.
      if (identityAction && !["auth.register", "auth.web_login", "auth.wechat_login", "weblogin.start", "weblogin.status"].includes(identityAction)) {
        identityUserId = authUser?.id || mpAuthService?.auditUserId?.(authorizationOf(req)) || mpAuthService?.introspectToken?.(authorizationOf(req))?.user_id || null;
      }
      if (req.method === "GET" && url.pathname === "/api/v1/health") data = service.health();
      else if (req.method === "GET" && url.pathname === "/api/v1/home") data = service.home();
      else if (req.method === "POST" && url.pathname === "/api/v1/auth/verify") {
        await requireService(req);
        const body = await readJsonBody(req);
        data = service.serviceVerifyToken(String(body?.token || ""));
      } else if (req.method === "POST" && url.pathname === "/api/v1/service/blacklist") {
        await requireService(req);
        const body = await readJsonBody(req);
        data = service.serviceBlacklist(body?.user_ids);
      } else if (req.method === "POST" && url.pathname === "/api/v1/service/rate-limit") {
        const caller = await requireService(req);
        const body = await readJsonBody(req);
        data = service.serviceRateLimit(caller, body);
      } else if (req.method === "GET" && url.pathname === "/api/v1/search-index") data = service.searchIndex();
      else if (req.method === "GET" && url.pathname === "/api/v1/catalog") data = service.catalog(url.searchParams);
      else if (req.method === "GET" && url.pathname === "/api/v1/search-data") data = service.searchData();
      else if (req.method === "GET" && url.pathname === "/api/v1/about") data = service.about();
      else if (req.method === "GET" && url.pathname === "/api/v1/donate") data = service.donate();
      else if (req.method === "POST" && url.pathname === "/api/v1/donate/pay-native") {
        const body = await readJsonBody(req);
        const amount = Number(body?.amount);
        if (!Number.isFinite(amount) || amount < 1 || amount > 10000) throw new PublicApiError(400, "捐助金额需在 1-10000 元之间。", "INVALID_DONATE_AMOUNT");
        if (typeof service.createDonateOrderNative !== "function" || !service.donatePayReady?.()) {
          throw new PublicApiError(503, "支付功能暂未开通，正在接入中。", "DONATE_PAY_NOT_CONFIGURED");
        }
        // 网页会话可选：有 cookie 就记录归属，扫码付款本身不需要登录
        const webUser = mpAuthService ? mpAuthService.verifyToken(authorizationOf(req)) : null;
        data = await service.createDonateOrderNative({ userId: webUser?.id || 0, amount, nickname: body?.nickname, remark: body?.remark });
      }
      else if (req.method === "GET" && url.pathname === "/api/v1/donate/order-status") {
        data = service.donateOrderStatus(url.searchParams.get("out_trade_no"));
      }
      else if (req.method === "POST" && url.pathname === "/api/v1/donate/pay") {
        if (!mpAuthService) throw new PublicApiError(503, "登录暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const user = mpAuthService.requireUser(authorizationOf(req));
        const body = await readJsonBody(req);
        const amount = Number(body?.amount);
        if (!Number.isFinite(amount) || amount < 1 || amount > 10000) throw new PublicApiError(400, "捐助金额需在 1-10000 元之间。", "INVALID_DONATE_AMOUNT");
        if (typeof service.createDonateOrder !== "function" || !service.donatePayReady?.()) {
          throw new PublicApiError(503, "支付功能暂未开通，正在接入中。", "DONATE_PAY_NOT_CONFIGURED");
        }
        data = await service.createDonateOrder(user, amount, { nickname: body?.nickname, remark: body?.remark });
      }
      else if (req.method === "GET" && url.pathname === "/api/v1/guides") data = service.guides(url.searchParams);
      else if (req.method === "GET" && url.pathname === "/api/v1/courses") data = service.courses(url.searchParams);
      else if (req.method === "POST" && url.pathname === "/api/v1/auth/wechat") {
        if (!mpAuthService) throw new PublicApiError(503, "小程序登录暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        if (!service.assertMpAuthAttempt(clientIp(req))) {
          throw new PublicApiError(429, "登录尝试过于频繁，请稍后再试。", "AUTH_RATE_LIMITED");
        }
        let body;
        try {
          body = await readBody(req);
        } catch {
          throw new PublicApiError(400, "请求正文必须是有效的 JSON。", "INVALID_JSON");
        }
        const session = await mpAuthService.loginWithCode(body?.code);
        identityUserId = session.user.id;
        const { registered, ...publicSession } = session;
        data = publicSession;
        if (registered) securityLog?.record({ userId: identityUserId, action: "auth.wechat_register", path: url.pathname, ip: clientIp(req), userAgent: req.headers["user-agent"] || "", result: "ok", detail: "status=200 code=OK" });
      } else if (req.method === "GET" && url.pathname === "/api/v1/me") {
        if (!mpAuthService) throw new PublicApiError(503, "小程序登录暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        data = { user: accountUserDto(mpAuthService.requireUser(authorizationOf(req))) };
      } else if (req.method === "POST" && url.pathname === "/api/v1/auth/phone-verify") {
        if (!mpAuthService) throw new PublicApiError(503, "登录暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        if (!service.assertMpAuthAttempt(clientIp(req))) throw new PublicApiError(429, "操作过于频繁，请稍后再试。", "AUTH_RATE_LIMITED");
        const user = mpAuthService.requireUser(authorizationOf(req));
        let body;
        try { body = await readBody(req); } catch { throw new PublicApiError(400, "请求正文必须是有效的 JSON。", "INVALID_JSON"); }
        identityUserId = user.id;
        const code = body?.code;
        if (typeof code !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(code)) throw new PublicApiError(400, "缺少微信手机号授权码。", "INVALID_PHONE_CODE");
        if (!phoneVerifier || !phoneVerifier.configured) throw new PublicApiError(503, "手机号验证暂未配置。", "PHONE_VERIFY_NOT_CONFIGURED");
        if (!mpAuthService.claimPhoneCode(code)) throw new PublicApiError(409, "授权码已使用，请重新授权。", "PHONE_CODE_REPLAYED");
        let phone;
        try {
          phone = await phoneVerifier.getPhoneNumber(code);
        } catch {
          throw new PublicApiError(502, "手机号验证失败，请重新授权。", "PHONE_VERIFY_FAILED");
        }
        // Recheck after the upstream await: a revoked or blocked session cannot finish verification.
        mpAuthService.requireUser(authorizationOf(req));
        mpAuthService.setVerifiedPhone(user.id, phone);
        data = { ok: true, phone_masked: String(phone).slice(0, 3) + "****" + String(phone).slice(-4) };
      } else if (req.method === "POST" && url.pathname === "/api/v1/me/avatar") {
        if (!mpAuthService) throw new PublicApiError(503, "登录暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const user = mpAuthService.requireUser(authorizationOf(req));
        if (!avatarService || typeof readAvatarUpload !== "function") {
          throw new PublicApiError(503, "头像上传暂未开放。", "AVATAR_UPLOAD_UNAVAILABLE");
        }
        const buffer = await readAvatarUpload(req);
        try {
          const result = await avatarService.upload({ userId: user.id, buffer });
          data = { avatar_url: result.avatar_url };
        } catch (error) {
          if (error?.code) {
            throw new PublicApiError(Number(error.statusCode) || 400, error.message, error.code);
          }
          throw error;
        }
      } else if (req.method === "POST" && url.pathname === "/api/v1/me/profile") {
        if (!mpAuthService) throw new PublicApiError(503, "小程序登录暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const user = mpAuthService.requireUser(authorizationOf(req));
        let body;
        try {
          body = await readBody(req);
        } catch {
          throw new PublicApiError(400, "请求正文必须是有效的 JSON。", "INVALID_JSON");
        }
        // 头像归属校验：变更头像时仅允许绑定本站 avatars 资源且登记为本人已过审
        const nextAvatar = body?.avatar_url;
        let boundAvatarId = null;
        if (nextAvatar !== undefined && nextAvatar !== user.avatar_url) {
          if (String(nextAvatar).trim() !== "") {
            const avatarId = avatarService?.idFromUrl ? avatarService.idFromUrl(nextAvatar) : null;
            if (!avatarService || !avatarStore || !avatarId || !avatarStore.bindable({ userId: user.id, id: avatarId })) {
              throw new PublicApiError(403, "只能使用本人上传且已通过审核的头像。", "AVATAR_NOT_OWNED");
            }
            boundAvatarId = avatarId;
          }
        }
        data = { user: mpAuthService.updateProfile(user, { nickname: body.nickname, avatarUrl: body.avatar_url }) };
        if (boundAvatarId) avatarStore.markBound(boundAvatarId);
      } else if (req.method === "POST" && url.pathname === "/api/v1/auth/logout") {
        if (!mpAuthService) throw new PublicApiError(503, "小程序登录暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const revoked = mpAuthService.revoke(authorizationOf(req));
        if (!revoked) { eventResult = "ignored"; identityCode = "SESSION_NOT_REVOKED"; }
        setCookies.push(clearWebSessionCookie());
        data = { revoked };
      } else if (req.method === "POST" && url.pathname === "/api/v1/auth/web-register") {
        if (!mpAuthService) throw new PublicApiError(503, "注册暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        if (!service.assertMpAuthAttempt(clientIp(req))) throw new PublicApiError(429, "注册尝试过于频繁，请稍后再试。", "AUTH_RATE_LIMITED");
        let body;
        try { body = await readBody(req); } catch { throw new PublicApiError(400, "请求正文必须是有效的 JSON。", "INVALID_JSON"); }
        const session = mpAuthService.webRegister(body);
        identityUserId = session.user.id;
        setCookies.push(webSessionCookie(session.token, session.expires_in));
        data = { user: session.user };
      } else if (req.method === "POST" && url.pathname === "/api/v1/auth/web-login") {
        if (!mpAuthService) throw new PublicApiError(503, "登录暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        let body;
        try { body = await readBody(req); } catch { throw new PublicApiError(400, "请求正文必须是有效的 JSON。", "INVALID_JSON"); }
        if (body && (body.nickname || body.password)) {
          // 凭据登录：签发会话令牌并通过 httpOnly cookie 下发
          if (!service.assertMpAuthAttempt(clientIp(req))) throw new PublicApiError(429, "登录尝试过于频繁，请稍后再试。", "AUTH_RATE_LIMITED");
          const session = mpAuthService.webLogin(body);
          identityUserId = session.user.id;
          setCookies.push(webSessionCookie(session.token, session.expires_in));
          data = { user: session.user };
        } else {
          // 空请求：仅凭既有 cookie 恢复会话，不消耗登录限流额度
          identityAction = "auth.session_restore";
          const user = mpAuthService.requireUser(authorizationOf(req));
          identityUserId = user.id;
          data = { user: accountUserDto(user) };
        }
      } else if (req.method === "POST" && url.pathname === "/api/v1/auth/web-login/start") {
        if (!mpAuthService || !webLoginTickets) throw new PublicApiError(503, "扫码登录暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        if (!service.assertMpAuthAttempt(clientIp(req))) throw new PublicApiError(429, "操作过于频繁，请稍后再试。", "AUTH_RATE_LIMITED");
        const ticket = webLoginTickets.create();
        let qrImage = null;
        if (wxacode?.configured) {
          try {
            const code = await wxacode.unlimitedQr({ scene: ticket.id, page: webLoginPagePath, envVersion: wxacodeEnvVersion });
            qrImage = `data:${code.contentType};base64,${code.base64}`;
          } catch (error) {
            console.warn(`[web-login] wxacode failed: ${error.message} ${error.detail || ""}`);
          }
        }
        data = { ticket: ticket.id, expires_in: Math.max(1, Math.floor((ticket.expiresAt - Date.now()) / 1000)), qr_available: Boolean(qrImage), qr_image: qrImage };
      } else if (req.method === "POST" && url.pathname === "/api/v1/auth/web-login/confirm") {
        if (!mpAuthService || !webLoginTickets) throw new PublicApiError(503, "扫码登录暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const user = mpAuthService.requireUser(authorizationOf(req));
        identityUserId = user.id;
        if (user.blocked) throw new PublicApiError(403, "该账号已被封禁，如有疑问请联系管理员。", "AUTH_USER_BLOCKED");
        if (typeof mpAuthService.isPhoneVerified === "function" && !mpAuthService.isPhoneVerified(user.id)) {
          throw new PublicApiError(403, "请先在小程序完成手机号验证，再扫码登录网页。", "PHONE_VERIFY_REQUIRED");
        }
        const body = await readJsonBody(req);
        const ticketId = String(body?.ticket || "");
        if (!/^[A-Za-z0-9_-]{10,64}$/.test(ticketId)) throw new PublicApiError(400, "登录码无效。", "WEB_LOGIN_TICKET_INVALID");
        if (!webLoginTickets.confirm(ticketId, user.id)) throw new PublicApiError(404, "登录码不存在或已使用。", "WEB_LOGIN_TICKET_INVALID");
        data = { confirmed: true };
      } else if (req.method === "GET" && url.pathname === "/api/v1/auth/web-login/status") {
        if (!mpAuthService || !webLoginTickets) throw new PublicApiError(503, "扫码登录暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const ticketId = String(url.searchParams.get("ticket") || "");
        if (!/^[A-Za-z0-9_-]{10,64}$/.test(ticketId)) throw new PublicApiError(400, "登录码无效。", "WEB_LOGIN_TICKET_INVALID");
        const ticket = webLoginTickets.get(ticketId);
        if (!ticket) {
          data = { status: "expired" };
        } else if (ticket.status === "confirmed") {
          identityUserId = ticket.userId;
          identityAction = "weblogin.granted";
          const session = mpAuthService.issueSessionForUser(ticket.userId);
          webLoginTickets.markUsed(ticket.id);
          setCookies.push(webSessionCookie(session.token, session.expires_in));
          data = { status: "confirmed", user: session.user };
        } else {
          data = { status: ticket.status, expires_in: Math.max(1, Math.floor((ticket.expiresAt - Date.now()) / 1000)) };
        }
      } else if (req.method === "GET" && url.pathname === "/api/v1/me/feedback") {
        if (!mpAuthService) throw new PublicApiError(503, "暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const user = mpAuthService.requireUser(authorizationOf(req));
        data = service.getMyFeedback(user.id, { page: url.searchParams.get("page"), pageSize: url.searchParams.get("page_size") });
      } else if (req.method === "POST" && url.pathname === "/api/v1/me/delete-account") {
        if (!mpAuthService) throw new PublicApiError(503, "暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const user = mpAuthService.requireUser(authorizationOf(req));
        if (user.blocked) {
          throw new PublicApiError(403, "该账号已被封禁，无法自行注销。请联系管理员处理。", "AUTH_USER_BLOCKED");
        }
        mpAuthService.deleteAccount(user.id);
        mpAuthService.revoke(authorizationOf(req));
        setCookies.push(clearWebSessionCookie());
        if (mpFavoritesService) mpFavoritesService.deleteAllForUser(user.id);
        data = { deleted: true, note: "账号绑定关系已删除，已发布内容保留。" };
      } else if (req.method === "POST" && url.pathname === "/api/v1/me/web-password") {
        if (!mpAuthService) throw new PublicApiError(503, "暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const user = mpAuthService.requireUser(authorizationOf(req));
        let body;
        try { body = await readBody(req); } catch { throw new PublicApiError(400, "请求正文必须是有效的 JSON。", "INVALID_JSON"); }
        mpAuthService.setWebPassword(user.id, body.password);
        data = { ok: true };
      } else if (req.method === "POST" && url.pathname === "/api/v1/me/web-password/change") {
        if (!mpAuthService) throw new PublicApiError(503, "暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const user = mpAuthService.requireUser(authorizationOf(req));
        let body;
        try { body = await readBody(req); } catch { throw new PublicApiError(400, "请求正文必须是有效的 JSON。", "INVALID_JSON"); }
        mpAuthService.changeWebPassword(user.id, { currentPassword: body.current_password, newPassword: body.new_password });
        data = { ok: true };
      } else if (req.method === "GET" && url.pathname === "/api/v1/me/favorites") {
        if (!mpAuthService || !mpFavoritesService) throw new PublicApiError(503, "收藏暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const user = mpAuthService.requireUser(authorizationOf(req));
        data = mpFavoritesService.list(user, { page: url.searchParams.get("page"), pageSize: url.searchParams.get("page_size") });
      } else if (req.method === "GET" && url.pathname === "/api/v1/me/reviews") {
        if (!mpAuthService) throw new PublicApiError(503, "小程序登录暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const user = mpAuthService.requireUser(authorizationOf(req));
        data = service.reviewSubmissionService.listByUser(user.id, { page: url.searchParams.get("page"), pageSize: url.searchParams.get("page_size") });
      } else if (req.method === "POST" && url.pathname === "/api/v1/favorites") {
        if (!mpAuthService || !mpFavoritesService) throw new PublicApiError(503, "收藏暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const user = mpAuthService.requireUser(authorizationOf(req));
        let body;
        try {
          body = await readBody(req);
        } catch {
          throw new PublicApiError(400, "请求正文必须是有效的 JSON。", "INVALID_JSON");
        }
        data = mpFavoritesService.add(user, body.course_id);
      } else {
        let match = url.pathname.match(/^\/api\/v1\/guides\/([^/]+)\/variants\/([^/]+)$/);
        if (req.method === "GET" && match) data = service.guideVariant(decodePathPart(match[1]), decodePathPart(match[2]));
        else {
          match = url.pathname.match(/^\/api\/v1\/guides\/([^/]+)$/);
          if (req.method === "GET" && match) data = service.guide(decodePathPart(match[1]));
          else {
            match = url.pathname.match(/^\/api\/v1\/courses\/([^/]+)$/);
            if (req.method === "GET" && match) data = service.course(decodePathPart(match[1]));
            else {
            match = url.pathname.match(/^\/api\/v1\/courses\/([^/]+)\/resources$/);
            if (req.method === "GET" && match) data = service.resources(decodePathPart(match[1]));
            else if (req.method === "GET" && url.pathname === "/api/v1/review-groups") data = service.reviewGroups({ viewerId: authUser?.id || null });
            else {
              match = url.pathname.match(/^\/api\/v1\/favorites\/([^/]+)$/);
              if (req.method === "DELETE" && match) {
                if (!mpAuthService || !mpFavoritesService) throw new PublicApiError(503, "收藏暂未开放。", "MP_AUTH_NOT_CONFIGURED");
                const user = mpAuthService.requireUser(authorizationOf(req));
                data = mpFavoritesService.remove(user, decodePathPart(match[1]));
              } else {
              match = url.pathname.match(/^\/api\/v1\/review-groups\/([^/]+)$/);
                if (req.method === "GET" && match) data = service.reviewGroup(decodePathPart(match[1]), { viewerId: authUser?.id || null });
                else {
                match = url.pathname.match(/^\/api\/v1\/reviews\/([^/]+)\/reaction$/);
                if (req.method === "PUT" && match) {
                  if (!mpAuthService) throw new PublicApiError(503, "小程序登录暂未开放。", "MP_AUTH_NOT_CONFIGURED");
                  const user = mpAuthService.requireUser(authorizationOf(req));
                  let body;
                  try {
                    body = await readBody(req);
                  } catch {
                    throw new PublicApiError(400, "请求正文必须是有效的 JSON。", "INVALID_JSON");
                  }
                  data = await service.reactReviewHelpful(decodePathPart(match[1]), body?.reaction ?? null, user.id);
                } else if (req.method === "POST" && url.pathname === "/api/v1/guide-assistant/answers") {
                if (!mpAuthService || !service.guideAssistantAnswer) throw new PublicApiError(503, "问答服务暂未开放。", "AI_UNAVAILABLE");
                const user = mpAuthService.requireUser(authorizationOf(req));
                let body;
                try {
                  body = await readBody(req);
                } catch {
                  throw new PublicApiError(400, "请求正文必须是有效的 JSON。", "INVALID_JSON");
                }
                data = await service.guideAssistantAnswer(user.id, body);
              } else if (req.method === "POST" && url.pathname === "/api/v1/reviews") {
                const ip = clientIp(req);
                const ugcUser = requirePhoneVerifiedUser(mpAuthService, req);
                service.assertReviewAttempt(ip);
                let body;
                try {
                  body = await readBody(req);
                } catch {
                  throw new PublicApiError(400, "请求正文必须是有效的 JSON。", "INVALID_JSON");
                }
                data = await service.submitReview(body, { clientIp: ip, userAgent: req.headers["user-agent"], userId: ugcUser.id, notify,
                  onSubmitted(result) {
                    eventTargetId = result.reviewId || "";
                    eventResult = eventTargetId ? (result.pending ? "pending" : "ok") : "ignored";
                    if (!eventTargetId) identityCode = "SUBMISSION_NOT_STORED";
                  },
                });
              } else {
                throw new PublicApiError(404, "接口不存在。", "NOT_FOUND");
              }
              }
            }
          }
        }
      }
      }
      }
      response = { status: 200, body: responseBody(data), options: { cache: req.method === "GET" && !authorizationOf(req) && !url.pathname.startsWith("/api/v1/me") && !url.pathname.startsWith("/api/v1/auth/") && !url.pathname.startsWith("/api/v1/donate/order-status") && url.pathname !== "/api/v1/health", setCookies } };
    } catch (error) {
      const statusCode = error instanceof PublicApiError ? error.statusCode : 500;
      const code = error instanceof PublicApiError ? error.code : "INTERNAL_ERROR";
      const message = error instanceof PublicApiError ? error.message : "服务器暂时无法处理请求。";
      identityStatus = statusCode;
      identityCode = code;
      identityUserId = error.userId || identityUserId;
      response = { status: statusCode, body: JSON.stringify({ code, message }) };
    } finally {
      if (identityAction) {
        if (!identityUserId && ["phone.verify", "weblogin.confirm", "auth.session_restore"].includes(identityAction)) {
          identityUserId = mpAuthService?.introspectToken?.(authorizationOf(req))?.user_id || null;
        }
        securityLog?.record({ eventId, userId: identityUserId, action: identityAction, path: url.pathname,
          targetType: identityAction === "review.submit" ? "review" : "", targetId: eventTargetId,
          ip: clientIp(req), userAgent: req.headers["user-agent"] || "",
          result: identityStatus < 400 ? eventResult : identityStatus >= 500 ? "error" : "rejected",
          detail: `status=${identityStatus} code=${identityCode}` });
      }
    }
    // The client must not receive an outcome before its audit insert is attempted.
    writeJson(req, res, response.status, response.body, response.options);
    return true;
  };
}
