import io

# ===== 1. Router: web auth + me/feedback =====
p = "server/public-api-router.mjs"
s = io.open(p, encoding="utf-8").read()

old = '''      } else if (req.method === "POST" && url.pathname === "/api/v1/auth/logout") {'''
new = '''      else if (req.method === "POST" && url.pathname === "/api/v1/auth/web-register") {
        if (!mpAuthService) throw new PublicApiError(503, "注册暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        if (!service.assertMpAuthAttempt(clientIp(req))) {
          throw new PublicApiError(429, "注册尝试过于频繁，请稍后再试。", "AUTH_RATE_LIMITED");
        }
        let body;
        try { body = await readBody(req); } catch { throw new PublicApiError(400, "请求正文必须是有效的 JSON。", "INVALID_JSON"); }
        const user = mpAuthService.webRegister(body);
        data = { user: { id: user.id, nickname: user.nickname, email: user.email || "", has_web_password: true } };
      } else if (req.method === "POST" && url.pathname === "/api/v1/auth/web-login") {
        if (!mpAuthService) throw new PublicApiError(503, "登录暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        if (!service.assertMpAuthAttempt(clientIp(req))) {
          throw new PublicApiError(429, "登录尝试过于频繁，请稍后再试。", "AUTH_RATE_LIMITED");
        }
        let body;
        try { body = await readBody(req); } catch { throw new PublicApiError(400, "请求正文必须是有效的 JSON。", "INVALID_JSON"); }
        const user = mpAuthService.webLogin(body);
        const timestamp = Date.now();
        const token = randomBytes(32).toString("base64url");
        data = { user: { id: user.id, nickname: user.nickname, email: user.email || "", has_web_password: true } };
        // 网页端也发 Cookie（方便浏览器场景）
        res.setHeader("set-cookie", `nkustudy_user=${user.id}; Path=/; Max-Age=28800; HttpOnly; SameSite=Lax`);
      } else if (req.method === "POST" && url.pathname === "/api/v1/auth/logout") {'''
assert old in s, "auth routes"
s = s.replace(old, new)

old = '''      else if (req.method === "GET" && url.pathname === "/api/v1/me/favorites") {'''
new = '''      else if (req.method === "GET" && url.pathname === "/api/v1/me/feedback") {
        if (!mpAuthService) throw new PublicApiError(503, "暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const user = mpAuthService.requireUser(req.headers.authorization);
        const feedbackData = service.getMyFeedback(user.id, { page: url.searchParams.get("page"), pageSize: url.searchParams.get("page_size") });
        data = feedbackData;
      } else if (req.method === "GET" && url.pathname === "/api/v1/me/favorites") {'''
assert old in s, "feedback route"
s = s.replace(old, new)

old = '''      else if (req.method === "POST" && url.pathname === "/api/v1/me/profile") {'''
new = '''      else if (req.method === "POST" && url.pathname === "/api/v1/me/web-password") {
        if (!mpAuthService) throw new PublicApiError(503, "暂未开放。", "MP_AUTH_NOT_CONFIGURED");
        const user = mpAuthService.requireUser(req.headers.authorization);
        let body;
        try { body = await readBody(req); } catch { throw new PublicApiError(400, "请求正文必须是有效的 JSON。", "INVALID_JSON"); }
        mpAuthService.setWebPassword(user.id, body.password);
        data = { ok: true };
      } else if (req.method === "POST" && url.pathname === "/api/v1/me/profile") {'''
assert old in s, "web password route"
s = s.replace(old, new)

io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("router ok")

# ===== 2. Service: getMyFeedback =====
p2 = "server/public-api-service.mjs"
s2 = io.open(p2, encoding="utf-8").read()

old2 = '''  catalog(searchParams) {'''
new2 = '''  getMyFeedback(userId, { page = 1, pageSize = 20 } = {}) {
    const feedback = this.readFeedbackData();
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
    const items = (feedback.items || [])
      .filter((item) => Number(item.user_id) === Number(userId))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return {
      items: items.slice((safePage - 1) * safePageSize, safePage * safePageSize).map((item) => ({
        id: item.id,
        title: item.title,
        content: item.content,
        type: item.type,
        status: String(item.status || "open"),
        hidden: item.hidden === true,
        resourceRef: item.resourceRef || "",
        createdAt: item.createdAt || "",
        updatedAt: item.updatedAt || "",
      })),
      total: items.length,
      page: safePage,
      page_size: safePageSize,
    };
  }

  catalog(searchParams) {'''
assert old2 in s2, "feedback method"
s2 = s2.replace(old2, new2)

# constructor: readFeedbackData
old3 = '''    this.readVisitStats = readVisitStats;
    this.courseCatalog = courseCatalog;'''
new3 = '''    this.readVisitStats = readVisitStats;
    this.courseCatalog = courseCatalog;
    this.readFeedbackData = readFeedback || (() => ({ items: [] }));'''
assert old3 in s2
s2 = s2.replace(old3, new3)

old4 = '''  constructor({ readManifest, readReviews, readHome, readGuides = () => ({ version: 1, items: [] }), readVisitStats = () => null, courseCatalog = null, reviewSubmissionService,'''
new4 = '''  constructor({ readManifest, readReviews, readHome, readGuides = () => ({ version: 1, items: [] }), readVisitStats = () => null, readFeedback = null, courseCatalog = null, reviewSubmissionService,'''
assert old4 in s2
s2 = s2.replace(old4, new4)

io.open(p2, "w", encoding="utf-8", newline="\n").write(s2)
print("service ok")

# ===== 3. admin-server: wire readFeedback =====
p3 = "server/admin-server.mjs"
s3 = io.open(p3, encoding="utf-8").read()
old5 = '''  readVisitStats: readVisitStats,
  courseCatalog,'''
new5 = '''  readVisitStats: readVisitStats,
  readFeedback: () => readFeedback(),
  courseCatalog,'''
assert old5 in s3
s3 = s3.replace(old5, new5)
io.open(p3, "w", encoding="utf-8", newline="\n").write(s3)
print("admin-server ok")
