import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalogCourseImports, cleanCatalogCourseName } from "../server/catalog-import.mjs";

test("cleanCatalogCourseName removes only CJK-internal spaces", () => {
  assert.equal(cleanCatalogCourseName("AI智能体设计开发及应 用"), "AI智能体设计开发及应用");
  assert.equal(cleanCatalogCourseName("3D 打印及应用"), "3D 打印及应用", "拉丁相邻空格保留");
  assert.equal(cleanCatalogCourseName("VR 体验与全景视频创 作"), "VR 体验与全景视频创作");
  assert.equal(cleanCatalogCourseName("普通课程名"), "普通课程名");
});

test("bulk import creates shells, dedupes by basePath and normalized title, and is idempotent", () => {
  const snapshot = {
    courses: [
      { id: "existing", term: "E课", group: "通识选修课", title: "人体中的化学", basePath: "E课/通识选修课/人体中的化学/" },
      { id: "spacing", term: "E课", group: "通识选修课", title: "已收录 空格课", basePath: "E课/通识选修课/已收录 空格课/" },
    ],
  };
  const pool = [
    { name: "人体中的化学", categories: ["通识选修课"], modules: [] },
    { name: "已收录空格课", categories: ["通识选修课"], modules: [] },
    { name: "全新课程", categories: ["通识选修课"], modules: ["社会发展与国家治理"] },
    { name: "另一学院课", categories: ["历史学院"], modules: [] },
    { name: "同名课程", categories: ["通识选修课"], modules: [] },
    { name: "同名课 程", categories: ["通识选修课"], modules: [] },
  ];
  const first = buildCatalogCourseImports(snapshot, pool, { date: "2026-08-30" });
  assert.equal(first.created, 2, "同名课程与带空格变体规范化后视为一门");
  assert.equal(first.skipped, 3);
  const shell = first.courses.find((course) => course.title === "全新课程");
  assert.equal(shell.term, "E课");
  assert.equal(shell.group, "通识选修课");
  assert.equal(shell.assessment, "通过制");
  assert.deepEqual(shell.tags, ["社会发展与国家治理"]);
  assert.equal(shell.basePath, "E课/通识选修课/全新课程/");
  assert.deepEqual(shell.sections, []);
  // 幂等：把第一次结果并回快照后重跑
  const merged = { courses: [...snapshot.courses, ...first.courses] };
  const second = buildCatalogCourseImports(merged, pool, { date: "2026-08-30" });
  assert.equal(second.created, 0);
  assert.equal(second.skipped, 5, "分类内5个池条目全部命中已存在课程");
});

test("imported ids stay unique against manifest and each other", () => {
  const snapshot = { courses: [{ id: "tong-ming", term: "E课", group: "通识选修课", title: "其他", basePath: "E课/通识选修课/其他/" }] };
  const pool = [
    { name: "同名", categories: ["通识选修课"], modules: [] },
    { name: "同名！", categories: ["通识选修课"], modules: [] },
  ];
  const result = buildCatalogCourseImports(snapshot, pool, { date: "now" });
  const ids = result.courses.map((course) => course.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!ids.includes("tong-ming"));
});
