import assert from "node:assert/strict";
import test from "node:test";
import { mergeCourseR2Discovery, mergeR2Discoveries } from "../server/r2-sync-merge.mjs";
import { validateManifest } from "../server/manifest-schema.mjs";
import { assertR2CleanupSafety, planR2ManifestMutation, planR2ObjectCopies, strictR2BasePath, strictR2Path } from "../server/r2-mutation-plan.mjs";
import { publishAfterR2Prepare, R2MutationQueue, runExclusiveR2Mutation, runSerializedR2Mutation } from "../server/r2-transaction.mjs";

const existing = {
  uid: "00000000-0000-4000-8000-000000000001",
  id: "web-only", term: "term", group: "group", title: "Web only", updated: "old", basePath: "web/only/", sections: [],
};

function withFile(course, filePath) {
  return { ...course, sections: [{ title: "Files", files: [{ title: filePath.split("/").at(-1), path: filePath }] }] };
}

test("empty R2 discovery preserves every web-managed course", () => {
  const result = mergeR2Discoveries({ resourceRoot: "x", courses: [existing] }, [], { createId: () => "new", date: "now" });
  assert.deepEqual(result.manifest.courses, [existing]);
  assert.deepEqual({ updated: result.updated, added: result.added }, { updated: 0, added: 0 });
});

test("single-course empty and partial discoveries never delete manifest resources", () => {
  const course = {
    ...existing,
    sections: [{ title: "Files", files: [
      { title: "keep.pdf", path: "Files/keep.pdf", size: 1, description: "web note" },
      { title: "missing.pdf", path: "Files/missing.pdf", size: 2, description: "retain me" },
    ] }],
  };
  const empty = mergeCourseR2Discovery(course, { sections: [] });
  assert.deepEqual(empty.course.sections, course.sections);
  assert.deepEqual(empty.report.missing, ["Files/keep.pdf", "Files/missing.pdf"]);
  const partial = mergeCourseR2Discovery(course, { sections: [{ title: "Files", files: [{ title: "keep.pdf", path: "Files/keep.pdf", size: 10 }] }] });
  assert.equal(partial.course.sections[0].files.length, 2);
  assert.equal(partial.course.sections[0].files.find((file) => file.path.endsWith("keep.pdf")).size, 10);
  assert.equal(partial.course.sections[0].files.find((file) => file.path.endsWith("missing.pdf")).description, "retain me");
  assert.deepEqual(partial.report.missing, ["Files/missing.pdf"]);
});

test("manifest schema rejects overlapping course prefixes and duplicate declared resource paths", () => {
  const base = { ...existing, id: "one", uid: "00000000-0000-4000-8000-000000000021", term: "t", group: "g", title: "One", updated: "now" };
  const manifest = {
    resourceRoot: "https://resources.example.invalid/resources/",
    courses: [
      { ...base, basePath: "parent/", sections: [{ title: "A", files: [{ title: "one", path: "same.pdf" }] }, { title: "B", files: [{ title: "two", path: "same.pdf" }] }] },
      { ...base, uid: "00000000-0000-4000-8000-000000000022", id: "two", title: "Two", basePath: "parent/child/", sections: [] },
    ],
  };
  const errors = validateManifest(manifest);
  assert.equal(errors.some((error) => /overlaps/.test(error)), true);
  assert.equal(errors.some((error) => /duplicate file path/.test(error)), true);
});

test("partial discovery updates matches, skips empty new folders and retains unmatched courses", () => {
  const discoveries = [
    { basePath: "web/only", term: "term", group: "group", title: "Web only", sections: [{ title: "其他", files: [] }] },
    { basePath: "r2/new", term: "term", group: "group", title: "New", sections: [] },
    { basePath: "r2/with-files", term: "term", group: "group", title: "With files", sections: [{ title: "其他", files: [{ title: "a.pdf", path: "a.pdf", size: 1, description: "" }] }] },
  ];
  const result = mergeR2Discoveries({ resourceRoot: "x", courses: [existing, { ...existing, uid: "00000000-0000-4000-8000-000000000002", id: "unmatched", basePath: "unmatched/" }] }, discoveries, { createId: () => "new", date: "now" });
  assert.equal(result.manifest.courses.some((course) => course.id === "unmatched"), true);
  assert.equal(result.manifest.courses.length, 3, "已有2门 + 仅带真实文件的新目录1门；空目录不建课");
  assert.deepEqual({ updated: result.updated, added: result.added }, { updated: 1, added: 1 });
  assert.equal(result.report.placeholderSkipped, 1);
});

