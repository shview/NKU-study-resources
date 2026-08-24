import { createCipheriv, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import Busboy from "busboy";
import { CopyObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { AtomicJsonStore } from "./atomic-json-store.mjs";
import { syncCourseResponse } from "./admin-response.mjs";
import { AdminAccountsStore, ADMIN_PERMISSION_POINTS, ADMIN_ROLE_PRESETS, hasAdminPermission } from "./admin-accounts-store.mjs";
import { AdminSessionStore } from "./admin-session-store.mjs";
import { clientIp, hashActor, trustedProxyRules } from "./client-identity.mjs";
import { ContentPublishJournal, ContentPublishService } from "./content-publish-service.mjs";
import { manifestRevision, ManifestConflictError, ManifestService } from "./manifest-service.mjs";
import { validateManifest } from "./manifest-schema.mjs";
import { PersistentRateLimiter } from "./persistent-rate-limiter.mjs";
import { createPublicApiHandler, decodePathPart } from "./public-api-router.mjs";
import { PublicApiError } from "./public-api-errors.mjs";
import { PublicApiService } from "./public-api-service.mjs";
import { MpAuthService } from "./mp-auth-service.mjs";
import { ServiceAuthStore } from "./service-auth-store.mjs";
import { MpFavoritesService } from "./mp-favorites-service.mjs";
import { CourseCatalogService } from "./course-catalog-service.mjs";
import { FeishuNotifyService } from "./feishu-notify-service.mjs";
import { readJsonBody } from "./read-json-body.mjs";
import { mergeCourseR2Discovery, mergeR2Discoveries } from "./r2-sync-merge.mjs";
import { assertR2CleanupSafety, planR2ManifestMutation, planR2ObjectCopies, strictR2BasePath, strictR2Path } from "./r2-mutation-plan.mjs";
import { publishAfterR2Prepare, R2MutationQueue, runExclusiveR2Mutation, runSerializedR2Mutation } from "./r2-transaction.mjs";
import { ReviewSubmissionService } from "./review-submission-service.mjs";
import { preflightProductionRuntime, projectRoot, runtimeDataPathMap } from "./runtime-config.mjs";
import { StaticReleasePublisher } from "./static-release-publisher.mjs";

const root = projectRoot;
const runtime = preflightProductionRuntime();
trustedProxyRules(process.env);
const dataDir = runtime.dataDir;
const runtimeDataPaths = runtimeDataPathMap();
const jsonStore = new AtomicJsonStore({ allowedRoot: dataDir });
const {
  manifest: manifestPath,
  reviews: reviewsPath,
  feedback: feedbackPath,
  about: aboutPath,
  home: homePath,
  guides: guidesPath,
  participate: participatePath,
  links: linksPath,
  footer: footerPath,
  editorSettings: editorSettingsPath,
  visitStats: visitStatsPath,
  backupSettings: backupSettingsPath,
} = runtimeDataPaths;
const backupSecretPath = path.resolve(process.env.BACKUP_SECRET_FILE || path.join(dataDir, "backup-secrets.json"));
const backupSecretStore = new AtomicJsonStore({ allowedRoot: path.dirname(backupSecretPath) });
const distDir = path.join(root, "dist");
const publicDir = runtime.publicDir;
const staticReleasePublisher = new StaticReleasePublisher({
  publicDir,
  releaseRoot: runtime.publicReleasesDir,
  distDir,
});
const host = process.env.ADMIN_HOST || "127.0.0.1";
const port = Number(process.env.ADMIN_PORT || 8787);
const adminOrigin = String(process.env.ADMIN_ORIGIN || (process.env.NODE_ENV === "production" ? "" : `http://${host}:${port}`)).replace(/\/+$/, "");
const secretPath = runtime.adminSecretPath;
const r2Bucket = process.env.R2_BUCKET;
const r2Prefix = strictR2Path(process.env.R2_PREFIX || "resources", "R2_PREFIX");
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
const visitDedupMs = 30 * 60 * 1000;
const visitVisitorCap = 5_000;
const visitHistoryDays = 400;
let backupRunning = false;
let lastAutoBackupDate = "";
let backupSettingsQueue = Promise.resolve();
let manifestService;
let contentPublishService;
const r2MutationQueue = new R2MutationQueue();
const activeChildren = new Set();

if (!adminOrigin || !/^https?:\/\/[^/]+$/i.test(adminOrigin)) {
  console.error("ADMIN_ORIGIN must be an exact http(s) origin without a path.");
  process.exit(1);
}

let secret;
if (fs.existsSync(secretPath)) {
  secret = fs.readFileSync(secretPath, "utf8").trim();
} else {
  if (process.env.NODE_ENV === "production") throw new Error("ADMIN_SECRET_FILE must already exist in production.");
  secret = randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
}
if (secret.length < 32) throw new Error("ADMIN_SECRET_FILE must contain at least 32 characters.");
const rateLimiter = new PersistentRateLimiter({ dbPath: runtime.stateDbPath });
const sessionStore = new AdminSessionStore({
  dbPath: runtime.stateDbPath,
  secret,
  absoluteTtlMs: Number(process.env.ADMIN_SESSION_ABSOLUTE_TTL_MS || 8 * 60 * 60 * 1000),
  idleTtlMs: Number(process.env.ADMIN_SESSION_IDLE_TTL_MS || 30 * 60 * 1000),
});
const auditArchiveDir = path.join(dataDir, "audit-archive");
let auditArchiveUploadStarted = false;
const accountsStore = new AdminAccountsStore({
  dbPath: runtime.stateDbPath,
  archiveDir: auditArchiveDir,
  onArchive: () => {
    if (auditArchiveUploadStarted) return;
    auditArchiveUploadStarted = true;
    setTimeout(() => {
      auditArchiveUploadStarted = false;
      uploadPendingAuditArchive().catch(() => {});
    }, 2_000).unref();
  },
});
migrateServiceKeyPermission();
seedInitialAdminAccount();

function migrateServiceKeyPermission() {
  try {
    for (const account of accountsStore.list()) {
      if (account.permissions.includes("accounts.manage") && !account.permissions.includes("services.manage")) {
        accountsStore.updateSettings(account.id, { permissions: [...account.permissions, "services.manage"] });
      }
    }
  } catch (error) {
    console.warn(`services.manage migration skipped: ${error.message}`);
  }
}

function seedInitialAdminAccount() {
  if (accountsStore.count() > 0) return;
  const initialPassword = String(process.env.ADMIN_INITIAL_PASSWORD || "").trim();
  const permissions = ADMIN_PERMISSION_POINTS.slice();
  if (initialPassword.length >= 10) {
    accountsStore.create({ username: "Shview", password: initialPassword, permissions, mustChangePassword: true, createdBy: "system" });
    console.log("Seeded initial admin account Shview from ADMIN_INITIAL_PASSWORD.");
    return;
  }
  const generated = randomBytes(15).toString("base64url");
  accountsStore.create({ username: "Shview", password: generated, permissions, mustChangePassword: true, createdBy: "system" });
  const passwordFile = path.join(dataDir, "admin-initial-password.txt");
  fs.writeFileSync(passwordFile, `Shview / ${generated}\n`, { mode: 0o600 });
  fs.chmodSync(passwordFile, 0o600);
  console.log(`Seeded admin account Shview; one-time initial password written to ${passwordFile}`);
}
const reviewSubmissionService = new ReviewSubmissionService({
  store: jsonStore,
  reviewsPath,
  readReviews,
  consumeAttempt: (ip) => consumeLayeredAttempt("review-attempt", ip, { perIp: 30, global: 1_000 }),
  consumeSubmission: checkReviewRate,
  actorHash: ipHash,
  nowIso,
  today,
  validateCourseTitle: (courseTitle) => {
    const manifestTitles = new Set((jsonStore.readSync(manifestPath).courses || []).map((course) => String(course.title)));
    if (manifestTitles.has(courseTitle) || courseCatalog.find(courseTitle)) return;
    throw new PublicApiError(400, "请从已有课程中选择（课程目录未收录该课程名）。", "COURSE_NOT_IN_CATALOG");
  },
  validateTeacher: (courseTitle, teacher) => {
    const entry = courseCatalog.find(courseTitle);
    if (!entry) {
      throw new PublicApiError(400, "该课程不在课程目录中，请先从已有课程选择。", "COURSE_NOT_IN_CATALOG");
    }
    if (!entry.teachers.length) return;
    const wanted = String(teacher || "").replace(/\s+/g, "");
    if (!entry.teachers.some((name) => String(name).replace(/\s+/g, "") === wanted)) {
      throw new PublicApiError(400, `请从该课程的授课教师中选择（${entry.teachers.slice(0, 30).join("、")}）。`, "TEACHER_NOT_IN_CATALOG");
    }
  },
});
const courseCatalog = new CourseCatalogService({ catalogPath: path.join(dataDir, "catalog.json") });
const mpAuthService = new MpAuthService({
  dbPath: runtime.stateDbPath,
  appid: process.env.WECHAT_APPID || "",
  secret: process.env.WECHAT_APPSECRET || "",
});
const mpFavoritesService = new MpFavoritesService({
  dbPath: runtime.stateDbPath,
  readManifest: () => cleanManifestResources(jsonStore.readSync(manifestPath)),
});
const publicApiService = new PublicApiService({
  readManifest: () => cleanManifestResources(jsonStore.readSync(manifestPath)),
  readReviews,
  readHome,
  readGuides,
  readVisitStats: readVisitStats,
  readFeedback: () => readFeedback(),
  courseCatalog,
  reviewSubmissionService,
  publicResourceOrigin: process.env.PUBLIC_RESOURCE_ORIGIN || "https://resources.nkustudy.top",
  guideCorrectionUrl: process.env.PUBLIC_GUIDE_CORRECTION_URL || "https://nkustudy.top/feedback",
  assertMpAuthAttempt: (ip) => consumeLayeredAttempt("mp-auth-attempt", ip, { perIp: 10, global: 240 }),
  mpAuthService,
  serviceRateLimiter: rateLimiter,
});
const notifySettingsPath = path.join(dataDir, "notify-settings.json");
const notifySecretsPath = path.join(dataDir, "notify-secrets.json");
const notifySecretStore = new AtomicJsonStore({ allowedRoot: dataDir });
const feishuNotify = new FeishuNotifyService({
  readSettings: async () => {
    try {
      return readJsonFile(notifySettingsPath);
    } catch {
      return {};
    }
  },
  writeSettings: async (data) => jsonStore.write(notifySettingsPath, data),
  readSecrets: async () => (fs.existsSync(notifySecretsPath) ? notifySecretStore.readSync(notifySecretsPath) : {}),
  writeSecrets: async (data) => notifySecretStore.write(notifySecretsPath, data, { mode: 0o600 }),
});
function submissionHint(rules) {
  const options = (rules || {}).submissionOptions || {};
  if (options.allowCustomCourse === false) {
    return "课程需从已有课程中选择；如发现课程或教师信息有误、缺失，请到「问题反馈」页提交，我们会尽快补充。";
  }
  return "课程与教师名称可直接填写，不存在时会自动创建新的评价条目。";
}

async function notifyModerators(payload = {}) {
  const typeLabels = { "review.pending": payload.pending === false ? "新评价（免审已公开）" : "新评价待审", "feedback.pending": "新反馈待处理", "resource-report": "资源失效反馈" };
  const title = typeLabels[payload.type] || "待处理通知";
  const lines = [];
  if (payload.type === "review.pending") {
    lines.push(`**课程**：${payload.title || "-"}`, `**老师**：${payload.teacher || "-"}`, `**评分**：${"★".repeat(Math.max(1, Math.min(5, Number(payload.rating) || 0)))}`, `**内容预览**：${String(payload.content || "").slice(0, 80)}`);
  } else if (payload.type === "feedback.pending") {
    lines.push(`**标题**：${payload.title || "-"}`, `**类型**：${payload.feedbackType || "-"}`, `**内容预览**：${String(payload.content || "").slice(0, 80)}`, ...(payload.resourceRef ? [`**关联资源**：${payload.resourceRef}`] : []));
  } else {
    lines.push(...(payload.lines || ["请登录后台查看。"]));
  }
  const result = await feishuNotify.broadcast({ title, lines });
  if (!result.sent) console.warn(`Feishu notify skipped: ${result.reason || "all bots failed"}`);
  return result;
}
const readPublicBody = (req) => readJsonBody(req, { rejectReplacementCharacters: true });
const serviceAuthStore = new ServiceAuthStore({ store: jsonStore, filePath: path.join(dataDir, "service-keys.json") });
const consumeServiceQuota = (caller) => {
  const quota = Number(caller?.limits?.daily_quota) || 0;
  if (quota <= 0) return true;
  const result = rateLimiter.consume({
    scope: `svc-quota:${caller.id}`.slice(0, 128),
    actorHash: "calls",
    limits: [{ windowMs: 86_400_000, max: quota }],
  });
  return result.allowed === true;
};
const handlePublicApi = createPublicApiHandler({ service: publicApiService, mpAuthService, mpFavoritesService, serviceAuthStore, consumeServiceQuota, notify: notifyModerators, readBody: readPublicBody, clientIp });

function json(res, status, data) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
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
  const data = backupSecretStore.readSync(backupSecretPath);
  data.webdav = data.webdav || {};
  return data;
}

async function writeBackupSecrets(data) {
  await backupSecretStore.write(backupSecretPath, data, { mode: 0o600 });
}

function readBackupSettings() {
  const defaults = defaultBackupSettings();
  const data = readJsonFile(backupSettingsPath);
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

async function writeBackupSettingsUnlocked(input) {
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
  await writeBackupSecrets(secrets);
  await jsonStore.write(backupSettingsPath, next);
  return publicBackupSettings();
}

function writeBackupSettings(input) {
  const operation = backupSettingsQueue.catch(() => {}).then(() => writeBackupSettingsUnlocked(input));
  backupSettingsQueue = operation;
  return operation;
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
  return normalizeEditorSettings(readJsonFile(editorSettingsPath));
}

function publicEditorSettings() {
  return readEditorSettings();
}

async function writeEditorSettings(data) {
  const next = normalizeEditorSettings(data || {});
  await jsonStore.write(editorSettingsPath, next);
  return next;
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
    note: "Admin password hashes are included for account recovery; plaintext passwords and R2 secret keys are never included.",
  };
  const data = {
    ok: true,
    scope,
    createdAt,
    config: safeConfig,
  };
  const manifest = () => cleanManifestResources(jsonStore.readSync(manifestPath));
  const pages = () => ({
    about: readAbout(),
    home: readHome(),
    guides: readGuides(),
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
  if (scope === "all" || scope === "config") data.adminAccounts = accountsStore.exportForBackup();
  if (!["all", "manifest", "reviews", "feedback", "pages", "stats", "config"].includes(scope)) {
    return null;
  }
  return data;
}

function serverConfigBackup() {
  const secrets = readBackupSecrets();
  const envText = readFileIfExists("/etc/nkustudy/admin.env");
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
      path: "/etc/nkustudy/admin.env",
      payload: encryptText(envText, secrets.encryptionPassword),
    };
  } else if (envText) {
    config.encryptedSecrets = {
      path: "/etc/nkustudy/admin.env",
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

async function uploadPendingAuditArchive() {
  if (!r2Client || !r2Bucket) return;
  let files;
  try {
    files = (await fs.promises.readdir(auditArchiveDir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return;
  }
  for (const name of files.slice(0, 50)) {
    try {
      const filePath = path.join(auditArchiveDir, name);
      const payload = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
      await putR2Json(objectKey("backups/audit", name), payload);
      await fs.promises.unlink(filePath);
    } catch (error) {
      console.warn(`Audit archive upload failed for ${name}: ${error.message}`);
      break;
    }
  }
}

let lastDigestDate = "";

async function runDailyDigest() {
  const beijingDay = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const beijingMinute = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(11, 16);
  if (lastDigestDate === beijingDay || beijingMinute < "21:00") return;
  const described = await feishuNotify.describe().catch(() => ({ bots: [] }));
  const digestBots = (described.bots || []).filter((bot) => bot.enabled && (bot.purposes || []).includes("digest"));
  if (!digestBots.length) {
    lastDigestDate = beijingDay;
    return;
  }
  const reviewData = readReviews();
  const feedbackData = readFeedback();
  const day = beijingDay;
  const newReviews = (reviewData.reviews || []).filter((review) => String(review.createdAt || "").slice(0, 10) === day).length;
  const pendingReviews = (reviewData.reviews || []).filter((review) => String(review.status || "pending") === "pending" && !review.hidden).length;
  const newFeedback = (feedbackData.items || []).filter((item) => String(item.createdAt || "").slice(0, 10) === day).length;
  const openFeedback = (feedbackData.items || []).filter((item) => !item.hidden && String(item.status || "open") === "open").length;
  const mpOverview = mpAuthService.adminOverview({ dayStartMs: Date.parse(`${day}T00:00:00+08:00`) });
  lastDigestDate = beijingDay;
  await feishuNotify.broadcast({
    title: "NKUStudy 每日汇总",
    lines: [
      `**日期**：${day}`,
      `**今日新增评价**：${newReviews} 条（待审累计 ${pendingReviews}）`,
      `**今日新增反馈**：${newFeedback} 条（待处理累计 ${openFeedback}）`,
      `**今日登录用户**：${mpOverview.logins_since} 次（总用户 ${mpOverview.total}）`,
    ],
  }, { purpose: "digest" }).catch(() => {});
}

function startDigestScheduler() {
  setInterval(() => {
    runDailyDigest().catch(() => {});
  }, 5 * 60 * 1000).unref();
}

function startBackupScheduler() {
  setInterval(async () => {
    try {
      const settings = readBackupSettings();
      if (!settings.autoEnabled) return;
      const now = currentShanghaiTime();
      if (now.date === lastAutoBackupDate) return;
      if (now.time < settings.dailyTime) return;
      lastAutoBackupDate = now.date;
      await runBackupJob({ manual: false });
    } catch (error) {
      console.error(`Scheduled backup failed: ${error.message}`);
    }
  }, 60 * 1000);
}

const readBody = readJsonBody;
const adminCookieName = "__Host-nkustudy_admin";

function cookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return "";
      }
    }
  }
  return "";
}

function requireAuth(req, res) {
  const token = cookie(req, adminCookieName);
  const identity = sessionStore.lookup(token);
  if (!identity?.username) {
    json(res, 401, { ok: false, error: "Unauthorized" });
    return null;
  }
  const account = accountsStore.getByUsername(identity.username);
  if (!account || !account.enabled) {
    sessionStore.revoke(token);
    json(res, 401, { ok: false, error: "Unauthorized" });
    return null;
  }
  req.__adminAccount = account;
  return account;
}

function requirePermission(req, account, permission, res) {
  if (hasAdminPermission(account, permission)) return true;
  json(res, 403, { ok: false, error: "没有执行该操作的权限。" });
  req.resume();
  return false;
}

function requireAdminMutationProvenance(req, res, url) {
  const origin = String(req.headers.origin || "");
  const fetchSite = String(req.headers["sec-fetch-site"] || "");
  if (origin !== adminOrigin || (fetchSite && fetchSite !== "same-origin") || req.headers["x-nkustudy-admin-request"] !== "1") {
    json(res, 403, { ok: false, error: "Admin request origin could not be verified." });
    req.resume();
    return false;
  }
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  const expected = url.pathname === "/admin-api/upload" ? "multipart/form-data" : "application/json";
  if (!contentType.startsWith(expected)) {
    json(res, 415, { ok: false, error: `Content-Type must be ${expected}.` });
    req.resume();
    return false;
  }
  return true;
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

function preserveUnchangedCourseDates(nextManifest, currentManifest) {
  if (!currentManifest) return nextManifest;
  const currentByUid = new Map((currentManifest.courses || []).filter((course) => course.uid).map((course) => [course.uid, course]));
  const currentById = new Map((currentManifest.courses || []).map((course) => [course.id, course]));
  const currentByBasePath = new Map((currentManifest.courses || []).map((course) => [strictR2BasePath(course.basePath), course]));
  for (const course of nextManifest.courses || []) {
    const previous = currentByUid.get(course.uid) || currentById.get(course.id) || currentByBasePath.get(strictR2BasePath(course.basePath));
    if (!previous) {
      course.updated = course.updated || today();
      continue;
    }
    course.updated = courseSnapshot(previous) === courseSnapshot(course) ? previous.updated : today();
  }
  return nextManifest;
}

function readJsonFile(filePath) {
  return jsonStore.readSync(filePath);
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

function normalizeVisitStats(stats) {
  stats.total = Number(stats.total || 0);
  stats.days = stats.days && typeof stats.days === "object" ? stats.days : {};
  stats.pages = stats.pages && typeof stats.pages === "object" ? stats.pages : {};
  stats.visitors = stats.visitors && typeof stats.visitors === "object" ? stats.visitors : {};
  for (const visitor of Object.values(stats.visitors)) {
    if (visitor?.ip && !visitor.actorHash) visitor.actorHash = ipHash(visitor.ip);
  }
  return stats;
}

function readVisitStats() {
  return normalizeVisitStats(readJsonFile(visitStatsPath));
}

function publicVisitStats(stats = readVisitStats()) {
  const day = localDay();
  return {
    total: stats.total,
    today: Number(stats.days[day] || 0),
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
  // 小程序端上报：接受 /mp/<页面名>（小写字母/数字/中划线），其余 /mp/ 路径归入 /mp/other。
  if (/^\/mp\/[a-z0-9-]{1,32}$/.test(pathname)) return pathname;
  if (pathname.startsWith("/mp/")) return "/mp/other";
  pathname = pathname.replace(/\/+$/, "") || "/";
  const fixed = new Set(["/", "/about", "/feedback", "/friends", "/participate", "/reviews", "/courses"]);
  if (fixed.has(pathname)) return pathname;
  if (/^\/courses\/[^/]+$/.test(pathname)) return "/courses/:id";
  if (pathname === "/reviews/detail") return pathname;
  return "/__unknown__";
}

async function recordVisit(req, pagePath) {
  const pathname = cleanVisitPath(pagePath);
  const summary = publicVisitStats();
  if (!pathname) return { counted: false, ...summary };
  const key = visitKey(req);
  const now = Date.now();
  let counted = false;
  const stats = await jsonStore.update(visitStatsPath, (current) => {
    normalizeVisitStats(current);
    const previous = current.visitors[key]?.lastSeen || 0;
    const cutoff = now - 24 * 60 * 60 * 1000;
    for (const [visitorKey, visitor] of Object.entries(current.visitors)) {
      if (Number(visitor?.lastSeen || 0) < cutoff) delete current.visitors[visitorKey];
    }
    current.visitors[key] = { ip: clientIp(req), actorHash: ipHash(clientIp(req)), userAgentHash: userAgentHash(req), lastSeen: now };
    const visitorEntries = Object.entries(current.visitors);
    if (visitorEntries.length > visitVisitorCap) {
      visitorEntries.sort((a, b) => Number(a[1]?.lastSeen || 0) - Number(b[1]?.lastSeen || 0));
      for (const [visitorKey] of visitorEntries.slice(0, visitorEntries.length - visitVisitorCap)) delete current.visitors[visitorKey];
    }
    if (now - Number(previous || 0) >= visitDedupMs) {
      counted = true;
      const day = localDay();
      current.total += 1;
      current.days[day] = Number(current.days[day] || 0) + 1;
      current.pages[pathname] ??= { total: 0, days: {} };
      current.pages[pathname].total = Number(current.pages[pathname].total || 0) + 1;
      current.pages[pathname].days[day] = Number(current.pages[pathname].days[day] || 0) + 1;
    }
    const retainedDays = Object.keys(current.days).sort().slice(-visitHistoryDays);
    current.days = Object.fromEntries(retainedDays.map((day) => [day, current.days[day]]));
    for (const page of Object.values(current.pages)) {
      const pageDays = Object.keys(page.days || {}).sort().slice(-visitHistoryDays);
      page.days = Object.fromEntries(pageDays.map((day) => [day, page.days[day]]));
    }
    current.updatedAt = nowIso();
    return current;
  });
  return { counted, ...publicVisitStats(stats) };
}

function defaultReviews() {
  return {
    version: 1,
    updated: today(),
    rules: {
      submissionOpen: true,
      moderationRequired: true,
      turnstileEnabled: false,
      hourlyLimit: 3,
      dailyLimit: 10,
      minLength: 12,
      submissionOptions: { allowCustomCourse: false, allowCustomTeacher: true },
      announcement: "评价内容会先进入待审核。请尽量描述授课风格、作业考试情况与适合人群，避免人身攻击或泄露隐私。",
      notes: "",
    },
    reviews: [],
  };
}

function normalizeReviewData(data) {
  const defaults = defaultReviews();
  data = structuredClone(data || {});
  data.rules = { ...defaults.rules, ...(data.rules || {}) };
  data.reviews = Array.isArray(data.reviews) ? data.reviews : [];
  return data;
}

function readReviews() {
  return normalizeReviewData(readJsonFile(reviewsPath));
}

function defaultFeedback() {
  return {
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
}

function readFeedback() {
  const defaults = defaultFeedback();
  const data = readJsonFile(feedbackPath);
  data.title = cleanText(data.title, 120) || defaults.title;
  data.announcement = cleanText(data.announcement, 4000);
  data.rules = { ...defaults.rules, ...(data.rules || {}) };
  data.items = Array.isArray(data.items) ? data.items : [];
  return data;
}

function normalizeFeedbackData(data, defaults = defaultFeedback().rules) {
  return {
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
}

function readAbout() {
  const defaults = {
    title: "NKUStudy",
    content: "NKUStudy 是一个面向课程资料整理、课程导航和老师评价的轻量站点。\n\n资源索引在构建时读取，下载由 R2 分发，OpenList 作为补充网盘入口。",
  };
  const data = readJsonFile(aboutPath);
  return {
    title: cleanText(data.title, 120) || defaults.title,
    content: cleanText(data.content, 6000) || defaults.content,
  };
}

function normalizeAbout(data) {
  const content = cleanText(data.content, 6000);
  return {
    title: cleanText(data.title, 120) || "NKUStudy",
    content,
  };
}

function readParticipate() {
  return readJsonFile(participatePath);
}

function normalizeParticipate(data) {
  return {
    title: cleanText(data.title, 120) || "参与贡献",
    content: cleanText(data.content, 8000),
  };
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
      description: cleanText(item.description, 4000),
      hidden: item.hidden === true,
    })).filter((item) => item.name && item.url),
  };
}

function readLinks() {
  return normalizeLinks(readJsonFile(linksPath));
}

function readHome() {
  return readJsonFile(homePath);
}

function readGuides() {
  if (!fs.existsSync(guidesPath)) return { version: 1, updated_at: "", items: [] };
  return readJsonFile(guidesPath);
}

function normalizeHome(data) {
  return {
    announcement: cleanText(data.announcement, 2000) || "南开课程资料导航，整合课程信息、复习资料、往年试题与网盘入口。",
  };
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
  return normalizeFooter(readJsonFile(footerPath));
}

function ipHash(ip) {
  return hashActor(ip, secret, 24);
}

function checkRate(scope, ip, rules, defaults) {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  return rateLimiter.consume({
    scope,
    actorHash: hashActor(ip, secret),
    limits: [
      { windowMs: hour, max: Number(rules.hourlyLimit || defaults.hourlyLimit) },
      { windowMs: day, max: Number(rules.dailyLimit || defaults.dailyLimit) },
    ],
  }).allowed;
}

function consumeLayeredAttempt(scope, ip, { perIp, global, windowMs = 60_000 }) {
  return rateLimiter.consumeLayered({
    scope,
    actorHash: hashActor(ip, secret),
    globalActorHash: hashActor(`global:${scope}`, secret),
    actorLimits: [{ windowMs, max: perIp }],
    globalLimits: [{ windowMs, max: global }],
  }).allowed;
}

function checkReviewRate(ip, rules) {
  return checkRate("review-submit", ip, rules, { hourlyLimit: 3, dailyLimit: 10 });
}

function checkFeedbackRate(ip, rules) {
  return checkRate("feedback-submit", ip, rules, { hourlyLimit: 3, dailyLimit: 15 });
}

function cleanText(value, max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

function publicReview(review) {
  const { ipHash: _ipHash, userAgent: _userAgent, ...safe } = review;
  return safe;
}

function publicFeedback(item) {
  const { ipHash: _ipHash, userAgent: _userAgent, contact: _contact, resourceRef: _resourceRef, user_id: _userId, ...safe } = item;
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

function isOpenListPlaceholder(filePath) {
  return path.posix.basename(normalizeKey(filePath)).toLowerCase() === ".openlist";
}

function cleanManifestResources(manifest) {
  if (!manifest || typeof manifest !== "object") return manifest;
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
  const ip = clientIp(req);
  const authUser = mpAuthService.verifyToken(req.headers.authorization);
  if (!consumeLayeredAttempt("feedback-attempt", ip, { perIp: 30, global: 1_000 })) {
    json(res, 429, { ok: false, error: "请求太频繁，请稍后再试。" });
    req.resume();
    return;
  }
  const data = readFeedback();
  const rules = data.rules || {};
  if (!rules.submissionOpen) {
    json(res, 403, { ok: false, error: "反馈提交暂未开放。" });
    return;
  }

  const body = await readPublicBody(req);
  if (body.website) {
    json(res, 200, { ok: true });
    return;
  }

  const title = cleanText(body.title, 120);
  const content = cleanText(body.content, 2000);
  const type = cleanText(body.type, 40) || "bug";
  const contact = cleanText(body.contact, 120);
  const resourceRef = cleanText(body.resourceRef, 200);
  if (!title || content.length < Number(rules.minLength || 5)) {
    json(res, 400, { ok: false, error: "请填写标题，并补充更完整的反馈内容。" });
    return;
  }

  if (!checkFeedbackRate(ip, rules)) {
    json(res, 429, { ok: false, error: "提交太频繁，请稍后再试。" });
    return;
  }

  await jsonStore.update(feedbackPath, (current) => {
    current.items = Array.isArray(current.items) ? current.items : [];
    current.items.unshift({
      id: `feedback-${Date.now()}-${randomBytes(4).toString("hex")}`,
      title,
      content,
      type,
      contact,
      ...(resourceRef ? { resourceRef } : {}),
      ...(authUser ? { user_id: authUser.id } : {}),
      status: "open",
      hidden: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ipHash: ipHash(ip),
      userAgent: cleanText(req.headers["user-agent"], 240),
    });
    current.updated = today();
    return current;
  });
  Promise.resolve(notifyModerators({ type: "feedback.pending", title, feedbackType: type, content, resourceRef })).catch(() => {});
  json(res, 200, { ok: true });
}

async function handleReviewSubmit(req, res) {
  const ip = clientIp(req);
  reviewSubmissionService.assertAttempt(ip);
  const result = await reviewSubmissionService.submit(await readPublicBody(req), { clientIp: ip, userAgent: req.headers["user-agent"] });
  if (result.notify) {
    Promise.resolve(notifyModerators({
      type: "review.pending",
      title: result.notify.title,
      teacher: result.notify.teacher,
      rating: result.notify.rating,
      content: result.notify.content,
      pending: result.pending,
    })).catch(() => {});
  }
  json(res, 200, { ok: true, pending: result.pending });
}

async function readReviewStore() {
  const data = readReviews();
  return { data, revision: manifestRevision(data) };
}

async function updateReviewStore(next, expectedRevision) {
  let revision;
  const data = await jsonStore.update(reviewsPath, (persisted) => {
    const current = normalizeReviewData(persisted);
    const currentRevision = manifestRevision(current);
    if (!expectedRevision) {
      const error = new Error("expectedRevision is required; reload reviews before saving.");
      error.statusCode = 400;
      throw error;
    }
    if (expectedRevision !== currentRevision) {
      throw new ManifestConflictError("Reviews changed after they were loaded; no changes were written. Refresh and retry.", currentRevision);
    }
    if (next.rules) current.rules = { ...(current.rules || {}), ...next.rules };
    if (Array.isArray(next.reviews)) current.reviews = next.reviews;
    current.updated = today();
    revision = manifestRevision(current);
    return current;
  }, { mode: 0o600 });
  return { data, revision };
}

async function uploadFileToR2({ course, section, filename, stream, mimeType, abortSignal }) {
  if (!r2Client || !r2Bucket) {
    return Promise.reject(new Error("R2 upload is not configured on the server."));
  }

  const relativeName = strictR2Path(filename, "Upload filename");
  const basePath = strictR2BasePath(course.basePath, `Course ${course.uid || course.id} basePath`);
  const manifestPath = section.title === "其他"
    ? relativeName
    : strictR2Path(`${strictR2Path(section.title, "Upload section")}/${relativeName}`, "Uploaded manifest path");
  const key = `${r2Prefix}/${basePath}${manifestPath}`;
  const counter = new PassThrough();
  let size = 0;

  stream.on("data", (chunk) => {
    size += chunk.length;
  });
  stream.pipe(counter);

  await r2Client.send(new PutObjectCommand({
    Bucket: r2Bucket,
    Key: key,
    Body: counter,
    ContentType: mimeType || "application/octet-stream",
    ContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(relativeName))}`,
  }), { abortSignal });

  return {
    title: path.posix.basename(relativeName),
    path: manifestPath,
    size,
    description: "",
  };
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

async function syncCourseFromR2(courseId, expectedRevision) {
  if (!expectedRevision) {
    const error = new Error("expectedRevision is required.");
    error.statusCode = 400;
    throw error;
  }
  const { manifest: snapshot, revision } = await manifestService.readWithRevision();
  if (revision !== expectedRevision) {
    const error = new Error("Manifest changed before R2 sync began; no changes were written.");
    error.statusCode = 409;
    error.currentRevision = revision;
    throw error;
  }
  if (!r2Client || !r2Bucket) {
    throw new Error("R2 upload is not configured on the server.");
  }
  const course = snapshot.courses.find((item) => item.id === courseId);
  if (!course) throw new Error("Course was not found.");
  const courseUid = course.uid;
  const expectedBasePath = strictR2BasePath(course.basePath, `Course ${courseUid} basePath`);

  const basePrefix = `${r2Prefix}/${expectedBasePath.slice(0, -1)}`;
  const objects = await listR2Objects(`${basePrefix}/`);
  const existingSections = new Map((course.sections ?? []).map((section) => [section.title, section]));
  const sections = new Map();

  for (const object of objects) {
    const relativePath = strictR2Path(object.Key.slice(basePrefix.length + 1), `R2 object under ${basePrefix}`);
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

  const nextSections = Array.from(sections.values()).sort((a, b) => {
    const rank = orderRank(a.title) - orderRank(b.title);
    return rank || a.title.localeCompare(b.title, "zh-CN");
  });
  let syncReport;
  const result = await manifestService.mutate((latest) => {
    const latestCourse = latest.courses.find((item) => item.uid === courseUid) || latest.courses.find((item) => item.id === courseId);
    if (!latestCourse) throw new Error("Course was deleted while R2 was being listed.");
    if (strictR2BasePath(latestCourse.basePath, `Course ${courseUid} basePath`) !== expectedBasePath) {
      const error = new Error("Course path changed while R2 was being listed; retry the sync.");
      error.statusCode = 409;
      throw error;
    }
    const merged = mergeCourseR2Discovery(latestCourse, { sections: nextSections });
    latestCourse.sections = merged.course.sections;
    latestCourse.updated = today();
    syncReport = merged.report;
    return latest;
  }, { expectedRevision });
  const persistedCourse = result.manifest.courses.find((item) => item.uid === courseUid);
  return { manifest: result.manifest, revision: result.revision, course: persistedCourse, report: syncReport, ...(result.warnings ? { warnings: result.warnings } : {}) };
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
      basePath: strictR2Path(`${parts[0]}/${parts[1]}/${parts[2]}`, "Discovered course basePath"),
    };
  }
  if (parts.length >= 3 && noFixedTermGroups.has(parts[0])) {
    return {
      term: "无固定年级",
      group: parts[0],
      title: parts[1],
      rest: parts.slice(2),
      basePath: strictR2Path(`${parts[0]}/${parts[1]}`, "Discovered course basePath"),
    };
  }
  if (parts.length >= 4) {
    return {
      term: parts[0],
      group: parts[1],
      title: parts[2],
      rest: parts.slice(3),
      basePath: strictR2Path(`${parts[0]}/${parts[1]}/${parts[2]}`, "Discovered course basePath"),
    };
  }
  return null;
}

async function syncAllCoursesFromR2(expectedRevision) {
  if (!expectedRevision) {
    const error = new Error("expectedRevision is required.");
    error.statusCode = 400;
    throw error;
  }
  const { manifest: snapshot, revision } = await manifestService.readWithRevision();
  if (revision !== expectedRevision) {
    const error = new Error("Manifest changed before R2 sync began; no changes were written.");
    error.statusCode = 409;
    error.currentRevision = revision;
    throw error;
  }
  if (!r2Client || !r2Bucket) {
    throw new Error("R2 upload is not configured on the server.");
  }
  const objects = await listR2Objects(`${r2Prefix}/`);
  const discovered = new Map();
  const unmatched = [];
  const conflicts = [];
  const usedIds = new Set(snapshot.courses.map((course) => course.id));
  for (const object of objects) {
    if (!object.Key || object.Key.endsWith("/")) continue;
    let relative;
    try {
      relative = strictR2Path(object.Key.slice(r2Prefix.length + 1), "R2 discovery key");
    } catch {
      unmatched.push(object.Key);
      continue;
    }
    const parsed = coursePartsFromR2Path(relative.split("/"));
    if (!parsed) {
      unmatched.push(relative);
      continue;
    }
    const { term, group, title, rest, basePath } = parsed;
    const entry = discovered.get(basePath) || { term, group, title, basePath, sections: new Map() };
    if (entry.term !== term || entry.group !== group || entry.title !== title) {
      conflicts.push({ basePath, key: relative, reason: "inconsistent course metadata" });
      continue;
    }
    discovered.set(basePath, entry);
    if (isOpenListPlaceholder(relative)) continue;
    const sectionTitle = rest.length > 1 ? rest[0] : "其他";
    const filePath = rest.join("/");
    if (!filePath) continue;
    const section = entry.sections.get(sectionTitle) || { title: sectionTitle, note: "", files: [] };
    section.files.push({ title: path.posix.basename(filePath), path: filePath, size: object.Size ?? 0, description: "" });
    entry.sections.set(sectionTitle, section);
  }

  const existingByBasePath = new Map(snapshot.courses.map((course) => [strictR2BasePath(course.basePath).slice(0, -1), course]));
  const discoveries = Array.from(discovered, ([basePath, entry]) => {
    const existing = existingByBasePath.get(basePath);
    const sections = Array.from(entry.sections.values()).sort((a, b) => {
      const rank = sectionOrderRank(a.title) - sectionOrderRank(b.title);
      return rank || a.title.localeCompare(b.title, "zh-CN");
    }).map((section) => ({
      ...section,
      note: existing?.sections?.find((item) => item.title === section.title)?.note || section.note,
    }));
    return { ...entry, basePath, sections };
  });
  const merged = mergeR2Discoveries(snapshot, discoveries, {
    conflicts,
    createId: (entry) => uniqueCourseId(entry.title, entry.term, entry.group, entry.basePath, usedIds),
    date: today(),
  });
  const result = await manifestService.publish(merged.manifest, { expectedRevision, deletedCourseUids: [] });
  return {
    manifest: result.manifest,
    revision: result.revision,
    report: { ...merged.report, unmatched: [...unmatched, ...merged.report.unmatched], conflicts },
    ...(result.warnings ? { warnings: result.warnings } : {}),
  };
}

async function saveManifestDraft(manifest, options) {
  try {
    return await manifestService.draft(manifest, options);
  } catch (error) {
    return { ok: false, statusCode: Number(error.statusCode) || 400, errors: error.validationErrors || [error.message], currentRevision: error.currentRevision };
  }
}

async function deleteExactR2Keys(keys) {
  if (!r2Client || !r2Bucket) {
    throw new Error("R2 upload is not configured on the server.");
  }
  const objects = [...new Set((keys || []).filter((key) => typeof key === "string" && key.length > 0))].map((Key) => ({ Key }));
  if (!objects.length) return;
  for (let index = 0; index < objects.length; index += 1000) {
    const result = await r2Client.send(new DeleteObjectsCommand({
      Bucket: r2Bucket,
      Delete: {
        Objects: objects.slice(index, index + 1000),
        Quiet: true,
      },
    }));
    if (result.Errors?.length) throw new Error(`R2 cleanup failed for ${result.Errors.length} object(s).`);
  }
}

async function safeR2ManifestPublish({ manifest, expectedRevision, deletedCourseUids, moves = [], fileDeletes = [] } = {}) {
  if (!r2Client || !r2Bucket) {
    throw new Error("R2 upload is not configured on the server.");
  }
  if (!expectedRevision) {
    const error = new Error("expectedRevision is required.");
    error.statusCode = 400;
    throw error;
  }
  return runSerializedR2Mutation({
    queue: r2MutationQueue,
    expectedRevision,
    readCurrent: () => manifestService.readWithRevision(),
    mutate: async (current) => {
      const plan = planR2ManifestMutation(current.manifest, manifest, { moves, fileDeletes, deletedCourseUids, r2Prefix });
      const cleanupKeys = new Set();
      const plannedTargets = new Set();
      const preparedMoves = [];
      let copied = 0;
      let extraSourceObjects = 0;
      const unmovedSourceKeys = [];

      for (const move of plan.moves) {
        const oldPrefix = `${move.sourcePrefix}/`;
        const newPrefix = `${move.targetPrefix}/`;
        const [sourceObjects, targetObjects] = await Promise.all([listR2Objects(oldPrefix), listR2Objects(newPrefix)]);
        const planned = planR2ObjectCopies(move, sourceObjects, targetObjects, { reservedTargets: plannedTargets });
        for (const key of planned.cleanupKeys) cleanupKeys.add(key);
        extraSourceObjects += planned.extraSourceKeys.length;
        unmovedSourceKeys.push(...planned.unmovedSourceKeys);
        preparedMoves.push({ oldPrefix, newPrefix, copies: planned.copies, requiredObjects: move.requiredObjects });
      }
      for (const key of plan.fileDeleteKeys) cleanupKeys.add(key);
      for (const prefix of plan.deletedCoursePrefixes) {
        for (const object of await listR2Objects(`${prefix}/`)) cleanupKeys.add(object.Key);
      }
      const exactCleanupKeys = assertR2CleanupSafety(
        [...cleanupKeys],
        [...plannedTargets],
        plan.moves.map((move) => move.targetPrefix),
      );

      for (const prepared of preparedMoves) {
        for (const { source, targetKey } of prepared.copies) {
          await r2Client.send(new CopyObjectCommand({
            Bucket: r2Bucket,
            CopySource: `${r2Bucket}/${encodeURIComponent(source.Key).replaceAll("%2F", "/")}`,
            Key: targetKey,
          }));
          copied += 1;
        }
        const copiedByKey = new Map((await listR2Objects(prepared.newPrefix)).map((object) => [object.Key, Number(object.Size || 0)]));
        for (const { source, targetKey } of prepared.copies) {
          if (!copiedByKey.has(targetKey) || copiedByKey.get(targetKey) !== Number(source.Size || 0)) {
            throw new Error(`R2 copy verification failed for ${targetKey}; the manifest was not changed.`);
          }
        }
        const sourceByKey = new Map(prepared.copies.map(({ source }) => [source.Key, Number(source.Size || 0)]));
        for (const required of prepared.requiredObjects || []) {
          if (!sourceByKey.has(required.sourceKey)
            || !copiedByKey.has(required.targetKey)
            || copiedByKey.get(required.targetKey) !== sourceByKey.get(required.sourceKey)) {
            throw new Error(`R2 declared-resource verification failed for ${required.targetKey}; the manifest was not changed.`);
          }
        }
      }

      const transaction = await publishAfterR2Prepare({
        prepare: async () => ({ cleanupKeys: exactCleanupKeys, copied }),
        publish: async () => manifestService.publish(manifest, { expectedRevision, deletedCourseUids, allowBasePathChanges: true }),
        cleanup: async (prepared) => deleteExactR2Keys(prepared.cleanupKeys),
      });
      return {
        ...transaction,
        copied,
        extraSourceObjects,
        unmovedSourceKeys,
        deleted: transaction.cleanupWarnings.length ? 0 : exactCleanupKeys.length,
      };
    },
  });
}

async function handleUpload(req, res, url) {
  if (!r2Client || !r2Bucket) {
    json(res, 400, { ok: false, error: "R2 upload is not configured on the server." });
    req.resume();
    return;
  }

  const courseId = url.searchParams.get("courseId");
  const sectionIndex = Number(url.searchParams.get("sectionIndex"));
  const manifest = await manifestService.read();
  const course = manifest.courses.find((item) => item.id === courseId);
  const section = course?.sections?.[sectionIndex];

  if (!course || !section) {
    json(res, 400, { ok: false, error: "Course or section was not found." });
    req.resume();
    return;
  }

  return new Promise((resolve) => {
    const abortController = new AbortController();
    const busboy = Busboy({
      headers: req.headers,
      limits: { files: 20, parts: 20, fileSize: 100 * 1024 * 1024 },
    });
    const uploads = [];
    let responded = false;
    let limitError = "";
    const respond = (status, body) => {
      if (responded) return;
      responded = true;
      if (status >= 400) abortController.abort();
      json(res, status, body);
      resolve();
    };

    busboy.on("file", (_name, file, info) => {
      const filename = info.filename || "unnamed-file";
      file.once("limit", () => {
        limitError = `File ${filename} exceeds the 100 MiB upload limit.`;
        file.resume();
        abortController.abort();
      });
      uploads.push(uploadFileToR2({
        course,
        section,
        filename,
        stream: file,
        mimeType: info.mimeType,
        abortSignal: abortController.signal,
      }));
    });

    busboy.once("filesLimit", () => { limitError = "At most 20 files may be uploaded per request."; abortController.abort(); });
    busboy.once("partsLimit", () => { limitError = "Multipart request has too many parts."; abortController.abort(); });
    busboy.on("error", (error) => respond(500, { ok: false, error: error.message }));
    busboy.on("finish", async () => {
      try {
        const files = await Promise.allSettled(uploads);
        if (limitError) throw Object.assign(new Error(limitError), { statusCode: 413 });
        const failed = files.find((result) => result.status === "rejected");
        if (failed) throw failed.reason;
        respond(200, { ok: true, files: files.map((result) => result.value) });
      } catch (error) {
        respond(Number(error.statusCode) || 500, { ok: false, error: error.message });
      }
    });

    req.once("aborted", () => {
      abortController.abort();
      if (!responded) {
        responded = true;
        resolve();
      }
    });
    req.pipe(busboy);
  });
}

function terminateChildTree(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function run(command, args, { timeoutMs = 180_000, maxOutputBytes = 256 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const executable = process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
    const child = spawn(executable, args, {
      cwd: root,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      env: { ...process.env, CI: "true" },
    });
    activeChildren.add(child);
    let output = "";
    let truncated = false;
    const append = (data) => {
      if (output.length >= maxOutputBytes) {
        truncated = true;
        return;
      }
      output += data.toString().slice(0, maxOutputBytes - output.length);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateChildTree(child);
      setTimeout(() => terminateChildTree(child, "SIGKILL"), 2_000).unref();
      reject(new Error(`${command} timed out after ${timeoutMs}ms${output ? `:\n${output}` : "."}`));
    }, timeoutMs);
    timeout.unref();
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        activeChildren.delete(child);
        reject(error);
      }
    });
    child.on("close", (code) => {
      activeChildren.delete(child);
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const suffix = truncated ? "\n[output truncated]" : "";
      if (code === 0) resolve(`${output}${suffix}`);
      else reject(new Error(`${output}${suffix}` || `${command} exited with code ${code}`));
    });
  });
}

async function buildAndDeploy() {
  const result = await staticReleasePublisher.publish(async () => {
    await run("npm", ["run", "check:content"]);
    await run("npm", ["run", "build"]);
  });
  for (const warning of result.warnings || []) console.warn(`Static publish durability warning: ${warning}`);
  return result;
}

function readDeploymentProof() {
  return staticReleasePublisher.readDeploymentProof();
}

async function publish(manifest, options) {
  try {
    return await manifestService.publish(manifest, options);
  } catch (error) {
    return { ok: false, statusCode: Number(error.statusCode) || 400, errors: error.validationErrors || [error.message], rolledBack: Boolean(error.publishRolledBack), currentRevision: error.currentRevision };
  }
}

const publishJournal = new ContentPublishJournal({ store: jsonStore, dataDir, readDeploymentProof });
manifestService = new ManifestService({
  store: jsonStore,
  manifestPath,
  sanitize: cleanManifestResources,
  prepare: (next, current) => preserveUnchangedCourseDates(next, current),
  buildAndDeploy,
  journal: publishJournal,
});
contentPublishService = new ContentPublishService({ store: jsonStore, mutationQueue: manifestService, buildAndDeploy, dataDir, journal: publishJournal });

async function readPublishedContent(filePath, normalize) {
  return contentPublishService.read(filePath, normalize);
}

async function publishContent(filePath, data, expectedRevision, normalize) {
  try {
    return await contentPublishService.publish(filePath, data, { expectedRevision, normalize });
  } catch (error) {
    return {
      ok: false,
      statusCode: Number(error.statusCode) || 400,
      errors: error.validationErrors || [error.message],
      rolledBack: Boolean(error.publishRolledBack),
      currentRevision: error.currentRevision,
    };
  }
}

async function initializeRuntimeData() {
  const initializable = new Map([
    [reviewsPath, defaultReviews],
    [feedbackPath, defaultFeedback],
    [visitStatsPath, defaultVisitStats],
    [editorSettingsPath, defaultEditorSettings],
    [backupSettingsPath, defaultBackupSettings],
  ]);
  for (const [filePath, factory] of initializable) {
    await jsonStore.read(filePath, { initialize: factory });
  }

  for (const filePath of [manifestPath, aboutPath, homePath, participatePath, linksPath, footerPath]) {
    await jsonStore.read(filePath);
  }
  const manifestErrors = validateManifest(jsonStore.readSync(manifestPath));
  if (manifestErrors.length) throw new Error(`Runtime manifest validation failed:\n${manifestErrors.join("\n")}`);
}

await staticReleasePublisher.recoverStartup();
await manifestService.recoverStartup();
await contentPublishService.recoverStartup();
await initializeRuntimeData();

const server = createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (await handlePublicApi(req, res, url)) return;
    if (url.pathname.startsWith("/review-api/")) {
      if (req.method === "GET" && url.pathname === "/review-api/reviews") {
        const publicRules = readReviews().rules;
        json(res, 200, { ok: true, reviews: approvedReviews(), rules: { ...publicRules, submission_hint: submissionHint(publicRules) } });
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
        if (!consumeLayeredAttempt("visit-attempt", clientIp(req), { perIp: 120, global: 600 })) {
          json(res, 429, { ok: false, error: "请求太频繁，请稍后再试。" });
          req.resume();
          return;
        }
        const body = await readPublicBody(req);
        json(res, 200, { ok: true, stats: await recordVisit(req, body.path || req.headers.referer || "/") });
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

    if (!["GET", "HEAD"].includes(req.method || "GET") && !requireAdminMutationProvenance(req, res, url)) return;

    res.on("finish", () => {
      try {
        if (!req.__adminAccount || ["GET", "HEAD"].includes(req.method)) return;
        accountsStore.audit({
          username: req.__adminAccount.username,
          action: `${req.method} ${url.pathname}`,
          method: req.method,
          path: url.pathname,
          status: res.statusCode,
          ip: clientIp(req),
          userAgent: req.headers["user-agent"] || "",
        });
      } catch {
        // 审计失败不影响已完成的响应。
      }
    });

    if (req.method === "POST" && url.pathname === "/admin-api/login") {
      const ip = clientIp(req);
      if (!consumeLayeredAttempt("admin-login-attempt", ip, { perIp: 5, global: 60, windowMs: 5 * 60 * 1000 })) {
        json(res, 429, { ok: false, error: "登录尝试过多，请 5 分钟后再试。" });
        req.resume();
        return;
      }
      const body = await readBody(req);
      const account = accountsStore.verify(body.username, body.password);
      if (!account) {
        accountsStore.audit({
          username: cleanText(body.username, 64) || "unknown",
          action: "login.failed",
          method: "POST",
          path: "/admin-api/login",
          status: 403,
          ip,
          userAgent: req.headers["user-agent"] || "",
        });
        json(res, 403, { ok: false, error: "账号或密码不正确。" });
        return;
      }
      const token = sessionStore.create({ username: account.username });
      res.setHeader("set-cookie", `${adminCookieName}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`);
      accountsStore.audit({
        username: account.username,
        action: "login.success",
        method: "POST",
        path: "/admin-api/login",
        status: 200,
        ip,
        userAgent: req.headers["user-agent"] || "",
      });
      json(res, 200, { ok: true, data: { username: account.username, permissions: account.permissions, mustChangePassword: account.mustChangePassword } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/logout") {
      sessionStore.revoke(cookie(req, adminCookieName));
      res.setHeader("set-cookie", [
        `${adminCookieName}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
        "nkustudy_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
      ]);
      json(res, 200, { ok: true });
      return;
    }

    const account = requireAuth(req, res);
    if (!account) return;

    if (req.method === "POST" && url.pathname === "/admin-api/upload") {
      if (!requirePermission(req, account, "content.edit", res)) return;
      await runExclusiveR2Mutation({ queue: r2MutationQueue, mutate: () => handleUpload(req, res, url) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/sync-r2") {
      if (!requirePermission(req, account, "storage.manage", res)) return;
      const body = await readBody(req);
      const result = await syncCourseFromR2(body.courseId, body.expectedRevision);
      json(res, 200, syncCourseResponse(result));
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/sync-r2-all") {
      if (!requirePermission(req, account, "storage.manage", res)) return;
      const body = await readBody(req);
      const result = await syncAllCoursesFromR2(body.expectedRevision);
      json(res, 200, { ok: true, ...result });
      return;
    }

    if (req.method === "POST" && ["/admin-api/delete-r2", "/admin-api/delete-r2-course", "/admin-api/move-r2-prefix"].includes(url.pathname)) {
      json(res, 410, { ok: false, error: "Unsafe legacy R2 mutation route is disabled; use /admin-api/r2-publish with manifest CAS." });
      req.resume();
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/r2-publish") {
      if (!requirePermission(req, account, "storage.manage", res)) return;
      const body = await readBody(req);
      const result = await safeR2ManifestPublish(body);
      json(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/backup") {
      if (!requirePermission(req, account, "backup.manage", res)) return;
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
      if (!requirePermission(req, account, "backup.manage", res)) return;
      json(res, 200, { ok: true, data: publicBackupSettings() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/backup-settings") {
      if (!requirePermission(req, account, "backup.manage", res)) return;
      const body = await readBody(req);
      json(res, 200, { ok: true, data: await writeBackupSettings(body.data || {}) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/editor-settings") {
      if (!requirePermission(req, account, "content.read", res)) return;
      json(res, 200, { ok: true, data: publicEditorSettings() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/editor-settings") {
      if (!requirePermission(req, account, "content.edit", res)) return;
      const body = await readBody(req);
      json(res, 200, { ok: true, data: await writeEditorSettings(body.data || {}) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/backup-run") {
      if (!requirePermission(req, account, "backup.manage", res)) return;
      const result = await runBackupJob({ manual: true });
      json(res, result.ok === false ? 409 : 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/backup-test-webdav") {
      if (!requirePermission(req, account, "backup.manage", res)) return;
      const body = await readBody(req);
      const result = await testWebdavDestination(body.destination || {});
      json(res, result.ok ? 200 : 400, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/visit-stats") {
      if (!requirePermission(req, account, "content.read", res)) return;
      json(res, 200, { ok: true, stats: readVisitStats(), summary: publicVisitStats() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/home") {
      if (!requirePermission(req, account, "content.read", res)) return;
      json(res, 200, { ok: true, ...await readPublishedContent(homePath, normalizeHome) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/home") {
      if (!requirePermission(req, account, "content.edit", res)) return;
      const body = await readBody(req);
      const result = await publishContent(homePath, body.data || {}, body.expectedRevision, normalizeHome);
      json(res, result.ok ? 200 : result.statusCode || 400, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/footer") {
      if (!requirePermission(req, account, "content.read", res)) return;
      json(res, 200, { ok: true, ...await readPublishedContent(footerPath, normalizeFooter) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/footer") {
      if (!requirePermission(req, account, "content.edit", res)) return;
      const body = await readBody(req);
      const result = await publishContent(footerPath, body.data || {}, body.expectedRevision, normalizeFooter);
      json(res, result.ok ? 200 : result.statusCode || 400, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/about") {
      if (!requirePermission(req, account, "content.read", res)) return;
      json(res, 200, { ok: true, ...await readPublishedContent(aboutPath, normalizeAbout) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/about") {
      if (!requirePermission(req, account, "content.edit", res)) return;
      const body = await readBody(req);
      const result = await publishContent(aboutPath, body.data || {}, body.expectedRevision, normalizeAbout);
      json(res, result.ok ? 200 : result.statusCode || 400, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/participate") {
      if (!requirePermission(req, account, "content.read", res)) return;
      json(res, 200, { ok: true, ...await readPublishedContent(participatePath, normalizeParticipate) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/participate") {
      if (!requirePermission(req, account, "content.edit", res)) return;
      const body = await readBody(req);
      const result = await publishContent(participatePath, body.data || {}, body.expectedRevision, normalizeParticipate);
      json(res, result.ok ? 200 : result.statusCode || 400, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/links") {
      if (!requirePermission(req, account, "content.read", res)) return;
      json(res, 200, { ok: true, ...await readPublishedContent(linksPath, normalizeLinks) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/links") {
      if (!requirePermission(req, account, "content.edit", res)) return;
      const body = await readBody(req);
      const result = await publishContent(linksPath, body.data || {}, body.expectedRevision, normalizeLinks);
      json(res, result.ok ? 200 : result.statusCode || 400, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/feedback") {
      if (!requirePermission(req, account, "content.read", res)) return;
      json(res, 200, { ok: true, ...await readPublishedContent(feedbackPath, normalizeFeedbackData) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/feedback") {
      if (!requirePermission(req, account, "content.moderate", res)) return;
      const body = await readBody(req);
      const result = await publishContent(feedbackPath, body.data || {}, body.expectedRevision, normalizeFeedbackData);
      json(res, result.ok ? 200 : result.statusCode || 400, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/reviews") {
      if (!requirePermission(req, account, "content.read", res)) return;
      json(res, 200, { ok: true, ...await readReviewStore() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/reviews") {
      if (!requirePermission(req, account, "content.edit", res)) return;
      const body = await readBody(req);
      json(res, 200, { ok: true, ...await updateReviewStore(body.data || {}, body.expectedRevision) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/session") {
      const reviewData = readReviews();
      const feedbackData = readFeedback();
      json(res, 200, { ok: true, data: {
        username: account.username,
        permissions: account.permissions,
        mustChangePassword: account.mustChangePassword,
        pendingReviews: (reviewData.reviews || []).filter((review) => String(review.status || "pending") === "pending" && !review.hidden).length,
        openFeedback: (feedbackData.items || []).filter((item) => !item.hidden && String(item.status || "open") === "open").length,
      } });
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/manifest") {
      if (!requirePermission(req, account, "content.read", res)) return;
      json(res, 200, { ok: true, ...await manifestService.readWithRevision() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/manifest") {
      if (!requirePermission(req, account, "content.edit", res)) return;
      const body = await readBody(req);
      const result = await publish(body.manifest, { expectedRevision: body.expectedRevision, deletedCourseUids: body.deletedCourseUids });
      json(res, result.ok ? 200 : result.statusCode || 400, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/manifest-draft") {
      if (!requirePermission(req, account, "content.edit", res)) return;
      const body = await readBody(req);
      const result = await saveManifestDraft(body.manifest, { expectedRevision: body.expectedRevision, deletedCourseUids: body.deletedCourseUids });
      json(res, result.ok ? 200 : result.statusCode || 400, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/notify-settings") {
      if (!requirePermission(req, account, "backup.manage", res)) return;
      json(res, 200, { ok: true, data: await feishuNotify.describe() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/notify-bots") {
      if (!requirePermission(req, account, "backup.manage", res)) return;
      const body = await readBody(req);
      try {
        const data = await feishuNotify.upsertBot(body);
        json(res, 200, { ok: true, data });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
      return;
    }

    const notifyBotMatch = url.pathname.match(/^\/admin-api\/notify-bots\/([^/]+)$/);
    if (req.method === "DELETE" && notifyBotMatch) {
      if (!requirePermission(req, account, "backup.manage", res)) return;
      const result = await feishuNotify.removeBot(decodePathPart(notifyBotMatch[1]));
      json(res, 200, { ok: true, data: result });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/notify-test") {
      if (!requirePermission(req, account, "backup.manage", res)) return;
      const body = await readBody(req).catch(() => ({}));
      const described = await feishuNotify.describe();
      const bots = described.bots || [];
      const target = body.botId ? bots.find((bot) => bot.id === body.botId) : bots.find((bot) => bot.enabled);
      if (!target) {
        json(res, 400, { ok: false, error: "没有可测试的机器人。" });
        return;
      }
      const result = await feishuNotify.sendToBot(target.id, { title: "NKUStudy 通知测试", lines: [`**机器人**：${target.name}`, "这是一条测试卡片，仅发送给该机器人。", `**触发人**：${account.username}`] });
      json(res, result.sent ? 200 : 400, { ok: result.sent, ...(result.sent ? { data: { bot: target.name } } : { error: `发送失败：${result.reason}` }) });
      return;
    }

    const mpUserBlockMatch = url.pathname.match(/^\/admin-api\/mp-users\/([^/]+)\/blocked$/);
    if (req.method === "POST" && mpUserBlockMatch) {
      if (!requirePermission(req, account, "content.moderate", res)) return;
      const body = await readBody(req);
      try {
        const data = mpAuthService.setUserBlocked(decodePathPart(mpUserBlockMatch[1]), body.blocked === true);
        json(res, 200, { ok: true, data: { id: data.id, blocked: data.blocked === 1 } });
      } catch (error) {
        json(res, Number(error.statusCode) || 400, { ok: false, error: error.message });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/mp-users") {
      if (!requirePermission(req, account, "content.read", res)) return;
      const beijingDay = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const dayStartMs = Date.parse(`${beijingDay}T00:00:00+08:00`);
      json(res, 200, { ok: true, data: mpAuthService.adminOverview({ dayStartMs }) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/service-keys") {
      if (!requirePermission(req, account, "services.manage", res)) return;
      json(res, 200, { ok: true, data: await serviceAuthStore.list() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/service-keys") {
      if (!requirePermission(req, account, "services.manage", res)) return;
      const body = await readBody(req);
      try {
        const created = await serviceAuthStore.create({ name: body.name, note: body.note, dailyQuota: body.daily_quota });
        json(res, 200, { ok: true, data: created });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/service-keys-settings") {
      if (!requirePermission(req, account, "services.manage", res)) return;
      const body = await readBody(req);
      try {
        const settings = await serviceAuthStore.writeSettings(body.settings || body || {});
        json(res, 200, { ok: true, data: settings });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
      return;
    }

    const serviceKeyEnabledMatch = url.pathname.match(/^\/admin-api\/service-keys\/([^/]+)\/enabled$/);
    if (req.method === "POST" && serviceKeyEnabledMatch) {
      if (!requirePermission(req, account, "services.manage", res)) return;
      const body = await readBody(req);
      try {
        await serviceAuthStore.setEnabled(decodePathPart(serviceKeyEnabledMatch[1]), body.enabled === true);
        json(res, 200, { ok: true, data: await serviceAuthStore.list() });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
      return;
    }

    const serviceKeyQuotaMatch = url.pathname.match(/^\/admin-api\/service-keys\/([^/]+)\/daily-quota$/);
    if (req.method === "POST" && serviceKeyQuotaMatch) {
      if (!requirePermission(req, account, "services.manage", res)) return;
      const body = await readBody(req);
      try {
        await serviceAuthStore.setDailyQuota(decodePathPart(serviceKeyQuotaMatch[1]), body.daily_quota);
        json(res, 200, { ok: true, data: await serviceAuthStore.list() });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
      return;
    }

    const serviceKeyMatch = url.pathname.match(/^\/admin-api\/service-keys\/([^/]+)$/);
    if (req.method === "DELETE" && serviceKeyMatch) {
      if (!requirePermission(req, account, "services.manage", res)) return;
      try {
        await serviceAuthStore.remove(decodePathPart(serviceKeyMatch[1]));
        json(res, 200, { ok: true, data: await serviceAuthStore.list() });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/accounts") {
      if (!requirePermission(req, account, "accounts.manage", res)) return;
      json(res, 200, { ok: true, data: { accounts: accountsStore.list(), permissionPoints: ADMIN_PERMISSION_POINTS, rolePresets: ADMIN_ROLE_PRESETS } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/accounts") {
      if (!requirePermission(req, account, "accounts.manage", res)) return;
      const body = await readBody(req);
      try {
        const created = accountsStore.create({
          username: body.username,
          password: body.password,
          permissions: body.permissions,
          mustChangePassword: body.mustChangePassword !== false,
          createdBy: account.username,
        });
        json(res, 200, { ok: true, data: created });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
      return;
    }

    const accountPatchMatch = url.pathname.match(/^\/admin-api\/accounts\/([^/]+)$/);
    if (req.method === "PATCH" && accountPatchMatch && /^\d+$/.test(accountPatchMatch[1])) {
      if (!requirePermission(req, account, "accounts.manage", res)) return;
      const body = await readBody(req);
      try {
        const updated = accountsStore.updateSettings(Number(accountPatchMatch[1]), {
          permissions: body.permissions,
          enabled: body.enabled,
          mustChangePassword: body.mustChangePassword,
        });
        json(res, 200, { ok: true, data: updated });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
      return;
    }

    const accountPasswordMatch = url.pathname.match(/^\/admin-api\/accounts\/([^/]+)$/);
    if (req.method === "POST" && accountPasswordMatch && /^\d+$/.test(accountPasswordMatch[1])) {
      if (!requirePermission(req, account, "accounts.manage", res)) return;
      const body = await readBody(req);
      try {
        accountsStore.setPassword(Number(accountPasswordMatch[1]), body.password, { forceChangeNextLogin: body.mustChangePassword === true });
        json(res, 200, { ok: true });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
      return;
    }

    const accountDeleteMatch = url.pathname.match(/^\/admin-api\/accounts\/([^/]+)$/);
    if (req.method === "DELETE" && accountDeleteMatch && /^\d+$/.test(accountDeleteMatch[1])) {
      if (!requirePermission(req, account, "accounts.manage", res)) return;
      try {
        accountsStore.remove(Number(accountDeleteMatch[1]), { actorUsername: account.username });
        json(res, 200, { ok: true });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin-api/me/password") {
      const body = await readBody(req);
      const fresh = accountsStore.verify(account.username, body.currentPassword);
      if (!fresh) {
        json(res, 403, { ok: false, error: "当前密码不正确。" });
        return;
      }
      try {
        accountsStore.setPassword(account.id, body.newPassword);
        json(res, 200, { ok: true });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin-api/audit") {
      if (!requirePermission(req, account, "audit.read", res)) return;
      const data = accountsStore.queryAudit({
        page: url.searchParams.get("page") || 1,
        pageSize: url.searchParams.get("page_size") || 50,
        username: cleanText(url.searchParams.get("username") || "", 64),
        action: cleanText(url.searchParams.get("action") || "", 64),
      });
      json(res, 200, { ok: true, data });
      return;
    }

    json(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    const statusCode = Number(error.statusCode) || 500;
    const authenticatedAdmin = Boolean(url?.pathname.startsWith("/admin-api/") && sessionStore.validate(cookie(req, adminCookieName)));
    if (statusCode >= 500) console.error(`Request failed (${req.method} ${url?.pathname || "unknown"}): ${error.message}`);
    json(res, statusCode, {
      ok: false,
      error: statusCode < 500 || authenticatedAdmin ? error.message : "Internal server error.",
      currentRevision: error.currentRevision,
    });
  }
});

server.listen(port, host, () => {
  console.log(`NKUStudy admin API listening on http://${host}:${port}`);
  startBackupScheduler();
  startDigestScheduler();
  uploadPendingAuditArchive().catch(() => {});
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of activeChildren) terminateChildTree(child);
  server.close(() => {
    try {
      sessionStore.close();
      accountsStore.close();
      mpAuthService.close();
      mpFavoritesService.close();
      rateLimiter.close();
      process.exit(0);
    } catch (error) {
      console.error(`Shutdown after ${signal} failed: ${error.message}`);
      process.exit(1);
    }
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
