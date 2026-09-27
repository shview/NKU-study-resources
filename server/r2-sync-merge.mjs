import { strictR2BasePath, strictR2Path } from "./r2-mutation-plan.mjs";

function cloneFile(file, existing) {
  return {
    ...(existing ? structuredClone(existing) : {}),
    ...structuredClone(file),
    path: strictR2Path(file.path, "R2 discovered file path"),
    description: existing?.description || file.description || "",
  };
}

/**
 * R2 即真相（2026-09 语义变更）：发现含文件的课程，文件列表整体按 R2 替换，
 * 旧位置条目不再保留；仅延续人工维护的元数据（文件描述、板块备注/折叠态）。
 * 空发现视为 basePath 不匹配或列举异常的信号：保留原数据并计入 retainedEmpty，
 * 由管理员核查后处理，防止误清。
 */
export function mergeCourseR2Discovery(course, discovery) {
  const next = structuredClone(course);
  const discoveredFiles = (discovery?.sections || []).reduce((sum, section) => sum + (section.files || []).length, 0);
  if (!discoveredFiles) {
    return { course: next, report: { added: 0, updated: 0, removed: 0, retainedEmpty: true, removedPaths: [], unmatched: [] } };
  }

  const oldFilesByPath = new Map();
  const oldFilesByBasename = new Map();
  for (const section of next.sections || []) {
    for (const file of section.files || []) {
      const filePath = strictR2Path(file.path, "Manifest file path");
      oldFilesByPath.set(filePath, file);
      const basename = filePath.split("/").pop();
      const trimmed = basename.trim();
      if (!oldFilesByBasename.has(trimmed)) oldFilesByBasename.set(trimmed, []);
      oldFilesByBasename.get(trimmed).push(file);
    }
  }
  const oldSectionsByTitle = new Map((next.sections || []).map((section) => [section.title, section]));
  const discoveredPaths = new Set();
  const consumedOldPaths = new Set();
  let added = 0;
  let updated = 0;

  for (const discoveredSection of discovery.sections) {
    const previous = oldSectionsByTitle.get(discoveredSection.title);
    discoveredSection.note = discoveredSection.note || previous?.note || "";
    if (previous?.collapsed !== undefined) discoveredSection.collapsed = previous.collapsed;
    for (const file of discoveredSection.files || []) {
      const filePath = strictR2Path(file.path, "R2 discovered file path");
      if (discoveredPaths.has(filePath)) throw new Error(`R2 discovery contains duplicate file path ${filePath}.`);
      discoveredPaths.add(filePath);
      const existing = oldFilesByPath.get(filePath);
      // 同路径直接继承；否则若课程内存在唯一同名旧文件（移动场景），继承其人工描述
      const sameName = existing || oldFilesByBasename.get(filePath.split("/").pop().trim())?.filter((f) => f !== existing).find((f) => !consumedOldPaths.has(strictR2Path(f.path, "Manifest file path")));
      if (existing || sameName) {
        file.description = (existing || sameName).description || file.description || "";
        if (existing) consumedOldPaths.add(filePath);
        else consumedOldPaths.add(strictR2Path(sameName.path, "Manifest file path"));
        updated += 1;
      } else {
        added += 1;
      }
    }
  }

  const removedPaths = [...oldFilesByPath.keys()].filter((filePath) => !discoveredPaths.has(filePath)).sort();
  next.sections = structuredClone(discovery.sections);
  return {
    course: next,
    report: {
      added,
      updated,
      removed: removedPaths.length,
      retainedEmpty: false,
      removedPaths,
      unmatched: [],
    },
  };
}

