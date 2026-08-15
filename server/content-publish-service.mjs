import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { manifestRevision, ManifestConflictError } from "./content-revision.mjs";
import { syncDirectory } from "./static-release-publisher.mjs";

export class ContentPublishJournal {
  constructor({ store, dataDir, readDeploymentProof, syncDirectoryFn = syncDirectory } = {}) {
    if (!store || !dataDir) throw new Error("ContentPublishJournal requires store and dataDir.");
    this.store = store;
    this.dataDir = path.resolve(dataDir);
    this.journalDir = path.join(this.dataDir, ".publish-journal");
    this.snapshotDir = path.join(this.dataDir, ".publish-snapshots");
    this.readDeploymentProof = readDeploymentProof;
    this.syncDirectory = syncDirectoryFn;
  }

  async prepare(filePath, previous, next, { requiresDeployment = true } = {}) {
    await fs.mkdir(this.journalDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.snapshotDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.journalDir, 0o700);
    await fs.chmod(this.snapshotDir, 0o700);
    const id = `${Date.now()}-${process.pid}-${randomBytes(6).toString("hex")}`;
    const snapshotPath = path.join(this.snapshotDir, `${id}-${path.basename(filePath)}`);
    const journalPath = path.join(this.journalDir, `${id}.json`);
    await this.store.write(snapshotPath, previous, { mode: 0o600 });
    const entry = {
      version: 1,
      id,
      file: path.basename(filePath),
      snapshot: path.basename(snapshotPath),
      previousRevision: manifestRevision(previous),
      nextRevision: manifestRevision(next),
      status: "prepared",
      requiresDeployment,
      createdAt: new Date().toISOString(),
    };
    await this.store.write(journalPath, entry, { mode: 0o600 });
    return { ...entry, journalPath, snapshotPath };
  }

  async markPublished(record, deploymentProof) {
    const durableProof = deploymentProof && typeof deploymentProof.activeTarget === "string"
      ? { activeTarget: deploymentProof.activeTarget }
      : deploymentProof || null;
    const entry = await this.store.update(record.journalPath, (current) => ({
      ...current,
      status: "published",
      deploymentProof: durableProof,
      publishedAt: new Date().toISOString(),
    }), { mode: 0o600 });
    return { ...record, ...entry };
  }

  async complete(record) {
    await fs.rm(record.snapshotPath, { force: true });
    await this.syncDirectory(this.snapshotDir);
    await this.syncDirectory(this.journalDir);
    // The journal is deliberately the final fallible operation. Once it is
    // removed, publication is complete and no later error may claim ambiguity.
    await fs.rm(record.journalPath, { force: true });
  }

  async recoverStartup() {
    let names;
    try {
      names = (await fs.readdir(this.journalDir)).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      const journalPath = path.join(this.journalDir, name);
      const entry = await this.store.read(journalPath);
      if (!entry || entry.version !== 1 || !/^[a-z0-9._-]+\.json$/i.test(entry.file) || !/^[a-z0-9._-]+\.json$/i.test(entry.snapshot)) {
        throw new Error(`Invalid durable publish journal ${name}; refusing to start.`);
      }
      const filePath = path.join(this.dataDir, entry.file);
      const snapshotPath = path.join(this.snapshotDir, entry.snapshot);
      const currentRevision = manifestRevision(await this.store.read(filePath));
      if (entry.status === "published" && currentRevision !== entry.nextRevision) {
        const error = new Error(`Published journal ${name} does not match its recorded next revision; refusing to start.`);
        error.code = "PUBLISH_RECOVERY_REQUIRED";
        throw error;
      }
      if (entry.status === "published") {
        if (entry.requiresDeployment !== false) {
          if (!entry.deploymentProof || typeof this.readDeploymentProof !== "function") {
            const error = new Error(`Published journal ${name} has no verifiable deployment proof; refusing to start.`);
            error.code = "PUBLISH_RECOVERY_REQUIRED";
            throw error;
          }
          const currentProof = await this.readDeploymentProof();
          if (JSON.stringify(currentProof) !== JSON.stringify(entry.deploymentProof)) {
            const error = new Error(`Published journal ${name} does not match the active static release; refusing to start.`);
            error.code = "PUBLISH_RECOVERY_REQUIRED";
            throw error;
          }
        }
        await this.complete({ journalPath, snapshotPath });
        continue;
      }
      if (currentRevision === entry.previousRevision) {
        await this.complete({ journalPath, snapshotPath });
        continue;
      }
      const error = new Error(`Unresolved content publish journal ${name}; refusing to start until the active static release and ${entry.file} are reconciled.`);
      error.code = "PUBLISH_RECOVERY_REQUIRED";
      throw error;
    }
  }
}

export class ContentPublishService {
  constructor({ store, mutationQueue, buildAndDeploy, dataDir, journal } = {}) {
    if (!store || !mutationQueue || !buildAndDeploy) throw new Error("ContentPublishService requires store, mutationQueue and buildAndDeploy.");
    this.store = store;
    this.mutationQueue = mutationQueue;
    this.buildAndDeploy = buildAndDeploy;
    this.journal = journal || (dataDir ? new ContentPublishJournal({ store, dataDir }) : null);
  }

  recoverStartup() {
    return this.journal?.recoverStartup() || Promise.resolve();
  }

  async read(filePath, normalize = (value) => value) {
    await this.mutationQueue.queue.catch(() => {});
    const data = normalize(await this.store.read(filePath));
    return { data, revision: manifestRevision(data) };
  }

  publish(filePath, incoming, { expectedRevision, normalize = (value) => value } = {}) {
    return this.mutationQueue.enqueue(async () => {
      this.journal ||= new ContentPublishJournal({ store: this.store, dataDir: path.dirname(filePath) });
      let nextRevision;
      let journalRecord;
      let deploymentSucceeded = false;
      let deploymentProof;
      try {
        const data = await this.store.update(filePath, async (persisted) => {
          const current = normalize(structuredClone(persisted));
          const currentRevision = manifestRevision(current);
          if (!expectedRevision) {
            const error = new Error("expectedRevision is required; reload this content before saving.");
            error.statusCode = 400;
            throw error;
          }
          if (expectedRevision !== currentRevision) {
            throw new ManifestConflictError("Content changed after it was loaded; no changes were written. Refresh and retry.", currentRevision);
          }
          const next = normalize(structuredClone(incoming));
          nextRevision = manifestRevision(next);
          journalRecord = await this.journal.prepare(filePath, persisted, next, { requiresDeployment: true });
          return next;
        }, {
          mode: 0o600,
          afterWrite: async () => {
            deploymentProof = await this.buildAndDeploy();
            deploymentSucceeded = true;
          },
          rollbackOnAfterWriteError: true,
        });
        journalRecord = await this.journal.markPublished(journalRecord, deploymentProof);
        await this.journal.complete(journalRecord);
        const warnings = Array.isArray(deploymentProof?.warnings) ? deploymentProof.warnings.filter((warning) => typeof warning === "string") : [];
        return { ok: true, data, revision: nextRevision, ...(warnings.length ? { warnings } : {}) };
      } catch (error) {
        if (error.atomicJsonRolledBack) {
          error.publishRolledBack = true;
          if (journalRecord) await this.journal.complete(journalRecord);
        } else if (deploymentSucceeded) {
          error.publishStateAmbiguous = true;
          error.code ||= "PUBLISH_RECOVERY_REQUIRED";
          error.statusCode ||= 503;
        }
        throw error;
      }
    });
  }
}
