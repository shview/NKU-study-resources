import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

function sameVersion(left, right) {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  }
  return Object.is(left, right);
}

/** Synchronous loads cannot overlap in one process. Never retain a failed load. */
export class SnapshotCache {
  #entry = null;

  constructor({ load, readVersion, ttlMs = 3_000, now = () => performance.now() } = {}) {
    if (typeof load !== "function" || typeof readVersion !== "function" || typeof now !== "function") {
      throw new Error("SnapshotCache requires load, readVersion and now functions.");
    }
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error("Snapshot cache TTL must be non-negative.");
    this.load = load;
    this.readVersion = readVersion;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  get({ force = false } = {}) {
    try {
      let version = this.readVersion();
      const age = this.#entry ? this.now() - this.#entry.loadedAt : Infinity;
      if (!force && this.#entry && age >= 0 && age < this.ttlMs && sameVersion(version, this.#entry.version)) {
        return this.#entry.value;
      }
      this.#entry = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const value = this.load();
        const after = this.readVersion();
        if (sameVersion(version, after)) {
          this.#entry = { value, version: after, loadedAt: this.now() };
          return value;
        }
        version = after;
      }
      throw new Error("Runtime data changed while loading the public API snapshot.");
    } catch (error) {
      this.#entry = null;
      throw error;
    }
  }
}

/** Match AtomicJsonStore's path checks for the flat runtime JSON directory. */
export function runtimeJsonFingerprint(dataDir, filePaths) {
  const root = path.resolve(dataDir);
  const rootStat = fs.lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Runtime data root must be a real directory.");
  const fingerprints = [`${rootStat.dev}:${rootStat.ino}:${rootStat.mode}`];
  for (const filePath of filePaths) {
    const target = path.resolve(filePath);
    if (path.dirname(target) !== root) throw new Error("Cached runtime JSON must be directly inside the data root.");
    const stat = fs.lstatSync(target, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Cached runtime JSON must be a regular non-symlink file.");
    fingerprints.push(`${target}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`);
  }
  return fingerprints.join("|");
}
