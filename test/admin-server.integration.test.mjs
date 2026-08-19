import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const fixtureDir = path.join(projectRoot, "src", "data", "fixtures");

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("admin server did not start")), 10_000);
    let output = "";
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes("NKUStudy admin API listening")) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`admin server exited early (${code}): ${output}`));
    });
  });
}

test("legacy public write routes start with isolated DATA_DIR and persist submissions", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkustudy-admin-integration-"));
  const publicRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nkustudy-admin-public-"));
  for (const name of ["about.json", "feedback.json", "footer.json", "home.json", "links.json", "manifest.json", "participate.json", "reviews.json"]) {
    await fs.copyFile(path.join(fixtureDir, name), path.join(dataDir, name));
  }
  const port = await freePort();
  const wxMock = http.createServer((req, res) => {
    const code = new URL(req.url || "/", "http://127.0.0.1").searchParams.get("js_code");
    res.setHeader("content-type", "application/json");
    if (code === "mp-good-code") res.end(JSON.stringify({ openid: "integration-openid-1" }));
    else res.end(JSON.stringify({ errcode: 40029, errmsg: "invalid code" }));
  });
  await new Promise((resolve) => wxMock.listen(0, "127.0.0.1", resolve));
  const wxMockPort = wxMock.address().port;
  const childEnv = {
    ...process.env,
    DATA_DIR: dataDir,
    STATE_DB_PATH: path.join(dataDir, "state.sqlite"),
    ADMIN_SECRET_FILE: path.join(dataDir, "admin-secret"),
    BACKUP_SECRET_FILE: path.join(dataDir, "backup-secrets.json"),
    PUBLIC_DIR: path.join(publicRoot, "current"),
    PUBLIC_RELEASES_DIR: path.join(publicRoot, "releases"),
    ADMIN_INITIAL_PASSWORD: "isolated-test-password-123",
    WECHAT_APPID: "wx-integration-appid",
    WECHAT_APPSECRET: "integration-secret-value",
    MP_CODE2SESSION_URL: `http://127.0.0.1:${wxMockPort}/sns/jscode2session`,
    ADMIN_ORIGIN: `http://127.0.0.1:${port}`,
    ADMIN_HOST: "127.0.0.1",
    ADMIN_PORT: String(port),
  };
  const adminHeaders = (extra = {}) => ({
    origin: childEnv.ADMIN_ORIGIN,
    "sec-fetch-site": "same-origin",
    "x-nkustudy-admin-request": "1",
    ...extra,
  });
  assert.equal(path.relative(projectRoot, childEnv.PUBLIC_DIR).startsWith(".."), true, "tests must not publish inside a read-only source candidate");
  assert.notEqual(childEnv.PUBLIC_DIR, path.join(projectRoot, ".runtime-public", "current"));
  let child = spawn(process.execPath, [path.join(projectRoot, "server", "admin-server.mjs")], {
    cwd: projectRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await new Promise((resolve) => wxMock.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await fs.rm(publicRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await waitForServer(child);

  const missingCsrfHeader = await fetch(`http://127.0.0.1:${port}/admin-api/login`, {
    method: "POST",
    headers: { origin: childEnv.ADMIN_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ username: "Shview", password: childEnv.ADMIN_INITIAL_PASSWORD }),
  });
  assert.equal(missingCsrfHeader.status, 403);
  const crossSiteLogin = await fetch(`http://127.0.0.1:${port}/admin-api/login`, {
    method: "POST",
    headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site", "x-nkustudy-admin-request": "1", "content-type": "application/json" },
    body: JSON.stringify({ username: "Shview", password: childEnv.ADMIN_INITIAL_PASSWORD }),
  });
  assert.equal(crossSiteLogin.status, 403);
  const simpleContentType = await fetch(`http://127.0.0.1:${port}/admin-api/login`, {
    method: "POST",
    headers: adminHeaders({ "content-type": "text/plain" }),
    body: JSON.stringify({ username: "Shview", password: childEnv.ADMIN_INITIAL_PASSWORD }),
  });
  assert.equal(simpleContentType.status, 415);

  const login = await fetch(`http://127.0.0.1:${port}/admin-api/login`, {
    method: "POST",
    headers: adminHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ username: "Shview", password: childEnv.ADMIN_INITIAL_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const manifestResponse = await fetch(`http://127.0.0.1:${port}/admin-api/manifest`, { headers: { cookie } });
  const tabA = await manifestResponse.json();
  const tabB = structuredClone(tabA);
  const saveA = await fetch(`http://127.0.0.1:${port}/admin-api/manifest-draft`, {
    method: "POST",
    headers: adminHeaders({ "content-type": "application/json", cookie }),
    body: JSON.stringify({ manifest: { ...tabA.manifest, testMarker: "tab-a" }, expectedRevision: tabA.revision, deletedCourseUids: [] }),
  });
  assert.equal(saveA.status, 200);
  const savedA = await saveA.json();
  const staleB = await fetch(`http://127.0.0.1:${port}/admin-api/manifest-draft`, {
    method: "POST",
    headers: adminHeaders({ "content-type": "application/json", cookie }),
    body: JSON.stringify({ manifest: { ...tabB.manifest, testMarker: "tab-b" }, expectedRevision: tabB.revision, deletedCourseUids: [] }),
  });
  assert.equal(staleB.status, 409);
  assert.equal((await staleB.json()).currentRevision, savedA.revision);
  const staleSync = await fetch(`http://127.0.0.1:${port}/admin-api/sync-r2-all`, {
    method: "POST",
    headers: adminHeaders({ "content-type": "application/json", cookie }),
    body: JSON.stringify({ expectedRevision: tabB.revision }),
  });
  assert.equal(staleSync.status, 409, "stale R2 sync must fail CAS before touching R2");

  const createAccount = await fetch(`http://127.0.0.1:${port}/admin-api/accounts`, {
    method: "POST",
    headers: adminHeaders({ "content-type": "application/json", cookie }),
    body: JSON.stringify({ username: "viewer1", password: "viewer-password-123", permissions: ["content.read"] }),
  });
  assert.equal(createAccount.status, 200);
  const viewerLogin = await fetch(`http://127.0.0.1:${port}/admin-api/login`, {
    method: "POST",
    headers: adminHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ username: "viewer1", password: "viewer-password-123" }),
  });
  assert.equal(viewerLogin.status, 200);
  const viewerCookie = viewerLogin.headers.get("set-cookie").split(";", 1)[0];
  const viewerSession = await (await fetch(`http://127.0.0.1:${port}/admin-api/session`, { headers: { cookie: viewerCookie } })).json();
  assert.equal(viewerSession.data.username, "viewer1");
  assert.deepEqual(viewerSession.data.permissions, ["content.read"]);
  const viewerForbidden = await fetch(`http://127.0.0.1:${port}/admin-api/accounts`, { headers: { cookie: viewerCookie } });
  assert.equal(viewerForbidden.status, 403, "viewer must not manage accounts");
  const viewerManifest = await fetch(`http://127.0.0.1:${port}/admin-api/manifest`, { headers: { cookie: viewerCookie } });
  assert.equal(viewerManifest.status, 200, "viewer can read manifest");
  const viewerWrite = await fetch(`http://127.0.0.1:${port}/admin-api/manifest-draft`, {
    method: "POST",
    headers: adminHeaders({ "content-type": "application/json", cookie: viewerCookie }),
    body: JSON.stringify({ manifest: tabA.manifest, expectedRevision: savedA.revision, deletedCourseUids: [] }),
  });
  assert.equal(viewerWrite.status, 403, "viewer must not edit content");
  const auditFeed = await (await fetch(`http://127.0.0.1:${port}/admin-api/audit?username=viewer1`, { headers: { cookie } })).json();
  assert.equal(auditFeed.ok, true);
  assert.equal(auditFeed.data.items.length >= 1, true, "viewer write attempt must be audited");
  assert.equal(auditFeed.data.items.some((item) => item.action.includes("manifest-draft") && item.status === 403), true);

  const reviewsLoaded = await (await fetch(`http://127.0.0.1:${port}/admin-api/reviews`, { headers: { cookie } })).json();
  const feedbackLoaded = await (await fetch(`http://127.0.0.1:${port}/admin-api/feedback`, { headers: { cookie } })).json();

  const reviewResponse = await fetch(`http://127.0.0.1:${port}/review-api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      courseTitle: "Fixture course",
      teacher: "Fixture teacher",
      rating: 5,
      content: "Synthetic review content long enough for validation.",
    }),
  });
  assert.equal(reviewResponse.status, 200);
  assert.equal((await reviewResponse.json()).pending, true);

  const feedbackResponse = await fetch(`http://127.0.0.1:${port}/feedback-api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Fixture feedback", content: "Synthetic feedback content." }),
  });
  assert.equal(feedbackResponse.status, 200);
  assert.equal((await feedbackResponse.json()).ok, true);
  const staleReviews = await fetch(`http://127.0.0.1:${port}/admin-api/reviews`, {
    method: "POST",
    headers: adminHeaders({ "content-type": "application/json", cookie }),
    body: JSON.stringify({ data: reviewsLoaded.data, expectedRevision: reviewsLoaded.revision }),
  });
  assert.equal(staleReviews.status, 409, "public review submission must make a loaded admin revision stale");
  const staleFeedback = await fetch(`http://127.0.0.1:${port}/admin-api/feedback`, {
    method: "POST",
    headers: adminHeaders({ "content-type": "application/json", cookie }),
    body: JSON.stringify({ data: feedbackLoaded.data, expectedRevision: feedbackLoaded.revision }),
  });
  assert.equal(staleFeedback.status, 409, "public feedback submission must make a loaded admin revision stale");
  const health = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { code: 0, data: { status: "ok" } });
  const courses = await (await fetch(`http://127.0.0.1:${port}/api/v1/courses?page=1&page_size=20&group=${encodeURIComponent("示例分类")}`)).json();
  assert.equal(courses.code, 0);
  assert.equal(courses.data.items[0].id, "11111111-1111-4111-8111-111111111111");
  assert.equal(Object.hasOwn(courses.data.items[0], "basePath"), false);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/admin-api/manifest`)).status, 404);

  const mpBadLogin = await fetch(`http://127.0.0.1:${port}/api/v1/auth/wechat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "mp-bad-code" }),
  });
  assert.equal(mpBadLogin.status, 401);
  assert.equal((await mpBadLogin.json()).code, "AUTH_INVALID_CODE");

  const mpLogin = await fetch(`http://127.0.0.1:${port}/api/v1/auth/wechat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "mp-good-code" }),
  });
  assert.equal(mpLogin.status, 200);
  const mpLoginBody = await mpLogin.json();
  assert.equal(mpLoginBody.code, 0);
  assert.equal(JSON.stringify(mpLoginBody).includes("openid"), false, "login response must not contain openid");
  assert.match(mpLoginBody.data.token, /^[A-Za-z0-9_-]{40,}$/);
  const mpAuth = { authorization: `Bearer ${mpLoginBody.data.token}` };

  assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/me`)).status, 401);
  const meResponse = await fetch(`http://127.0.0.1:${port}/api/v1/me`, { headers: mpAuth });
  assert.equal(meResponse.status, 200);
  assert.equal((await meResponse.json()).data.user.id, mpLoginBody.data.user.id);

  const profileResponse = await fetch(`http://127.0.0.1:${port}/api/v1/me/profile`, {
    method: "POST",
    headers: { "content-type": "application/json", ...mpAuth },
    body: JSON.stringify({ nickname: "集成测试用户", avatar_url: "https://example.com/avatar.png" }),
  });
  assert.equal(profileResponse.status, 200);
  assert.equal((await profileResponse.json()).data.user.nickname, "集成测试用户");

  const mpLogout = await fetch(`http://127.0.0.1:${port}/api/v1/auth/logout`, {
    method: "POST",
    headers: { "content-type": "application/json", ...mpAuth },
    body: "{}",
  });
  assert.equal(mpLogout.status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/me`, { headers: mpAuth })).status, 401, "logout must revoke the token");

  const mpUsersAdmin = await (await fetch(`http://127.0.0.1:${port}/admin-api/mp-users`, { headers: { cookie } })).json();
  assert.equal(mpUsersAdmin.ok, true);
  assert.equal(mpUsersAdmin.data.total, 1);
  assert.equal(mpUsersAdmin.data.users[0].login_count, 1);
  assert.equal(mpUsersAdmin.data.users[0].nickname, "集成测试用户");
  assert.equal(JSON.stringify(mpUsersAdmin).includes("integration-openid-1"), false, "admin list must only expose masked openid");

  const mpLogin2 = await fetch(`http://127.0.0.1:${port}/api/v1/auth/wechat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "mp-good-code" }),
  });
  const mpAuth2 = { authorization: `Bearer ${(await mpLogin2.json()).data.token}` };

  const favAdd = await fetch(`http://127.0.0.1:${port}/api/v1/favorites`, {
    method: "POST",
    headers: { "content-type": "application/json", ...mpAuth2 },
    body: JSON.stringify({ course_id: "11111111-1111-4111-8111-111111111111" }),
  });
  assert.equal(favAdd.status, 200);
  assert.equal((await favAdd.json()).data.total, 1);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/favorites`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ course_id: "11111111-1111-4111-8111-111111111111" }),
  })).status, 401, "favorites require login");

  const favList = await (await fetch(`http://127.0.0.1:${port}/api/v1/me/favorites`, { headers: mpAuth2 })).json();
  assert.equal(favList.data.total, 1);
  assert.equal(favList.data.items[0].name, "示例课程");

  assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/favorites/11111111-1111-4111-8111-111111111111`, { method: "DELETE", headers: mpAuth2 })).status, 200);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/v1/me/favorites`, { headers: mpAuth2 })).json()).data.total, 0);

  const boundReview = await fetch(`http://127.0.0.1:${port}/api/v1/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", ...mpAuth2 },
    body: JSON.stringify({
      course_id: "11111111-1111-4111-8111-111111111111",
      teacher: "Fixture bound teacher",
      rating: 5,
      tags: [],
      body: "Bound user review content long enough for validation.",
      anonymous: true,
    }),
  });
  assert.equal(boundReview.status, 200);
  const myReviews = await (await fetch(`http://127.0.0.1:${port}/api/v1/me/reviews`, { headers: mpAuth2 })).json();
  assert.equal(myReviews.data.total, 1);
  assert.equal(myReviews.data.items[0].teacher_name, "Fixture bound teacher");
  assert.equal(JSON.stringify(myReviews.data.items[0]).includes("ipHash"), false);

  const notifyState = await (await fetch(`http://127.0.0.1:${port}/admin-api/notify-settings`, { headers: { cookie } })).json();
  assert.equal(notifyState.ok, true);
  assert.equal(notifyState.data.enabled, false);

  const publicReviewResponse = await fetch(`http://127.0.0.1:${port}/api/v1/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      course_id: "11111111-1111-4111-8111-111111111111",
      teacher: "Fixture mini-program teacher",
      rating: 4,
      tags: ["Fixture tag"],
      body: "Synthetic mini-program review content long enough for validation.",
      anonymous: true,
    }),
  });
  assert.equal(publicReviewResponse.status, 200);
  assert.deepEqual(await publicReviewResponse.json(), { code: 0, data: { submitted: true, pending: true } });

  const invalidAttempts = [];
  for (let index = 0; index < 30; index += 1) {
    invalidAttempts.push(await fetch(`http://127.0.0.1:${port}/review-api/submit`, {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: "{}",
    }));
  }
  assert.equal(invalidAttempts.at(-1).status, 429, "invalid bodies must consume the persistent attempt limit");

  for (let index = 0; index < 50; index += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/visit-api/hit`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `attacker-${index}` },
      body: JSON.stringify({ path: `/random-${index}` }),
    });
    assert.equal(response.status, 200);
  }

  const badLogins = [];
  for (let index = 0; index < 4; index += 1) {
    badLogins.push(await fetch(`http://127.0.0.1:${port}/admin-api/login`, {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ username: "Shview", password: "wrong-password" }),
    }));
  }
  assert.equal(badLogins.at(-1).status, 429, "login attempts are counted before password verification");

  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  child = spawn(process.execPath, [path.join(projectRoot, "server", "admin-server.mjs")], {
    cwd: projectRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer(child);
  const persistedSession = await fetch(`http://127.0.0.1:${port}/admin-api/session`, { headers: { cookie } });
  assert.equal(persistedSession.status, 200, "admin sessions must survive a server restart until server-side expiry or logout");
  const persistedLoginLimit = await fetch(`http://127.0.0.1:${port}/admin-api/login`, {
    method: "POST",
    headers: adminHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ username: "Shview", password: childEnv.ADMIN_INITIAL_PASSWORD }),
  });
  assert.equal(persistedLoginLimit.status, 429, "login limit must survive a server restart");
  const persistedAttempt = await fetch(`http://127.0.0.1:${port}/review-api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(persistedAttempt.status, 429, "attempt limit must survive a server restart");
  const logout = await fetch(`http://127.0.0.1:${port}/admin-api/logout`, {
    method: "POST",
    headers: adminHeaders({ "content-type": "application/json", cookie }),
    body: "{}",
  });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/admin-api/session`, { headers: { cookie } })).status, 401, "logout must revoke the session server-side");

  const reviews = JSON.parse(await fs.readFile(path.join(dataDir, "reviews.json"), "utf8"));
  const feedback = JSON.parse(await fs.readFile(path.join(dataDir, "feedback.json"), "utf8"));
  const visits = JSON.parse(await fs.readFile(path.join(dataDir, "visit-stats.json"), "utf8"));
  assert.equal(reviews.reviews.length, 3);
  assert.equal(feedback.items.length, 1);
  assert.equal(typeof reviews.reviews[0].ipHash, "string");
  assert.equal(JSON.stringify(reviews).includes("127.0.0.1"), false);
  assert.equal(JSON.stringify(feedback).includes("127.0.0.1"), false);
  assert.deepEqual(Object.keys(visits.pages), ["/__unknown__"]);
});
