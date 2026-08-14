import { createCipheriv, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Busboy from "busboy";
import { CopyObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "src", "data", "manifest.json");
const reviewsPath = path.join(root, "src", "data", "reviews.json");
const feedbackPath = path.join(root, "src", "data", "feedback.json");
const aboutPath = path.join(root, "src", "data", "about.json");
const homePath = path.join(root, "src", "data", "home.json");
const participatePath = path.join(root, "src", "data", "participate.json");
const linksPath = path.join(root, "src", "data", "links.json");
const footerPath = path.join(root, "src", "data", "footer.json");
const editorSettingsPath = path.join(root, "src", "data", "editor-settings.json");
const visitStatsPath = path.join(root, "src", "data", "visit-stats.json");
const backupSettingsPath = path.join(root, "src", "data", "backup-settings.json");
const backupSecretPath = process.env.BACKUP_SECRET_FILE || path.join(root, ".backup-secrets.json");
const distDir = path.join(root, "dist");
const publicDir = process.env.PUBLIC_DIR || "/var/www/nkustudy";
const host = process.env.ADMIN_HOST || "127.0.0.1";
const port = Number(process.env.ADMIN_PORT || 8787);
const password = process.env.ADMIN_PASSWORD;
const secretPath = process.env.ADMIN_SECRET_FILE || path.join(root, ".admin-secret");
const r2Bucket = process.env.R2_BUCKET;
const r2Prefix = normalizeKey(process.env.R2_PREFIX || "resources");
const r2Client = process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
  ? new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    })
  : null;
const reviewRate = new Map();
const feedbackRate = new Map();
const loginFailures = new Map();
const loginLockThreshold = 5;
const loginLockMs = 5 * 60 * 1000;
const visitDedupMs = 30 * 60 * 1000;
let backupRunning = false;
let lastAutoBackupDate = "";

if (!password) {
  console.error("ADMIN_PASSWORD is required.");
  process.exit(1);
}

let secret;
if (fs.existsSync(secretPath)) {
  secret = fs.readFileSync(secretPath, "utf8").trim();
} else {
  secret = randomBytes(32).toString("hex");
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function jsonDownload(res, filename, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
  });
  res.end(body);
}

function defaultBackupSettings() {
  return {
    version: 1,
    updated: today(),
    autoEnabled: true,
    dailyTime: "03:20",
    r2DataBackup: true,
    r2BackupPrefix: "backups/site-data",
    webdavEnabled: false,
    includeSiteData: true,
    includeServerConfig: true,
    includeCourseFiles: true,
    destinations: [],
  };
}

function defaultEditorSettings() {
  return {
    version: 1,
    updated: today(),
    user: {
      toolbar: ["bold", "italic", "strike", "headings", "link", "list", "ordered-list", "check", "quote", "code", "line", "table", "preview", "fullscreen"],
    },
    admin: {
      toolbar: ["bold", "italic", "strike", "headings", "link", "list", "ordered-list", "check", "quote", "code", "line", "table", "preview", "fullscreen", "outline"],
    },
  };
}

function readBackupSecrets() {
  if (!fs.existsSync(backupSecretPath)) return { webdav: {}, encryptionPassword: "" };
  const data = JSON.parse(fs.readFileSync(backupSecretPath, "utf8"));
  data.webdav = data.webdav || {};
  return data;
}

function writeBackupSecrets(data) {
  fs.writeFileSync(backupSecretPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(backupSecretPath, 0o600);
  } catch {}
}

function readBackupSettings() {
  const defaults = defaultBackupSettings();
  const data = readJsonFile(backupSettingsPath, defaults);
  return {
    ...defaults,
    ...data,
    destinations: Array.isArray(data.destinations) ? data.destinations : [],
  };
}

function publicBackupSettings() {
  const settings = readBackupSettings();
  const secrets = readBackupSecrets();
  return {
    ...settings,
    encryptionPasswordConfigured: Boolean(secrets.encryptionPassword),
    destinations: settings.destinations.map((dest) => ({
      id: dest.id,
      name: dest.name,
      url: dest.url,
      username: dest.username || "",
      enabled: dest.enabled !== false,
      passwordConfigured: Boolean(secrets.webdav?.[dest.id]?.password),
    })),
  };
}

