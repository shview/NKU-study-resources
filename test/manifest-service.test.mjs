import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AtomicJsonStore } from "../server/atomic-json-store.mjs";
import { ManifestService } from "../server/manifest-service.mjs";

const uidA = "00000000-0000-4000-8000-000000000001";
const uidB = "00000000-0000-4000-8000-000000000002";
const uidC = "00000000-0000-4000-8000-000000000003";

function course(id = "A", uid = uidA) {
  return { uid, id, term: "term", group: "group", title: id, updated: "2026-08-14", basePath: `${id}/`, sections: [] };
}

function manifest(courses = [course()]) {
  return { version: 1, updated: "2026-08-14", resourceRoot: "https://example.invalid/resources/", courses };
}

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nkustudy-manifest-service-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, "manifest.json");
  const store = new AtomicJsonStore({ allowedRoot: directory });
  await store.write(manifestPath, manifest());
  const generated = [uidB, uidC, ...Array.from({ length: 30 }, (_, index) => `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`)];
  const service = new ManifestService({ store, manifestPath, createUid: () => generated.shift(), ...options });
  return { service, store, manifestPath };
}

test("UID survives title/id rename and basePath changes require explicit R2 authorization", async (t) => {
  const { service } = await fixture(t);
  const renamed = manifest([{ ...course(), id: "A2", title: "Renamed" }]);
  const initial = await service.readWithRevision();
  const draft = await service.draft(renamed, { expectedRevision: initial.revision, deletedCourseUids: [] });
  assert.equal(draft.manifest.courses[0].uid, uidA);
  await assert.rejects(service.publish(manifest([{ ...draft.manifest.courses[0], basePath: "new/path/" }]), {
    expectedRevision: draft.revision,
    deletedCourseUids: [],
  }), /require the R2 publish transaction/);
  const published = await service.publish(manifest([{ ...draft.manifest.courses[0], basePath: "new/path/" }]), {
    expectedRevision: draft.revision,
    deletedCourseUids: [],
    allowBasePathChanges: true,
  });
  assert.equal(published.manifest.courses[0].uid, uidA);
  assert.equal(published.manifest.courses[0].basePath, "new/path/");
});

test("existing courses require UID while replacement and client-supplied new UID are rejected", async (t) => {
  const { service } = await fixture(t);
  const withoutUid = manifest([{ ...course(), uid: undefined }]);
  const initial = await service.readWithRevision();
  await assert.rejects(service.draft(withoutUid, { expectedRevision: initial.revision, deletedCourseUids: [uidA] }), /Ambiguous replacement/);
  await assert.rejects(service.draft(manifest([{ ...course(), uid: uidB }]), { expectedRevision: initial.revision, deletedCourseUids: [uidA] }), /Unknown course uid/);
  await assert.rejects(service.draft(manifest([course(), course("B", uidB)]), { expectedRevision: initial.revision, deletedCourseUids: [] }), /Unknown course uid/);
});

test("new, deleted, and re-added courses receive server-owned non-reused UIDs", async (t) => {
  const { service } = await fixture(t);
  const initial = await service.readWithRevision();
  const withNew = await service.draft(manifest([course(), { ...course("B", undefined), uid: undefined }]), { expectedRevision: initial.revision, deletedCourseUids: [] });
  assert.equal(withNew.manifest.courses[1].uid, uidB);
  const deleted = await service.draft(manifest([course()]), { expectedRevision: withNew.revision, deletedCourseUids: [uidB] });
  const readded = await service.draft(manifest([course(), { ...course("B", undefined), uid: undefined }]), { expectedRevision: deleted.revision, deletedCourseUids: [] });
  assert.equal(readded.manifest.courses[1].uid, uidC);
});

test("concurrent mutations reread latest and publish failure rolls back in the same queue", async (t) => {
  let failBuild = false;
  const { service, store, manifestPath } = await fixture(t, {
    buildAndDeploy: async () => { if (failBuild) throw new Error("synthetic build failure"); },
  });
  for (let index = 0; index < 20; index += 1) {
    const loaded = await service.readWithRevision();
    await service.mutate((latest) => {
    latest.updated = `revision-${index}`;
    latest.marker = [...(latest.marker || []), index];
    return latest;
    }, { publish: false, expectedRevision: loaded.revision });
  }
  assert.equal((await service.read()).marker.length, 20);
  const before = await store.read(manifestPath);
  failBuild = true;
  const loaded = await service.readWithRevision();
  await assert.rejects(service.publish({ ...before, updated: "should-rollback" }, { expectedRevision: loaded.revision, deletedCourseUids: [] }), /synthetic build failure/);
  assert.deepEqual(await store.read(manifestPath), before);
});

test("two stale tabs cannot overwrite one another and missing CAS is rejected", async (t) => {
  const { service } = await fixture(t);
  const tabA = await service.readWithRevision();
  const tabB = await service.readWithRevision();
  await assert.rejects(service.draft(tabA.manifest, { deletedCourseUids: [] }), /expectedRevision is required/);
  const saved = await service.draft({ ...tabA.manifest, marker: "A" }, { expectedRevision: tabA.revision, deletedCourseUids: [] });
  await assert.rejects(
    service.draft({ ...tabB.manifest, marker: "B" }, { expectedRevision: tabB.revision, deletedCourseUids: [] }),
    (error) => error.statusCode === 409 && error.currentRevision === saved.revision,
  );
  assert.equal((await service.read()).marker, "A");
});

test("publish creates durable mode-0600 backup and retains it after rollback", async (t) => {
  const { service, manifestPath } = await fixture(t, { buildAndDeploy: async () => { throw new Error("build failed"); } });
  const loaded = await service.readWithRevision();
  await assert.rejects(service.publish({ ...loaded.manifest, marker: "never-live" }, { expectedRevision: loaded.revision, deletedCourseUids: [] }), /build failed/);
  const backupDir = path.join(path.dirname(manifestPath), ".manifest-backups");
  const backups = await fs.readdir(backupDir);
  assert.equal(backups.length, 1);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(path.join(backupDir, backups[0]))).mode & 0o777, 0o600);
  }
  assert.equal((await service.read()).marker, undefined);
});

test("draft also creates a durable backup before replacing live manifest JSON", async (t) => {
  const { service, manifestPath } = await fixture(t);
  const loaded = await service.readWithRevision();
  await service.draft({ ...loaded.manifest, marker: "draft" }, { expectedRevision: loaded.revision, deletedCourseUids: [] });
  const backups = await fs.readdir(path.join(path.dirname(manifestPath), ".manifest-backups"));
  assert.equal(backups.length, 1);
});

test("manifest startup fails closed after a crash between JSON replacement and journal publish", async (t) => {
  const { service, store, manifestPath } = await fixture(t);
  const previous = await store.read(manifestPath);
  const next = { ...previous, marker: "crashed-after-json-write" };
  await service.journal.prepare(manifestPath, previous, next);
  await store.write(manifestPath, next, { mode: 0o600 });
  await assert.rejects(service.recoverStartup(), (error) => error.code === "PUBLISH_RECOVERY_REQUIRED");
});
