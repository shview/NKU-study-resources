function badPath(label, reason) {
  const error = new Error(`${label} ${reason}`);
  error.statusCode = 400;
  return error;
}

export function strictR2Path(value, label = "R2 path") {
  if (typeof value !== "string") throw badPath(label, "must be a string.");
  if (!value || value !== value.trim()) throw badPath(label, "must be non-empty and have no surrounding whitespace.");
  if (value.includes("\\") || value.startsWith("/") || value.endsWith("/") || value.includes("//")) {
    throw badPath(label, "must be a canonical relative slash-separated path.");
  }
  const segments = value.split("/");
  for (const segment of segments) {
    if (!segment || segment !== segment.trim() || segment === "." || segment === ".." || /[\u0000-\u001f\u007f]/.test(segment)) {
      throw badPath(label, "contains an unsafe path segment.");
    }
    let decoded = segment;
    for (let depth = 0; depth < 5; depth += 1) {
      let next;
      try {
        next = decodeURIComponent(decoded);
      } catch {
        throw badPath(label, "contains invalid percent encoding.");
      }
      if (next !== next.trim() || next === "." || next === ".." || next.includes("/") || next.includes("\\") || /[\u0000-\u001f\u007f]/.test(next)) {
        throw badPath(label, "contains an encoded traversal or separator.");
      }
      if (next === decoded) break;
      decoded = next;
    }
  }
  return segments.join("/");
}

/** Manifest basePath values are canonical directory paths with one trailing slash. */
export function strictR2BasePath(value, label = "R2 basePath") {
  if (typeof value !== "string" || !value.endsWith("/") || value.endsWith("//")) {
    throw badPath(label, "must be a canonical relative path ending in exactly one slash.");
  }
  const canonical = `${strictR2Path(value.slice(0, -1), label)}/`;
  if (value !== canonical) throw badPath(label, "must equal its canonical slash-separated representation.");
  return canonical;
}