function writeBackupSettings(input) {
  const current = readBackupSettings();
  const secrets = readBackupSecrets();
  const next = {
    ...current,
    ...input,
    updated: today(),
  };
  next.dailyTime = /^\d{2}:\d{2}$/.test(String(next.dailyTime || "")) ? next.dailyTime : "03:20";
  next.r2BackupPrefix = normalizeKey(next.r2BackupPrefix || "backups/site-data");
  next.destinations = (Array.isArray(input.destinations) ? input.destinations : current.destinations).map((dest) => {
    const id = cleanText(dest.id, 80) || `webdav-${randomBytes(4).toString("hex")}`;
    if (typeof dest.password === "string" && dest.password) {
      secrets.webdav[id] = { ...(secrets.webdav[id] || {}), password: dest.password };
    }
    if (dest.clearPassword) delete secrets.webdav[id];
    return {
      id,
      name: cleanText(dest.name, 120) || "WebDAV",
      url: cleanText(dest.url, 500),
      username: cleanText(dest.username, 160),
      enabled: dest.enabled !== false,
    };
  }).filter((dest) => dest.url);
  if (typeof input.encryptionPassword === "string" && input.encryptionPassword) {
    secrets.encryptionPassword = input.encryptionPassword;
  }
  if (input.clearEncryptionPassword) secrets.encryptionPassword = "";
  writeBackupSecrets(secrets);
  fs.writeFileSync(backupSettingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return publicBackupSettings();
}

function normalizeToolbar(toolbar, defaults) {
  const allowed = [
    "headings",
    "bold",
    "italic",
    "strike",
    "line",
    "quote",
    "list",
    "ordered-list",
    "check",
    "outdent",
    "indent",
    "code",
    "inline-code",
    "insert-after",
    "insert-before",
    "undo",
    "redo",
    "upload",
    "link",
    "table",
    "record",
    "edit-mode",
    "both",
    "preview",
    "fullscreen",
    "outline",
    "code-theme",
    "content-theme",
    "export",
    "devtools",
    "info",
    "help",
    "br",
  ];
  const next = Array.isArray(toolbar) ? toolbar : defaults;
  return [...new Set(next.filter((item) => allowed.includes(item)))];
}

function normalizeEditorSettings(data) {
  const defaults = defaultEditorSettings();
  return {
    version: Number(data.version || 1),
    updated: today(),
    user: {
      toolbar: normalizeToolbar(data.user?.toolbar, defaults.user.toolbar),
    },
    admin: {
      toolbar: normalizeToolbar(data.admin?.toolbar, defaults.admin.toolbar),
    },
  };
}

function readEditorSettings() {
  return normalizeEditorSettings(readJsonFile(editorSettingsPath, defaultEditorSettings()));
}

function publicEditorSettings() {
  return readEditorSettings();
}

function writeEditorSettings(data) {
  const next = normalizeEditorSettings(data || {});
  fs.writeFileSync(editorSettingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return publicEditorSettings();
}

function encryptText(plainText, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(passphrase, salt, 310000, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  return {
    algorithm: "AES-256-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: 310000,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
}

function readFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

function backupData(scope = "all") {
  const createdAt = nowIso();
  const safeConfig = {
    publicDir,
    adminHost: host,
    adminPort: port,
    r2Bucket: r2Bucket || "",
    r2Prefix,
    r2Configured: Boolean(r2Client && r2Bucket),
    note: "Sensitive values such as ADMIN_PASSWORD and R2 secret keys are intentionally not included.",
  };
  const data = {
    ok: true,
    scope,
    createdAt,
    config: safeConfig,
  };
  const manifest = () => cleanManifestResources(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  const pages = () => ({
    about: readAbout(),
    home: readHome(),
    participate: readParticipate(),
    links: readLinks(),
    footer: readFooter(),
  });
  if (scope === "all" || scope === "manifest") data.manifest = manifest();
  if (scope === "all" || scope === "reviews") data.reviews = readReviews();
  if (scope === "all" || scope === "feedback") data.feedback = readFeedback();
  if (scope === "all" || scope === "pages") data.pages = pages();
  if (scope === "all" || scope === "stats") data.visitStats = readVisitStats();
  if (scope === "all" || scope === "config") data.editorSettings = readEditorSettings();
  if (!["all", "manifest", "reviews", "feedback", "pages", "stats", "config"].includes(scope)) {
    return null;
  }
  return data;
}

function serverConfigBackup() {
  const secrets = readBackupSecrets();
  const envText = readFileIfExists("/etc/nkustudy-admin.env");
  const config = {
    createdAt: nowIso(),
    files: [
      { path: "/etc/caddy/Caddyfile", content: readFileIfExists("/etc/caddy/Caddyfile") },
      { path: "/etc/systemd/system/nkustudy-admin.service", content: readFileIfExists("/etc/systemd/system/nkustudy-admin.service") },
    ].filter((file) => file.content !== null),
    encryptedSecrets: null,
    note: "The environment file is encrypted when a backup encryption password is configured.",
  };
  if (envText && secrets.encryptionPassword) {
    config.encryptedSecrets = {
      path: "/etc/nkustudy-admin.env",
      payload: encryptText(envText, secrets.encryptionPassword),
    };
  } else if (envText) {
    config.encryptedSecrets = {
      path: "/etc/nkustudy-admin.env",
      missing: true,
      note: "Encryption password is not configured, so sensitive env content was not included.",
    };
  }
  return config;
}

async function putR2Json(key, data) {
  if (!r2Client || !r2Bucket) throw new Error("R2 upload is not configured on the server.");
  await r2Client.send(new PutObjectCommand({
    Bucket: r2Bucket,
    Key: objectKey(key),
    Body: JSON.stringify(data, null, 2),
    ContentType: "application/json; charset=utf-8",
  }));
}

function backupDateKey() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function webdavHeaders(dest, extra = {}) {
  const headers = { ...extra };
  const secrets = readBackupSecrets();
  const password = dest.password || secrets.webdav?.[dest.id]?.password || "";
  if (dest.username || password) {
    headers.authorization = `Basic ${Buffer.from(`${dest.username || ""}:${password}`).toString("base64")}`;
  }
  return headers;
}

function webdavUrl(dest, relativePath = "") {
  const base = String(dest.url || "").replace(/\/+$/, "") + "/";
  const encoded = normalizeKey(relativePath).split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return base + encoded;
}

async function webdavRequest(dest, method, relativePath, options = {}) {
  const response = await fetch(webdavUrl(dest, relativePath), {
    method,
    headers: webdavHeaders(dest, options.headers || {}),
    body: options.body,
    duplex: options.body ? "half" : undefined,
    signal: options.signal,
  });
  return response;
}

async function testWebdavDestination(dest) {
  if (!dest?.url) throw new Error("WebDAV URL is required.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    let response = await webdavRequest(dest, "PROPFIND", "", {
      headers: { depth: "0" },
      signal: controller.signal,
    });
    if (response.status === 405) {
      response = await webdavRequest(dest, "HEAD", "", { signal: controller.signal });
    }
    const ok = [200, 207, 301, 302].includes(response.status);
    return {
      ok,
      status: response.status,
      statusText: response.statusText,
      message: ok ? "WebDAV 连接正常。" : `WebDAV 返回 ${response.status} ${response.statusText || ""}`.trim(),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function ensureWebdavDirs(dest, relativePath) {
  const parts = normalizeKey(path.posix.dirname(relativePath)).split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const response = await webdavRequest(dest, "MKCOL", current);
    if (![200, 201, 204, 405, 409].includes(response.status)) {
      throw new Error(`WebDAV MKCOL failed for ${current}: ${response.status}`);
    }
  }
}

async function remoteWebdavStat(dest, relativePath) {
  const response = await webdavRequest(dest, "HEAD", relativePath);
  if (response.status === 404) return null;
  if (!response.ok) return null;
  return {
    size: Number(response.headers.get("content-length") || 0),
    modified: response.headers.get("last-modified") ? new Date(response.headers.get("last-modified")).getTime() : 0,
  };
}

function shouldUpload(remote, size, modified) {
  if (!remote) return true;
  if (Number(remote.size || 0) !== Number(size || 0)) return true;
  if (modified && remote.modified && modified > remote.modified + 1000) return true;
  return false;
}

async function uploadWebdavBuffer(dest, relativePath, buffer, modified = 0) {
  const remote = await remoteWebdavStat(dest, relativePath);
  if (!shouldUpload(remote, buffer.length, modified)) return "skipped";
  await ensureWebdavDirs(dest, relativePath);
  const response = await webdavRequest(dest, "PUT", relativePath, {
    headers: {
      "content-length": String(buffer.length),
      "content-type": "application/octet-stream",
    },
    body: buffer,
  });
  if (!response.ok) throw new Error(`WebDAV PUT failed for ${relativePath}: ${response.status}`);
  return "uploaded";
}

async function uploadWebdavR2Object(dest, object, relativePath) {
  const size = Number(object.Size || 0);
  const modified = object.LastModified ? new Date(object.LastModified).getTime() : 0;
  const remote = await remoteWebdavStat(dest, relativePath);
  if (!shouldUpload(remote, size, modified)) return "skipped";
  await ensureWebdavDirs(dest, relativePath);
  const result = await r2Client.send(new GetObjectCommand({ Bucket: r2Bucket, Key: object.Key }));
  const response = await webdavRequest(dest, "PUT", relativePath, {
    headers: {
      "content-length": String(size),
      "content-type": result.ContentType || "application/octet-stream",
    },
    body: result.Body,
  });
  if (!response.ok) throw new Error(`WebDAV PUT failed for ${relativePath}: ${response.status}`);
  return "uploaded";
}

async function runBackupJob({ manual = false } = {}) {
  if (backupRunning) return { ok: false, error: "Backup is already running." };
  backupRunning = true;
  try {
  const settings = readBackupSettings();
  const date = backupDateKey();
  const summary = {
    ok: true,
    manual,
    startedAt: nowIso(),
    r2: [],
    webdav: [],
    warnings: [],
  };
  const siteData = backupData("all");
  const configData = serverConfigBackup();

  if (settings.r2DataBackup) {
    await putR2Json(objectKey(settings.r2BackupPrefix, date, "site-data.json"), siteData);
    await putR2Json(objectKey(settings.r2BackupPrefix, date, "server-config.json"), configData);
    summary.r2.push("site-data", "server-config");
  }

  if (settings.webdavEnabled) {
    const destinations = (settings.destinations || []).filter((dest) => dest.enabled !== false && dest.url);
    const siteBuffer = Buffer.from(JSON.stringify(siteData, null, 2));
    const configBuffer = Buffer.from(JSON.stringify(configData, null, 2));
    const courseObjects = settings.includeCourseFiles && r2Client && r2Bucket
      ? (await listR2Objects(`${r2Prefix}/`)).filter((item) => item.Key && !isOpenListPlaceholder(item.Key))
      : [];

    for (const dest of destinations) {
      const record = { id: dest.id, name: dest.name, uploaded: 0, skipped: 0, errors: [] };
      try {
        if (settings.includeSiteData) {
          const status = await uploadWebdavBuffer(dest, `site-data/${date}/site-data.json`, siteBuffer);
          record[status] += 1;
        }
        if (settings.includeServerConfig) {
          const status = await uploadWebdavBuffer(dest, `server-config/${date}/server-config.json`, configBuffer);
          record[status] += 1;
        }
        for (const object of courseObjects) {
          const status = await uploadWebdavR2Object(dest, object, `course-files/${object.Key}`);
          record[status] += 1;
        }
      } catch (error) {
        record.errors.push(error.message);
      }
      summary.webdav.push(record);
    }
  }

  summary.finishedAt = nowIso();
  return summary;
  } finally {
    backupRunning = false;
  }
}

function currentShanghaiTime() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return {
    date: shifted.toISOString().slice(0, 10),
    time: shifted.toISOString().slice(11, 16),
  };
}

function startBackupScheduler() {
  setInterval(async () => {
    const settings = readBackupSettings();
    if (!settings.autoEnabled) return;
    const now = currentShanghaiTime();
    if (now.date === lastAutoBackupDate) return;
    if (now.time < settings.dailyTime) return;
    lastAutoBackupDate = now.date;
    try {
      await runBackupJob({ manual: false });
    } catch (error) {
      console.error(`Scheduled backup failed: ${error.message}`);
    }
  }, 60 * 1000);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON request body."));
      }
    });
    req.on("error", reject);
  });
}

