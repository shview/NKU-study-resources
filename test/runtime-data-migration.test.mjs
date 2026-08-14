import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyRuntimeDataMigration, assertMigrationApproval, planRuntimeDataMigration } from "../scripts/migrate-runtime-data.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const fixtureDir = path.join(projectRoot, "src", "data", "fixtures");

async function migrationFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nkustudy-runtime-migration-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourceDir = path.join(directory, "source");
  const targetDir = path.join(directory, "target");
  await fs.mkdir(sourceDir);
  for (const name of ["manifest.json", "reviews.json", "home.json", "about.json", "participate.json", "links.json", "footer.json", "feedback.json"]) {
    await fs.copyFile(path.join(fixtureDir, name), path.join(sourceDir, name));
  }
  const manifestPath = path.join(sourceDir, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  delete manifest.courses[0].uid;
  manifest.repository = "old/resource-repository";
  manifest.hiddenMetaTags = ["hidden-global"];
  manifest.courses[0].source = "E:\\private\\course";
  manifest.courses[0].hiddenMetaTags = ["hidden-course"];
  manifest.courses[0].basePath = "fixtures\\example-course\\";
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const reviewsPath = path.join(sourceDir, "reviews.json");
  const reviews = JSON.parse(await fs.readFile(reviewsPath, "utf8"));
  reviews.reviews.push({ id: "unmatched-1", courseTitle: "历史课程", teacher: "教师", rating: 5, content: "保留的历史评价", status: "approved" });
  await fs.writeFile(reviewsPath, JSON.stringify(reviews));
  return { sourceDir, targetDir };
}

test("runtime migration plan is deterministic and record-loss free", async (t) => {
  const { sourceDir, targetDir } = await migrationFixture(t);
  const first = await planRuntimeDataMigration({ sourceDir, targetDir });
  const second = await planRuntimeDataMigration({ sourceDir, targetDir });
  assert.equal(first.report.planSha256, second.report.planSha256);
  assert.deepEqual(first.report.before, first.report.after);
  assert.deepEqual(first.report.deletions, { courses: 0, reviews: 0, resources: 0, items: [] });
  assert.equal(first.report.changes.uidAdded.length, 1);
  assert.equal(first.report.changes.basePathNormalized.length, 1);
  assert.equal(first.report.changes.internalFieldsRemoved.length, 1);
  assert.equal(first.report.unmatchedReviews.length, 1);
  assert.deepEqual(first.report.manualFixRequired, []);
  assert.equal(first.migratedFiles["manifest.json"].courses[0].basePath, "fixtures/example-course/");
  assert.equal(Object.hasOwn(first.migratedFiles["manifest.json"].courses[0], "source"), false);
  assert.equal(first.migratedFiles["manifest.json"].repository, "old/resource-repository");
  assert.deepEqual(first.migratedFiles["manifest.json"].hiddenMetaTags, ["hidden-global"]);
  assert.deepEqual(first.migratedFiles["manifest.json"].courses[0].hiddenMetaTags, ["hidden-course"]);
});

test("unmatched or deleted records require exact operator confirmation", async (t) => {
  const { sourceDir, targetDir } = await migrationFixture(t);
  const { report } = await planRuntimeDataMigration({ sourceDir, targetDir });
  assert.throws(() => assertMigrationApproval(report), /confirm-unmatched=1/);
  assert.throws(() => assertMigrationApproval(report, { confirmUnmatched: 1 }), /confirm-path-changes=1/);
  assert.doesNotThrow(() => assertMigrationApproval(report, { confirmUnmatched: 1, confirmPathChanges: 1 }));
  const destructive = structuredClone(report);
  destructive.unmatchedReviews = [];
  destructive.deletions.courses = 4;
  assert.throws(() => assertMigrationApproval(destructive), /confirm-deletions=4/);
  assert.doesNotThrow(() => assertMigrationApproval(destructive, { confirmDeletions: 4, confirmPathChanges: 1 }));
});

test("invalid approved reviews and mismatched counts require direct source repair", async (t) => {
  const { sourceDir, targetDir } = await migrationFixture(t);
  const reviewsPath = path.join(sourceDir, "reviews.json");
  const reviews = JSON.parse(await fs.readFile(reviewsPath, "utf8"));
  reviews.count = reviews.reviews.length + 10;
  reviews.reviews[0] = { id: "broken", status: "approved", rating: 9, courseTitle: "", teacher: "", content: "" };
  await fs.writeFile(reviewsPath, JSON.stringify(reviews));
  const { report } = await planRuntimeDataMigration({ sourceDir, targetDir });
  assert.equal(report.manualFixRequired.some((issue) => issue.index === 0 && /rating/.test(issue.reason)), true);
  assert.equal(report.manualFixRequired.some((issue) => /count=.*reviews.length/.test(issue.reason)), true);
  assert.throws(() => assertMigrationApproval(report, { confirmUnmatched: report.unmatchedReviews.length, confirmPathChanges: 1 }), /manual correction|needs manual/i);
});

test("path-changing write requires exact confirmation and a complete server R2 inventory", async (t) => {
  const { sourceDir, targetDir } = await migrationFixture(t);
  const { report } = await planRuntimeDataMigration({ sourceDir, targetDir });
  const backupDir = path.join(path.dirname(sourceDir), "backup");
  await assert.rejects(applyRuntimeDataMigration({
    sourceDir, targetDir, backupDir, expectedPlanSha256: report.planSha256,
    confirmUnmatched: 1, confirmPathChanges: 1,
  }), /r2-inventory/);
  const inventory = path.join(path.dirname(sourceDir), "r2-inventory.json");
  await fs.writeFile(inventory, JSON.stringify({ objects: report.changes.requiredR2Keys.map((Key) => ({ Key })) }));
  const result = await applyRuntimeDataMigration({
    sourceDir, targetDir, backupDir, expectedPlanSha256: report.planSha256,
    confirmUnmatched: 1, confirmPathChanges: 1, r2Inventory: inventory,
  });
  assert.equal(result.inventoryVerification.verifiedKeys, report.changes.requiredR2Keys.length);
});
