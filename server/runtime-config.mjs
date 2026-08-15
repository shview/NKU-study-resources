import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_ROOT_SENTINEL = ".nkustudy-data-root";
export const DATA_ROOT_SENTINEL_CONTENT = "NKUSTUDY_RUNTIME_DATA_V1";
const coreDataFiles = ["manifest.json", "about.json", "home.json", "participate.json", "links.json", "footer.json"];

function requiredAbsoluteOutsideRelease(name, value) {
  if (!value) throw new Error(`${name} must be explicitly configured in production.`);
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path in production.`);
  const resolved = path.resolve(value);
  const relative = path.relative(projectRoot, resolved);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error(`${name} must be outside the release tree ${projectRoot}.`);
  }
  return resolved;
}

export function resolveDataDir(env = process.env) {
  if (env.NODE_ENV === "production") return requiredAbsoluteOutsideRelease("DATA_DIR", env.DATA_DIR);
  return path.resolve(env.DATA_DIR || path.join(projectRoot, "src", "data"));
}

export function resolveDataPath(filename, env = process.env) {
  if (!/^[a-z0-9][a-z0-9._-]*\.json$/i.test(filename)) throw new Error(`Invalid runtime data filename: ${filename}`);
  return path.join(resolveDataDir(env), filename);
}

export function resolveStateDbPath(env = process.env) {
  if (env.NODE_ENV === "production") return requiredAbsoluteOutsideRelease("STATE_DB_PATH", env.STATE_DB_PATH);
  return path.resolve(env.STATE_DB_PATH || path.join(resolveDataDir(env), "miniprogram.sqlite"));
}

export function resolveAdminSecretPath(env = process.env) {
  if (env.NODE_ENV === "production") return requiredAbsoluteOutsideRelease("ADMIN_SECRET_FILE", env.ADMIN_SECRET_FILE);
  return path.resolve(env.ADMIN_SECRET_FILE || path.join(projectRoot, ".admin-secret"));
}

export function resolvePublicDir(env = process.env) {
  if (env.NODE_ENV === "production") return requiredAbsoluteOutsideRelease("PUBLIC_DIR", env.PUBLIC_DIR);
  return path.resolve(env.PUBLIC_DIR || path.join(projectRoot, ".runtime-public", "current"));
}

export function resolvePublicReleasesDir(env = process.env) {
  if (env.NODE_ENV === "production") return requiredAbsoluteOutsideRelease("PUBLIC_RELEASES_DIR", env.PUBLIC_RELEASES_DIR);
  const publicDir = resolvePublicDir(env);
  return path.resolve(env.PUBLIC_RELEASES_DIR || path.join(path.dirname(publicDir), ".nkustudy-releases"));
}

export function runtimeDataPathMap(env = process.env) {
  return Object.freeze({
    manifest: resolveDataPath("manifest.json", env),
    reviews: resolveDataPath("reviews.json", env),
    feedback: resolveDataPath("feedback.json", env),
    about: resolveDataPath("about.json", env),
    home: resolveDataPath("home.json", env),
    participate: resolveDataPath("participate.json", env),
    links: resolveDataPath("links.json", env),
    footer: resolveDataPath("footer.json", env),
    editorSettings: resolveDataPath("editor-settings.json", env),
    visitStats: resolveDataPath("visit-stats.json", env),
    backupSettings: resolveDataPath("backup-settings.json", env),
  });
}

function assertSecureRegularFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file: ${filePath}`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error(`${label} permissions must not grant group/other access: ${filePath}`);
}

/** Must run before SQLite or any mutable file is created. */
export function preflightProductionRuntime(env = process.env) {
  const dataDir = resolveDataDir(env);
  const stateDbPath = resolveStateDbPath(env);
  const adminSecretPath = resolveAdminSecretPath(env);
  const publicDir = resolvePublicDir(env);
  const publicReleasesDir = resolvePublicReleasesDir(env);
  if (env.NODE_ENV !== "production") return { dataDir, stateDbPath, adminSecretPath, publicDir, publicReleasesDir };

  const dataStat = fs.lstatSync(dataDir);
  if (!dataStat.isDirectory() || dataStat.isSymbolicLink()) throw new Error(`DATA_DIR must be a real directory: ${dataDir}`);
  if (process.platform !== "win32" && (dataStat.mode & 0o077) !== 0) throw new Error(`DATA_DIR permissions must be 0700 or stricter: ${dataDir}`);
  const sentinelPath = path.join(dataDir, DATA_ROOT_SENTINEL);
  assertSecureRegularFile(sentinelPath, "DATA_DIR sentinel");
  if (fs.readFileSync(sentinelPath, "utf8").trim() !== DATA_ROOT_SENTINEL_CONTENT) throw new Error("DATA_DIR sentinel content is invalid.");
  for (const filename of coreDataFiles) {
    const filePath = path.join(dataDir, filename);
    assertSecureRegularFile(filePath, `Core data ${filename}`);
    try {
      JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new Error(`Core data ${filename} is not valid JSON: ${error.message}`);
    }
  }
  fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK);
  assertSecureRegularFile(adminSecretPath, "ADMIN_SECRET_FILE");
  const secret = fs.readFileSync(adminSecretPath, "utf8").trim();
  if (secret.length < 32) throw new Error("ADMIN_SECRET_FILE must contain at least 32 characters.");
  const stateParent = path.dirname(stateDbPath);
  fs.accessSync(stateParent, fs.constants.R_OK | fs.constants.W_OK);
  const stateParentStat = fs.lstatSync(stateParent);
  if (!stateParentStat.isDirectory() || stateParentStat.isSymbolicLink()) throw new Error("STATE_DB_PATH parent must be a real directory.");
  if (process.platform !== "win32" && (stateParentStat.mode & 0o077) !== 0) throw new Error("STATE_DB_PATH parent permissions must be 0700 or stricter.");
  if (fs.existsSync(stateDbPath)) assertSecureRegularFile(stateDbPath, "STATE_DB_PATH");
  return { dataDir, stateDbPath, adminSecretPath, publicDir, publicReleasesDir };
}

export const runtimeDataPaths = runtimeDataPathMap();
