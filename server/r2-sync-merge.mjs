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
 * R2 listing is discovery, never deletion authorization. Empty or partial
 * listings retain every manifest file and report what was not observed.
 */
export function mergeCourseR2Discovery(course, discovery) {
  const next = structuredClone(course);
  const sections = new Map((next.sections || []).map((section) => [section.title, section]));
  const discoveredPaths = new Set();
  let added = 0;
  let updated = 0;

  for (const discoveredSection of discovery?.sections || []) {
    const section = sections.get(discoveredSection.title) || {
      title: discoveredSection.title,
      note: discoveredSection.note || "",
      files: [],
    };
    if (!sections.has(discoveredSection.title)) sections.set(discoveredSection.title, section);
    const filesByPath = new Map((section.files || []).map((file) => [strictR2Path(file.path, "Existing manifest file path"), file]));
    for (const file of discoveredSection.files || []) {
      const filePath = strictR2Path(file.path, "R2 discovered file path");
      if (discoveredPaths.has(filePath)) throw new Error(`R2 discovery contains duplicate file path ${filePath}.`);
      discoveredPaths.add(filePath);
      const existing = filesByPath.get(filePath);
      if (existing) {
        Object.assign(existing, cloneFile(file, existing));
        updated += 1;
      } else {
        section.files.push(cloneFile(file));
        added += 1;
      }
    }
  }

  next.sections = [...sections.values()];
  const retainedPaths = [];
  for (const section of next.sections) {
    for (const file of section.files || []) {
      const filePath = strictR2Path(file.path, "Manifest file path");
      if (!discoveredPaths.has(filePath)) retainedPaths.push(filePath);
    }
  }
  return {
    course: next,
    report: {
      added,
      updated,
      missing: [...new Set(retainedPaths)].sort(),
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
      report.missing.push(...merged.report.missing.map((filePath) => ({ basePath: entryBasePath, filePath })));
      continue;
    }
    manifest.courses.push({
      id: createId(entry), term: entry.term, group: entry.group, title: entry.title,
      summary: "待补充课程简介。", contributors: [], assessment: "绩点制",
      updated: date, grades: [], tags: entry.group === "通识选修课" ? ["通识选修课"] : [],
      basePath: `${entryBasePath}/`, sections: structuredClone(entry.sections),
    });
    report.addedCourses += 1;
    report.addedResources += (entry.sections || []).reduce((sum, section) => sum + (section.files || []).length, 0);
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
