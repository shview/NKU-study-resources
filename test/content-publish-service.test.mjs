import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AtomicJsonStore } from "../server/atomic-json-store.mjs";
import { ContentPublishJournal, ContentPublishService } from "../server/content-publish-service.mjs";
import { ManifestService } from "../server/manifest-service.mjs";

async function fixture(t, buildAndDeploy) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nkustudy-content-publish-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new AtomicJsonStore({ allowedRoot: directory });
  const manifestPath = path.join(directory, "manifest.json");
  const contentPath = path.join(directory, "home.json");
  await store.write(manifestPath, { resourceRoot: "https://example.invalid", courses: [] });
  await store.write(contentPath, { announcement: "before" });
  const queue = new ManifestService({ store, manifestPath });
  const journal = new ContentPublishJournal({ store, dataDir: directory });
  return { service: new ContentPublishService({ store, mutationQueue: queue, buildAndDeploy, dataDir: directory, journal }), store, contentPath };
}

test("content publish uses CAS and returns the new revision", async (t) => {
  const { service, contentPath } = await fixture(t, async () => {});
  const tabA = await service.read(contentPath);
  const tabB = await service.read(contentPath);
  const saved = await service.publish(contentPath, { announcement: "A" }, { expectedRevision: tabA.revision });
  assert.notEqual(saved.revision, tabA.revision);
  await assert.rejects(service.publish(contentPath, { announcement: "B" }, { expectedRevision: tabB.revision }), (error) => error.statusCode === 409);
  assert.deepEqual((await service.read(contentPath)).data, { announcement: "A" });
});

test("content publish exposes deployment warnings while journal stores only durable proof", async (t) => {
  const proof = { activeTarget: "/releases/release-after", warnings: ["directory fsync unavailable"] };
  const { service, store, contentPath } = await fixture(t, async () => proof);
  service.journal.complete = async () => {};
  const loaded = await service.read(contentPath);
  const saved = await service.publish(contentPath, { announcement: "after" }, { expectedRevision: loaded.revision });
  assert.deepEqual(saved.warnings, proof.warnings);
  assert.deepEqual(await store.read(contentPath), { announcement: "after" });
  const journals = await fs.readdir(service.journal.journalDir);
  const journal = await store.read(path.join(service.journal.journalDir, journals[0]));
  assert.deepEqual(journal.deploymentProof, { activeTarget: proof.activeTarget });
});

test("content journal never hides directory fsync permission failures", async (t) => {
  for (const code of ["EACCES", "EPERM"]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), `nkustudy-content-fsync-${code.toLowerCase()}-`));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new AtomicJsonStore({ allowedRoot: directory });
    const filePath = path.join(directory, "home.json");
    const previous = { announcement: "before" };
    const next = { announcement: "after" };
    await store.write(filePath, previous);
    const denied = Object.assign(new Error(`${code} denied`), { code });
    const journal = new ContentPublishJournal({ store, dataDir: directory, syncDirectoryFn: async () => { throw denied; } });
    const record = await journal.prepare(filePath, previous, next);
    await assert.rejects(journal.complete(record), (error) => error === denied);
    await fs.access(record.journalPath);
  }
});

test("content build failure atomically restores prior JSON", async (t) => {
  const { service, store, contentPath } = await fixture(t, async () => { throw new Error("synthetic build failure"); });
  const loaded = await service.read(contentPath);
  await assert.rejects(service.publish(contentPath, { announcement: "bad" }, { expectedRevision: loaded.revision }), /synthetic build failure/);
  assert.deepEqual(await store.read(contentPath), { announcement: "before" });
  assert.deepEqual(await fs.readdir(path.join(path.dirname(contentPath), ".publish-journal")), []);
  assert.deepEqual(await fs.readdir(path.join(path.dirname(contentPath), ".publish-snapshots")), []);
});

test("startup fails closed for an ambiguous crash after JSON replacement", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nkustudy-content-crash-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new AtomicJsonStore({ allowedRoot: directory });
  const filePath = path.join(directory, "home.json");
  const previous = { announcement: "before" };
  const next = { announcement: "after" };
  await store.write(filePath, previous);
  const journal = new ContentPublishJournal({ store, dataDir: directory });
  const record = await journal.prepare(filePath, previous, next);
  await store.write(filePath, next);
  await assert.rejects(journal.recoverStartup(), (error) => error.code === "PUBLISH_RECOVERY_REQUIRED");
  assert.equal((await fs.readdir(journal.journalDir)).length, 1);
  assert.equal((await fs.readdir(journal.snapshotDir)).length, 1);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(record.journalPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(record.snapshotPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(journal.journalDir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(journal.snapshotDir)).mode & 0o777, 0o700);
  }
});

test("startup safely clears journals from pre-write and confirmed-published crashes", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nkustudy-content-recovery-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new AtomicJsonStore({ allowedRoot: directory });
  const filePath = path.join(directory, "home.json");
  const previous = { announcement: "before" };
  const next = { announcement: "after" };
  await store.write(filePath, previous);
  const proof = { activeTarget: "/releases/release-after" };
  const journal = new ContentPublishJournal({ store, dataDir: directory, readDeploymentProof: async () => proof });
  await journal.prepare(filePath, previous, next);
  await journal.recoverStartup();
  assert.deepEqual(await fs.readdir(journal.journalDir), []);

  let record = await journal.prepare(filePath, previous, next);
  await store.write(filePath, next);
  record = await journal.markPublished(record, proof);
  await journal.recoverStartup();
  assert.deepEqual(await fs.readdir(journal.journalDir), []);
  assert.deepEqual(await fs.readdir(journal.snapshotDir), []);
});

test("markPublished failure after deployment never rolls JSON back or removes the ambiguous journal", async (t) => {
  const proof = { activeTarget: "/releases/release-after" };
  const { service, store, contentPath } = await fixture(t, async () => proof);
  const loaded = await service.read(contentPath);
  service.journal.markPublished = async () => { throw new Error("synthetic markPublished failure"); };
  await assert.rejects(
    service.publish(contentPath, { announcement: "after" }, { expectedRevision: loaded.revision }),
    (error) => error.code === "PUBLISH_RECOVERY_REQUIRED" && error.publishStateAmbiguous === true,
  );
  assert.deepEqual(await store.read(contentPath), { announcement: "after" });
  assert.equal((await fs.readdir(path.join(path.dirname(contentPath), ".publish-journal"))).length, 1);
});

test("complete failure retains a published proof and startup forward-completes only when the active release matches", async (t) => {
  const proof = { activeTarget: "/releases/release-after" };
  const { service, store, contentPath } = await fixture(t, async () => proof);
  const loaded = await service.read(contentPath);
  service.journal.complete = async () => { throw new Error("synthetic complete failure"); };
  await assert.rejects(
    service.publish(contentPath, { announcement: "after" }, { expectedRevision: loaded.revision }),
    (error) => error.code === "PUBLISH_RECOVERY_REQUIRED" && error.publishStateAmbiguous === true,
  );
  assert.deepEqual(await store.read(contentPath), { announcement: "after" });
  const recovery = new ContentPublishJournal({ store, dataDir: path.dirname(contentPath), readDeploymentProof: async () => proof });
  await recovery.recoverStartup();
  assert.deepEqual(await fs.readdir(recovery.journalDir), []);
});