function overlaps(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function courseFiles(course) {
  const files = new Set();
  for (const section of course?.sections || []) {
    for (const file of section.files || []) files.add(strictR2Path(String(file.path || ""), `File path in course ${course.uid || course.id || "unknown"}`));
  }
  return files;
}

/** Produces the only accepted authorization plan for destructive R2 changes. */
export function planR2ManifestMutation(currentManifest, nextManifest, {
  moves = [],
  fileDeletes = [],
  deletedCourseUids = [],
  r2Prefix = "resources",
} = {}) {
  const prefix = strictR2Path(r2Prefix, "R2 prefix");
  const currentCourses = Array.isArray(currentManifest?.courses) ? currentManifest.courses : [];
  const nextCourses = Array.isArray(nextManifest?.courses) ? nextManifest.courses : [];
  const currentByUid = new Map(currentCourses.map((course) => [course.uid, course]));
  const nextByUid = new Map(nextCourses.filter((course) => course.uid).map((course) => [course.uid, course]));
  const actualDeleted = currentCourses.filter((course) => !nextByUid.has(course.uid)).map((course) => course.uid).sort();
  const declaredDeleted = [...new Set((deletedCourseUids || []).map(String))].sort();
  if (JSON.stringify(actualDeleted) !== JSON.stringify(declaredDeleted)) {
    throw badPath("deletedCourseUids", "must exactly authorize every removed course.");
  }

  const changed = new Map();
  for (const [uid, before] of currentByUid) {
    const after = nextByUid.get(uid);
    if (!after) continue;
    const oldBasePath = strictR2BasePath(before.basePath, `Loaded basePath for ${uid}`).slice(0, -1);
    const newBasePath = strictR2BasePath(after.basePath, `Proposed basePath for ${uid}`).slice(0, -1);
    if (oldBasePath !== newBasePath) changed.set(uid, { courseUid: uid, oldBasePath, newBasePath });
  }

  const normalizedMoves = [];
  const movedUids = new Set();
  for (const move of moves || []) {
    const uid = String(move?.courseUid || "");
    if (!uid || movedUids.has(uid)) throw badPath("R2 moves", "must contain each changed course UID exactly once.");
    const expected = changed.get(uid);
    if (!expected) throw badPath("R2 move", `for ${uid} does not correspond to a basePath change.`);
    const oldBasePath = strictR2Path(move.oldBasePath, `Move source for ${uid}`);
    const newBasePath = strictR2Path(move.newBasePath, `Move target for ${uid}`);
    if (oldBasePath !== expected.oldBasePath || newBasePath !== expected.newBasePath) {
      throw badPath("R2 move", `for ${uid} must exactly match the loaded and proposed basePath.`);
    }
    movedUids.add(uid);
    const beforeFiles = courseFiles(currentByUid.get(uid));
    const afterFiles = courseFiles(nextByUid.get(uid));
    normalizedMoves.push({
      ...expected,
      sourcePrefix: `${prefix}/${oldBasePath}`,
      targetPrefix: `${prefix}/${newBasePath}`,
      beforeFiles,
      afterFiles,
    });
  }
  if (movedUids.size !== changed.size) throw badPath("R2 moves", "must authorize every basePath change one-to-one.");

  for (let left = 0; left < normalizedMoves.length; left += 1) {
    for (let right = left + 1; right < normalizedMoves.length; right += 1) {
      if (overlaps(normalizedMoves[left].sourcePrefix, normalizedMoves[right].sourcePrefix)
        || overlaps(normalizedMoves[left].targetPrefix, normalizedMoves[right].targetPrefix)) {
        throw badPath("R2 moves", "contain overlapping source or target prefixes.");
      }
    }
    for (const candidate of normalizedMoves) {
      if (overlaps(normalizedMoves[left].sourcePrefix, candidate.targetPrefix)) {
        throw badPath("R2 moves", "may not overlap any source and target prefix.");
      }
    }
  }

  const nextBaseOwners = new Map();
  for (const course of nextCourses) {
    const basePath = strictR2BasePath(course.basePath, `Proposed basePath for ${course.uid || course.id || "new course"}`).slice(0, -1);
    for (const [otherPath, owner] of nextBaseOwners) {
      if (overlaps(basePath, otherPath)) throw badPath("Proposed course basePaths", `overlap between ${owner} and ${course.uid || course.id || "new course"}.`);
    }
    nextBaseOwners.set(basePath, course.uid || course.id || "new course");
  }

  const declaredDeletes = new Map();
  for (const request of fileDeletes || []) {
    const uid = String(request?.courseUid || "");
    if (!currentByUid.has(uid) || !nextByUid.has(uid)) {
      throw badPath("File deletion", "must reference an existing course UID retained by the proposed manifest.");
    }
    if (declaredDeletes.has(uid)) throw badPath("File deletion", `contains duplicate course entry ${uid}.`);
    declaredDeletes.set(uid, new Set((request.paths || []).map((filePath) => strictR2Path(String(filePath), `Deleted file path for ${uid}`))));
  }

  const fileDeleteKeys = [];
  for (const [uid, before] of currentByUid) {
    const after = nextByUid.get(uid);
    if (!after) continue;
    const beforeFiles = courseFiles(before);
    const afterFiles = courseFiles(after);
    const removed = [...beforeFiles].filter((filePath) => !afterFiles.has(filePath)).sort();
    const declared = [...(declaredDeletes.get(uid) || new Set())].sort();
    if (JSON.stringify(removed) !== JSON.stringify(declared)) {
      throw badPath("File deletion", `for ${uid} must exactly authorize every removed manifest file.`);
    }
    if (changed.has(uid)) {
      changed.get(uid).deletedFilePaths = removed;
      const move = normalizedMoves.find((entry) => entry.courseUid === uid);
      if (move) move.deletedFilePaths = removed;
    } else {
      const basePath = strictR2BasePath(before.basePath, `Loaded basePath for ${uid}`).slice(0, -1);
      for (const filePath of removed) fileDeleteKeys.push(`${prefix}/${basePath}/${filePath}`);
    }
  }
  for (const uid of declaredDeletes.keys()) {
    if (!currentByUid.has(uid)) throw badPath("File deletion", `references unknown course ${uid}.`);
  }

  const deletedCoursePrefixes = actualDeleted.map((uid) => {
    const basePath = strictR2BasePath(currentByUid.get(uid).basePath, `Deleted course basePath for ${uid}`).slice(0, -1);
    return `${prefix}/${basePath}`;
  });
  const targetPrefixes = normalizedMoves.map((move) => move.targetPrefix);
  const retainedCoursePrefixes = nextCourses.map((course) => {
    const basePath = strictR2BasePath(course.basePath, `Retained course basePath for ${course.uid || course.id || "new course"}`).slice(0, -1);
    return `${prefix}/${basePath}`;
  });
  for (const cleanupPrefix of deletedCoursePrefixes) {
    if (retainedCoursePrefixes.some((retained) => overlaps(cleanupPrefix, retained))) {
      throw badPath("R2 cleanup", `deleted course prefix ${cleanupPrefix} overlaps retained course prefix.`);
    }
  }
  for (const cleanupKey of fileDeleteKeys) {
    if (targetPrefixes.some((target) => overlaps(cleanupKey, target))) {
      throw badPath("R2 cleanup", `file key ${cleanupKey} overlaps a move target.`);
    }
  }
  for (const move of normalizedMoves) {
    const deleted = new Set(move.deletedFilePaths || []);
    const requiredRelativePaths = [...move.beforeFiles].filter((filePath) => !deleted.has(filePath)).sort();
    const proposedRelativePaths = [...move.afterFiles].sort();
    if (JSON.stringify(requiredRelativePaths) !== JSON.stringify(proposedRelativePaths)) {
      throw badPath("R2 move", `for ${move.courseUid} may only relocate unchanged declared file paths; add or rename resources in a separate explicit transaction.`);
    }
    move.requiredObjects = requiredRelativePaths.map((relativePath) => ({
      relativePath,
      sourceKey: `${move.sourcePrefix}/${relativePath}`,
      targetKey: `${move.targetPrefix}/${relativePath}`,
    }));
    delete move.beforeFiles;
    delete move.afterFiles;
  }
  return { moves: normalizedMoves, fileDeleteKeys, deletedCoursePrefixes };
}

export function planR2ObjectCopies(move, sourceObjects, targetObjects, { reservedTargets = new Set() } = {}) {
  if (!move?.sourcePrefix || !move?.targetPrefix) throw badPath("R2 object copy", "requires planned source and target prefixes.");
  if ((targetObjects || []).length) {
    const error = new Error(`R2 move target ${move.targetPrefix} is not empty; refusing to overwrite existing objects.`);
    error.statusCode = 409;
    throw error;
  }
  const oldPrefix = `${move.sourcePrefix}/`;
  const newPrefix = `${move.targetPrefix}/`;
  const deletedPaths = new Set(move.deletedFilePaths || []);
  const copies = [];
  const cleanupKeys = [];
  const unmovedSourceKeys = [];
  const sourceByKey = new Map((sourceObjects || []).filter((object) => typeof object?.Key === "string").map((object) => [object.Key, object]));
  for (const required of move.requiredObjects || []) {
    if (!sourceByKey.has(required.sourceKey)) {
      const error = new Error(`R2 move source is missing manifest-declared object ${required.sourceKey}; refusing to publish.`);
      error.statusCode = 409;
      throw error;
    }
  }
  for (const source of sourceObjects || []) {
    if (typeof source?.Key !== "string" || !source.Key.startsWith(oldPrefix)) {
      throw badPath("R2 source object", `must be strictly beneath ${move.sourcePrefix}.`);
    }
    let relativePath;
    try {
      relativePath = strictR2Path(source.Key.slice(oldPrefix.length), `R2 source object under ${move.sourcePrefix}`);
    } catch {
      // Raw R2 keys are opaque. Unsafe spellings are neither transformed nor
      // deleted; they remain at the old prefix for explicit manual handling.
      unmovedSourceKeys.push(source.Key);
      continue;
    }
    cleanupKeys.push(source.Key);
    if (deletedPaths.has(relativePath)) continue;
    const targetKey = `${newPrefix}${relativePath}`;
    if (reservedTargets.has(targetKey)) throw badPath("R2 copy", `target collision at ${targetKey}.`);
    reservedTargets.add(targetKey);
    copies.push({ source, targetKey });
  }
  const declaredSourceKeys = new Set((move.requiredObjects || []).map((item) => item.sourceKey));
  const extraSourceKeys = cleanupKeys.filter((key) => !declaredSourceKeys.has(key));
  return { copies, cleanupKeys, extraSourceKeys, unmovedSourceKeys };
}

export function assertR2CleanupSafety(cleanupKeys, targetKeys, targetPrefixes = []) {
  const exactCleanup = [...new Set(cleanupKeys || [])];
  const exactTargets = [...new Set(targetKeys || [])];
  for (const key of [...exactCleanup, ...exactTargets, ...(targetPrefixes || [])]) {
    if (typeof key !== "string" || !key) throw badPath("R2 cleanup", "contains an empty or non-string key.");
  }
  for (const cleanup of exactCleanup) {
    if (exactTargets.some((target) => overlaps(cleanup, target))
      || (targetPrefixes || []).some((target) => overlaps(cleanup, target))) {
      throw badPath("R2 cleanup", `key ${cleanup} overlaps a copy target.`);
    }
  }
  return exactCleanup;
}
