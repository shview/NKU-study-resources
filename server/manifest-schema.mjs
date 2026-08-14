import { randomUUID } from "node:crypto";
import { strictR2BasePath, strictR2Path } from "./r2-mutation-plan.mjs";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pathsOverlap(left, right) {
  const leftPath = left.endsWith("/") ? left.slice(0, -1) : left;
  const rightPath = right.endsWith("/") ? right.slice(0, -1) : right;
  return leftPath === rightPath || leftPath.startsWith(`${rightPath}/`) || rightPath.startsWith(`${leftPath}/`);
}

export function assignMissingCourseUids(manifest, { createUid = randomUUID } = {}) {
  for (const course of manifest?.courses || []) {
    if (!course.uid) course.uid = createUid();
  }
  return manifest;
}

/**
 * Reconciles an administrator's complete manifest replacement against the
 * latest persisted manifest. Once the migration has assigned UIDs, identity
 * is UID-only: names, ids and paths are editable attributes, never identity.
 */
export function reconcileCourseUids(current, incoming, { createUid = randomUUID, deletedCourseUids } = {}) {
  const next = structuredClone(incoming || {});
  next.courses = Array.isArray(next.courses) ? next.courses : [];
  const currentCourses = Array.isArray(current?.courses) ? current.courses : [];
  if (currentCourses.some((course) => !course.uid)) {
    throw new Error("Persisted courses must be backfilled with UIDs before online edits are accepted.");
  }
  const currentByUid = new Map(currentCourses.map((course) => [course.uid, course]));
  const seen = new Set();
  const uidless = [];

  for (const course of next.courses) {
    const suppliedUid = String(course.uid || "").trim();
    if (suppliedUid) {
      const uidMatch = currentByUid.get(suppliedUid);
      if (!uidMatch) {
        throw new Error(`Unknown course uid ${suppliedUid}; new courses must omit uid so the server can assign it.`);
      }
      course.uid = uidMatch.uid;
    } else {
      uidless.push(course);
      course.uid = createUid();
    }
    if (seen.has(course.uid)) throw new Error(`Duplicate course uid ${course.uid}.`);
    seen.add(course.uid);
  }

  const actualDeleted = currentCourses.map((course) => course.uid).filter((uid) => !seen.has(uid)).sort();
  if (!Array.isArray(deletedCourseUids)) {
    throw new Error("deletedCourseUids is required for a complete manifest replacement.");
  }
  const declaredDeleted = [...new Set(deletedCourseUids.map((uid) => String(uid || "").trim()).filter(Boolean))].sort();
  if (declaredDeleted.some((uid) => !currentByUid.has(uid))) {
    throw new Error("deletedCourseUids contains an unknown course UID.");
  }
  if (JSON.stringify(actualDeleted) !== JSON.stringify(declaredDeleted)) {
    throw new Error("deletedCourseUids must exactly match the courses removed from the loaded manifest.");
  }
  if (actualDeleted.length && uidless.length) {
    throw new Error("Ambiguous replacement: a request cannot delete existing courses and add UID-less courses at the same time. Save the deletion and addition separately.");
  }
  return next;
}

export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object") errors.push("manifest must be an object.");
  if (!manifest?.resourceRoot) errors.push("resourceRoot is required.");
  if (!Array.isArray(manifest?.courses)) errors.push("courses must be an array.");
  const ids = new Set();
  const uids = new Set();
  const basePaths = [];
  const publicResourceKeys = new Map();
  for (const [index, course] of (manifest?.courses || []).entries()) {
    const label = course.title || `course #${index + 1}`;
    for (const key of ["uid", "id", "term", "group", "title", "updated", "basePath"]) {
      if (!course[key]) errors.push(`${label}: missing ${key}.`);
    }
    if (course.uid && !UUID_PATTERN.test(course.uid)) errors.push(`${label}: invalid uid ${course.uid}.`);
    if (course.uid && uids.has(course.uid)) errors.push(`${label}: duplicate uid ${course.uid}.`);
    if (course.uid) uids.add(course.uid);
    if (course.id && ids.has(course.id)) errors.push(`${label}: duplicate id ${course.id}.`);
    if (course.id) ids.add(course.id);
    if (!Array.isArray(course.sections)) errors.push(`${label}: sections must be an array.`);
    let canonicalBasePath;
    try {
      canonicalBasePath = strictR2BasePath(course.basePath, `${label}: basePath`);
      for (const previous of basePaths) {
        if (pathsOverlap(canonicalBasePath, previous.path)) {
          errors.push(`${label}: basePath ${canonicalBasePath} overlaps ${previous.label}: ${previous.path}.`);
        }
      }
      basePaths.push({ path: canonicalBasePath, label });
    } catch (error) {
      errors.push(error.message);
    }
    const courseFilePaths = new Map();
    for (const section of course.sections || []) {
      if (!section.title) errors.push(`${label}: section missing title.`);
      if (!Array.isArray(section.files)) errors.push(`${label}/${section.title}: files must be an array.`);
      for (const file of section.files || []) {
        if (!file.title) errors.push(`${label}/${section.title}: file missing title.`);
        if (!file.path) errors.push(`${label}/${section.title}/${file.title || "file"}: file missing path.`);
        if (file.path) {
          try {
            const canonicalFilePath = strictR2Path(file.path, `${label}/${section.title}: file path`);
            const previousSection = courseFilePaths.get(canonicalFilePath);
            if (previousSection) {
              errors.push(`${label}: duplicate file path ${canonicalFilePath} in sections ${previousSection} and ${section.title}.`);
            } else {
              courseFilePaths.set(canonicalFilePath, section.title || "untitled");
            }
            if (canonicalBasePath) {
              const publicKey = `${canonicalBasePath}${canonicalFilePath}`;
              const previousOwner = publicResourceKeys.get(publicKey);
              if (previousOwner) errors.push(`${label}: public resource key ${publicKey} collides with ${previousOwner}.`);
              else publicResourceKeys.set(publicKey, label);
            }
          }
          catch (error) { errors.push(error.message); }
        }
      }
    }
  }
  return errors;
}
