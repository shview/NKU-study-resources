import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

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
    if (child.exitCode !== null) throw new Error(`Server exited before smoke check (${child.exitCode}).`);
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

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkustudy-public-smoke-"));
let child;
try {
  for (const name of ["about.json", "feedback.json", "footer.json", "guides.json", "home.json", "links.json", "manifest.json", "participate.json", "reviews.json"]) {
    await fs.copyFile(path.join(fixtureDir, name), path.join(dataDir, name));
  }
  const port = await freePort();
  child = spawn(process.execPath, [path.join(projectRoot, "server", "admin-server.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      STATE_DB_PATH: path.join(dataDir, "state.sqlite"),
      ADMIN_SECRET_FILE: path.join(dataDir, "admin-secret"),
      BACKUP_SECRET_FILE: path.join(dataDir, "backup-secrets.json"),
      ADMIN_INITIAL_PASSWORD: "isolated-smoke-password-123",
      ADMIN_HOST: "127.0.0.1",
      ADMIN_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  const health = await waitForHealth(`${base}/api/v1/health`, child);
  const courseResponse = await fetch(`${base}/api/v1/courses?page=1&page_size=20`);
  const courses = await courseResponse.json();
  const cached = await fetch(`${base}/api/v1/courses?page=1&page_size=20`, { headers: { "if-none-match": courseResponse.headers.get("etag") } });
  const reviewGroups = await (await fetch(`${base}/api/v1/review-groups`)).json();
  const searchIndex = await (await fetch(`${base}/api/v1/search-index`)).json();
  const guides = await (await fetch(`${base}/api/v1/guides`)).json();
  const guide = await (await fetch(`${base}/api/v1/guides/fixture-add-drop`)).json();
  const blocked = await fetch(`${base}/api/v1/admin-api/manifest`);
  const unsupportedAuth = await fetch(`${base}/api/v1/auth/wechat`);
  if (health.code !== 0 || health.data?.status !== "ok") throw new Error("Health response contract failed.");
  if (courses.code !== 0 || courses.data?.items?.length !== 1) throw new Error("Course response contract failed.");
  if (cached.status !== 304) throw new Error("Public GET ETag contract failed.");
  if (reviewGroups.code !== 0 || !Array.isArray(reviewGroups.data?.items)) throw new Error("Review group response contract failed.");
  if (searchIndex.code !== 0 || !searchIndex.data?.version || !Array.isArray(searchIndex.data?.items)) throw new Error("Search index response contract failed.");
  if (guides.code !== 0 || guides.data?.items?.length !== 1) throw new Error("Guide list response contract failed.");
  if (guide.code !== 0 || guide.data?.id !== "fixture-add-drop") throw new Error("Guide detail response contract failed.");
  if (blocked.status !== 404) throw new Error("A management path was exposed under /api/v1.");
  if (unsupportedAuth.status !== 404) throw new Error("Unsupported authentication was accidentally exposed.");
  console.log(`smoke passed: health=${health.data.status}, courses=${courses.data.items.length}, search=${searchIndex.data.items.length}, guides=${guides.data.items.length}, etag=${cached.status}, public-admin=${blocked.status}`);
} catch (error) {
  throw new Error(`${error.message}${child ? "" : " (child was not started)"}`, { cause: error });
} finally {
  if (child?.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
