import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CourseCatalogService } from "../server/course-catalog-service.mjs";

const sample = {
  version: 1,
  updated: "2026-08-22",
  sources: ["test"],
  courses: [
    { id: "cat-a", name: "高等数学 A（上）", aliases: ["高数A上"], categories: ["数学科学学院"], modules: [], teachers: ["陈成", "耿甜甜"], terms: ["2026-2027-1"] },
    { id: "cat-b", name: "泥人张百年技艺传承与经营实践", categories: ["通识选修课"], modules: ["艺术审美与文化思辨"], teachers: ["张宇"], terms: ["2025-2026-1", "2026-2027-1"] },
    { id: "cat-c", name: "人工智能与创新", categories: ["人工智能学院"], modules: [], teachers: [], terms: ["2026-2027-1"] },
  ],
};

function tempCatalog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nkustudy-cat-"));
  const file = path.join(dir, "catalog.json");
  fs.writeFileSync(file, JSON.stringify(sample), "utf8");
  return new CourseCatalogService({ catalogPath: file });
}

test("catalog loads courses, resolves ids, names and aliases", () => {
  const c = tempCatalog();
  assert.equal(c.loaded, true);
  assert.equal(c.summary().courses, 3);
  assert.equal(c.find("cat-b").name, "泥人张百年技艺传承与经营实践");
  assert.equal(c.find("高等数A（上）".replace("高等数", "高等数学")).name.includes("高等数学"), true);
  assert.equal(c.find("高数A上").id, "cat-a", "alias resolves");
  assert.equal(c.find("不存在的课"), null);
});

test("catalog search supports keyword, paging and teacher matching", () => {
  const c = tempCatalog();
  const byName = c.search({ q: "泥人张" });
  assert.equal(byName.total, 1);
  assert.equal(byName.items[0].teachers[0], "张宇");
  const byTeacher = c.search({ q: "陈成" });
  assert.equal(byTeacher.items[0].id, "cat-a");
  const paged = c.search({ q: "", page: 2, pageSize: 2 });
  assert.equal(paged.items.length, 1);
  assert.equal(paged.total, 3);
});

test("empty catalog degrades to not-loaded", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nkustudy-cat-"));
  const c = new CourseCatalogService({ catalogPath: path.join(dir, "none.json") });
  assert.equal(c.loaded, false);
  assert.equal(c.find("任何"), null);
});

test("addCourse validates input, dedupes, persists, and hot-reloads", async () => {
  const { CourseCatalogService } = await import("../server/course-catalog-service.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-add-"));
  const file = path.join(dir, "catalog.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, updated: "", sources: [], courses: [
    { id: "cat-exists", name: "高等数学", aliases: [], categories: [], modules: [], teachers: ["张三"], terms: [] }
  ] }));
  const service = new CourseCatalogService({
    catalogPath: file,
    writeJson: async (mutator) => {
      const current = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify(mutator(current)));
    },
  });
  const added = await service.addCourse({ name: "量子计算导论", categories: "计算机学院", teachers: "李四、王五, 李四", terms: "2026-2027-1" });
  assert.equal(added.name, "量子计算导论");
  assert.deepEqual(added.teachers, ["李四", "王五"], "分隔符拆分并去重");
  assert.ok(service.find("量子计算导论"), "写入后立即可查（热重载）");
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(stored.courses.length, 2);
  assert.equal(stored.courses[1].origin, "user");
  await assert.rejects(() => service.addCourse({ name: "高等数学", teachers: ["x"] }), /已在目录/);
  await assert.rejects(() => service.addCourse({ name: "量子计算导论", teachers: ["x"] }), /已在目录/);
  await assert.rejects(() => service.addCourse({ name: "量", teachers: ["x"] }), /课程名称/);
  await assert.rejects(() => service.addCourse({ name: "新课程" }), /任课教师/);
  await assert.rejects(
    () => service.addCourse({ name: "课程库课程", teachers: ["x"], manifestTitles: new Set(["课程库课程"]) }),
    /已在目录/,
  );
  await assert.rejects(() => new CourseCatalogService({ catalogPath: file }).addCourse({ name: "y课程", teachers: ["x"] }), /read-only/);
  fs.rmSync(dir, { recursive: true, force: true });
});
