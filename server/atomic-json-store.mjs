import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const queues = new Map();

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function renameReplacingWithoutDelete(source, destination) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fsp.rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!new Set(["EACCES", "EBUSY", "EEXIST", "EPERM"]).has(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fsp.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!new Set(["EACCES", "EBADF", "EINVAL", "ENOTSUP", "EPERM"]).has(error.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export class AtomicJsonStore {
  constructor({ faultHook, allowedRoot } = {}) {
    this.faultHook = faultHook;
    this.allowedRoot = allowedRoot ? path.resolve(allowedRoot) : null;
  }

  async read(filePath, { initialize } = {}) {
    const target = await this.#safeTarget(filePath, { createParent: initialize !== undefined });
    try {
      return JSON.parse(await fsp.readFile(target, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT" || initialize === undefined) throw error;
      const initialValue = typeof initialize === "function" ? initialize() : structuredClone(initialize);
      await this.write(target, initialValue, { mode: 0o600 });
      return structuredClone(initialValue);
    }
  }

  readSync(filePath, { initialize } = {}) {
    const target = this.#safeTargetSync(filePath);
    try {
      return JSON.parse(fs.readFileSync(target, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT" || initialize === undefined) throw error;
      throw new Error(`Synchronous initialization is disabled for ${target}; initialize it through AtomicJsonStore.read().`);
    }
  }

  write(filePath, value, options = {}) {
    return this.#enqueue(filePath, async () => this.#writeUnlocked(await this.#safeTarget(filePath, { createParent: true }), value, options));
  }

  update(filePath, updater, { initialize, afterWrite, rollbackOnAfterWriteError = false, ...writeOptions } = {}) {
    return this.#enqueue(filePath, async () => {
      const target = await this.#safeTarget(filePath, { createParent: initialize !== undefined });
      let current;
      try {
        current = JSON.parse(await fsp.readFile(target, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT" || initialize === undefined) throw error;
        current = typeof initialize === "function" ? initialize() : structuredClone(initialize);
      }
      const next = await updater(structuredClone(current));
      if (next === undefined) throw new Error("AtomicJsonStore updater must return the next JSON value.");
      await this.#writeUnlocked(target, next, writeOptions);
      if (afterWrite) {
        try {
          await afterWrite(structuredClone(next), structuredClone(current));
        } catch (error) {
          if (rollbackOnAfterWriteError) {
            await this.#writeUnlocked(target, current, writeOptions);
            error.atomicJsonRolledBack = true;
          }
          throw error;
        }
      }
      return structuredClone(next);
    });
  }

  #enqueue(filePath, operation) {
    const key = path.resolve(filePath);
    const previous = queues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    queues.set(key, current);
    return current.finally(() => {
      if (queues.get(key) === current) queues.delete(key);
    });
  }

  async #writeUnlocked(target, value, { mode } = {}) {
    const directory = path.dirname(target);
    await fsp.mkdir(directory, { recursive: true });
    const temp = path.join(directory, `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`);
    let handle;
    try {
      handle = await fsp.open(temp, "wx", mode ?? 0o600);
      await handle.writeFile(jsonText(value), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.faultHook?.("beforeRename", { target, temp });
      await renameReplacingWithoutDelete(temp, target);
      await fsp.chmod(target, mode ?? 0o600);
      await syncDirectory(directory);
      return structuredClone(value);
    } finally {
      await handle?.close().catch(() => {});
      await fsp.rm(temp, { force: true }).catch(() => {});
    }
  }

  async #safeTarget(filePath, { createParent = false } = {}) {
    const target = path.resolve(filePath);
    if (!this.allowedRoot) return target;
    const root = path.resolve(this.allowedRoot);
    if (!isWithin(root, target)) throw new Error(`JSON path is outside allowedRoot: ${target}`);
    const rootStat = await fsp.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`allowedRoot must be a real directory: ${root}`);
    const rootReal = await fsp.realpath(root);
    const parent = path.dirname(target);
    const relativeParent = path.relative(root, parent);
    let cursor = root;
    for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      try {
        const stat = await fsp.lstat(cursor);
        if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in JSON paths: ${cursor}`);
        if (!stat.isDirectory()) throw new Error(`JSON parent is not a directory: ${cursor}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (!createParent) throw error;
        await fsp.mkdir(cursor, { mode: 0o700 });
      }
    }
    const parentReal = await fsp.realpath(parent);
    if (!isWithin(rootReal, parentReal)) throw new Error(`JSON parent resolves outside allowedRoot: ${parent}`);
    try {
      const stat = await fsp.lstat(target);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic link JSON targets are not allowed: ${target}`);
      const targetReal = await fsp.realpath(target);
      if (!isWithin(rootReal, targetReal)) throw new Error(`JSON target resolves outside allowedRoot: ${target}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return target;
  }

  #safeTargetSync(filePath) {
    const target = path.resolve(filePath);
    if (!this.allowedRoot) return target;
    const root = path.resolve(this.allowedRoot);
    if (!isWithin(root, target)) throw new Error(`JSON path is outside allowedRoot: ${target}`);
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`allowedRoot must be a real directory: ${root}`);
    const rootReal = fs.realpathSync.native(root);
    let cursor = root;
    for (const segment of path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe JSON parent: ${cursor}`);
    }
    const parentReal = fs.realpathSync.native(path.dirname(target));
    if (!isWithin(rootReal, parentReal)) throw new Error(`JSON parent resolves outside allowedRoot: ${target}`);
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic link JSON targets are not allowed: ${target}`);
    }
    return target;
  }
}

export const jsonStore = new AtomicJsonStore();
