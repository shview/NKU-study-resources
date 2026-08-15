import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const RELEASE_NAME = /^release-\d+-[a-f0-9]+$/;
const BUILD_NAME = /^\.building-release-\d+-[a-f0-9]+$/;

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export async function syncDirectory(directory, { open = fsp.open, platform = process.platform } = {}) {
  // Node/Windows does not provide a portable directory-fsync primitive.
  if (platform === "win32") return { supported: false };
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP"]).has(error.code)) throw error;
    return { supported: false };
  } finally {
    await handle?.close().catch(() => {});
  }
  return { supported: true };
}

async function normalizeStaticTree(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Static build output must not contain symlinks: ${entryPath}`);
    if (entry.isDirectory()) {
      await normalizeStaticTree(entryPath);
      await fsp.chmod(entryPath, 0o755);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Static build output contains an unsupported file type: ${entryPath}`);
    await fsp.chmod(entryPath, 0o644);
  }
  await fsp.chmod(directory, 0o755);
}

export function validateStaticReleasePaths({ publicDir, releaseRoot, production = process.env.NODE_ENV === "production" } = {}) {
  if (!publicDir || !releaseRoot) throw new Error("Static publishing requires PUBLIC_DIR and PUBLIC_RELEASES_DIR.");
  const resolvedPublicDir = path.resolve(publicDir);
  const resolvedReleaseRoot = path.resolve(releaseRoot);
  const publishRoot = path.dirname(resolvedPublicDir);
  if (resolvedPublicDir === resolvedReleaseRoot || inside(resolvedReleaseRoot, resolvedPublicDir)) {
    throw new Error("PUBLIC_DIR must not be inside PUBLIC_RELEASES_DIR.");
  }
  if (production && path.dirname(resolvedReleaseRoot) !== publishRoot) {
    throw new Error("PUBLIC_DIR and PUBLIC_RELEASES_DIR must be siblings in one service-owned publish directory.");
  }
  if (production && path.basename(resolvedPublicDir) !== "current") {
    throw new Error("Production PUBLIC_DIR must be the current symlink inside the service-owned publish directory.");
  }
  return { publicDir: resolvedPublicDir, releaseRoot: resolvedReleaseRoot, publishRoot };
}

export class StaticReleasePublisher {
  constructor({ publicDir, releaseRoot, distDir, production = process.env.NODE_ENV === "production", keepReleases = 5, syncDirectoryFn = syncDirectory } = {}) {
    const layout = validateStaticReleasePaths({ publicDir, releaseRoot, production });
    if (!distDir) throw new Error("Static publishing requires a distDir.");
    this.publicDir = layout.publicDir;
    this.releaseRoot = layout.releaseRoot;
    this.publishRoot = layout.publishRoot;
    this.distDir = path.resolve(distDir);
    this.production = production;
    this.keepReleases = Math.max(2, Number(keepReleases) || 5);
    this.syncDirectory = syncDirectoryFn;
    this.queue = Promise.resolve();
  }

  enqueue(operation) {
    const current = this.queue.catch(() => {}).then(operation);
    this.queue = current;
    return current;
  }

  readDeploymentProof() {
    let publicStat;
    try {
      publicStat = fs.lstatSync(this.publicDir);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (!publicStat.isSymbolicLink()) throw new Error(`PUBLIC_DIR must be a symlink: ${this.publicDir}`);
    let target;
    try {
      target = path.resolve(fs.realpathSync(this.publicDir));
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`PUBLIC_DIR symlink is dangling: ${this.publicDir}`, { cause: error });
      throw error;
    }
    if (!inside(this.releaseRoot, target) || !RELEASE_NAME.test(path.basename(target))) {
      throw new Error(`PUBLIC_DIR must point to a managed release inside ${this.releaseRoot}.`);
    }
    return { activeTarget: target };
  }

  async recoverStartup() {
    if (!this.production) {
      await fsp.mkdir(this.publishRoot, { recursive: true });
      await fsp.mkdir(this.releaseRoot, { recursive: true });
    }
    await this.#assertWritableLayout();
    const escapedPublicName = path.basename(this.publicDir).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tempName = new RegExp(`^\\.${escapedPublicName}\\.next-\\d+-\\d+-[a-f0-9]{4}$`);
    for (const entry of await fsp.readdir(this.publishRoot, { withFileTypes: true })) {
      if (tempName.test(entry.name) && entry.isSymbolicLink()) {
        await fsp.unlink(path.join(this.publishRoot, entry.name));
      }
    }
    for (const entry of await fsp.readdir(this.releaseRoot, { withFileTypes: true })) {
      if (BUILD_NAME.test(entry.name) && entry.isDirectory()) {
        await fsp.rm(path.join(this.releaseRoot, entry.name), { recursive: true, force: true });
      }
    }
    if (this.production || fs.existsSync(this.publicDir)) this.readDeploymentProof();
  }

