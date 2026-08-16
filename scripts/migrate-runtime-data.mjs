import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AtomicJsonStore } from "../server/atomic-json-store.mjs";
import { DATA_ROOT_SENTINEL, DATA_ROOT_SENTINEL_CONTENT } from "../server/runtime-config.mjs";
import { validateManifest } from "../server/manifest-schema.mjs";
import { assertNoReplacementCharacters, decodeUtf8Strict } from "../server/text-integrity.mjs";

const REQUIRED_FILES = ["manifest.json", "reviews.json", "home.json", "about.json", "participate.json", "links.json", "footer.json"];
const OPTIONAL_FILES = ["guides.json", "feedback.json", "visit-stats.json", "editor-settings.json", "backup-settings.json"];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableUid(course) {
  const digest = createHash("sha256")
    .update([course.id, course.title, course.term, course.group, course.basePath].map((value) => String(value || "").normalize("NFKC")).join("\0"), "utf8")
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalPath(value, { directory, label }) {
  const original = String(value ?? "").trim();
  if (!original) throw new Error(`${label} is empty.`);
  if (/^[a-z]:/i.test(original) || /^[a-z][a-z0-9+.-]*:\/\//i.test(original) || original.includes("\0")) {
    throw new Error(`${label} is not a public relative path.`);
  }
  const replaced = original.replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/^\/+/, "").replace(/\/\.\//g, "/");
  const parts = replaced.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) throw new Error(`${label} contains a non-canonical segment.`);
  return `${parts.join("/")}${directory ? "/" : ""}`;
}

function recordCounts(manifest, reviews) {
  return {
    courses: manifest.courses?.length || 0,
    reviews: reviews.reviews?.length || 0,
    resources: (manifest.courses || []).reduce((total, course) => total + (course.sections || []).reduce((sectionTotal, section) => sectionTotal + (section.files || []).length, 0), 0),
  };
}

function migrateManifest(source) {
  const manifest = structuredClone(source);
  const changes = { uidAdded: [], basePathNormalized: [], filePathNormalized: [], internalFieldsRemoved: [] };

  for (const course of manifest.courses || []) {
    const label = course.title || course.id || "unknown course";
    if (!course.uid) {
      course.uid = stableUid(course);
      changes.uidAdded.push({ id: String(course.id || ""), title: String(course.title || ""), uid: course.uid });
    }
    if (Object.hasOwn(course, "source")) {
      delete course.source;
      changes.internalFieldsRemoved.push(`course:${course.uid}:source`);
    }
    const canonicalBase = canonicalPath(course.basePath, { directory: true, label: `${label}: basePath` });
    if (canonicalBase !== course.basePath) {
      changes.basePathNormalized.push({ uid: course.uid, from: course.basePath, to: canonicalBase });
      course.basePath = canonicalBase;
    }
    for (const section of course.sections || []) {
      for (const file of section.files || []) {
        const canonicalFile = canonicalPath(file.path, { directory: false, label: `${label}/${section.title}/${file.title}` });
        if (canonicalFile !== file.path) {
          changes.filePathNormalized.push({ uid: course.uid, title: String(file.title || ""), from: file.path, to: canonicalFile });
          file.path = canonicalFile;
        }
      }
    }
  }
  return { manifest, changes };
}

function reviewVisibility(review) {
  const status = normalized(review?.status);
  if (["approved", "通过"].includes(status) && review?.hidden !== true) return "public API and website";
  if (["approved", "通过"].includes(status)) return "approved but hidden";
  return "moderation queue only";
}

