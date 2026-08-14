import fs from "node:fs";
import path from "node:path";

const manifestPath = path.resolve("src/data/manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

const errors = [];
const ids = new Set();

if (!manifest.resourceRoot) errors.push("manifest.resourceRoot is required.");
if (!Array.isArray(manifest.courses)) errors.push("manifest.courses must be an array.");

for (const [index, course] of (manifest.courses ?? []).entries()) {
  const label = course.title || `course #${index + 1}`;
  for (const key of ["id", "term", "group", "title", "updated", "basePath"]) {
    if (!course[key]) errors.push(`${label}: missing ${key}.`);
  }
  if (course.id) {
    if (ids.has(course.id)) errors.push(`${label}: duplicate id ${course.id}.`);
    ids.add(course.id);
  }
  if (!Array.isArray(course.sections)) errors.push(`${label}: sections must be an array.`);
  for (const section of course.sections ?? []) {
    if (!section.title) errors.push(`${label}: section missing title.`);
    if (!Array.isArray(section.files)) errors.push(`${label}/${section.title}: files must be an array.`);
    for (const file of section.files ?? []) {
      if (!file.title) errors.push(`${label}/${section.title}: file missing title.`);
      if (!file.path) errors.push(`${label}/${section.title}/${file.title ?? "file"}: file missing path.`);
    }
  }
}

if (errors.length) {
  console.error("Content check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const fileCount = manifest.courses.reduce((sum, course) => {
  return sum + (course.sections ?? []).reduce((inner, section) => inner + (section.files ?? []).length, 0);
}, 0);

console.log(`Content OK: ${manifest.courses.length} courses, ${fileCount} files.`);
