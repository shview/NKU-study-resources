import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AtomicJsonStore } from "../server/atomic-json-store.mjs";
import { assignMissingCourseUids, validateManifest } from "../server/manifest-schema.mjs";
import { resolveDataPath } from "../server/runtime-config.mjs";

export async function backfillCourseUids({
  manifestPath = resolveDataPath("manifest.json"),
  write = false,
  createUid = randomUUID,
  now = () => new Date(),
  store = new AtomicJsonStore({ allowedRoot: path.dirname(manifestPath) }),
  expectedHash,
} = {}) {
  const lockPath = `${manifestPath}.uid-migration.lock`;
  let lock;
  if (write) {
    if (!expectedHash) throw new Error("A deployment-captured expectedHash is required for --write.");
    try {
      lock = await fs.open(lockPath, "wx", 0o600);
      await lock.writeFile(`${process.pid}\n`, "utf8");
      await lock.sync();
    } catch (error) {
      if (error.code === "EEXIST") throw new Error(`Migration lock already exists: ${lockPath}. Stop the service and verify no migration is running.`);
      throw error;
    }
  }
  try {
  const originalBytes = await fs.readFile(manifestPath);
  const original = JSON.parse(originalBytes.toString("utf8"));
  const originalHash = createHash("sha256").update(originalBytes).digest("hex");
  if (write && expectedHash !== originalHash) throw new Error(`Manifest hash changed (expected ${expectedHash}, found ${originalHash}); aborting migration.`);
  const existingErrors = validateManifest({
    ...original,
    courses: (original.courses || []).filter((course) => course.uid),
  }).filter((error) => error.includes("uid"));
  if (existingErrors.length) throw new Error(existingErrors.join("\n"));

  const missing = (original.courses || []).filter((course) => !course.uid).length;
  const migrated = assignMissingCourseUids(structuredClone(original), { createUid });
  const errors = validateManifest(migrated);
  if (errors.length) throw new Error(errors.join("\n"));
  if (!write || missing === 0) return { written: false, missing, manifest: migrated, backupPath: null, expectedHash: originalHash };

  const stamp = now().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const backupPath = `${manifestPath}.bak.uid-${stamp}`;
  await fs.copyFile(manifestPath, backupPath, constants.COPYFILE_EXCL);
  await fs.chmod(backupPath, 0o600);
  const latestBytes = await fs.readFile(manifestPath);
  const latestHash = createHash("sha256").update(latestBytes).digest("hex");
  if (latestHash !== originalHash) throw new Error("Manifest changed during UID migration; refusing to overwrite it.");
  await store.write(manifestPath, migrated, { mode: 0o600 });
  return { written: true, missing, manifest: migrated, backupPath, expectedHash: originalHash };
  } finally {
    await lock?.close().catch(() => {});
    if (lock) await fs.rm(lockPath, { force: true });
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const write = process.argv.includes("--write");
  const expectedHashArg = process.argv.slice(2).find((arg) => arg.startsWith("--expected-sha256="));
  const expectedHash = expectedHashArg?.slice("--expected-sha256=".length);
  const unknown = process.argv.slice(2).filter((arg) => arg !== "--write" && arg !== expectedHashArg);
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
  const result = await backfillCourseUids({ write, expectedHash });
  console.log(`${write ? "Migration" : "Dry run"}: ${result.missing} course UID(s) missing. SHA256: ${result.expectedHash}.${result.written ? ` Backup: ${result.backupPath}` : ""}`);
}