function validateReviews(reviewData) {
  const issues = [];
  if (!reviewData || typeof reviewData !== "object" || !Array.isArray(reviewData.reviews)) {
    return [{ scope: "reviews", index: null, id: "", reason: "reviews.json must contain a reviews array", apiVisibilityImpact: "all reviews unavailable" }];
  }
  const ids = new Set();
  for (const [index, review] of reviewData.reviews.entries()) {
    const id = normalized(review?.id);
    const status = normalized(review?.status);
    const visibility = reviewVisibility(review);
    const add = (reason) => issues.push({ scope: "review", index, id, reason, apiVisibilityImpact: visibility });
    if (!id) add("id is required");
    else if (ids.has(id)) add(`duplicate id ${id}`);
    ids.add(id);
    if (!status) add("status is required");
    const rating = Number(review?.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) add("rating must be an integer from 1 to 5");
    if (["approved", "通过"].includes(status)) {
      if (!normalized(review?.courseTitle)) add("approved review courseTitle is required");
      if (!normalized(review?.teacher)) add("approved review teacher is required");
      if (!normalized(review?.content)) add("approved review content/body is required");
    }
  }
  for (const field of ["count", "total", "reviewCount"]) {
    if (Object.hasOwn(reviewData, field) && Number(reviewData[field]) !== reviewData.reviews.length) {
      issues.push({
        scope: "reviews",
        index: null,
        id: "",
        reason: `${field}=${reviewData[field]} does not equal reviews.length=${reviewData.reviews.length}`,
        apiVisibilityImpact: "reported totals may disagree with visible records",
      });
    }
  }
  return issues;
}

function requiredInventoryKeys(manifest, changes, r2Prefix = "resources") {
  const baseChanged = new Set(changes.basePathNormalized.map((change) => change.uid));
  const fileChanged = new Set(changes.filePathNormalized.map((change) => `${change.uid}\0${change.to}`));
  const keys = [];
  for (const course of manifest.courses || []) {
    for (const section of course.sections || []) {
      for (const file of section.files || []) {
        if (baseChanged.has(course.uid) || fileChanged.has(`${course.uid}\0${file.path}`)) {
          keys.push(`${r2Prefix}/${course.basePath}${file.path}`);
        }
      }
    }
  }
  return [...new Set(keys)].sort();
}

async function verifyR2Inventory(inventoryPath, requiredKeys) {
  if (!inventoryPath) throw new Error("Path changes require --r2-inventory=<server-generated-json-file>.");
  const raw = JSON.parse(await fs.readFile(path.resolve(inventoryPath), "utf8"));
  const entries = Array.isArray(raw) ? raw : raw.objects || raw.Contents;
  if (!Array.isArray(entries)) throw new Error("R2 inventory must be an array or contain objects/Contents.");
  const keys = new Set(entries.map((entry) => typeof entry === "string" ? entry : entry?.Key).filter((key) => typeof key === "string"));
  const missing = requiredKeys.filter((key) => !keys.has(key));
  if (missing.length) throw new Error(`R2 inventory is missing ${missing.length} normalized exact key(s):\n${missing.join("\n")}`);
  return { inventoryPath: path.resolve(inventoryPath), verifiedKeys: requiredKeys.length };
}

function normalized(value) {
  return String(value ?? "").trim();
}