function sign(value) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function makeToken() {
  const value = randomBytes(24).toString("hex");
  return `${value}.${sign(value)}`;
}

function validToken(token = "") {
  const [value, mac] = token.split(".");
  if (!value || !mac) return false;
  const expected = sign(value);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

function requireAuth(req, res) {
  if (validToken(cookie(req, "nkustudy_admin"))) return true;
  json(res, 401, { ok: false, error: "Unauthorized" });
  return false;
}

function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object") errors.push("manifest must be an object.");
  if (!manifest.resourceRoot) errors.push("resourceRoot is required.");
  if (!Array.isArray(manifest.courses)) errors.push("courses must be an array.");
  const ids = new Set();
  for (const [index, course] of (manifest.courses || []).entries()) {
    const label = course.title || `course #${index + 1}`;
    for (const key of ["id", "term", "group", "title", "updated", "basePath"]) {
      if (!course[key]) errors.push(`${label}: missing ${key}.`);
    }
    if (ids.has(course.id)) errors.push(`${label}: duplicate id ${course.id}.`);
    ids.add(course.id);
    if (!Array.isArray(course.sections)) errors.push(`${label}: sections must be an array.`);
    for (const section of course.sections || []) {
      if (!section.title) errors.push(`${label}: section missing title.`);
      if (!Array.isArray(section.files)) errors.push(`${label}/${section.title}: files must be an array.`);
      for (const file of section.files || []) {
        if (!file.title) errors.push(`${label}/${section.title}: file missing title.`);
        if (!file.path) errors.push(`${label}/${section.title}/${file.title || "file"}: file missing path.`);
      }
    }
  }
  return errors;
}

function normalizeKey(value) {
  return value
    .replaceAll("\\", "/")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
}

