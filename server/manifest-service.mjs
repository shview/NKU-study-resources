import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { reconcileCourseUids, validateManifest } from "./manifest-schema.mjs";
import { ContentPublishJournal } from "./content-publish-service.mjs";
import { manifestRevision, ManifestConflictError } from "./content-revision.mjs";

export { manifestRevision, ManifestConflictError } from "./content-revision.mjs";

/**
 * The sole in-process mutation boundary for manifest.json. Every operation
 * rereads the latest value after entering the queue, reconciles immutable UIDs,
 * validates, atomically writes, and (for publish) rolls back inside that queue.
 * Deployments must run a single writer process; the offline migration uses a
 * separate lock/CAS guard for maintenance windows.
 */
export class ManifestService {
  constructor({ store, manifestPath, sanitize = (value) => value, prepare = (value) => value, createUid = randomUUID, buildAndDeploy, backupLimit = 20, journal } = {}) {
    if (!store || !manifestPath) throw new Error("ManifestService requires store and manifestPath.");
    this.store = store;
    this.manifestPath = manifestPath;
    this.sanitize = sanitize;
    this.prepare = prepare;
    this.createUid = createUid;
    this.buildAndDeploy = buildAndDeploy;
    this.backupLimit = Math.max(1, Number(backupLimit) || 20);
    this.journal = journal || new ContentPublishJournal({ store, dataDir: path.dirname(manifestPath) });
    this.queue = Promise.resolve();
  }

  enqueue(operation) {
    const current = this.queue.catch(() => {}).then(operation);
    this.queue = current;
    return current;
  }

  async read() {
    await this.queue.catch(() => {});
    return this.sanitize(await this.store.read(this.manifestPath));
  }

  recoverStartup() {
    return this.journal.recoverStartup();
  }

  async readWithRevision() {
    const manifest = await this.read();
    return { manifest, revision: manifestRevision(manifest) };
  }

  draft(incoming, options = {}) {
    return this.#commit({ incoming, ...options, publish: false });
  }

  publish(incoming, options = {}) {
    return this.#commit({ incoming, ...options, publish: true });
  }

  mutate(updater, options = {}) {
    if (typeof updater !== "function") throw new Error("Manifest mutation requires an updater function.");
    return this.#commit({ updater, ...options, publish: options.publish !== false });
  }

  #commit({ incoming, updater, expectedRevision, deletedCourseUids, publish, context, allowBasePathChanges = false } = {}) {
    return this.enqueue(async () => {
      const persisted = this.sanitize(await this.store.read(this.manifestPath));
      const currentRevision = manifestRevision(persisted);
      if (!expectedRevision) {
        const error = new Error("expectedRevision is required; reload the manifest before saving.");
        error.statusCode = 400;
        throw error;
      }
      if (expectedRevision !== currentRevision) {
        throw new ManifestConflictError("Manifest changed after it was loaded; no changes were written. Refresh and retry.", currentRevision);
      }

      const candidateInput = updater
        ? await updater(structuredClone(persisted), context)
        : structuredClone(incoming);
      const cleaned = this.sanitize(candidateInput);
      let next;
      try {
        next = updater
          ? cleaned
          : reconcileCourseUids(persisted, cleaned, { createUid: this.createUid, deletedCourseUids });
      } catch (error) {
        error.statusCode ||= 400;
        throw error;
      }
      next = await this.prepare(next, persisted);
      if (!allowBasePathChanges) {
        const beforeByUid = new Map((persisted.courses || []).map((course) => [course.uid, course]));
        for (const course of next.courses || []) {
          const before = beforeByUid.get(course.uid);
          if (before && String(before.basePath || "") !== String(course.basePath || "")) {
            const error = new Error("Existing course basePath changes require the R2 publish transaction.");
            error.statusCode = 400;
            throw error;
          }
        }
      }
      const errors = validateManifest(next);
      if (errors.length) {
        const error = new Error(errors.join("\n"));
        error.statusCode = 400;
        error.validationErrors = errors;
        throw error;
      }

      if (updater) {
        const beforeByUid = new Map((persisted.courses || []).map((course) => [course.uid, course]));
        for (const course of next.courses || []) {
          if (!course.uid || !beforeByUid.has(course.uid)) {
            const error = new Error("Internal manifest mutations may not add or replace course UIDs.");
            error.statusCode = 400;
            throw error;
          }
        }
      }
      const backupPath = await this.#createDurableBackup(persisted, currentRevision);
      const requiresDeployment = Boolean(publish && this.buildAndDeploy);
      let journalRecord = await this.journal.prepare(this.manifestPath, persisted, next, { requiresDeployment });
      let deploymentProof;
      try {
        await this.store.write(this.manifestPath, next, { mode: 0o600 });
        if (requiresDeployment) deploymentProof = await this.buildAndDeploy({ manifest: structuredClone(next), previous: structuredClone(persisted) });
      } catch (error) {
        try {
          await this.store.write(this.manifestPath, persisted, { mode: 0o600 });
          await this.journal.complete(journalRecord);
          error.publishRolledBack = true;
        } catch (rollbackError) {
          error.rollbackError = rollbackError;
        }
        throw error;
      }
      try {
        journalRecord = await this.journal.markPublished(journalRecord, deploymentProof);
        await this.journal.complete(journalRecord);
      } catch (error) {
        // The build/deploy callback has already succeeded. Rolling the JSON
        // back now could create website-new/API-old split brain. Preserve the
        // durable journal and fail closed on restart until proof is reconciled.
        error.publishStateAmbiguous = true;
        error.code ||= "PUBLISH_RECOVERY_REQUIRED";
        error.statusCode ||= 503;
        throw error;
      }
      const manifest = this.sanitize(await this.store.read(this.manifestPath));
      return { ok: true, manifest, revision: manifestRevision(manifest), backup: backupPath ? path.basename(backupPath) : undefined };
    });
  }

  async #createDurableBackup(manifest, revision) {
    const backupDir = path.join(path.dirname(this.manifestPath), ".manifest-backups");
    await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
    await fs.chmod(backupDir, 0o700);
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const backupPath = path.join(backupDir, `manifest-${stamp}-${revision.slice(0, 12)}-${randomBytes(3).toString("hex")}.json`);
    await this.store.write(backupPath, manifest, { mode: 0o600 });
    const backups = (await fs.readdir(backupDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.startsWith("manifest-") && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    await Promise.all(backups.slice(this.backupLimit).map((name) => fs.rm(path.join(backupDir, name), { force: true })));
    return backupPath;
  }
}
