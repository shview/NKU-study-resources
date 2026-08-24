import { createHash } from "node:crypto";
import { PublicApiError } from "./public-api-errors.mjs";

function responseBody(data) {
  return JSON.stringify({ code: 0, data });
}

function writeJson(req, res, statusCode, body, { cache = false } = {}) {
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
  res.writeHead(statusCode, headers);
  res.end(body);
}

function decodePathPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new PublicApiError(400, "请求路径无效。", "INVALID_PATH");
  }
}

export function createPublicApiHandler({ service, mpAuthService = null, mpFavoritesService = null, serviceAuthStore = null, notify = null, readBody, clientIp } = {}) {
  if (!service || !readBody || !clientIp) throw new Error("Public API router dependencies are required.");
  async function requireService(req) {
    if (!serviceAuthStore) throw new PublicApiError(503, "服务间接口暂未开放。", "SERVICE_AUTH_NOT_CONFIGURED");
    const caller = await serviceAuthStore.verify(req.headers["x-service-key"]);
    if (!caller) throw new PublicApiError(401, "服务密钥无效。", "SERVICE_KEY_REQUIRED");
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
    try {
      let data;
      const authUser = mpAuthService ? mpAuthService.verifyToken(req.headers.authorization) : null;
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
        data = service.serviceRateLimit(caller.id, body);
      } else if (req.method === "GET" && url.pathname === "/api/v1/search-index") data = service.searchIndex();
      else if (req.method === "GET" && url.pathname === "/api/v1/catalog") data = service.catalog(url.searchParams);
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
        data = await mpAuthService.loginWithCode(body.code);
      } else if (req.method === "GET" && url.pathname === "/api/v1/me") {
        if (!mpAuthService) throw new PublicApiError(503, "小程序登录暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        data = { user: mpAuthService.requireUser(req.headers.authorization) };
      } else if (req.method === "POST" && url.pathname === "/api/v1/me/profile") {
        if (!mpAuthService) throw new PublicApiError(503, "小程序登录暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const user = mpAuthService.requireUser(req.headers.authorization);
        let body;
        try {
          body = await readBody(req);
        } catch {
          throw new PublicApiError(400, "请求正文必须是有效的 JSON。", "INVALID_JSON");
        }
        data = { user: mpAuthService.updateProfile(user, { nickname: body.nickname, avatarUrl: body.avatar_url }) };
      } else if (req.method === "POST" && url.pathname === "/api/v1/auth/logout") {
        if (!mpAuthService) throw new PublicApiError(503, "小程序登录暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const revoked = mpAuthService.revoke(req.headers.authorization);
        data = { revoked };
      } else if (req.method === "POST" && url.pathname === "/api/v1/auth/web-register") {
        if (!mpAuthService) throw new PublicApiError(503, "注册暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        if (!service.assertMpAuthAttempt(clientIp(req))) throw new PublicApiError(429, "注册尝试过于频繁，请稍后再试。", "AUTH_RATE_LIMITED");
        let body;
        try { body = await readBody(req); } catch { throw new PublicApiError(400, "请求正文必须是有效的 JSON。", "INVALID_JSON"); }
        const user = mpAuthService.webRegister(body);
        data = { user: { id: user.id, nickname: user.nickname, email: user.email || "", has_web_password: true } };
      } else if (req.method === "POST" && url.pathname === "/api/v1/auth/web-login") {
        if (!mpAuthService) throw new PublicApiError(503, "登录暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        if (!service.assertMpAuthAttempt(clientIp(req))) throw new PublicApiError(429, "登录尝试过于频繁，请稍后再试。", "AUTH_RATE_LIMITED");
        let body;
        try { body = await readBody(req); } catch { throw new PublicApiError(400, "请求正文必须是有效的 JSON。", "INVALID_JSON"); }
        const user = mpAuthService.webLogin(body);
        data = { user: { id: user.id, nickname: user.nickname, email: user.email || "", has_web_password: true } };
      } else if (req.method === "GET" && url.pathname === "/api/v1/me/feedback") {
        if (!mpAuthService) throw new PublicApiError(503, "暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const user = mpAuthService.requireUser(req.headers.authorization);
        data = service.getMyFeedback(user.id, { page: url.searchParams.get("page"), pageSize: url.searchParams.get("page_size") });
      } else if (req.method === "POST" && url.pathname === "/api/v1/me/delete-account") {
        if (!mpAuthService) throw new PublicApiError(503, "暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const user = mpAuthService.requireUser(req.headers.authorization);
        if (user.blocked) {
          throw new PublicApiError(403, "该账号已被封禁，无法自行注销。请联系管理员处理。", "AUTH_USER_BLOCKED");
        }
        mpAuthService.deleteAccount(user.id);
        mpAuthService.revoke(req.headers.authorization);
        if (mpFavoritesService) mpFavoritesService.deleteAllForUser(user.id);
        data = { deleted: true, note: "账号绑定关系已删除，已发布内容保留。" };
      } else if (req.method === "POST" && url.pathname === "/api/v1/me/web-password") {
        if (!mpAuthService) throw new PublicApiError(503, "暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const user = mpAuthService.requireUser(req.headers.authorization);
        let body;
        try { body = await readBody(req); } catch { throw new PublicApiError(400, "请求正文必须是有效的 JSON。", "INVALID_JSON"); }
        mpAuthService.setWebPassword(user.id, body.password);
        data = { ok: true };
      } else if (req.method === "GET" && url.pathname === "/api/v1/me/favorites") {
        if (!mpAuthService || !mpFavoritesService) throw new PublicApiError(503, "收藏暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const user = mpAuthService.requireUser(req.headers.authorization);
        data = mpFavoritesService.list(user, { page: url.searchParams.get("page"), pageSize: url.searchParams.get("page_size") });
      } else if (req.method === "GET" && url.pathname === "/api/v1/me/reviews") {
        if (!mpAuthService) throw new PublicApiError(503, "小程序登录暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const user = mpAuthService.requireUser(req.headers.authorization);
        data = service.reviewSubmissionService.listByUser(user.id, { page: url.searchParams.get("page"), pageSize: url.searchParams.get("page_size") });
      } else if (req.method === "POST" && url.pathname === "/api/v1/favorites") {
        if (!mpAuthService || !mpFavoritesService) throw new PublicApiError(503, "收藏暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const user = mpAuthService.requireUser(req.headers.authorization);
        let body;
        try {
          body = await readBody(req);
        } catch {
          throw new PublicApiError(400, "请求正文必须是有效的 JSON。", "INVALID_JSON");
        }
        data = mpFavoritesService.add(user, body.course_id);
      } else {
        let match = url.pathname.match(/^\/api\/v1\/guides\/([^/]+)$/);
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
                const user = mpAuthService.requireUser(req.headers.authorization);
                data = mpFavoritesService.remove(user, decodePathPart(match[1]));
              } else {
              match = url.pathname.match(/^\/api\/v1\/review-groups\/([^/]+)$/);
                if (req.method === "GET" && match) data = service.reviewGroup(decodePathPart(match[1]), { viewerId: authUser?.id || null });
                else {
                match = url.pathname.match(/^\/api\/v1\/reviews\/([^/]+)\/reaction$/);
                if (req.method === "PUT" && match) {
                  if (!mpAuthService) throw new PublicApiError(503, "小程序登录暂未开放。", "MP_AUTH_NOT_CONFIGURED");
                  const user = mpAuthService.requireUser(req.headers.authorization);
                  let body;
                  try {
                    body = await readBody(req);
                  } catch {
                    throw new PublicApiError(400, "请求正文必须是有效的 JSON。", "INVALID_JSON");
                  }
                  data = await service.reactReviewHelpful(decodePathPart(match[1]), body?.reaction ?? null, user.id);
                } else if (req.method === "POST" && url.pathname === "/api/v1/reviews") {
                const ip = clientIp(req);
                service.assertReviewAttempt(ip);
                let body;
                try {
                  body = await readBody(req);
                } catch {
                  throw new PublicApiError(400, "请求正文必须是有效的 JSON。", "INVALID_JSON");
                }
                data = await service.submitReview(body, { clientIp: ip, userAgent: req.headers["user-agent"], userId: authUser?.id || null, notify });
              } else {
                throw new PublicApiError(404, "接口不存在。", "NOT_FOUND");
              }
              }
            }
          }
        }
      }
      }
      writeJson(req, res, 200, responseBody(data), { cache: req.method === "GET" && url.pathname !== "/api/v1/health" });
    } catch (error) {
      const statusCode = error instanceof PublicApiError ? error.statusCode : 500;
      const code = error instanceof PublicApiError ? error.code : "INTERNAL_ERROR";
      const message = error instanceof PublicApiError ? error.message : "服务器暂时无法处理请求。";
      writeJson(req, res, statusCode, JSON.stringify({ code, message }));
    }
    return true;
  };
}
