import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AtomicJsonStore } from "../server/atomic-json-store.mjs";
import { ContentPublishJournal, ContentPublishService } from "../server/content-publish-service.mjs";
import { ManifestService } from "../server/manifest-service.mjs";
import { manifestRevision } from "../server/content-revision.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("journal finalization failure quarantines later writers without undoing a published revision", async (t) => {
  const { service, store, contentPath } = await fixture(t, async () => ({ activeTarget: "/synthetic/release" }));
  service.journal.complete = async () => { throw Object.assign(new Error("synthetic finalization I/O failure"), { code: "EIO" }); };
  const loaded = await service.read(contentPath);
  const failed = service.publish(contentPath, { announcement: "published" }, { expectedRevision: loaded.revision });
  await assert.rejects(failed, error => error.publishStateAmbiguous === true && error.statusCode === 503);
  const persisted = await store.read(contentPath);
  assert.equal(persisted.announcement, "published");
  const journals = await fs.readdir(service.journal.journalDir);
  const journal = await store.read(path.join(service.journal.journalDir, journals[0]));
  assert.equal(journal.status, "published");
  assert.equal(journal.nextRevision, manifestRevision(persisted));
  await assert.rejects(store.update(contentPath, data => ({ ...data, announcement: "later" })), error => error.code === "PUBLISH_RECOVERY_REQUIRED");
  const otherStore = new AtomicJsonStore({ allowedRoot: path.dirname(contentPath) });
  await assert.rejects(otherStore.write(contentPath, { announcement: "bypass" }), error => error.statusCode === 503);
  assert.deepEqual(await store.read(contentPath), persisted);
  await store.write(path.join(path.dirname(contentPath), "unrelated.json"), { stillWritable: true });
  const storeModule = new URL("../server/atomic-json-store.mjs", import.meta.url).href;
  const journalModule = new URL("../server/content-publish-service.mjs", import.meta.url).href;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import { AtomicJsonStore } from ${JSON.stringify(storeModule)};
    import { ContentPublishJournal } from ${JSON.stringify(journalModule)};
    const file = process.argv[1], directory = process.argv[2];
    const store = new AtomicJsonStore({ allowedRoot: directory });
    const journal = new ContentPublishJournal({ store, dataDir: directory, readDeploymentProof: async () => ({ activeTarget: "/synthetic/release" }) });
    await journal.recoverStartup();
    await store.update(file, current => ({ ...current, announcement: "after-restart" }));
  `, contentPath, path.dirname(contentPath)]);
  assert.equal((await store.read(contentPath)).announcement, "after-restart");
  assert.deepEqual(await fs.readdir(service.journal.journalDir), []);
});

test("scoped settings publish holds concurrent item writes through build and journal finalization", async (t) => {
  let releaseBuild, buildStarted;
  const started = new Promise(resolve => { buildStarted = resolve; });
  const held = new Promise(resolve => { releaseBuild = resolve; });
  const { service, store, contentPath } = await fixture(t, async () => { buildStarted(); await held; });
  await store.write(contentPath, { title: "old", items: [{ id: "a" }] });
  const saving = service.publish(contentPath, null, { mutate(current) { return { ...current, title: "new" }; } });
  await started;
  let appendFinished = false;
  const append = store.update(contentPath, current => ({ ...current, items: [...current.items, { id: "b" }] })).then(() => { appendFinished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(appendFinished, false);
  releaseBuild();
  await saving; await append;
  assert.deepEqual(await store.read(contentPath), { title: "new", items: [{ id: "a" }, { id: "b" }] });
  assert.deepEqual(await fs.readdir(service.journal.journalDir), []);
});

test("scoped runtime item mutation does not build and failed settings preserve queued submissions", async (t) => {
  let fail = false, builds = 0;
  const { service, store, contentPath } = await fixture(t, async () => { builds++; if (fail) throw new Error("build failed"); });
  await store.write(contentPath, { title: "old", items: [] });
  await service.publish(contentPath, null, { mutate: current => ({ ...current, items: [{ id: "first" }] }), shouldBuild: () => false });
  assert.equal(builds, 0);
  fail = true;
  await assert.rejects(service.publish(contentPath, null, { mutate: current => ({ ...current, title: "failed" }) }), /build failed/);
  await store.update(contentPath, current => ({ ...current, items: [...current.items, { id: "second" }] }));
  assert.deepEqual(await store.read(contentPath), { title: "old", items: [{ id: "first" }, { id: "second" }] });
});

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