test("R2 prepare failure never publishes or deletes", async () => {
  const order = [];
  await assert.rejects(publishAfterR2Prepare({
    prepare: async () => { order.push("copy+verify"); throw new Error("copy failed"); },
    publish: async () => { order.push("publish"); },
    cleanup: async () => { order.push("delete"); },
  }), /copy failed/);
  assert.deepEqual(order, ["copy+verify"]);
});

test("R2 publish failure leaves verified copies and keeps old keys", async () => {
  const order = [];
  await assert.rejects(publishAfterR2Prepare({
    prepare: async () => { order.push("copy+verify"); },
    publish: async () => { order.push("publish"); throw new Error("CAS conflict"); },
    cleanup: async () => { order.push("delete"); },
  }), /CAS conflict/);
  assert.deepEqual(order, ["copy+verify", "publish"]);
});

test("R2 cleanup runs only after publish and failure becomes a non-destructive warning", async () => {
  const order = [];
  const result = await publishAfterR2Prepare({
    prepare: async () => { order.push("copy+verify"); return {}; },
    publish: async () => { order.push("publish"); return { ok: true }; },
    cleanup: async () => { order.push("delete"); throw new Error("R2 unavailable"); },
  });
  assert.deepEqual(order, ["copy+verify", "publish", "delete"]);
  assert.equal(result.ok, true);
  assert.match(result.cleanupWarnings[0], /R2 unavailable/);
});

test("strict R2 paths reject traversal, encoded separators and non-canonical segments", () => {
  assert.equal(strictR2Path("term/group/course"), "term/group/course");
  for (const unsafe of ["../course", "term//course", "/term/course", "term/course/", "term\\course", "term/%2e/course", "term/%2e%2e/course", "term/%252e%252e/course", "term/%2F/course", "term/%252F/course", "term/%00/course", "term/%20course", " term/course"]) {
    assert.throws(() => strictR2Path(unsafe), /path|segment|separator|traversal|canonical|whitespace/i);
  }
  assert.equal(strictR2BasePath("term/group/course/"), "term/group/course/");
  for (const unsafe of ["term/group/course", "term/group/course//", "term/../course/", "term/%2e%2e/course/", "term\\group\\course/", " term/group/course/"]) {
    assert.throws(() => strictR2BasePath(unsafe), /canonical|unsafe|traversal|separator|path/i);
  }
});

test("R2 mutation plan requires a one-to-one move for every basePath change", () => {
  const current = { courses: [existing] };
  const next = { courses: [{ ...existing, basePath: "moved/only/" }] };
  assert.throws(() => planR2ManifestMutation(current, next), /every basePath change one-to-one/);
  const plan = planR2ManifestMutation(current, next, {
    moves: [{ courseUid: existing.uid, oldBasePath: "web/only", newBasePath: "moved/only" }],
  });
  assert.deepEqual(plan.moves.map(({ sourcePrefix, targetPrefix }) => ({ sourcePrefix, targetPrefix })), [
    { sourcePrefix: "resources/web/only", targetPrefix: "resources/moved/only" },
  ]);
  // 管理端 basePath 带尾斜杠的写法同样接受（归一化后仍需与库内 basePath 精确对应）
  const trailingSlashPlan = planR2ManifestMutation(current, next, {
    moves: [{ courseUid: existing.uid, oldBasePath: "web/only/", newBasePath: "moved/only/" }],
  });
  assert.deepEqual(trailingSlashPlan.moves.map(({ sourcePrefix, targetPrefix }) => ({ sourcePrefix, targetPrefix })), [
    { sourcePrefix: "resources/web/only", targetPrefix: "resources/moved/only" },
  ]);
  assert.throws(() => planR2ManifestMutation(current, next, {
    moves: [
      { courseUid: existing.uid, oldBasePath: "web/only", newBasePath: "moved/only" },
      { courseUid: existing.uid, oldBasePath: "web/only", newBasePath: "moved/only" },
    ],
  }), /exactly once/);
});