function objectKey(...parts) {
  return normalizeKey(parts.filter(Boolean).join("/"));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function localDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function courseSnapshot(course) {
  const copy = JSON.parse(JSON.stringify(course || {}));
  delete copy.updated;
  return JSON.stringify(copy);
}

function preserveUnchangedCourseDates(nextManifest) {
  if (!fs.existsSync(manifestPath)) return;
  let currentManifest;
  try {
    currentManifest = cleanManifestResources(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  } catch {
    return;
  }
  const currentById = new Map((currentManifest.courses || []).map((course) => [course.id, course]));
  const currentByBasePath = new Map((currentManifest.courses || []).map((course) => [normalizeKey(course.basePath || ""), course]));
  for (const course of nextManifest.courses || []) {
    const previous = currentById.get(course.id) || currentByBasePath.get(normalizeKey(course.basePath || ""));
    if (!previous) {
      course.updated = course.updated || today();
      continue;
    }
    course.updated = courseSnapshot(previous) === courseSnapshot(course) ? previous.updated : today();
  }
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(fallback, null, 2)}\n`, "utf8");
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function defaultVisitStats() {
  return {
    version: 1,
    updatedAt: nowIso(),
    total: 0,
    days: {},
    pages: {},
    visitors: {},
  };
}

function readVisitStats() {
  const stats = readJsonFile(visitStatsPath, defaultVisitStats());
  stats.total = Number(stats.total || 0);
  stats.days = stats.days && typeof stats.days === "object" ? stats.days : {};
  stats.pages = stats.pages && typeof stats.pages === "object" ? stats.pages : {};
  stats.visitors = stats.visitors && typeof stats.visitors === "object" ? stats.visitors : {};
  return stats;
}

function writeVisitStats(stats) {
  stats.updatedAt = nowIso();
  fs.writeFileSync(visitStatsPath, `${JSON.stringify(stats, null, 2)}\n`, "utf8");
}

function publicVisitStats() {
  const stats = readVisitStats();
  const today = localDay();
  return {
    total: stats.total,
    today: Number(stats.days[today] || 0),
    updatedAt: stats.updatedAt || "",
  };
}

function visitKey(req) {
  const ua = req.headers["user-agent"] || "";
  return createHmac("sha256", secret).update(`${clientIp(req)}|${ua}`).digest("hex").slice(0, 32);
}

function userAgentHash(req) {
  return createHmac("sha256", secret).update(String(req.headers["user-agent"] || "")).digest("hex").slice(0, 16);
}

function cleanVisitPath(value) {
  let pathname = "/";
  try {
    pathname = new URL(String(value || "/"), "https://nkustudy.top").pathname;
  } catch {
    pathname = "/";
  }
  if (pathname.startsWith("/admin") || pathname.startsWith("/admin-api") || pathname.startsWith("/visit-api")) return "";
  return cleanText(pathname, 300) || "/";
}

function recordVisit(req, pagePath) {
  const pathname = cleanVisitPath(pagePath);
  const summary = publicVisitStats();
  if (!pathname) return { counted: false, ...summary };

  const stats = readVisitStats();
  const key = visitKey(req);
  const ip = clientIp(req);
  const now = Date.now();
  const previous = stats.visitors[key]?.lastSeen || 0;
  const cutoff = now - 24 * 60 * 60 * 1000;
  for (const [visitorKey, visitor] of Object.entries(stats.visitors)) {
    if (Number(visitor?.lastSeen || 0) < cutoff) delete stats.visitors[visitorKey];
  }
  stats.visitors[key] = { ip, userAgentHash: userAgentHash(req), lastSeen: now };
  if (now - Number(previous || 0) < visitDedupMs) {
    writeVisitStats(stats);
    return { counted: false, ...publicVisitStats() };
  }

  const day = localDay();
  stats.total += 1;
  stats.days[day] = Number(stats.days[day] || 0) + 1;
  stats.pages[pathname] ??= { total: 0, days: {} };
  stats.pages[pathname].total = Number(stats.pages[pathname].total || 0) + 1;
  stats.pages[pathname].days[day] = Number(stats.pages[pathname].days[day] || 0) + 1;
  writeVisitStats(stats);
  return { counted: true, ...publicVisitStats() };
}

function readReviews() {
  const defaults = {
    version: 1,
    updated: today(),
    rules: {
      submissionOpen: true,
      moderationRequired: true,
      turnstileEnabled: false,
      hourlyLimit: 3,
      dailyLimit: 10,
      minLength: 12,
      announcement: "评价内容会先进入待审核。请尽量描述授课风格、作业考试情况与适合人群，避免人身攻击或泄露隐私。",
      notes: "",
    },
    reviews: [],
  };
  const data = readJsonFile(reviewsPath, defaults);
  data.rules = { ...defaults.rules, ...(data.rules || {}) };
  data.reviews = Array.isArray(data.reviews) ? data.reviews : [];
  return data;
}

function readFeedback() {
  const defaults = {
    version: 1,
    updated: today(),
    title: "问题与建议",
    announcement: "",
    rules: {
      submissionOpen: true,
      hourlyLimit: 3,
      dailyLimit: 15,
      minLength: 5,
      notes: "默认反馈公开显示，管理员可以隐藏、搁置或标记完成。",
    },
    items: [],
  };
  const data = readJsonFile(feedbackPath, defaults);
  data.title = cleanText(data.title, 120) || defaults.title;
  data.announcement = cleanText(data.announcement, 4000);
  data.rules = { ...defaults.rules, ...(data.rules || {}) };
  data.items = Array.isArray(data.items) ? data.items : [];
  return data;
}

function writeFeedback(data) {
  const defaults = readFeedback().rules;
  const next = {
    version: Number(data.version || 1),
    updated: today(),
    title: cleanText(data.title, 120) || "问题与建议",
    announcement: cleanText(data.announcement, 4000),
    rules: {
      submissionOpen: data.rules?.submissionOpen !== false,
      hourlyLimit: Math.max(1, Number(data.rules?.hourlyLimit || defaults.hourlyLimit || 3)),
      dailyLimit: Math.max(1, Number(data.rules?.dailyLimit || defaults.dailyLimit || 15)),
      minLength: Math.max(1, Number(data.rules?.minLength || defaults.minLength || 5)),
      notes: cleanText(data.rules?.notes ?? defaults.notes, 2000),
    },
    items: Array.isArray(data.items) ? data.items : [],
  };
  fs.writeFileSync(feedbackPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function readAbout() {
  const defaults = {
    title: "NKUStudy",
    content: "NKUStudy 是一个面向课程资料整理、课程导航和老师评价的轻量站点。\n\n资源索引在构建时读取，下载由 R2 分发，OpenList 作为补充网盘入口。",
  };
  const data = readJsonFile(aboutPath, defaults);
  return {
    title: cleanText(data.title, 120) || defaults.title,
    content: cleanText(data.content, 6000) || defaults.content,
  };
}

function writeAbout(data) {
  const content = cleanText(data.content, 6000);
  const next = {
    title: cleanText(data.title, 120) || "NKUStudy",
    content,
  };
  fs.writeFileSync(aboutPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function readParticipate() {
  return readJsonFile(participatePath, {
    title: "参与贡献",
    content: "## 如何参与\n\n如果你希望补充课程资料，可以通过反馈页说明课程、资料类型和联系方式。\n\n- 文件名尽量包含年份、用途或版本\n- 不上传含个人隐私、账号信息或明显侵权的内容\n- 管理员整理后会同步到课程资源树",
  });
}

function writeParticipate(data) {
  const next = {
    title: cleanText(data.title, 120) || "参与贡献",
    content: cleanText(data.content, 8000),
  };
  fs.writeFileSync(participatePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function normalizeLinks(data) {
  const defaults = {
    title: "友情链接",
    intro: "以下是与本站建立友情链接或推荐访问的伙伴站点。",
    mutualTitle: "友情链接",
    recommendedTitle: "推荐链接",
    siteInfoTitle: "本站信息",
    siteInfo: {
      name: "NKUStudy",
      url: "https://nkustudy.top/",
      description: "面向南开课程资料整理、课程导航与教师评价的轻量级站点。",
    },
    links: [],
  };
  const siteInfo = data.siteInfo || {};
  return {
    title: cleanText(data.title, 120) || defaults.title,
    intro: cleanText(data.intro, 1000) || defaults.intro,
    mutualTitle: cleanText(data.mutualTitle, 120) || defaults.mutualTitle,
    recommendedTitle: cleanText(data.recommendedTitle, 120) || defaults.recommendedTitle,
    siteInfoTitle: cleanText(data.siteInfoTitle, 120) || defaults.siteInfoTitle,
    siteInfo: {
      name: cleanText(siteInfo.name, 120) || defaults.siteInfo.name,
      url: cleanText(siteInfo.url, 500) || defaults.siteInfo.url,
      description: cleanText(siteInfo.description, 1000) || defaults.siteInfo.description,
    },
    links: (Array.isArray(data.links) ? data.links : []).map((item) => ({
      id: cleanText(item.id, 120) || `link-${randomBytes(4).toString("hex")}`,
      type: item.type === "recommended" ? "recommended" : "mutual",
      name: cleanText(item.name, 120),
      url: cleanText(item.url, 500),
      description: cleanText(item.description, 1000),
      hidden: item.hidden === true,
    })).filter((item) => item.name && item.url),
  };
}

function readLinks() {
  return normalizeLinks(readJsonFile(linksPath, {}));
}

function writeLinks(data) {
  const next = normalizeLinks(data || {});
  fs.writeFileSync(linksPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function readHome() {
  return readJsonFile(homePath, {
    announcement: "南开课程资料导航，整合课程信息、复习资料、往年试题与网盘入口。",
  });
}

function writeHome(data) {
  const next = {
    announcement: cleanText(data.announcement, 2000) || "南开课程资料导航，整合课程信息、复习资料、往年试题与网盘入口。",
  };
  fs.writeFileSync(homePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function defaultFooter() {
  return {
    enabled: false,
    showVisitCount: true,
    useRealVisitCount: true,
    visitCount: "10411114",
    startedAt: "2022-01-01T00:00:00+08:00",
    copyrightText: "© 2025 NKUStudy",
    copyrightYear: "2025",
    maintainers: [
      { label: "@Shview", url: "https://github.com/shview" },
      { label: "@K.", url: "" },
    ],
  };
}

function normalizeFooter(data) {
  const defaults = defaultFooter();
  const startedAt = cleanText(data.startedAt, 80)
    .replace(" ", "T")
    .replace(/T0(\d{2}:\d{2}(?::\d{2})?)/, "T$1");
  return {
    enabled: data.enabled === true,
    showVisitCount: data.showVisitCount !== false,
    useRealVisitCount: data.useRealVisitCount !== false,
    visitCount: cleanText(data.visitCount, 40) || defaults.visitCount,
    startedAt: Number.isNaN(new Date(startedAt).getTime()) ? defaults.startedAt : startedAt,
    copyrightText: cleanText(data.copyrightText, 500) || (data.copyrightYear ? `© ${cleanText(data.copyrightYear, 20)} NKUStudy` : defaults.copyrightText),
    copyrightYear: cleanText(data.copyrightYear, 20) || defaults.copyrightYear,
    maintainers: (Array.isArray(data.maintainers) ? data.maintainers : defaults.maintainers)
      .map((item) => ({
        label: cleanText(item.label, 80),
        url: /^(null|undefined)$/i.test(cleanText(item.url, 500)) ? "" : cleanText(item.url, 500),
      }))
      .filter((item) => item.label),
  };
}

function readFooter() {
  return normalizeFooter(readJsonFile(footerPath, defaultFooter()));
}

function writeFooter(data) {
  const next = normalizeFooter(data || {});
  fs.writeFileSync(footerPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function writeReviews(data) {
  data.updated = today();
  fs.writeFileSync(reviewsPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function ipHash(ip) {
  return createHmac("sha256", secret).update(ip).digest("hex").slice(0, 24);
}

function checkRate(rateStore, ip, rules, defaults) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  const key = ipHash(ip);
  const entries = (rateStore.get(key) || []).filter((time) => now - time < day);
  const hourly = entries.filter((time) => now - time < hour).length;
  if (hourly >= Number(rules.hourlyLimit || defaults.hourlyLimit)) return false;
  if (entries.length >= Number(rules.dailyLimit || defaults.dailyLimit)) return false;
  entries.push(now);
  rateStore.set(key, entries);
  return true;
}

function checkReviewRate(ip, rules) {
  return checkRate(reviewRate, ip, rules, { hourlyLimit: 3, dailyLimit: 10 });
}

function checkFeedbackRate(ip, rules) {
  return checkRate(feedbackRate, ip, rules, { hourlyLimit: 3, dailyLimit: 15 });
}

function loginLockedMs(ip) {
  const state = loginFailures.get(ipHash(ip));
  if (!state?.lockedUntil) return 0;
  const remaining = state.lockedUntil - Date.now();
  if (remaining <= 0) {
    loginFailures.delete(ipHash(ip));
    return 0;
  }
  return remaining;
}

function recordLoginFailure(ip) {
  const key = ipHash(ip);
  const state = loginFailures.get(key) || { count: 0, lockedUntil: 0 };
  state.count += 1;
  if (state.count >= loginLockThreshold) {
    state.count = 0;
    state.lockedUntil = Date.now() + loginLockMs;
  }
  loginFailures.set(key, state);
  return loginLockedMs(ip);
}

function clearLoginFailures(ip) {
  loginFailures.delete(ipHash(ip));
}

function cleanText(value, max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

function publicReview(review) {
  const { ipHash: _ipHash, userAgent: _userAgent, ...safe } = review;
  return safe;
}

function publicFeedback(item) {
  const { ipHash: _ipHash, userAgent: _userAgent, contact: _contact, ...safe } = item;
  return safe;
}

function visibleFeedback() {
  const data = readFeedback();
  return {
    title: data.title,
    announcement: data.announcement,
    rules: {
      submissionOpen: data.rules?.submissionOpen !== false,
      minLength: Number(data.rules?.minLength || 5),
    },
    items: data.items
    .filter((item) => item.status !== "hidden" && !item.hidden)
    .map(publicFeedback),
  };
}

function updateFeedbackStore(next) {
  const data = readFeedback();
  if ("title" in next) data.title = next.title;
  if ("announcement" in next) data.announcement = next.announcement;
  if (Array.isArray(next.items)) data.items = next.items;
  if (next.rules) data.rules = next.rules;
  writeFeedback(data);
  return data;
}

function isOpenListPlaceholder(filePath) {
  return path.posix.basename(normalizeKey(filePath)).toLowerCase() === ".openlist";
}

function cleanManifestResources(manifest) {
  for (const course of manifest.courses || []) {
    for (const section of course.sections || []) {
      section.files = (section.files || []).filter((file) => !isOpenListPlaceholder(file.path || file.title || ""));
    }
    delete course.teachers;
  }
  return manifest;
}

function approvedReviews() {
  const data = readReviews();
  return data.reviews
    .filter((review) => ["approved", "通过"].includes(String(review.status || "").trim()) && !review.hidden)
    .map(publicReview);
}

async function handleFeedbackSubmit(req, res) {
  const data = readFeedback();
  const rules = data.rules || {};
  if (!rules.submissionOpen) {
    json(res, 403, { ok: false, error: "反馈提交暂未开放。" });
    return;
  }

  const body = await readBody(req);
  if (body.website) {
    json(res, 200, { ok: true });
    return;
  }

  const title = cleanText(body.title, 120);
  const content = cleanText(body.content, 2000);
  const type = cleanText(body.type, 40) || "bug";
  const contact = cleanText(body.contact, 120);
  if (!title || content.length < Number(rules.minLength || 5)) {
    json(res, 400, { ok: false, error: "请填写标题，并补充更完整的反馈内容。" });
    return;
  }

  const ip = clientIp(req);
  if (!checkFeedbackRate(ip, rules)) {
    json(res, 429, { ok: false, error: "提交太频繁，请稍后再试。" });
    return;
  }

  data.items.unshift({
    id: `feedback-${Date.now()}-${randomBytes(4).toString("hex")}`,
    title,
    content,
    type,
    contact,
    status: "open",
    hidden: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ipHash: ipHash(ip),
    userAgent: cleanText(req.headers["user-agent"], 240),
  });
  writeFeedback(data);
  json(res, 200, { ok: true });
}

async function handleReviewSubmit(req, res) {
  const data = readReviews();
  const rules = data.rules || {};
  if (!rules.submissionOpen) {
    json(res, 403, { ok: false, error: "评价提交暂未开放。" });
    return;
  }

  const body = await readBody(req);
  if (body.website) {
    json(res, 200, { ok: true, pending: true });
    return;
  }

  const courseTitle = cleanText(body.courseTitle, 120);
  const teacher = cleanText(body.teacher, 80);
  const content = cleanText(body.content, 2000);
  const rating = Math.max(1, Math.min(5, Number(body.rating || 0)));

  if (!courseTitle || !teacher || !rating || content.length < Number(rules.minLength || 12)) {
    json(res, 400, { ok: false, error: "请填写课程、老师、评分，并补充更完整的评价内容。" });
    return;
  }

  const ip = clientIp(req);
  if (!checkReviewRate(ip, rules)) {
    json(res, 429, { ok: false, error: "提交太频繁，请稍后再试。" });
    return;
  }

  const review = {
    id: `review-${Date.now()}-${randomBytes(4).toString("hex")}`,
    courseTitle,
    teacher,
    rating,
    content,
    status: rules.moderationRequired ? "pending" : "approved",
    hidden: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ipHash: ipHash(ip),
    userAgent: cleanText(req.headers["user-agent"], 240),
  };
  data.reviews.unshift(review);
  writeReviews(data);
  json(res, 200, { ok: true, pending: review.status === "pending" });
}

function updateReviewStore(next) {
  const data = readReviews();
  if (next.rules) data.rules = { ...(data.rules || {}), ...next.rules };
  if (Array.isArray(next.reviews)) data.reviews = next.reviews;
  writeReviews(data);
  return data;
}

function uploadFileToR2({ course, section, filename, stream, mimeType }) {
  if (!r2Client || !r2Bucket) {
    return Promise.reject(new Error("R2 upload is not configured on the server."));
  }

  const relativeName = normalizeKey(filename);
  const manifestPath = section.title === "其他" ? relativeName : normalizeKey(`${section.title}/${relativeName}`);
  const key = objectKey(r2Prefix, course.basePath, manifestPath);
  const counter = new PassThrough();
  let size = 0;

  stream.on("data", (chunk) => {
    size += chunk.length;
  });
  stream.pipe(counter);

  const upload = r2Client.send(new PutObjectCommand({
    Bucket: r2Bucket,
    Key: key,
    Body: counter,
    ContentType: mimeType || "application/octet-stream",
    ContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(relativeName))}`,
  }));

  return upload.then(() => ({
    title: path.posix.basename(relativeName),
    path: manifestPath,
    size,
    description: "",
  }));
}

