import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SnapshotCache, runtimeJsonFingerprint } from "../server/snapshot-cache.mjs";
import { PublicApiService } from "../server/public-api-service.mjs";
import { createPublicApiHandler } from "../server/public-api-router.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nkustudy-snapshot-cache-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifestPath = path.join(dir, "manifest.json");
  const reviewsPath = path.join(dir, "reviews.json");
  const manifest = { resourceRoot: "https://resources.nkustudy.top/resources/", courses: [
    { uid: "course-a", id: "course-a", title: "课程甲", basePath: "课程甲/", sections: [] },
  ] };
  const reviews = { rules: { submissionOpen: true }, reviews: [
    { id: "review-a", courseTitle: "课程甲", teacher: "老师甲", rating: 5, content: "公开评价", status: "approved", hidden: false,
      helpfulBy: [7], helpfulCount: 1, createdAt: "2026-10-01T00:00:00Z" },
  ] };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(reviewsPath, JSON.stringify(reviews));
  let now = 0;
  const reads = { manifest: 0, reviews: 0, groups: 0 };
  const entry = { id: "catalog-a", name: "课程甲", teachers: ["老师甲"] };
  const catalog = { courses: [entry], find() { reads.groups += 1; return entry; } };
  const learningCompass = { searchItems: () => [], contentUpdatedAt: () => "" };
  const deps = {
    readManifest: () => { reads.manifest += 1; return JSON.parse(fs.readFileSync(manifestPath, "utf8")); },
    readReviews: () => { reads.reviews += 1; return JSON.parse(fs.readFileSync(reviewsPath, "utf8")); },
    readSnapshotVersion: () => runtimeJsonFingerprint(dir, [manifestPath, reviewsPath]),
    snapshotCacheNow: () => now,
    readHome: () => ({}),
    courseCatalog: catalog,
    learningCompass,
    reviewSubmissionService: {},
  };
  return { dir, manifestPath, reviewsPath, manifest, reviews, reads, catalog, learningCompass, deps,
    service: new PublicApiService(deps), setNow(value) { now = value; } };
}

function replaceJson(filePath, data, { preserveMtime = false } = {}) {
  const previous = fs.statSync(filePath);
  const temp = `${filePath}.replacement`;
  fs.writeFileSync(temp, JSON.stringify(data));
  if (preserveMtime) fs.utimesSync(temp, previous.atime, previous.mtime);
  fs.renameSync(temp, filePath);
}

test("unchanged source files reuse reads and anonymous groups until the hard TTL", (t) => {
  const f = fixture(t);
  const first = f.service.reviewGroups();
  f.service.reviewGroups();
  f.service.course("course-a");
  f.service.searchData();
  f.service.searchIndex();
  assert.deepEqual(f.reads, { manifest: 1, reviews: 1, groups: 1 });
  f.setNow(2_999);
  assert.deepEqual(f.service.reviewGroups(), first);
  assert.equal(f.reads.reviews, 1);
  f.setNow(3_000);
  f.service.reviewGroups();
  assert.deepEqual(f.reads, { manifest: 2, reviews: 2, groups: 2 });
});

test("same-size atomic replacements with preserved mtime invalidate immediately", (t) => {
  const f = fixture(t);
  fs.utimesSync(f.manifestPath, 1_700_000_000, 1_700_000_000);
  f.service.snapshot();
  f.manifest.courses[0].title = "课程乙";
  const oldSize = fs.statSync(f.manifestPath).size;
  const oldMtime = fs.statSync(f.manifestPath, { bigint: true }).mtimeNs;
  replaceJson(f.manifestPath, f.manifest, { preserveMtime: true });
  assert.equal(fs.statSync(f.manifestPath).size, oldSize);
  assert.equal(fs.statSync(f.manifestPath, { bigint: true }).mtimeNs, oldMtime);
  assert.equal(f.service.course("course-a").name, "课程乙");
  assert.equal(f.reads.manifest, 2);
  f.reviews.reviews[0].hidden = true;
  replaceJson(f.reviewsPath, f.reviews);
  assert.equal(f.service.reviewGroups().total, 0);
  assert.equal(f.reads.reviews, 3);
});

test("metadata collisions still reload at TTL, and health forces a fresh read", (t) => {
  const f = fixture(t);
  const service = new PublicApiService({ ...f.deps, readSnapshotVersion: () => "same-metadata" });
  assert.equal(service.reviewGroups().total, 1);
  f.reviews.reviews[0].hidden = true;
  replaceJson(f.reviewsPath, f.reviews);
  f.setNow(3_000);
  assert.equal(service.reviewGroups().total, 0);
  fs.writeFileSync(f.reviewsPath, "broken JSON");
  assert.throws(() => service.health(), SyntaxError);
  replaceJson(f.reviewsPath, f.reviews);
  assert.deepEqual(service.health(), { status: "ok" });
});

