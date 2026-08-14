import fs from "node:fs";
import path from "node:path";
import { validateManifest } from "../server/manifest-schema.mjs";
import { resolveDataPath } from "../server/runtime-config.mjs";

const useFixtures = process.argv.includes("--fixtures");
if (!useFixtures && !process.env.DATA_DIR) {
  throw new Error("DATA_DIR is required for check:content. Use npm run check:fixtures for synthetic repository fixtures.");
}
const manifestPath = useFixtures
  ? path.resolve(import.meta.dirname, "..", "src", "data", "fixtures", "manifest.json")
  : resolveDataPath("manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const errors = validateManifest(manifest);

if (errors.length) {
  console.error("Content check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const fileCount = manifest.courses.reduce((sum, course) => {
  return sum + (course.sections ?? []).reduce((inner, section) => inner + (section.files ?? []).length, 0);
}, 0);

console.log(`Content OK: ${manifest.courses.length} courses, ${fileCount} files.`);
