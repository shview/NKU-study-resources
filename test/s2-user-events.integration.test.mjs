import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const root = path.resolve(import.meta.dirname, "..");
const password = "synthetic-S2-password";

test("S2 user events: real HTTP outcomes, exact actors/targets, one event and no copied content", { timeout: 120000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nku-s2-events-"));
  const dataDir = path.join(dir, "data");
  await fs.mkdir(dataDir);
  for (const name of ["about", "feedback", "footer", "guides", "home", "links", "manifest", "participate", "reviews"]) {
    await fs.copyFile(path.join(root, "src/data/fixtures", `${name}.json`), path.join(dataDir, `${name}.json`));
  }
  const readData = async (name) => JSON.parse(await fs.readFile(path.join(dataDir, `${name}.json`), "utf8"));
  const writeData = async (name, data) => fs.writeFile(path.join(dataDir, `${name}.json`), JSON.stringify(data));
  for (const name of ["reviews", "feedback"]) {
    const value = await readData(name);
    value.rules = { ...value.rules, submissionOpen: true, moderationRequired: true, minLength: 5, hourlyLimit: 2, dailyLimit: 100 };
    await writeData(name, value);
  }
  await writeData("notify-settings", { enabled: false, guide_feedback_enabled: false });
  const reservation = http.createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const dbPath = path.join(dataDir, "state.sqlite");
  let child, db, output = "";
  t.after(async () => {
    if (child?.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    db?.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  child = spawn(process.execPath, ["server/admin-server.mjs"], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_ENV: "test", DATA_DIR: dataDir, STATE_DB_PATH: dbPath,
      ADMIN_HOST: "127.0.0.1", ADMIN_PORT: String(port), ADMIN_ORIGIN: base, ADMIN_INITIAL_PASSWORD: password,
      ADMIN_SECRET_FILE: path.join(dataDir, "admin-secret"), BACKUP_SECRET_FILE: path.join(dataDir, "backup-secrets.json"),
      PUBLIC_DIR: path.join(dir, "publish/current"), PUBLIC_RELEASES_DIR: path.join(dir, "publish/releases"), TRUSTED_PROXIES: "127.0.0.1/32" },
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Startup timeout: ${output}`)), 15000);
    const collect = (chunk) => { output += chunk; if (String(chunk).includes("NKUStudy admin API listening")) { clearTimeout(timeout); resolve(); } };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.once("exit", () => { clearTimeout(timeout); reject(new Error(output)); });
  });
  db = new Database(dbPath);
  let sequence = 0;
  const events = [];
  async function request(route, { body = {}, cookie = "", status = 200, action, userId = null, result = status >= 500 ? "error" : status >= 400 ? "rejected" : "ok", ip } = {}) {
    const marker = `S2-synthetic-${++sequence}`;
    const sourceIp = ip || `198.51.100.${sequence}`;
    const response = await fetch(base + route, { method: "POST", headers: { cookie, "content-type": "application/json", "user-agent": marker, "x-forwarded-for": sourceIp }, body: typeof body === "string" ? body : JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, status, `${route}: ${JSON.stringify(value)}`);
    if (action) {
      const rows = db.prepare("SELECT * FROM user_security_logs WHERE user_agent=?").all(marker);
      assert.equal(rows.length, 1, `${route} should emit exactly one outcome`);
      const row = rows[0];
      assert.equal(row.action, action); assert.equal(row.user_id, userId); assert.equal(row.result, result);
      assert.equal(row.path, route.split("?")[0]); assert.equal(row.ip, sourceIp); assert.ok(row.at > 0);
      assert.match(row.detail, new RegExp(`^status=${status} code=[A-Z0-9_]+$`));
      events.push(row);
      return { value, row, cookie: response.headers.get("set-cookie")?.split(";")[0] };
    }
    return { value, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }
  const a = await request("/api/v1/auth/web-register", { body: { nickname: "S2-user-A", password } });
  const b = await request("/api/v1/auth/web-register", { body: { nickname: "S2-user-B", password } });
  const aId = a.value.data.user.id, bId = b.value.data.user.id;
  // Synthetic test fixture only; never used against a production account.
  db.prepare("UPDATE mp_users SET phone_verified_at=? WHERE id=?").run(Date.now(), aId);
  const courses = (await (await fetch(base + "/api/v1/courses")).json()).data.items;
  const privateText = "S2-secret-body-that-must-not-be-logged";
  const feedback = { title: "S2-private-title", content: privateText, type: "bug", user_id: bId };
  const review = { course_id: courses[0].id, teacher: "synthetic-teacher", rating: 5, body: privateText, user_id: bId };
  const legacy = { courseTitle: "synthetic-course", teacher: "synthetic-teacher", rating: 5, content: privateText, user_id: bId };

  await t.test("public writes log anonymous, unverified and invalid input exactly once", async () => {
    for (const [route, body, action] of [["/api/v1/reviews", review, "review.submit"], ["/review-api/submit", legacy, "review.submit"], ["/feedback-api/submit", feedback, "feedback.submit"]]) {
      await request(route, { body, status: 401, action });
      await request(route, { body, cookie: b.cookie, status: 403, action, userId: bId });
      await request(route, { body: "{", cookie: a.cookie, status: 400, action, userId: aId });
    }
  });
  await t.test("stored review and feedback IDs match the persisted rows", async () => {
    for (const [route, body, action, file, key] of [["/api/v1/reviews", review, "review.submit", "reviews", "reviews"], ["/review-api/submit", legacy, "review.submit", "reviews", "reviews"], ["/feedback-api/submit", feedback, "feedback.submit", "feedback", "items"]]) {
      const { row } = await request(route, { body, cookie: a.cookie, action, userId: aId, result: "pending" });
      assert.ok(row.target_id);
      const saved = (await readData(file))[key].find((item) => item.id === row.target_id);
      assert.equal(saved.user_id, aId); assert.equal(saved.status, "pending");
    }
  });
  await t.test("private complaints omit report URL, target, title and body from logs", async () => {
    const body = { ...feedback, type: "report", reportUrl: "https://example.invalid/private-case", reportTarget: "synthetic-private-person", private: false };
    const { row } = await request("/feedback-api/submit", { body, action: "report.submit", result: "pending" });
    const saved = (await readData("feedback")).items.find((item) => item.id === row.target_id);
    assert.equal(saved.private, true); assert.equal(saved.user_id, null);
    await request("/feedback-api/submit", { body: { ...body, content: "x" }, action: "report.submit", status: 400 });
  });
  await t.test("ignored traps/disabled guide feedback and throttled submissions remain distinguishable", async () => {
    await request("/feedback-api/submit", { body: { website: "bot" }, action: "feedback.submit", result: "ignored" });
    await request("/feedback-api/submit", { body: { ...feedback, content: `[guide_id=x] ${privateText}` }, cookie: a.cookie, action: "feedback.submit", userId: aId, result: "ignored" });
    for (const [route, body, action] of [["/api/v1/reviews", review, "review.submit"], ["/review-api/submit", legacy, "review.submit"], ["/feedback-api/submit", feedback, "feedback.submit"]]) {
      const ip = `203.0.113.${++sequence}`;
      for (let n = 0; n < 3; n++) await request(route, { body, cookie: a.cookie, action, userId: aId, ip, status: n < 2 ? 200 : 429, result: n < 2 ? "pending" : "rejected" });
    }
  });
  await t.test("profile, avatar and password outcomes are captured without their values", async () => {
    await request("/api/v1/me/profile", { status: 401, action: "profile.update" });
    await request("/api/v1/me/profile", { cookie: a.cookie, body: "{", status: 400, action: "profile.update", userId: aId });
    await request("/api/v1/me/profile", { cookie: a.cookie, body: { nickname: "S2-private-nickname" }, action: "profile.update", userId: aId });
    await request("/api/v1/me/profile", { cookie: a.cookie, body: { avatar_url: "https://example.invalid/unowned.png" }, status: 403, action: "profile.update", userId: aId });
    await request("/api/v1/me/avatar", { status: 401, action: "avatar.upload" });
    await request("/api/v1/me/web-password", { cookie: a.cookie, body: { password }, action: "password.set", userId: aId });
    await request("/api/v1/me/web-password", { cookie: a.cookie, body: { password: "short" }, status: 400, action: "password.set", userId: aId });
    await request("/api/v1/me/web-password/change", { cookie: a.cookie, body: { current_password: "wrong", new_password: password }, status: 401, action: "password.change", userId: aId });
    await request("/api/v1/me/web-password/change", { cookie: a.cookie, body: { current_password: password, new_password: password }, action: "password.change", userId: aId });
    db.prepare("UPDATE mp_users SET blocked=1 WHERE id=?").run(bId);
    await request("/api/v1/me/profile", { cookie: b.cookie, status: 403, action: "profile.update", userId: bId });
    db.prepare("UPDATE mp_users SET blocked=0 WHERE id=?").run(bId);
    const expires = db.prepare("SELECT expires_at FROM mp_auth_tokens WHERE user_id=?").get(bId).expires_at;
    db.prepare("UPDATE mp_auth_tokens SET expires_at=1 WHERE user_id=?").run(bId);
    await request("/api/v1/me/profile", { cookie: b.cookie, status: 401, action: "profile.update", userId: bId });
    await request("/feedback-api/submit", { cookie: b.cookie, body: feedback, status: 401, action: "feedback.submit", userId: bId });
    db.prepare("UPDATE mp_auth_tokens SET expires_at=? WHERE user_id=?").run(expires, bId);
  });
  await t.test("logout/deletion capture the actor before credentials disappear", async () => {
    await request("/api/v1/me/delete-account", { status: 401, action: "account.delete" });
    await request("/api/v1/auth/logout", { cookie: a.cookie, action: "auth.logout", userId: aId });
    await request("/api/v1/auth/logout", { cookie: a.cookie, action: "auth.logout", result: "ignored" });
    await request("/api/v1/me/delete-account", { cookie: b.cookie, action: "account.delete", userId: bId });
    assert.equal(db.prepare("SELECT COUNT(*) count FROM mp_auth_tokens WHERE user_id=?").get(bId).count, 0);
  });
  const logs = JSON.stringify(db.prepare("SELECT * FROM user_security_logs").all());
  for (const forbidden of [password, privateText, "S2-private-title", "synthetic-private-person", "https://example.invalid/private-case", "S2-private-nickname", a.cookie.split("=")[1], b.cookie.split("=")[1]]) {
    assert.equal(logs.includes(forbidden), false, `log copied ${forbidden.slice(0, 12)}`);
  }
  assert.ok(events.length >= 35);
});