test("R2 mutation plan rejects overlapping targets and requires exact file cleanup authorization", () => {
  const second = { ...existing, uid: "00000000-0000-4000-8000-000000000002", id: "second", basePath: "second/course/" };
  assert.throws(() => planR2ManifestMutation(
    { courses: [existing, second] },
    { courses: [{ ...existing, basePath: "target/" }, { ...second, basePath: "target/nested/" }] },
    { moves: [
      { courseUid: existing.uid, oldBasePath: "web/only", newBasePath: "target" },
      { courseUid: second.uid, oldBasePath: "second/course", newBasePath: "target/nested" },
    ] },
  ), /overlapping/);

  const currentCourse = withFile(existing, "Files/old.pdf");
  const nextCourse = { ...currentCourse, sections: [{ title: "Files", files: [] }] };
  assert.throws(() => planR2ManifestMutation({ courses: [currentCourse] }, { courses: [nextCourse] }), /exactly authorize/);
  const plan = planR2ManifestMutation({ courses: [currentCourse] }, { courses: [nextCourse] }, {
    fileDeletes: [{ courseUid: existing.uid, paths: ["Files/old.pdf"] }],
  });
  assert.deepEqual(plan.fileDeleteKeys, ["resources/web/only/Files/old.pdf"]);

  const moved = { ...nextCourse, basePath: "moved/only/" };
  const movedPlan = planR2ManifestMutation({ courses: [currentCourse] }, { courses: [moved] }, {
    moves: [{ courseUid: existing.uid, oldBasePath: "web/only", newBasePath: "moved/only" }],
    fileDeletes: [{ courseUid: existing.uid, paths: ["Files/old.pdf"] }],
  });
  assert.deepEqual(movedPlan.moves[0].deletedFilePaths, ["Files/old.pdf"]);
  const movedObjects = [{ Key: "resources/web/only/Files/old.pdf", Size: 1 }, { Key: "resources/web/only/Files/keep.pdf", Size: 2 }];
  const objectPlan = planR2ObjectCopies(movedPlan.moves[0], movedObjects, []);
  assert.deepEqual(objectPlan.cleanupKeys, movedObjects.map((object) => object.Key), "changed-course removals remain exact cleanup keys");
  assert.equal(objectPlan.copies.some((copy) => copy.source.Key.endsWith("old.pdf")), false);
});

test("R2 object copy planning refuses occupied or colliding targets and skips authorized removals", () => {
  const move = {
    sourcePrefix: "resources/old/course",
    targetPrefix: "resources/new/course",
    deletedFilePaths: ["Files/deleted.pdf"],
  };
  const sources = [
    { Key: "resources/old/course/Files/keep.pdf", Size: 10 },
    { Key: "resources/old/course/Files/deleted.pdf", Size: 20 },
  ];
  assert.throws(() => planR2ObjectCopies(move, sources, [{ Key: "resources/new/course/existing.pdf" }]), (error) => error.statusCode === 409);
  assert.deepEqual(planR2ObjectCopies(move, sources, []).copies, [
    { source: sources[0], targetKey: "resources/new/course/Files/keep.pdf" },
  ]);
  const reservedTargets = new Set(["resources/new/course/Files/keep.pdf"]);
  assert.throws(() => planR2ObjectCopies(move, sources, [], { reservedTargets }), /collision/);
  const opaque = [
    { Key: "resources/old/course/ spaced.pdf" },
    { Key: "resources/old/course/back\\slash.pdf" },
    { Key: "resources/old/course/repeated//slash.pdf" },
  ];
  const rawPlan = planR2ObjectCopies(move, opaque, []);
  assert.deepEqual(rawPlan.copies, []);
  assert.deepEqual(rawPlan.cleanupKeys, []);
  assert.deepEqual(rawPlan.unmovedSourceKeys, opaque.map((object) => object.Key), "unsafe opaque keys remain at the old prefix for manual handling");
});