async function loadFiles(sourceDir) {
  const files = {};
  const bytes = {};
  for (const filename of REQUIRED_FILES) {
    const fileBytes = await fs.readFile(path.join(sourceDir, filename));
    bytes[filename] = fileBytes;
    files[filename] = JSON.parse(decodeUtf8Strict(fileBytes, filename));
    assertNoReplacementCharacters(files[filename], filename);
  }
  for (const filename of OPTIONAL_FILES) {
    try {
      const fileBytes = await fs.readFile(path.join(sourceDir, filename));
      bytes[filename] = fileBytes;
      files[filename] = JSON.parse(decodeUtf8Strict(fileBytes, filename));
      assertNoReplacementCharacters(files[filename], filename);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { files, bytes };
}

export async function planRuntimeDataMigration({ sourceDir, targetDir } = {}) {
  if (!sourceDir || !targetDir) throw new Error("sourceDir and targetDir are required.");
  const source = path.resolve(sourceDir);
  const target = path.resolve(targetDir);
  if (source === target) throw new Error("Source and target must differ; this migration performs a one-time data-directory cutover.");
  const { files, bytes } = await loadFiles(source);
  const { manifest, changes } = migrateManifest(files["manifest.json"]);
  changes.pathChangeCount = changes.basePathNormalized.length + changes.filePathNormalized.length;
  changes.requiredR2Keys = requiredInventoryKeys(manifest, changes);
  const migratedFiles = { ...files, "manifest.json": manifest };
  const schemaErrors = validateManifest(manifest);
  const duplicateTitles = [];
  const seenTitles = new Set();
  for (const course of manifest.courses || []) {
    const title = normalized(course.title);
    if (seenTitles.has(title)) duplicateTitles.push(`Duplicate normalized course title requires a source-data decision: ${course.title}`);
    seenTitles.add(title);
  }
  const titles = new Set((manifest.courses || []).map((course) => normalized(course.title)));
  const unmatchedReviews = (files["reviews.json"].reviews || [])
    .filter((review) => !titles.has(normalized(review.courseTitle)))
    .map((review) => ({ id: String(review.id || ""), courseTitle: String(review.courseTitle || ""), teacher: String(review.teacher || "") }));
  const before = recordCounts(files["manifest.json"], files["reviews.json"]);
  const after = recordCounts(manifest, migratedFiles["reviews.json"]);
  const deletions = {
    courses: Math.max(0, before.courses - after.courses),
    reviews: Math.max(0, before.reviews - after.reviews),
    resources: Math.max(0, before.resources - after.resources),
    items: [],
  };
  const report = {
    schema: "nkustudy-runtime-migration-plan-v1",
    sourceDir: source,
    targetDir: target,
    sourceHashes: Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, sha256(value)]).sort(([a], [b]) => a.localeCompare(b))),
    before,
    after,
    changes,
    deletions,
    unmatchedReviews,
    manualFixRequired: [
      ...schemaErrors.map((reason) => ({ scope: "manifest", index: null, id: "", reason, apiVisibilityImpact: "course or resource may be unreachable" })),
      ...duplicateTitles.map((reason) => ({ scope: "manifest", index: null, id: "", reason, apiVisibilityImpact: "review-to-course matching is ambiguous" })),
      ...validateReviews(files["reviews.json"]),
    ],
  };
  const planSha256 = sha256(JSON.stringify(report));
  return { report: { ...report, planSha256 }, migratedFiles };
}

export function assertMigrationApproval(report, { confirmUnmatched = 0, confirmDeletions = 0, confirmPathChanges = 0 } = {}) {
  const deletionCount = report.deletions.courses + report.deletions.reviews + report.deletions.resources;
  if (report.unmatchedReviews.length !== Number(confirmUnmatched)) {
    throw new Error(`Migration has ${report.unmatchedReviews.length} unmatched review(s); pass --confirm-unmatched=${report.unmatchedReviews.length} after review.`);
  }
  if (deletionCount !== Number(confirmDeletions)) {
    throw new Error(`Migration has ${deletionCount} record deletion(s); pass --confirm-deletions=${deletionCount} after review.`);
  }
  if (report.changes.pathChangeCount !== Number(confirmPathChanges)) {
    throw new Error(`Migration changes ${report.changes.pathChangeCount} path value(s); pass --confirm-path-changes=${report.changes.pathChangeCount} after reviewing possible logical data loss.`);
  }
  if (report.manualFixRequired.length) {
    const lines = report.manualFixRequired.map((issue) => typeof issue === "string" ? issue : `${issue.scope}${issue.index === null ? "" : `[${issue.index}]`}${issue.id ? ` id=${issue.id}` : ""}: ${issue.reason} (${issue.apiVisibilityImpact})`);
    throw new Error(`Source data needs manual correction before migration:\n${lines.join("\n")}`);
  }
}