async function listR2Objects(prefix) {
  const objects = [];
  let ContinuationToken;
  do {
    const result = await r2Client.send(new ListObjectsV2Command({
      Bucket: r2Bucket,
      Prefix: prefix,
      ContinuationToken,
    }));
    objects.push(...(result.Contents ?? []).filter((item) => item.Key && !item.Key.endsWith("/")));
    ContinuationToken = result.NextContinuationToken;
  } while (ContinuationToken);
  return objects;
}

async function syncCourseFromR2(courseId) {
  if (!r2Client || !r2Bucket) {
    throw new Error("R2 upload is not configured on the server.");
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const course = manifest.courses.find((item) => item.id === courseId);
  if (!course) throw new Error("Course was not found.");

  const basePrefix = objectKey(r2Prefix, course.basePath);
  const objects = await listR2Objects(`${basePrefix}/`);
  const existingSections = new Map((course.sections ?? []).map((section) => [section.title, section]));
  const sections = new Map();

  for (const object of objects) {
    const relativePath = normalizeKey(object.Key.slice(basePrefix.length + 1));
    if (!relativePath) continue;
    if (isOpenListPlaceholder(relativePath)) continue;
    const parts = relativePath.split("/");
    const sectionTitle = parts.length > 1 ? parts[0] : "其他";
    const filePath = relativePath;
    const section = sections.get(sectionTitle) || {
      title: sectionTitle,
      note: existingSections.get(sectionTitle)?.note || "",
      collapsed: existingSections.get(sectionTitle)?.collapsed,
      files: [],
    };
    section.files.push({
      title: path.posix.basename(relativePath),
      path: filePath,
      size: object.Size ?? 0,
      description: "",
    });
    sections.set(sectionTitle, section);
  }

  const orderRank = (title = "") => {
    const lower = title.toLowerCase();
    if (title.includes("大纲") || title.includes("说明")) return 0;
    if (title.includes("真题") || title.includes("试题") || title.includes("试卷")) return 1;
    if (lower.includes("ppt") || title.includes("课件")) return 2;
    return 3;
  };

  course.sections = Array.from(sections.values()).sort((a, b) => {
    const rank = orderRank(a.title) - orderRank(b.title);
    return rank || a.title.localeCompare(b.title, "zh-CN");
  });
  course.updated = today();

  const result = await publish(manifest);
  if (!result.ok) {
    throw new Error(result.errors?.join("\n") || "Publish failed.");
  }

  return { manifest, course };
}

function sectionOrderRank(title = "") {
  const lower = title.toLowerCase();
  if (title.includes("大纲") || title.includes("说明")) return 0;
  if (title.includes("真题") || title.includes("试题") || title.includes("试卷")) return 1;
  if (lower.includes("ppt") || title.includes("课件")) return 2;
  return 3;
}

function courseIdFromTitle(title) {
  return cleanText(title, 120) || `course-${Date.now()}`;
}

function uniqueCourseId(title, term, group, basePath, usedIds) {
  const candidates = [
    courseIdFromTitle(title),
    courseIdFromTitle(`${title}-${term}-${group}`),
    courseIdFromTitle(`${title}-${basePath.replaceAll("/", "-")}`),
  ];
  for (const candidate of candidates) {
    if (candidate && !usedIds.has(candidate)) {
      usedIds.add(candidate);
      return candidate;
    }
  }
  const fallback = `${courseIdFromTitle(title)}-${createHmac("sha1", secret).update(basePath).digest("hex").slice(0, 8)}`;
  usedIds.add(fallback);
  return fallback;
}

function coursePartsFromR2Path(parts) {
  const noFixedTermRoots = new Set(["E课"]);
  const noFixedTermGroups = new Set(["通识选修课", "公选课", "任选课"]);
  if (parts.length >= 4 && noFixedTermRoots.has(parts[0])) {
    return {
      term: parts[0],
      group: parts[1],
      title: parts[2],
      rest: parts.slice(3),
      basePath: normalizeKey(`${parts[0]}/${parts[1]}/${parts[2]}/`),
    };
  }
  if (parts.length >= 3 && noFixedTermGroups.has(parts[0])) {
    return {
      term: "无固定年级",
      group: parts[0],
      title: parts[1],
      rest: parts.slice(2),
      basePath: normalizeKey(`${parts[0]}/${parts[1]}/`),
    };
  }
  if (parts.length >= 4) {
    return {
      term: parts[0],
      group: parts[1],
      title: parts[2],
      rest: parts.slice(3),
      basePath: normalizeKey(`${parts[0]}/${parts[1]}/${parts[2]}/`),
    };
  }
  return null;
}

async function syncAllCoursesFromR2() {
  if (!r2Client || !r2Bucket) {
    throw new Error("R2 upload is not configured on the server.");
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const objects = await listR2Objects(`${r2Prefix}/`);
  const courseMap = new Map();
  const existingByBasePath = new Map(manifest.courses.map((course) => [normalizeKey(course.basePath), course]));
  const usedIds = new Set();

  for (const object of objects) {
    if (!object.Key || object.Key.endsWith("/")) continue;
    const relative = normalizeKey(object.Key.slice(r2Prefix.length + 1));
    const parts = relative.split("/");
    const parsed = coursePartsFromR2Path(parts);
    if (!parsed) continue;
    const { term, group, title, rest } = parsed;
    const basePath = parsed.basePath;
    const isPlaceholder = isOpenListPlaceholder(relative);
    const key = basePath;
    if (!courseMap.has(key)) {
      const existing = existingByBasePath.get(basePath);
      let course = existing ? structuredClone(existing) : null;
      if (course?.id) {
        if (usedIds.has(course.id)) {
          course.id = uniqueCourseId(title, term, group, basePath, usedIds);
        } else {
          usedIds.add(course.id);
        }
      }
      courseMap.set(key, {
        course: course || {
          id: uniqueCourseId(title, term, group, basePath, usedIds),
          term,
          group,
          title,
          summary: "待补充课程简介。",
          contributors: [],
          assessment: "绩点制",
          updated: today(),
          grades: [],
          tags: group === "通识选修课" ? ["通识选修课"] : [],
          basePath: `${basePath}/`,
          sections: [],
        },
        sections: new Map(),
      });
    }
    const entry = courseMap.get(key);
    entry.course.term = term;
    entry.course.group = group;
    entry.course.title = title;
    entry.course.assessment ||= "绩点制";
    entry.course.tags = (entry.course.tags || []).filter((tag) => tag !== "无固定年级");
    if (isPlaceholder) continue;
    const sectionTitle = rest.length > 1 ? rest[0] : "其他";
    const filePath = rest.join("/");
    if (!filePath) continue;
    const section = entry.sections.get(sectionTitle) || {
      title: sectionTitle,
      note: entry.course.sections?.find((item) => item.title === sectionTitle)?.note || "",
      files: [],
    };
    section.files.push({
      title: path.posix.basename(filePath),
      path: filePath,
      size: object.Size ?? 0,
      description: "",
    });
    entry.sections.set(sectionTitle, section);
  }

  const rebuiltCourses = [];
  for (const [basePath, entry] of courseMap) {
    entry.course.sections = Array.from(entry.sections.values()).sort((a, b) => {
      const rank = sectionOrderRank(a.title) - sectionOrderRank(b.title);
      return rank || a.title.localeCompare(b.title, "zh-CN");
    });
    entry.course.updated = today();
    entry.course.basePath = `${basePath}/`;
    rebuiltCourses.push(entry.course);
  }
  manifest.courses = rebuiltCourses;

  const result = await publish(manifest);
  if (!result.ok) throw new Error(result.errors?.join("\n") || "Publish failed.");
  return manifest;
}

function saveManifestDraft(manifest) {
  cleanManifestResources(manifest);
  const errors = validateManifest(manifest);
  if (errors.length) return { ok: false, errors };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { ok: true };
}

async function deleteR2Files(courseId, paths) {
  if (!r2Client || !r2Bucket) {
    throw new Error("R2 upload is not configured on the server.");
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const course = manifest.courses.find((item) => item.id === courseId);
  if (!course) throw new Error("Course was not found.");

  const objects = paths
    .map((filePath) => objectKey(r2Prefix, course.basePath, filePath))
    .filter(Boolean)
    .map((Key) => ({ Key }));

  if (!objects.length) return;

  for (let index = 0; index < objects.length; index += 1000) {
    await r2Client.send(new DeleteObjectsCommand({
      Bucket: r2Bucket,
      Delete: {
        Objects: objects.slice(index, index + 1000),
        Quiet: true,
      },
    }));
  }
}

async function deleteR2Prefix(prefix) {
  if (!r2Client || !r2Bucket) {
    throw new Error("R2 upload is not configured on the server.");
  }

  const normalized = `${normalizeKey(prefix)}/`;
  const objects = (await listR2Objects(normalized)).map((object) => ({ Key: object.Key }));
  if (!objects.length) return 0;

  for (let index = 0; index < objects.length; index += 1000) {
    await r2Client.send(new DeleteObjectsCommand({
      Bucket: r2Bucket,
      Delete: {
        Objects: objects.slice(index, index + 1000),
        Quiet: true,
      },
    }));
  }

  return objects.length;
}

async function deleteR2Course(courseId) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const course = manifest.courses.find((item) => item.id === courseId);
  if (!course) throw new Error("Course was not found.");
  return deleteR2Prefix(objectKey(r2Prefix, course.basePath));
}

async function moveR2Prefix(oldBasePath, newBasePath) {
  if (!r2Client || !r2Bucket) {
    throw new Error("R2 upload is not configured on the server.");
  }

  const oldPrefix = `${objectKey(r2Prefix, oldBasePath)}/`;
  const newPrefix = `${objectKey(r2Prefix, newBasePath)}/`;
  if (oldPrefix === newPrefix) return { copied: 0, deleted: 0 };

  const objects = await listR2Objects(oldPrefix);
  for (const object of objects) {
    const targetKey = `${newPrefix}${object.Key.slice(oldPrefix.length)}`;
    await r2Client.send(new CopyObjectCommand({
      Bucket: r2Bucket,
      CopySource: `${r2Bucket}/${encodeURIComponent(object.Key).replaceAll("%2F", "/")}`,
      Key: targetKey,
    }));
  }

  const deleted = objects.length ? await deleteR2Prefix(oldBasePath) : 0;
  return { copied: objects.length, deleted };
}

function handleUpload(req, res, url) {
  if (!r2Client || !r2Bucket) {
    json(res, 400, { ok: false, error: "R2 upload is not configured on the server." });
    req.resume();
    return;
  }

  const courseId = url.searchParams.get("courseId");
  const sectionIndex = Number(url.searchParams.get("sectionIndex"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const course = manifest.courses.find((item) => item.id === courseId);
  const section = course?.sections?.[sectionIndex];

  if (!course || !section) {
    json(res, 400, { ok: false, error: "Course or section was not found." });
    req.resume();
    return;
  }

  const busboy = Busboy({ headers: req.headers });
  const uploads = [];

  busboy.on("file", (_name, file, info) => {
    const filename = info.filename || "unnamed-file";
    uploads.push(uploadFileToR2({
      course,
      section,
      filename,
      stream: file,
      mimeType: info.mimeType,
    }));
  });

  busboy.on("error", (error) => {
    json(res, 500, { ok: false, error: error.message });
  });

  busboy.on("finish", async () => {
    try {
      const files = await Promise.all(uploads);
      json(res, 200, { ok: true, files });
    } catch (error) {
      json(res, 500, { ok: false, error: error.message });
    }
  });

  req.pipe(busboy);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      shell: process.platform === "win32",
      env: { ...process.env, CI: "true" },
    });
    let output = "";
    child.stdout.on("data", (data) => { output += data.toString(); });
    child.stderr.on("data", (data) => { output += data.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(output || `${command} exited with code ${code}`));
    });
  });
}

