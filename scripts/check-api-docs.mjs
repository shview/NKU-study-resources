import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { documentedRoutes, sourceRoutes } from "./api-route-extractor.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsPath = path.join(root, "docs", "API.md");
const sourcePaths = [
  path.join(root, "server", "public-api-router.mjs"),
  path.join(root, "server", "admin-server.mjs"),
];

const docs = fs.readFileSync(docsPath, "utf8");
const documented = documentedRoutes(docs);

const actual = new Set();
for (const sourcePath of sourcePaths) {
  for (const route of sourceRoutes(fs.readFileSync(sourcePath, "utf8"))) actual.add(route);
}

const missing = [...actual].filter((route) => !documented.has(route)).sort();
const extra = [...documented].filter((route) => !actual.has(route)).sort();
assert.deepEqual(missing, [], `Routes missing from docs/API.md:\n${missing.join("\n")}`);
assert.deepEqual(extra, [], `Routes documented but not registered:\n${extra.join("\n")}`);
console.log(`API documentation route registry matches ${actual.size} registered method/path pairs.`);