async function copyBackup(sourceDir, backupDir, filenames, report) {
  await fs.mkdir(backupDir, { recursive: false, mode: 0o700 });
  await fs.chmod(backupDir, 0o700);
  for (const filename of filenames) {
    await fs.copyFile(path.join(sourceDir, filename), path.join(backupDir, filename));
    await fs.chmod(path.join(backupDir, filename), 0o600);
  }
  await fs.writeFile(path.join(backupDir, "migration-plan.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

export async function applyRuntimeDataMigration({ sourceDir, targetDir, backupDir, expectedPlanSha256, confirmUnmatched = 0, confirmDeletions = 0, confirmPathChanges = 0, r2Inventory } = {}) {
  if (!backupDir) throw new Error("backupDir is required for --write.");
  const { report, migratedFiles } = await planRuntimeDataMigration({ sourceDir, targetDir });
  if (!expectedPlanSha256 || expectedPlanSha256 !== report.planSha256) throw new Error("The expected plan SHA256 is missing or stale; rerun plan mode.");
  assertMigrationApproval(report, { confirmUnmatched, confirmDeletions, confirmPathChanges });
  const inventoryVerification = report.changes.pathChangeCount
    ? await verifyR2Inventory(r2Inventory, report.changes.requiredR2Keys)
    : { inventoryPath: null, verifiedKeys: 0 };

  const source = path.resolve(sourceDir);
  const target = path.resolve(targetDir);
  const backup = path.resolve(backupDir);
  const parent = path.dirname(target);
  const lockPath = `${target}.migration.lock`;
  const stage = `${target}.staging-${process.pid}-${report.planSha256.slice(0, 12)}`;
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  let lock;
  try {
    lock = await fs.open(lockPath, "wx", 0o600);
    await lock.writeFile(`${process.pid}\n${report.planSha256}\n`, "utf8");
    await lock.sync();
    try {
      await fs.lstat(target);
      throw new Error(`Target already exists; migration will not merge or overwrite it: ${target}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const latest = await loadFiles(source);
    for (const [filename, expected] of Object.entries(report.sourceHashes)) {
      if (sha256(latest.bytes[filename]) !== expected) throw new Error(`Source ${filename} changed after planning; no files were written.`);
    }
    await copyBackup(source, backup, Object.keys(report.sourceHashes), report);
    await fs.mkdir(stage, { mode: 0o700 });
    await fs.chmod(stage, 0o700);
    await fs.writeFile(path.join(stage, DATA_ROOT_SENTINEL), `${DATA_ROOT_SENTINEL_CONTENT}\n`, { mode: 0o600 });
    const store = new AtomicJsonStore({ allowedRoot: stage });
    for (const [filename, data] of Object.entries(migratedFiles)) {
      await store.write(path.join(stage, filename), data, { mode: 0o600 });
    }
    const staged = await loadFiles(stage);
    const stagedCounts = recordCounts(staged.files["manifest.json"], staged.files["reviews.json"]);
    if (JSON.stringify(stagedCounts) !== JSON.stringify(report.after)) throw new Error("Staged record counts differ from the approved plan.");
    await fs.rename(stage, target);
    return { written: true, targetDir: target, backupDir: backup, inventoryVerification, report };
  } finally {
    await lock?.close().catch(() => {});
    if (lock) await fs.rm(lockPath, { force: true });
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

function parseArgs(argv) {
  const value = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const known = new Set(["write"]);
  const named = new Set(["source-dir", "target-dir", "backup-dir", "expected-plan-sha256", "confirm-unmatched", "confirm-deletions", "confirm-path-changes", "r2-inventory"]);
  const unknown = argv.filter((arg) => arg.startsWith("--") && !known.has(arg.slice(2)) && !named.has(arg.slice(2).split("=", 1)[0]));
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
  return {
    write: argv.includes("--write"),
    sourceDir: value("source-dir"),
    targetDir: value("target-dir"),
    backupDir: value("backup-dir"),
    expectedPlanSha256: value("expected-plan-sha256"),
    confirmUnmatched: Number(value("confirm-unmatched") || 0),
    confirmDeletions: Number(value("confirm-deletions") || 0),
    confirmPathChanges: Number(value("confirm-path-changes") || 0),
    r2Inventory: value("r2-inventory"),
  };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const options = parseArgs(process.argv.slice(2));
  const result = options.write ? await applyRuntimeDataMigration(options) : await planRuntimeDataMigration(options);
  console.log(JSON.stringify(options.write ? result : result.report, null, 2));
}