async function publish(manifest) {
  cleanManifestResources(manifest);
  preserveUnchangedCourseDates(manifest);
  const errors = validateManifest(manifest);
  if (errors.length) return { ok: false, errors };

  const backup = `${manifestPath}.bak.${Date.now()}`;
  fs.copyFileSync(manifestPath, backup);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  try {
    await run("npm", ["run", "check:content"]);
    await run("npm", ["run", "build"]);
    fs.rmSync(publicDir, { recursive: true, force: true });
    fs.mkdirSync(publicDir, { recursive: true });
    fs.cpSync(distDir, publicDir, { recursive: true });
    return { ok: true };
  } catch (error) {
    fs.copyFileSync(backup, manifestPath);
    return { ok: false, errors: [error.message] };
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname.startsWith("/review-api/")) {
      if (req.method === "GET" && url.pathname === "/review-api/reviews") {
        json(res, 200, { ok: true, reviews: approvedReviews(), rules: readReviews().rules });
        return;
      }
      if (req.method === "POST" && url.pathname === "/review-api/submit") {
        await handleReviewSubmit(req, res);
        return;
      }
      json(res, 404, { ok: false, error: "Not found" });
      return;
    }

    if (url.pathname.startsWith("/feedback-api/")) {
      if (req.method === "GET" && url.pathname === "/feedback-api/feedback") {
        json(res, 200, { ok: true, ...visibleFeedback() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/feedback-api/submit") {
        await handleFeedbackSubmit(req, res);
        return;
      }
      json(res, 404, { ok: false, error: "Not found" });
      return;
    }

    if (url.pathname.startsWith("/visit-api/")) {
      if (req.method === "GET" && url.pathname === "/visit-api/stats") {
        json(res, 200, { ok: true, stats: publicVisitStats() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/visit-api/hit") {
        const body = await readBody(req);
        json(res, 200, { ok: true, stats: recordVisit(req, body.path || req.headers.referer || "/") });
        return;
      }
      json(res, 404, { ok: false, error: "Not found" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/editor-settings") {
      json(res, 200, { ok: true, data: publicEditorSettings() });
      return;
    }

    if (!url.pathname.startsWith("/admin-api/")) {
      json(res, 404, { ok: false, error: "Not found" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/login") {
      const body = await readBody(req);
      const ip = clientIp(req);
      const remaining = loginLockedMs(ip);
      if (remaining > 0) {
        json(res, 429, { ok: false, error: `密码错误次数过多，请 ${Math.ceil(remaining / 1000)} 秒后再试。` });
        return;
      }
      if (body.password !== password) {
        const locked = recordLoginFailure(ip);
        json(res, locked > 0 ? 429 : 403, { ok: false, error: locked > 0 ? "密码错误次数过多，请 5 分钟后再试。" : "Password is incorrect." });
        return;
      }
      clearLoginFailures(ip);
      const token = makeToken();
      res.setHeader("set-cookie", `nkustudy_admin=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/logout") {
      res.setHeader("set-cookie", "nkustudy_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");
      json(res, 200, { ok: true });
      return;
    }

    if (!requireAuth(req, res)) return;

    if (req.method === "POST" && url.pathname === "/admin-api/upload") {
      handleUpload(req, res, url);
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/sync-r2") {
      const body = await readBody(req);
      const result = await syncCourseFromR2(body.courseId);
      json(res, 200, { ok: true, manifest: result.manifest, course: result.course });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/sync-r2-all") {
      const manifest = await syncAllCoursesFromR2();
      json(res, 200, { ok: true, manifest });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/delete-r2") {
      const body = await readBody(req);
      await deleteR2Files(body.courseId, body.paths || []);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/delete-r2-course") {
      const body = await readBody(req);
      let deleted = 0;
      const basePaths = Array.isArray(body.basePaths) ? body.basePaths.filter(Boolean) : [];
      if (basePaths.length) {
        for (const basePath of basePaths) deleted += await deleteR2Prefix(objectKey(r2Prefix, basePath));
      } else {
        deleted = await deleteR2Course(body.courseId);
      }
      json(res, 200, { ok: true, deleted });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/move-r2-prefix") {
      const body = await readBody(req);
      const result = await moveR2Prefix(body.oldBasePath, body.newBasePath);
      json(res, 200, { ok: true, ...result });
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/backup") {
      const scope = cleanText(url.searchParams.get("scope") || "all", 40);
      const data = backupData(scope);
      if (!data) {
        json(res, 400, { ok: false, error: "Unknown backup scope." });
        return;
      }
      jsonDownload(res, `nkustudy-${scope}-backup-${data.createdAt.slice(0, 10)}.json`, data);
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/backup-settings") {
      json(res, 200, { ok: true, data: publicBackupSettings() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/backup-settings") {
      const body = await readBody(req);
      json(res, 200, { ok: true, data: writeBackupSettings(body.data || {}) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/editor-settings") {
      json(res, 200, { ok: true, data: publicEditorSettings() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/editor-settings") {
      const body = await readBody(req);
      json(res, 200, { ok: true, data: writeEditorSettings(body.data || {}) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/backup-run") {
      const result = await runBackupJob({ manual: true });
      json(res, result.ok === false ? 409 : 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/backup-test-webdav") {
      const body = await readBody(req);
      const result = await testWebdavDestination(body.destination || {});
      json(res, result.ok ? 200 : 400, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/visit-stats") {
      json(res, 200, { ok: true, stats: readVisitStats(), summary: publicVisitStats() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/home") {
      json(res, 200, { ok: true, data: readHome() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/home") {
      const body = await readBody(req);
      writeHome(body.data || {});
      const manifest = cleanManifestResources(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
      const result = await publish(manifest);
      json(res, result.ok ? 200 : 400, result.ok ? { ok: true, data: readHome() } : result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/footer") {
      json(res, 200, { ok: true, data: readFooter() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/footer") {
      const body = await readBody(req);
      writeFooter(body.data || {});
      const manifest = cleanManifestResources(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
      const result = await publish(manifest);
      json(res, result.ok ? 200 : 400, result.ok ? { ok: true, data: readFooter() } : result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/about") {
      json(res, 200, { ok: true, data: readAbout() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/about") {
      const body = await readBody(req);
      writeAbout(body.data || {});
      const manifest = cleanManifestResources(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
      const result = await publish(manifest);
      json(res, result.ok ? 200 : 400, result.ok ? { ok: true, data: readAbout() } : result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/participate") {
      json(res, 200, { ok: true, data: readParticipate() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/participate") {
      const body = await readBody(req);
      writeParticipate(body.data || {});
      const manifest = cleanManifestResources(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
      const result = await publish(manifest);
      json(res, result.ok ? 200 : 400, result.ok ? { ok: true, data: readParticipate() } : result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/links") {
      json(res, 200, { ok: true, data: readLinks() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/links") {
      const body = await readBody(req);
      writeLinks(body.data || {});
      const manifest = cleanManifestResources(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
      const result = await publish(manifest);
      json(res, result.ok ? 200 : 400, result.ok ? { ok: true, data: readLinks() } : result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/feedback") {
      json(res, 200, { ok: true, data: readFeedback() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/feedback") {
      const body = await readBody(req);
      const data = updateFeedbackStore(body.data || {});
      const manifest = cleanManifestResources(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
      const result = await publish(manifest);
      json(res, result.ok ? 200 : 400, result.ok ? { ok: true, data } : result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/reviews") {
      json(res, 200, { ok: true, data: readReviews() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/reviews") {
      const body = await readBody(req);
      json(res, 200, { ok: true, data: updateReviewStore(body.data || {}) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/session") {
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/manifest") {
      json(res, 200, { ok: true, manifest: cleanManifestResources(JSON.parse(fs.readFileSync(manifestPath, "utf8"))) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/manifest") {
      const body = await readBody(req);
      const result = await publish(body.manifest);
      json(res, result.ok ? 200 : 400, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/manifest-draft") {
      const body = await readBody(req);
      const result = saveManifestDraft(body.manifest);
      json(res, result.ok ? 200 : 400, result);
      return;
    }

    json(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    json(res, 500, { ok: false, error: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`NKUStudy admin API listening on http://${host}:${port}`);
  startBackupScheduler();
});
