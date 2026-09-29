import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const root = path.resolve(import.meta.dirname, "..");
const password = "synthetic-password-s1";
const userAgent = "S1-synthetic-acceptance";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const forbidden = new Set(["openid", "phone", "web_password_hash", "user_id", "helpfulBy", "ipHash", "userAgent", "report_url", "report_target", "contact"]);
function safeDto(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbidden.has(key), false, `unexpected private field ${key}`);
    safeDto(child);
  }
}

for (const notNull of [false, true]) test(`S1 real HTTP identity acceptance: legacy openid ${notNull ? "NOT NULL" : "nullable"}`, { timeout: 180_000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nku-s1-http-"));
  const dataDir = path.join(dir, "data");
  await fs.mkdir(dataDir);
  for (const name of ["about", "feedback", "footer", "guides", "home", "links", "manifest", "participate", "reviews"]) {
    await fs.copyFile(path.join(root, "src/data/fixtures", `${name}.json`), path.join(dataDir, `${name}.json`));
  }
  const readJson = async (name) => JSON.parse(await fs.readFile(path.join(dataDir, `${name}.json`), "utf8"));
  const writeJson = async (name, data) => fs.writeFile(path.join(dataDir, `${name}.json`), JSON.stringify(data));
  const reviews = await readJson("reviews");
  reviews.rules = { ...reviews.rules, submissionOpen: true, moderationRequired: true, minLength: 5, hourlyLimit: 100, dailyLimit: 100 };
  await writeJson("reviews", reviews);
  await writeJson("notify-settings", { enabled: false, guide_feedback_enabled: false });
  const feedback = await readJson("feedback");
  feedback.items = [];
  feedback.rules = { submissionOpen: true, minLength: 5, hourlyLimit: 3, dailyLimit: 15 };
  await writeJson("feedback", feedback);
  const dbPath = path.join(dataDir, "state.sqlite");
  let db = new Database(dbPath);
  db.exec(`CREATE TABLE mp_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, openid TEXT ${notNull ? "NOT NULL" : ""} UNIQUE,
    nickname TEXT NOT NULL DEFAULT '', avatar_url TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL, last_login_at INTEGER, login_count INTEGER NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX legacy_nickname_idx ON mp_users(nickname);
  CREATE TABLE mp_auth_tokens(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES mp_users(id), created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  INSERT INTO mp_users(id, openid, nickname, created_at) VALUES(7, 'synthetic-old-openid', '旧账号', 1700000000000);
  INSERT INTO mp_users(id, openid, nickname, created_at, blocked) VALUES(8, 'synthetic-blocked-openid', '旧封禁账号', 1700000000000, 1);`);
  const oldToken = "legacy-session-".padEnd(43, "x");
  db.prepare("INSERT INTO mp_auth_tokens VALUES (?, 7, ?, ?, ?)").run(hash(oldToken), Date.now(), Date.now(), Date.now() + 3600000);
  // Preserve AUTOINCREMENT high-water mark even when the highest historical row was deleted.
  db.exec("UPDATE sqlite_sequence SET seq = 100 WHERE name = 'mp_users'");
  db.close();
  let phoneCalls = 0;
  let blockDuringPhone = null;
  let revokeDuringPhone = null;
  const usedLoginCodes = new Set();
  const wx = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    res.setHeader("content-type", "application/json");
    const send = (data) => res.end(JSON.stringify(data));
    if (url.pathname === "/sns/jscode2session") {
      const code = url.searchParams.get("js_code");
      if (usedLoginCodes.has(code) || code === "expired-login") return send({ errcode: 40163, openid: "error-must-not-create-user" });
      usedLoginCodes.add(code);
      if (code === "blocked-login") return send({ openid: "synthetic-blocked-openid" });
      return send({ openid: `synthetic-${code}` });
    }
    if (url.pathname === "/cgi-bin/stable_token") return send({ access_token: "synthetic-upstream-token", expires_in: 7200 });
    if (url.pathname === "/wxa/business/getuserphonenumber") {
      phoneCalls++;
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const { code } = JSON.parse(raw);
      if (blockDuringPhone) { db.prepare("UPDATE mp_users SET blocked = 1 WHERE id = ?").run(blockDuringPhone); blockDuringPhone = null; }
      if (revokeDuringPhone) { db.prepare("DELETE FROM mp_auth_tokens WHERE token_hash = ?").run(revokeDuringPhone); revokeDuringPhone = null; }
      if (code.startsWith("valid-")) return send({ errcode: 0, phone_info: { phoneNumber: "13800001234", watermark: { appid: "synthetic-app" } } });
      if (code === "malformed-number") return send({ errcode: 0, phone_info: { phoneNumber: { fake: true } } });
      if (code === "wrong-app") return send({ errcode: 0, phone_info: { phoneNumber: "13800001234", watermark: { appid: "other-app" } } });
      if (code === "http-error") { res.statusCode = 500; return send({ errcode: 0, phone_info: { phoneNumber: "13800001234" } }); }
      return send({ errcode: 40029, errmsg: "synthetic-expired-secret-must-not-log" });
    }
    return send({ errcode: -1 });
  });
  await new Promise((resolve) => wx.listen(0, "127.0.0.1", resolve));
  const reservation = http.createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const wxBase = `http://127.0.0.1:${wx.address().port}`;
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_ENV: "test", DATA_DIR: dataDir, STATE_DB_PATH: dbPath,
    ADMIN_SECRET_FILE: path.join(dataDir, "admin-secret"), BACKUP_SECRET_FILE: path.join(dataDir, "backup-secrets.json"),
    PUBLIC_DIR: path.join(dir, "public/current"), PUBLIC_RELEASES_DIR: path.join(dir, "public/releases"),
    ADMIN_INITIAL_PASSWORD: password, ADMIN_ORIGIN: base, ADMIN_HOST: "127.0.0.1", ADMIN_PORT: String(port),
    WECHAT_APPID: "synthetic-app", WECHAT_APPSECRET: "synthetic-app-secret", MP_CODE2SESSION_URL: `${wxBase}/sns/jscode2session`, MP_WXAPI_BASE: wxBase,
    TRUSTED_PROXIES: "127.0.0.1/32" };
  let child;
  let output = "";
  async function stop() {
    if (child && child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  }
  async function start(overrides = {}) {
    child = spawn(process.execPath, ["server/admin-server.mjs"], { cwd: root, env: { ...env, ...overrides }, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server timeout: ${output}`)), 15000);
      const receive = (chunk) => { output += chunk; if (String(chunk).includes("NKUStudy admin API listening")) { clearTimeout(timer); resolve(); } };
      child.stdout.on("data", receive); child.stderr.on("data", receive);
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${output}`)); });
    });
  }
  t.after(async () => { await stop(); db?.close(); await new Promise((resolve) => wx.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  await start();
  db = new Database(dbPath);
  const evidence = [];
  let ipSequence = 1;
  async function request(route, { body, headers = {}, expected = 200, method = body === undefined ? "GET" : "POST", ip } = {}) {
    const response = await fetch(base + route, { method, headers: { "content-type": "application/json", "user-agent": userAgent,
      "x-forwarded-for": ip || `198.51.100.${ipSequence++}`, ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(value)}`);
    evidence.push({ method, route: route.split("?")[0], expected, actual: response.status, code: value.code ?? null, cache: response.headers.get("cache-control") });
    return { response, value, data: value.data, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }
  const getUser = (id) => db.prepare("SELECT * FROM mp_users WHERE id = ?").get(id);
  assert.equal(getUser(7).openid, "synthetic-old-openid");
  assert.equal(getUser(7).phone_verified_at, null);
  assert.equal(getUser(8).blocked, 1);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='legacy_nickname_idx'").get());
  assert.equal(db.pragma("table_info(mp_users)").find((col) => col.name === "openid").notnull, 0);
  safeDto((await request("/api/v1/me", { headers: { authorization: `Bearer ${oldToken}` } })).data);
  const courses = (await request("/api/v1/courses")).data.items;
  assert.ok(courses.length);
  const legacyReview = { courseTitle: "合成课程", teacher: "合成教师", rating: 5, content: "合成评价正文足够长度，测试身份认证", user_id: 7, phone_verified: true };
  const v1Review = { course_id: courses[0].id, teacher: "合成教师", rating: 5, body: "合成评价正文足够长度，测试身份认证", user_id: 7, phone_verified: true };
  const ordinary = { title: "合成普通反馈", content: "合成反馈正文内容", type: "bug", user_id: 7, phone_verified: true };
  const writes = [["/review-api/submit", legacyReview], ["/api/v1/reviews", v1Review], ["/feedback-api/submit", ordinary]];
  for (const [route, body] of writes) await request(route, { body, expected: 401 });
  await request("/api/v1/auth/web-register", { body: { nickname: "bad", password: "short" }, expected: 400 });
  const a = await request("/api/v1/auth/web-register", { body: { nickname: "合成用户A", password, phone: "13999999999", phone_verified: true } });
  const b = await request("/api/v1/auth/web-register", { body: { nickname: "合成用户B", password } });
  assert.ok(a.data.user.id > 100);
  safeDto(a.data); safeDto(b.data);
  const aId = a.data.user.id;
  const bId = b.data.user.id;
  const cookieA = { cookie: a.cookie };
  const cookieB = { cookie: b.cookie };
  const bearerA = { authorization: `Bearer ${a.cookie.split("=")[1]}` };
  assert.equal(getUser(aId).phone_verified_at, null);
  for (const headers of [cookieA, bearerA]) for (const [route, body] of writes) await request(route, { headers, body, expected: 403 });
  await request("/api/v1/auth/web-register", { body: { nickname: "合成用户A", password }, expected: 409 });
  await request("/api/v1/auth/web-login", { body: { nickname: "合成用户A", password: "wrong" }, expected: 401 });
  await request("/api/v1/auth/web-login", { body: { nickname: "missing", password }, expected: 401 });
  await request("/api/v1/auth/web-login", { body: "{", headers: cookieA, expected: 400 });
  safeDto((await request("/api/v1/auth/web-login", { body: { nickname: "合成用户A", password } })).data);
  await request("/api/v1/auth/web-login", { body: {}, headers: cookieA });
  await request("/api/v1/auth/phone-verify", { body: { code: "valid-anon" }, expected: 401 });
  await request("/api/v1/auth/phone-verify", { body: { phone: "13999999999", phone_verified: true }, headers: cookieA, expected: 400 });
  await request("/api/v1/auth/phone-verify", { body: { code: "a".repeat(129) }, headers: cookieA, expected: 400 });
  for (const code of ["expired-phone", "malformed-number", "wrong-app", "http-error"]) {
    await request("/api/v1/auth/phone-verify", { body: { code }, headers: cookieA, expected: 502 });
    assert.equal(getUser(aId).phone_verified_at, null);
  }
  await request("/api/v1/auth/phone-verify", { body: { code: "valid-phone-a", phone: "13999999999", user_id: bId }, headers: cookieA });
  assert.equal(getUser(aId).phone, "13800001234"); assert.ok(getUser(aId).phone_verified_at); assert.equal(getUser(bId).phone_verified_at, null);
  const callCount = phoneCalls;
  await request("/api/v1/auth/phone-verify", { body: { code: "valid-phone-a" }, headers: cookieB, expected: 409 });
  assert.equal(phoneCalls, callCount);
  for (const headers of [cookieA, bearerA]) for (const [route, body] of writes) await request(route, { headers, body });
  const aTokenHash = hash(a.cookie.split("=")[1]);
  const expiry = db.prepare("SELECT expires_at FROM mp_auth_tokens WHERE token_hash=?").get(aTokenHash).expires_at;
  db.prepare("UPDATE mp_auth_tokens SET expires_at=1 WHERE token_hash=?").run(aTokenHash);
  for (const headers of [cookieA, bearerA]) for (const [route, body] of writes) await request(route, { headers, body, expected: 401 });
  db.prepare("UPDATE mp_auth_tokens SET expires_at=? WHERE token_hash=?").run(expiry, aTokenHash);
  for (const [route, body] of writes) await request(route, { headers: { ...cookieA, authorization: "Bearer invalid" }, body, expected: 401 });
  assert.ok((await readJson("reviews")).reviews.every((review) => review.user_id === aId && review.status === "pending"));
  assert.ok((await readJson("feedback")).items.every((item) => item.user_id === aId && item.status === "pending"));
  await request("/api/v1/favorites", { body: { course_id: courses[0].id, user_id: bId }, headers: cookieA });
  for (const suffix of ["", "/feedback", "/reviews", "/favorites"]) {
    await request(`/api/v1/me${suffix}`, { expected: 401 });
    const own = await request(`/api/v1/me${suffix}?user_id=${bId}`, { headers: { ...cookieA, "if-none-match": '"invented"' } });
    safeDto(own.data); assert.equal(own.response.headers.get("cache-control"), "no-store"); assert.equal(own.response.headers.has("etag"), false);
    const other = await request(`/api/v1/me${suffix}?user_id=${aId}`, { headers: cookieB });
    if (suffix) { assert.equal(other.data.items.length, 0); assert.ok(own.data.items.length > 0); }
    else { assert.equal(own.data.user.id, aId); assert.equal(other.data.user.id, bId); assert.equal(own.data.user.phone_verified, true); }
  }
  const publicReviews = await readJson("reviews");
  publicReviews.reviews[0] = { ...publicReviews.reviews[0], status: "approved", helpfulBy: [aId], helpfulCount: 1, phone: "synthetic-private", openid: "synthetic-private", web_password_hash: "synthetic-private" };
  await writeJson("reviews", publicReviews);
  safeDto((await request("/review-api/reviews")).value);
  safeDto((await request("/api/v1/review-groups")).data);
  assert.equal((await request("/api/v1/review-groups", { headers: cookieA })).response.headers.get("cache-control"), "no-store");
  db.prepare("UPDATE mp_users SET blocked=1 WHERE id=?").run(aId);
  for (const headers of [cookieA, bearerA]) for (const [route, body] of writes) await request(route, { headers, body, expected: 403 });
  await request("/api/v1/auth/phone-verify", { body: { code: "valid-blocked" }, headers: cookieA, expected: 403 });
  await request("/api/v1/auth/web-login", { body: { nickname: "合成用户A", password }, expected: 403 });
  db.prepare("UPDATE mp_users SET blocked=0 WHERE id=?").run(aId);
  blockDuringPhone = bId;
  await request("/api/v1/auth/phone-verify", { body: { code: "valid-block-during" }, headers: cookieB, expected: 403 });
  assert.equal(getUser(bId).phone_verified_at, null);
  db.prepare("UPDATE mp_users SET blocked=0 WHERE id=?").run(bId);
  const temporarySession = await request("/api/v1/auth/web-login", { body: { nickname: "合成用户B", password } });
  revokeDuringPhone = hash(temporarySession.cookie.split("=")[1]);
  await request("/api/v1/auth/phone-verify", { body: { code: "valid-revoked-during" }, headers: { cookie: temporarySession.cookie }, expected: 401 });
  assert.equal(getUser(bId).phone_verified_at, null);
  await request("/api/v1/auth/wechat", { body: { code: "short" }, expected: 400 });
  await request("/api/v1/auth/wechat", { body: { code: "expired-login" }, expected: 401 });
  const wxLogin = await request("/api/v1/auth/wechat", { body: { code: "valid-login-one" } });
  safeDto(wxLogin.data.user);
  await request("/api/v1/auth/wechat", { body: { code: "valid-login-one" }, expected: 401 });
  await request("/api/v1/auth/wechat", { body: { code: "blocked-login" }, expected: 403 });
  const qr = await request("/api/v1/auth/web-login/start", { body: {} });
  const ticket = qr.data.ticket;
  await request("/api/v1/auth/web-login/confirm", { body: { ticket }, headers: cookieB, expected: 403 });
  await request("/api/v1/auth/web-login/confirm", { body: { ticket }, headers: cookieA });
  const qrSession = await request(`/api/v1/auth/web-login/status?ticket=${ticket}`);
  assert.equal(qrSession.response.headers.get("cache-control"), "no-store"); assert.ok(qrSession.cookie); safeDto(qrSession.data);
  assert.equal((await request(`/api/v1/auth/web-login/status?ticket=${ticket}`)).data.status, "used");
  assert.equal((await request("/api/v1/auth/web-login/status?ticket=missing-ticket")).data.status, "expired");
  // Anonymous complaints must survive ordinary-submission and guide-feedback switches.
  const closed = await readJson("feedback"); closed.rules.submissionOpen = false; await writeJson("feedback", closed);
  const report = { title: "指南反馈：合成私密投诉", content: "[guide_id=x] 合成投诉正文", type: "report", user_id: aId, private: false, reportUrl: "https://example.invalid/s1", reportTarget: "合成对象" };
  await request("/feedback-api/submit", { body: report });
  await request("/feedback-api/submit", { body: { ...report, type: "complaint" }, headers: cookieB });
  await request("/feedback-api/submit", { body: ordinary, expected: 403 });
  await request("/feedback-api/submit", { body: { ...report, content: "x" }, expected: 400 });
  for (let i=0; i<3; i++) await request("/feedback-api/submit", { body: report, ip: "203.0.113.50" });
  await request("/feedback-api/submit", { body: report, ip: "203.0.113.50", expected: 429 });
  const storedReports = (await readJson("feedback")).items.filter((item) => item.private);
  assert.equal(storedReports.length, 5); assert.equal(storedReports.filter((item) => item.user_id === null).length, 4); assert.equal(storedReports.filter((item) => item.user_id === bId).length, 1);
  const adminHeaders = { origin: base, "sec-fetch-site": "same-origin", "x-nkustudy-admin-request": "1" };
  const admin = await request("/admin-api/login", { body: { username: "Shview", password }, headers: adminHeaders });
  const adminRead = await request("/admin-api/feedback", { headers: { cookie: admin.cookie } });
  assert.equal(adminRead.value.data.items.filter((item) => item.private).length, 5);
  const changes = adminRead.value.data;
  for (const item of changes.items) { if (item.private) { delete item.private; item.type = "bug"; item.status = "approved"; item.hidden = false; } }
  await request("/admin-api/feedback", { body: { data: changes, expectedRevision: adminRead.value.revision }, headers: { ...adminHeaders, cookie: admin.cookie } });
  const publicFeedback = (await request("/feedback-api/feedback")).value;
  assert.equal(publicFeedback.items.length, 0); safeDto(publicFeedback);
  assert.equal((await readJson("feedback")).items.filter((item) => item.private).length, 5);
  await request("/admin-api/feedback", { headers: cookieA, expected: 401 });
  // Identity rate limit is real and must itself leave an event.
  for (let i=0; i<10; i++) await request("/api/v1/auth/web-login", { body: { nickname: "absent", password }, ip: "203.0.113.90", expected: 401 });
  await request("/api/v1/auth/web-login", { body: { nickname: "absent", password }, ip: "203.0.113.90", expected: 429 });
  const logs = db.prepare("SELECT * FROM user_security_logs ORDER BY id").all();
  for (const [action, code] of [["auth.register","OK"],["auth.register","INVALID_PASSWORD"],["auth.register","NICKNAME_TAKEN"],["auth.web_login","OK"],["auth.web_login","AUTH_INVALID_CREDENTIALS"],["auth.web_login","AUTH_USER_BLOCKED"],["auth.web_login","AUTH_RATE_LIMITED"],["auth.wechat_login","OK"],["auth.wechat_login","AUTH_INVALID_CODE"],["phone.verify","OK"],["phone.verify","AUTH_REQUIRED"],["phone.verify","INVALID_PHONE_CODE"],["phone.verify","PHONE_VERIFY_FAILED"],["phone.verify","PHONE_CODE_REPLAYED"],["phone.verify","AUTH_USER_BLOCKED"],["weblogin.granted","OK"]]) {
    assert.ok(logs.some((log) => log.action === action && log.detail.endsWith(`code=${code}`)), `missing log ${action}:${code}`);
  }
  assert.ok(logs.some((log) => log.action === "auth.web_login" && log.user_id === aId && log.detail.endsWith("code=AUTH_INVALID_CREDENTIALS")));
  assert.ok(logs.some((log) => log.action === "report.submit" && log.user_id === null && log.target_id));
  const identityLogs = logs.filter((log) => /^(auth\.|phone\.|weblogin\.)/.test(log.action));
  for (const log of identityLogs) { assert.ok(log.at); assert.equal(log.user_agent, userAgent); assert.match(log.ip, /^(198\.51\.100\.|203\.0\.113\.)/); assert.ok(log.path.startsWith("/api/v1/auth/")); assert.ok(log.result); }
  const serializedLogs = JSON.stringify(identityLogs);
  for (const secret of [password, a.cookie.split("=")[1], "valid-phone-a", "synthetic-app-secret", "13800001234", "synthetic-expired-secret-must-not-log"]) assert.equal(serializedLogs.includes(secret), false);
  assert.equal(output.includes("synthetic-expired-secret-must-not-log"), false);
  const backupNames = (await fs.readdir(dataDir)).filter((name) => name.includes("before-openid-nullable"));
  assert.equal(backupNames.length, notNull ? 1 : 0);
  if (notNull) {
    const backupPath = path.join(dataDir, backupNames[0]);
    const backup = new Database(backupPath, { readonly: true });
    assert.equal(backup.pragma("table_info(mp_users)").find((col) => col.name === "openid").notnull, 1);
    assert.equal(backup.prepare("SELECT COUNT(*) c FROM mp_users").get().c, 2); backup.close();
    assert.equal((await fs.stat(backupPath)).mode & 0o777, 0o600);
  }
  await stop(); await start();
  assert.equal((await request("/api/v1/me", { headers: cookieA })).data.user.phone_verified, true);
  await request("/api/v1/auth/phone-verify", { body: { code: "valid-phone-a" }, headers: cookieB, expected: 409 });
  assert.equal((await request("/feedback-api/feedback")).value.items.length, 0);
  assert.equal((await readJson("feedback")).items.filter((item) => item.private).length, 5);
  assert.equal(getUser(7).phone_verified_at, null);
  assert.equal((await fs.readdir(dataDir)).filter((name) => name.includes("before-openid-nullable")).length, backupNames.length);
  // Missing real WeChat configuration must fail, never certify a submitted phone.
  await stop(); await start({ WECHAT_APPID: "", WECHAT_APPSECRET: "" });
  await request("/api/v1/auth/phone-verify", { body: { code: "valid-unconfigured", phone: "13999999999" }, headers: cookieB, expected: 503 });
  await request("/api/v1/auth/wechat", { body: { code: "valid-unconfigured" }, expected: 503 });
  assert.equal(getUser(bId).phone_verified_at, null);
  assert.ok(db.prepare("SELECT * FROM user_security_logs WHERE action='phone.verify' AND detail LIKE '%PHONE_VERIFY_NOT_CONFIGURED'").get());
  const finalIdentityLogs = db.prepare("SELECT * FROM user_security_logs ORDER BY id").all().filter((log) => /^(auth\.|phone\.|weblogin\.)/.test(log.action));
  if (process.env.S1_EVIDENCE_DIR) {
    await fs.mkdir(process.env.S1_EVIDENCE_DIR, { recursive: true });
    await fs.writeFile(path.join(process.env.S1_EVIDENCE_DIR, `http-${notNull ? "not-null" : "nullable"}.json`), JSON.stringify({
      schema: notNull ? "NOT NULL" : "nullable", syntheticOnly: true, requests: evidence,
      summary: { usersRetained: true, historicalUnverified: true, backupChecked: notNull, restartChecked: true, phoneCalls, privateComplaints: 5, identityLogCount: finalIdentityLogs.length },
      identityEvents: finalIdentityLogs.map(({ action, result, detail, user_id, ip, user_agent }) => ({ action, result, detail, user_id, ip, user_agent })),
    }, null, 2));
  }
});
