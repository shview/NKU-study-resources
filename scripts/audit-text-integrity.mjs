import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "../server/runtime-config.mjs";
import { decodeUtf8Strict, findReplacementCharacters } from "../server/text-integrity.mjs";

const dataDir = resolveDataDir();
const files = fs.readdirSync(dataDir).filter((name) => name.endsWith(".json")).sort();
const findings = [];

for (const filename of files) {
  const filePath = path.join(dataDir, filename);
  try {
    const bytes = fs.readFileSync(filePath);
    const data = JSON.parse(decodeUtf8Strict(bytes, filename));
    for (const jsonPath of findReplacementCharacters(data)) findings.push({ filename, jsonPath });
  } catch (error) {
    findings.push({ filename, jsonPath: "$", error: error.message });
  }
}

if (findings.length) {
  console.error(`Text integrity audit failed with ${findings.length} finding(s):`);
  for (const finding of findings) console.error(`- ${finding.filename} ${finding.jsonPath}${finding.error ? `: ${finding.error}` : ": contains U+FFFD"}`);
  process.exit(1);
}

console.log(`Text integrity OK: ${files.length} JSON file(s) are strict UTF-8 with no U+FFFD.`);