  publish(build) {
    if (typeof build !== "function") throw new Error("Static publishing requires a build callback.");
    return this.enqueue(async () => {
      await build();
      await this.#assertWritableLayout();
      return this.#publishBuiltTree();
    });
  }

  async #assertWritableLayout() {
    const publishStat = await fsp.lstat(this.publishRoot);
    const releaseStat = await fsp.lstat(this.releaseRoot);
    if (!publishStat.isDirectory() || publishStat.isSymbolicLink()) throw new Error(`Static publish root must be a real directory: ${this.publishRoot}`);
    if (!releaseStat.isDirectory() || releaseStat.isSymbolicLink()) throw new Error(`PUBLIC_RELEASES_DIR must be a real directory: ${this.releaseRoot}`);
    await fsp.access(this.publishRoot, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    await fsp.access(this.releaseRoot, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    if (this.production) {
      let publicStat;
      try {
        publicStat = await fsp.lstat(this.publicDir);
      } catch (error) {
        if (error.code === "ENOENT") throw new Error(`PUBLIC_DIR symlink is missing before production publishing: ${this.publicDir}`, { cause: error });
        throw error;
      }
      if (!publicStat.isSymbolicLink()) throw new Error(`PUBLIC_DIR must be a symlink before atomic production publishing: ${this.publicDir}`);
    }
  }

  async #publishBuiltTree() {
    const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    const buildingDir = path.join(this.releaseRoot, `.building-release-${suffix}`);
    const releaseDir = path.join(this.releaseRoot, `release-${suffix}`);
    const tempLink = path.join(this.publishRoot, `.${path.basename(this.publicDir)}.next-${process.pid}-${Date.now()}-${randomBytes(2).toString("hex")}`);
    let switched = false;
    try {
      await fsp.cp(this.distDir, buildingDir, { recursive: true, errorOnExist: true, force: false });
      await normalizeStaticTree(buildingDir);
      await fsp.rename(buildingDir, releaseDir);
      await fsp.symlink(releaseDir, tempLink, process.platform === "win32" ? "junction" : "dir");
      // Windows cannot atomically replace a directory junction. Production is
      // Linux; this fallback keeps local fixture development usable.
      if (process.platform === "win32") {
        try {
          await fsp.unlink(this.publicDir);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      await fsp.rename(tempLink, this.publicDir);
      switched = true;

      const warnings = [];
      try {
        const result = await this.syncDirectory(this.publishRoot);
        if (result?.supported === false) warnings.push("publish directory fsync is unsupported on this platform or filesystem");
      } catch (error) {
        warnings.push(`publish directory sync failed: ${error.message}`);
      }
      try {
        const result = await this.#pruneOldReleases(releaseDir);
        if (result?.supported === false) warnings.push("release directory fsync is unsupported on this platform or filesystem");
      } catch (error) {
        warnings.push(`old release cleanup failed: ${error.message}`);
      }
      return { activeTarget: releaseDir, ...(warnings.length ? { warnings } : {}) };
    } catch (error) {
      await fsp.rm(tempLink, { force: true }).catch(() => {});
      await fsp.rm(buildingDir, { recursive: true, force: true }).catch(() => {});
      if (!switched) await fsp.rm(releaseDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async #pruneOldReleases(activeRelease) {
    const releases = [];
    for (const entry of await fsp.readdir(this.releaseRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !RELEASE_NAME.test(entry.name)) continue;
      const entryPath = path.join(this.releaseRoot, entry.name);
      const stat = await fsp.lstat(entryPath);
      releases.push({ path: entryPath, mtimeMs: stat.mtimeMs });
    }
    releases.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const retained = new Set(releases.slice(0, this.keepReleases).map((entry) => entry.path));
    retained.add(path.resolve(activeRelease));
    for (const release of releases) {
      if (!retained.has(path.resolve(release.path))) await fsp.rm(release.path, { recursive: true, force: true });
    }
    return this.syncDirectory(this.releaseRoot);
  }
}
