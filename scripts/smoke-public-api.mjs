import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyGuideApi } from "./lib/public-api-smoke-contract.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const fixtureDir = path.join(projectRoot, "src", "data", "fixtures");

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Server exited before smoke check (${child.exitCode ?? child.signalCode}).`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return response.json();
    } catch {
      // The isolated child needs a short startup window for native SQLite.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Server did not become healthy within 10 seconds.");
}

export function smokeEnvironment(directory, port) {
  const dataDir = path.join(directory, "data");
  // Explicit allowlist: do not inherit real cloud/WeChat/AI/notification keys,
  // NODE_OPTIONS, proxies, or production runtime paths from the invoking shell.
  return {
    ...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    PATH: [path.dirname(process.execPath), ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"])].join(path.delimiter),
    TMPDIR: directory, TMP: directory, TEMP: directory, NODE_ENV: "test",
    DATA_DIR: dataDir, STATE_DB_PATH: path.join(dataDir, "state.sqlite"),
    ADMIN_SECRET_FILE: path.join(directory, "admin-secret"),
    BACKUP_SECRET_FILE: path.join(dataDir, "backup-secrets.json"),
    PUBLIC_DIR: path.join(directory, "public", "current"),
    PUBLIC_RELEASES_DIR: path.join(directory, "public", "releases"),
    ADMIN_INITIAL_PASSWORD: "isolated-smoke-password-123",
    ADMIN_HOST: "127.0.0.1", ADMIN_PORT: String(port), ADMIN_ORIGIN: `http://127.0.0.1:${port}`,
  };
}

async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, "exit");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try { child.kill("SIGTERM"); await exit; }
  finally { clearTimeout(timeout); }
}

export async function runPublicApiSmoke() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nkustudy-public-smoke-")));
  const dataDir = path.join(directory, "data");
  let child;
  let logs = "";
  try {
    await fs.mkdir(dataDir);
    for (const name of ["about.json", "feedback.json", "footer.json", "guides.json", "home.json", "links.json", "manifest.json", "participate.json", "reviews.json"]) {
      await fs.copyFile(path.join(fixtureDir, name), path.join(dataDir, name));
    }
    await fs.writeFile(path.join(dataDir, "backup-settings.json"), JSON.stringify({ autoEnabled: false, r2DataBackup: false, webdavEnabled: false }));
    await fs.writeFile(path.join(dataDir, "notify-settings.json"), JSON.stringify({ enabled: false }));
    const snapshot = JSON.parse(await fs.readFile(path.join(projectRoot, "server", "data", "learning-compass-snapshot.json"), "utf8"));
    const sourceContent = JSON.parse(await fs.readFile(path.join(projectRoot, "content", "learning-compass.generated.json"), "utf8"));
    const port = await freePort();
    child = spawn(process.execPath, [path.join(projectRoot, "server", "admin-server.mjs")], {
      cwd: projectRoot, env: smokeEnvironment(directory, port), stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", (error) => { logs += `\nChild startup failed: ${error.message}`; });
    child.stdout.on("data", (chunk) => { logs = (logs + chunk.toString()).slice(-16_384); });
    child.stderr.on("data", (chunk) => { logs = (logs + chunk.toString()).slice(-16_384); });
    const base = `http://127.0.0.1:${port}`;
    const request = async (route, options = {}) => {
      const response = await fetch(base + route, { ...options, signal: AbortSignal.timeout(5_000), redirect: "error" });
      assert.match(response.headers.get("content-type") || "", /^application\/json\b/, `${route}: expected JSON`);
      return { status: response.status, body: await response.json(), etag: response.headers.get("etag"), cache: response.headers.get("cache-control") };
    };
    const cachedGet = async (route) => {
      const response = await request(route);
      assert.equal(response.status, 200, `${route}: HTTP status mismatch`);
      assert.ok(response.etag, `${route}: ETag missing`);
      const cached = await fetch(base + route, { headers: { "if-none-match": response.etag }, signal: AbortSignal.timeout(5_000), redirect: "error" });
      assert.equal(cached.status, 304, `${route}: Public GET ETag contract failed`);
      assert.equal(await cached.text(), "", `${route}: 304 response must be empty`);
      return response;
    };
    const health = await waitForHealth(`${base}/api/v1/health`, child);
    assert.equal(health.code, 0, "Health response contract failed");
    assert.equal(health.data?.status, "ok", "Health response contract failed");
    const courses = (await cachedGet("/api/v1/courses?page=1&page_size=20")).body;
    assert.equal(courses.code, 0, "Course response contract failed");
    assert.equal(courses.data?.items?.length, 1, "Course response contract failed");
    const reviewGroups = await request("/api/v1/review-groups");
    assert.equal(reviewGroups.status, 200, "Review group response contract failed");
    assert.equal(reviewGroups.body.code, 0, "Review group response contract failed");
    assert.ok(Array.isArray(reviewGroups.body.data?.items), "Review group response contract failed");
    const searchIndex = (await cachedGet("/api/v1/search-index")).body;
    assert.equal(searchIndex.code, 0, "Search index response contract failed");
    await cachedGet("/api/v1/guides?page=1&page_size=5");
    const guides = await verifyGuideApi({ request, snapshot, sourceContent, searchIndex: searchIndex.data });
    const blocked = await request("/api/v1/admin-api/manifest");
    assert.equal(blocked.status, 404, "A management path was exposed under /api/v1");
    const unsupportedAuth = await request("/api/v1/auth/wechat");
    assert.equal(unsupportedAuth.status, 404, "Unsupported authentication was accidentally exposed");
    const disabledAuth = await request("/api/v1/auth/wechat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "synthetic-smoke-code" }) });
    assert.equal(disabledAuth.status, 503, "Unconfigured WeChat authentication must stay disabled");
    assert.equal(disabledAuth.body.code, "MP_AUTH_NOT_CONFIGURED", "Unconfigured WeChat authentication must not contact upstream");
    assert.equal(disabledAuth.cache, "no-store", "Authentication failure must not be cached");
    return { health: health.data.status, courses: courses.data.items.length, search: searchIndex.data.items.length, ...guides, etag: 304, publicAdmin: blocked.status, disabledAuth: disabledAuth.status };
  } catch (error) {
    throw new Error(`${error.message}${logs ? `\nIsolated server output:\n${logs}` : ""}`, { cause: error });
  } finally {
    await stop(child);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = await runPublicApiSmoke();
  console.log(`smoke passed: ${JSON.stringify(result)}`);
}
