import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("every reviewed fixture JSON is explicitly unignored and staged by the fixture build", () => {
  const fixtureNames = fs.readdirSync(path.join(root, "src", "data", "fixtures")).filter((name) => name.endsWith(".json")).sort();
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  const buildSource = fs.readFileSync(path.join(root, "scripts", "build-with-fixtures.mjs"), "utf8");
  for (const name of fixtureNames) {
    assert.match(gitignore, new RegExp(`^!src/data/fixtures/${name.replace(".", "\\.")}$`, "m"), `${name} is not explicitly tracked`);
    assert.equal(buildSource.includes(`"${name}"`), true, `${name} is not staged by the fixture build`);
  }
});
