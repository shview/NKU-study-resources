import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const source = await fs.readFile(new URL("../server/admin-server.mjs", import.meta.url), "utf8");
const adminUiSource = await fs.readFile(new URL("../src/pages/admin.astro", import.meta.url), "utf8");

test("admin server uses shared runtime paths and no direct runtime JSON writes", () => {
  assert.match(source, /runtimeDataPaths/);
  assert.doesNotMatch(source, /path\.join\(root,\s*["']src["'],\s*["']data["']/);
  assert.doesNotMatch(source, /fs\.writeFileSync\((manifestPath|reviewsPath|feedbackPath|aboutPath|homePath|participatePath|linksPath|footerPath|editorSettingsPath|visitStatsPath|backupSettingsPath)/);
});

test("public writes use persistent limits and queued read-modify-write", () => {
  assert.match(source, /new PersistentRateLimiter/);
  assert.match(source, /checkRate\("review-submit"/);
  assert.match(source, /checkRate\("feedback-submit"/);
  assert.match(source, /jsonStore\.update\(reviewsPath/);
  assert.match(source, /jsonStore\.update\(feedbackPath/);
  assert.match(source, /jsonStore\.update\(visitStatsPath/);
  assert.match(source, /"visit-attempt", clientIp\(req\), \{ perIp: 120, global: 600 \}/);
  assert.match(source, /"admin-login-attempt", ip, \{ perIp: 5, global: 60/);
  assert.doesNotMatch(source, /loginFailures\s*=\s*new Map/);
});

test("legacy destructive R2 routes are disabled and safe route remains admin-only", () => {
  assert.match(source, /Unsafe legacy R2 mutation route is disabled/);
  assert.match(source, /\/admin-api\/r2-publish/);
  assert.match(source, /publishAfterR2Prepare/);
  assert.match(source, /runSerializedR2Mutation/);
  assert.match(source, /strictR2BasePath\(course\.basePath/);
  assert.match(source, /strictR2Path\(object\.Key\.slice\(basePrefix\.length \+ 1\)/);
  const exactDeleteBody = source.slice(source.indexOf("async function deleteExactR2Keys"), source.indexOf("async function safeR2ManifestPublish"));
  assert.doesNotMatch(exactDeleteBody, /normalizeKey/);
});

test("public v1 routing remains separate from mini-program administration", () => {
  assert.match(source, /createPublicApiHandler/);
  assert.doesNotMatch(source, /miniprogram.*admin|admin.*miniprogram/i);
});

test("static publish warnings remain in management responses and are visible in the admin UI", () => {
  assert.match(source, /return result;\s*}\s*\n\s*function readDeploymentProof/);
  assert.match(source, /Static publish durability warning/);
  assert.match(adminUiSource, /import \{ statusWithWarnings \} from "\.\.\/lib\/admin-response-warnings\.js"/);
  assert.match(adminUiSource, /publishStatus\.textContent = statusWithWarnings\("已发布", data\)/);
  assert.match(adminUiSource, /已按 R2 重建并发布", data/);
  assert.match(adminUiSource, /课程已删除并发布", data/);
  assert.match(adminUiSource, /文件已删除并发布", data/);
  assert.match(adminUiSource, /板块已删除并发布", data/);
  assert.match(adminUiSource, /选中文件已删除并发布", data/);
});