test("R2 move refuses to publish when any manifest-declared source object is absent", () => {
  const move = {
    sourcePrefix: "resources/old/course",
    targetPrefix: "resources/new/course",
    requiredObjects: [{ relativePath: "Files/required.pdf", sourceKey: "resources/old/course/Files/required.pdf", targetKey: "resources/new/course/Files/required.pdf" }],
  };
  assert.throws(() => planR2ObjectCopies(move, [{ Key: "resources/old/course/Files/extra.pdf", Size: 1 }], []), /missing manifest-declared object/);
  const source = { Key: "resources/old/course/Files/required.pdf", Size: 9 };
  const plan = planR2ObjectCopies(move, [source, { Key: "resources/old/course/Files/extra.pdf", Size: 1 }], []);
  assert.deepEqual(plan.extraSourceKeys, ["resources/old/course/Files/extra.pdf"]);
});

test("cleanup authorization is exact and cannot overlap any move target", () => {
  assert.deepEqual(assertR2CleanupSafety(["resources/old/ spaced.pdf"], ["resources/new/file.pdf"], ["resources/new"]), ["resources/old/ spaced.pdf"]);
  for (const cleanup of ["resources/new", "resources/new/file.pdf", "resources/new/file.pdf/child"]) {
    assert.throws(() => assertR2CleanupSafety([cleanup], ["resources/new/file.pdf"], ["resources/new"]), /overlaps/);
  }

  const removed = { ...existing, uid: "00000000-0000-4000-8000-000000000010", id: "removed", basePath: "target/" };
  const moving = { ...existing, uid: "00000000-0000-4000-8000-000000000011", id: "moving", basePath: "source/" };
  assert.throws(() => planR2ManifestMutation(
    { courses: [removed, moving] },
    { courses: [{ ...moving, basePath: "target/" }] },
    {
      deletedCourseUids: [removed.uid],
      moves: [{ courseUid: moving.uid, oldBasePath: "source", newBasePath: "target" }],
    },
  ), /cleanup|overlap/i, "deleted course A must not erase course B's move target");
});

test("same-revision R2 mutations serialize and the loser conflicts before copy", async () => {
  const queue = new R2MutationQueue();
  let revision = "same";
  let copies = 0;
  const attempt = () => runSerializedR2Mutation({
    queue,
    expectedRevision: "same",
    readCurrent: async () => ({ revision }),
    mutate: async () => {
      copies += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      revision = "changed";
      return { ok: true };
    },
  });
  const results = await Promise.allSettled([attempt(), attempt()]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected"]);
  assert.equal(results[1].reason.statusCode, 409);
  assert.equal(copies, 1, "losing request must fail before any copy operation");
});

test("upload-style R2 work shares the destructive mutation queue", async () => {
  const queue = new R2MutationQueue();
  const events = [];
  let releaseUpload;
  const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
  const upload = runExclusiveR2Mutation({
    queue,
    mutate: async () => {
      events.push("upload:start");
      await uploadGate;
      events.push("upload:end");
    },
  });
  const publish = runSerializedR2Mutation({
    queue,
    expectedRevision: "same",
    readCurrent: async () => {
      events.push("publish:read");
      return { revision: "same" };
    },
    mutate: async () => events.push("publish:mutate"),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["upload:start"]);
  releaseUpload();
  await Promise.all([upload, publish]);
  assert.deepEqual(events, ["upload:start", "upload:end", "publish:read", "publish:mutate"]);
});

test("placeholder-only folders never create courses on rebuild (name-pool placeholders are safe)", () => {
  const snapshot = { resourceRoot: "x", courses: [] };
  const discoveries = [
    { term: "E课", group: "通识选修课", title: "只有占位的课", basePath: "E课/通识选修课/只有占位的课", sections: [] },
    { term: "E课", group: "通识选修课", title: "有真实资料的课", basePath: "E课/通识选修课/有真实资料的课", sections: [{ title: "其他", note: "", files: [{ title: "a.pdf", path: "a.pdf", size: 1, description: "" }] }] },
  ];
  const result = mergeR2Discoveries(snapshot, discoveries, { createId: () => "new-id", date: "now" });
  assert.equal(result.manifest.courses.length, 1, "占位-only 目录不得创建课程");
  assert.equal(result.manifest.courses[0].title, "有真实资料的课");
  assert.equal(result.report.addedCourses, 1);
  assert.equal(result.report.placeholderSkipped, 1);
  // 有文件的发现不受影响
  assert.equal(result.report.addedResources, 1);
});
