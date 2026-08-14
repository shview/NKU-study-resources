import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { backfillCourseUids } from "../scripts/backfill-course-uids.mjs";
import { AtomicJsonStore } from "../server/atomic-json-store.mjs";
import { validateManifest } from "../server/manifest-schema.mjs";

const uidA = "00000000-0000-4000-8000-000000000001";
const uidB = "00000000-0000-4000-8000-000000000002";

function manifest() {
  return {
    version: 1,
    updated: "2026-08-14",
    resourceRoot: "https://example.invalid/resources/",
    courses: ["A", "B"].map((title) => ({
      id: title,
      term: "term",
      group: "group",
      title,
      updated: "2026-08-14",
      basePath: `${title}/`,
      sections: [],
    })),
  };
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nkustudy-uid-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, "manifest.json");
  const store = new AtomicJsonStore();
  await store.write(manifestPath, manifest());
  return { directory, manifestPath, store };
}

test("UID backfill is dry-run by default", async (t) => {
  const { manifestPath, store } = await fixture(t);
  const ids = [uidA, uidB];
  const result = await backfillCourseUids({ manifestPath, store, createUid: () => ids.shift() });
  assert.equal(result.written, false);
  assert.equal(result.missing, 2);
  assert.deepEqual((await store.read(manifestPath)).courses.map((course) => course.uid), [undefined, undefined]);
});

test("UID backfill writes a backup and is idempotent", async (t) => {
  const { manifestPath, store } = await fixture(t);
  const ids = [uidA, uidB];
  const previewIds = [uidA, uidB];
  const dryRun = await backfillCourseUids({ manifestPath, store, createUid: () => previewIds.shift() });
  const result = await backfillCourseUids({
    manifestPath,
    store,
    write: true,
    createUid: () => ids.shift(),
    now: () => new Date("2026-08-14T12:00:00.000Z"),
    expectedHash: dryRun.expectedHash,
  });
  assert.equal(result.written, true);
  assert.deepEqual((await store.read(manifestPath)).courses.map((course) => course.uid), [uidA, uidB]);
  assert.deepEqual((await store.read(result.backupPath)).courses.map((course) => course.uid), [undefined, undefined]);
  const after = await backfillCourseUids({ manifestPath, store, createUid: () => { throw new Error("must not generate"); } });
  const again = await backfillCourseUids({ manifestPath, store, write: true, expectedHash: after.expectedHash, createUid: () => { throw new Error("must not generate"); } });
  assert.equal(again.written, false);
  assert.equal(again.missing, 0);
});

test("duplicate UIDs are rejected", async (t) => {
  const { manifestPath, store } = await fixture(t);
  const duplicate = manifest();
  duplicate.courses[0].uid = uidA;
  duplicate.courses[1].uid = uidA;
  await store.write(manifestPath, duplicate);
  await assert.rejects(backfillCourseUids({ manifestPath, store }), /duplicate uid/);
  assert.equal(validateManifest(duplicate).some((error) => error.includes("duplicate uid")), true);
});

test("manifest validation rejects non-canonical or unsafe basePath and file paths", () => {
  const invalidBase = manifest();
  invalidBase.courses[0].uid = uidA;
  invalidBase.courses[1].uid = uidB;
  invalidBase.courses[0].basePath = "term/../course/";
  assert.equal(validateManifest(invalidBase).some((error) => error.includes("basePath")), true);
  const invalidFile = manifest();
  invalidFile.courses[0].uid = uidA;
  invalidFile.courses[1].uid = uidB;
  invalidFile.courses[0].sections = [{ title: "Files", files: [{ title: "bad", path: "%2e%2e/secret" }] }];
  assert.equal(validateManifest(invalidFile).some((error) => error.includes("file path")), true);
});

test("write migration requires matching CAS hash and exclusive lock", async (t) => {
  const { manifestPath, store } = await fixture(t);
  await assert.rejects(backfillCourseUids({ manifestPath, store, write: true }), /expectedHash/);
  const previewIds = [uidA, uidB];
  const preview = await backfillCourseUids({ manifestPath, store, createUid: () => previewIds.shift() });
  await assert.rejects(backfillCourseUids({ manifestPath, store, write: true, expectedHash: "0".repeat(64) }), /hash changed/);
  await fs.writeFile(`${manifestPath}.uid-migration.lock`, "other\n", { flag: "wx" });
  await assert.rejects(backfillCourseUids({ manifestPath, store, write: true, expectedHash: preview.expectedHash }), /lock already exists/);
});