export function mergeR2Discoveries(snapshot, discoveries, { conflicts = [], createId, date } = {}) {
  const manifest = structuredClone(snapshot);
  const existingByBasePath = new Map(manifest.courses.map((course) => [strictR2BasePath(course.basePath).slice(0, -1), course]));
  const conflictPaths = new Set(conflicts.map((conflict) => strictR2Path(conflict.basePath, "R2 discovery conflict basePath")));
  const observedPaths = new Set();
  const report = { addedCourses: 0, updatedCourses: 0, addedResources: 0, updatedResources: 0, missing: [], unmatched: [] };

  for (const entry of discoveries) {
    const entryBasePath = strictR2Path(entry.basePath, "R2 discovery basePath");
    observedPaths.add(entryBasePath);
    if (conflictPaths.has(entryBasePath)) {
      report.unmatched.push({ basePath: entryBasePath, reason: "conflict" });
      continue;
    }
    const existing = existingByBasePath.get(entryBasePath);
    if (existing) {
      const merged = mergeCourseR2Discovery(existing, entry);
      Object.assign(existing, merged.course, { updated: date });
      report.updatedCourses += 1;
      report.addedResources += merged.report.added;
      report.updatedResources += merged.report.updated;
      if (merged.report.retainedEmpty) {
        report.retainedEmptyCourses = report.retainedEmptyCourses || [];
        report.retainedEmptyCourses.push({ basePath: entryBasePath, reason: "R2 未观察到任何文件，已保留原清单待人工核查" });
      } else {
        report.removedResources = (report.removedResources || 0) + merged.report.removed;
        report.missing.push(...merged.report.removedPaths.map((filePath) => ({ basePath: entryBasePath, filePath })));
      }
      continue;
    }
    // E课名字池按目录名预建占位（仅 .openlist），量级大且多数尚未开课，
    // 重建时跳过等真实资料出现；普通学期/分类下管理员新建的目录视为有意开课，
    // 纯占位也创建课程壳，资料上传后由后续重建合并。
    const realFileCount = (entry.sections || []).reduce((sum, section) => sum + (section.files || []).length, 0);
    if (!existing && realFileCount === 0 && entry.term === "E课") {
      report.placeholderSkipped = (report.placeholderSkipped || 0) + 1;
      observedPaths.add(entryBasePath);
      continue;
    }
    if (!existing && realFileCount === 0) report.placeholderShells = (report.placeholderShells || 0) + 1;
    manifest.courses.push({
      id: createId(entry), term: entry.term, group: entry.group, title: entry.title,
      summary: "待补充课程简介。", contributors: [], assessment: "绩点制",
      updated: date, grades: [], tags: entry.group === "通识选修课" ? ["通识选修课"] : [],
      basePath: `${entryBasePath}/`, sections: structuredClone(entry.sections),
    });
    report.addedCourses += 1;
    report.addedResources += realFileCount;
  }

  for (const course of manifest.courses) {
    const basePath = strictR2BasePath(course.basePath).slice(0, -1);
    if (!observedPaths.has(basePath)) report.unmatched.push({ basePath, courseUid: course.uid || null, reason: "not observed in this listing" });
  }
  return {
    manifest,
    updated: report.updatedCourses,
    added: report.addedCourses,
    report,
  };
}

/**
 * 校对清单（只读比对）：清单 vs R2 发现，产出移动/删除/新增/空发现报告，
 * 供「按 R2 校对清单」按钮展示，不修改任何数据。
 */
export function compareManifestWithDiscovery(snapshot, discoveries) {
  const r2ByBasePath = new Map();
  for (const entry of discoveries || []) {
    const paths = new Set();
    const byBasename = new Map();
    for (const section of entry.sections || []) {
      for (const file of section.files || []) {
        paths.add(strictR2Path(file.path, "R2 discovered file path"));
        const basename = file.path.split("/").pop();
        if (!byBasename.has(basename)) byBasename.set(basename, []);
        byBasename.get(basename).push(file.path);
      }
    }
    r2ByBasePath.set(entry.basePath, { paths, byBasename });
  }
  const report = { consistentFiles: 0, moved: [], deleted: [], newInR2: [], retainedEmptyCourses: [], newCourses: [] };
  const manifestBasePaths = new Set();
  for (const course of snapshot.courses || []) {
    const basePath = strictR2BasePath(course.basePath).slice(0, -1);
    manifestBasePaths.add(basePath);
    const r2 = r2ByBasePath.get(basePath);
    const manifestFiles = [];
    for (const section of course.sections || []) for (const file of section.files || []) manifestFiles.push(file);
    if (!r2 || r2.paths.size === 0) {
      if (manifestFiles.length) report.retainedEmptyCourses.push({ course: course.title, basePath, manifestFiles: manifestFiles.length });
      continue;
    }
    const resolvedR2 = new Set();
    for (const file of manifestFiles) {
      if (r2.paths.has(file.path)) { report.consistentFiles += 1; resolvedR2.add(file.path); continue; }
      const basename = file.path.split("/").pop();
      let candidates = (r2.byBasename.get(basename) || []).filter((p) => p !== file.path);
      if (!candidates.length) candidates = (r2.byBasename.get(basename.trim()) || []).filter((p) => p.split("/").pop() !== basename);
      if (candidates.length === 1) {
        report.moved.push({ course: course.title, from: file.path, to: candidates[0] });
        resolvedR2.add(candidates[0]);
      } else {
        report.deleted.push({ course: course.title, path: file.path, ...(candidates.length > 1 ? { note: `同名候选 ${candidates.length} 个，需人工确认` } : {}) });
      }
    }
    for (const p of r2.paths) if (!resolvedR2.has(p)) report.newInR2.push({ course: course.title, basePath, path: p });
  }
  for (const entry of discoveries || []) {
    if (!manifestBasePaths.has(entry.basePath)) report.newCourses.push({ basePath: entry.basePath, title: entry.title, files: (entry.sections || []).reduce((n, s) => n + (s.files || []).length, 0) });
  }
  return report;
}