test("source deletion, malformed JSON and rejected paths never return the old snapshot", (t) => {
  const f = fixture(t);
  f.service.snapshot();
  fs.unlinkSync(f.reviewsPath);
  assert.throws(() => f.service.reviewGroups(), { code: "ENOENT" });
  fs.writeFileSync(f.reviewsPath, "broken JSON");
  assert.throws(() => f.service.reviewGroups(), SyntaxError);
  replaceJson(f.reviewsPath, f.reviews);
  assert.equal(f.service.reviewGroups().total, 1);
  const real = path.join(f.dir, "real-reviews.json");
  fs.renameSync(f.reviewsPath, real);
  fs.symlinkSync(real, f.reviewsPath);
  assert.throws(() => f.service.snapshot(), /non-symlink/);
  fs.unlinkSync(f.reviewsPath);
  fs.renameSync(real, f.reviewsPath);
  assert.equal(f.service.reviewGroups().total, 1);
  assert.throws(() => runtimeJsonFingerprint(f.dir, [path.join(f.dir, "..", "manifest.json")]), /inside the data root/);
});

test("viewer reactions and caller mutations cannot poison a cached snapshot", (t) => {
  const f = fixture(t);
  const groupKey = f.service.reviewGroups().items[0].group_key;
  const firstUser = f.service.reviewGroup(groupKey, { viewerId: 7 });
  assert.equal(firstUser.items[0].viewer_reaction, "up");
  assert.equal(f.service.reviewGroup(groupKey, { viewerId: 9 }).items[0].viewer_reaction, null);
  assert.equal(f.service.reviewGroup(groupKey).items[0].viewer_reaction, null);
  firstUser.items[0].body = "poison";
  firstUser.items.push({ id: "fake" });
  const snapshot = f.service.snapshot();
  snapshot.manifest.courses[0].title = "poison";
  snapshot.reviewData.reviews[0].helpfulBy.push(9);
  snapshot.groups[0].catalogCourse.teachers.push("poison");
  f.service.searchData().catalog[0].teachers.push("poison");
  assert.equal(f.service.course("course-a").name, "课程甲");
  assert.deepEqual(f.service.searchData().catalog[0].teachers, ["老师甲"]);
  assert.equal(f.service.reviewGroup(groupKey).items[0].body, "公开评价");
  assert.equal(f.service.reviewGroup(groupKey, { viewerId: 9 }).items[0].viewer_reaction, null);
  f.reviews.reviews[0].helpfulBy = [9];
  replaceJson(f.reviewsPath, f.reviews);
  assert.equal(f.service.reviewGroup(groupKey, { viewerId: 7 }).items[0].viewer_reaction, null);
  assert.equal(f.service.reviewGroup(groupKey, { viewerId: 9 }).items[0].viewer_reaction, "up");
});

test("catalog reload identity invalidates groups without waiting for JSON or TTL", (t) => {
  const f = fixture(t);
  f.service.reviewGroups();
  f.catalog.courses = [...f.catalog.courses];
  f.service.reviewGroups();
  assert.equal(f.reads.reviews, 2);
  const other = new PublicApiService({ ...f.deps, readSnapshotVersion: null });
  other.snapshot();
  other.snapshot();
  assert.equal(f.reads.reviews, 4, "custom readers remain fresh without a version provider");
});

test("changing source versions during a load retries, then fails closed and recovers", () => {
  let version = 0;
  let loads = 0;
  const stableAfterFirst = new SnapshotCache({ readVersion: () => version, load() { loads += 1; if (loads === 1) version += 1; return loads; } });
  assert.equal(stableAfterFirst.get(), 2);
  assert.equal(stableAfterFirst.get(), 2);
  let unstable = true;
  const cache = new SnapshotCache({ readVersion: () => version, load() { if (unstable) version += 1; return version; } });
  assert.throws(() => cache.get(), /changed while loading/);
  unstable = false;
  assert.equal(cache.get(), version);
});

test("cached public routes retain ETag behavior and sanitize refresh failures", async (t) => {
  const f = fixture(t);
  const handler = createPublicApiHandler({ service: f.service, readBody: async () => ({}), clientIp: () => "actor" });
  async function invoke(headers = {}) {
    const req = { method: "GET", headers };
    const res = { body: "", writableEnded: false, destroyed: false,
      writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders; },
      end(body = "") { this.body = body; this.writableEnded = true; } };
    await handler(req, res, new URL("https://example.test/api/v1/courses"));
    return res;
  }
  const first = await invoke();
  assert.equal((await invoke({ "if-none-match": first.headers.etag })).status, 304);
  assert.equal(f.reads.reviews, 1);
  f.manifest.courses[0].title = "课程乙";
  replaceJson(f.manifestPath, f.manifest);
  const changed = await invoke({ "if-none-match": first.headers.etag });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, first.headers.etag);
  fs.writeFileSync(f.reviewsPath, "secret-malformed-json");
  const failure = await invoke();
  assert.equal(failure.status, 500);
  assert.equal(failure.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(failure.body), { code: "INTERNAL_ERROR", message: "服务器暂时无法处理请求。" });
  replaceJson(f.reviewsPath, f.reviews);
  assert.equal((await invoke()).status, 200);
});
