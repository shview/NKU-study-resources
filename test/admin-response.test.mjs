import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { syncCourseResponse } from "../server/admin-response.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the sync-r2 route uses the tested response shaper", () => {
  const source = fs.readFileSync(path.join(root, "server", "admin-server.mjs"), "utf8");
  assert.match(source, /url\.pathname === "\/admin-api\/sync-r2"[\s\S]*?json\(res, 200, syncCourseResponse\(result\)\)/);
});

test("sync-r2 response preserves publish warnings without changing its public fields", () => {
  const result = {
    manifest: { courses: [] },
    revision: "revision-1",
    course: { uid: "course-1" },
    warnings: ["publish directory sync failed"],
    report: { internal: true },
  };
  assert.deepEqual(syncCourseResponse(result), {
    ok: true,
    manifest: result.manifest,
    revision: result.revision,
    course: result.course,
    warnings: result.warnings,
  });
  assert.deepEqual(syncCourseResponse({ ...result, warnings: [] }), {
    ok: true,
    manifest: result.manifest,
    revision: result.revision,
    course: result.course,
  });
});
