import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AtomicJsonStore } from "../server/atomic-json-store.mjs";

async function tempDir(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nkustudy-store-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("50 concurrent updates do not lose data", async (t) => {
  const directory = await tempDir(t);
  const file = path.join(directory, "counter.json");
  const store = new AtomicJsonStore();
  await store.write(file, { count: 0 });
  await Promise.all(Array.from({ length: 50 }, () => store.update(file, (value) => ({ count: value.count + 1 }))));
  assert.deepEqual(await store.read(file), { count: 50 });
  assert.equal((await fs.readFile(file, "utf8")).endsWith("\n"), true);
});

test("a failure before rename preserves the original and removes temp files", async (t) => {
  const directory = await tempDir(t);
  const file = path.join(directory, "state.json");
  const baseline = new AtomicJsonStore();
  await baseline.write(file, { safe: true });
  const failing = new AtomicJsonStore({ faultHook(stage) {
    if (stage === "beforeRename") throw new Error("injected failure");
  } });
  await assert.rejects(failing.write(file, { safe: false }), /injected failure/);
  assert.deepEqual(await baseline.read(file), { safe: true });
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.includes(".tmp-")), []);
});

test("allowedRoot rejects traversal and symbolic-link targets", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nkustudy-store-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "nkustudy-store-outside-"));
  t.after(() => Promise.all([fs.rm(directory, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  const store = new AtomicJsonStore({ allowedRoot: directory });
  await assert.rejects(store.write(path.join(outside, "escape.json"), { bad: true }), /outside allowedRoot/);
  const target = path.join(outside, "target.json");
  await fs.writeFile(target, "{}\n");
  const link = path.join(directory, "link.json");
  try {
    await fs.symlink(target, link);
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) return;
    throw error;
  }
  await assert.rejects(store.write(link, { bad: true }), /Symbolic link/);
});

test("afterWrite rollback and a queued public update are serialized without data loss", async (t) => {
  const directory = await tempDir(t);
  const file = path.join(directory, "shared.json");
  const store = new AtomicJsonStore({ allowedRoot: directory });
  await store.write(file, { items: ["before"] });
  let releaseBuild;
  const buildStarted = new Promise((resolve) => { releaseBuild = resolve; });
  let failBuild;
  const buildFailure = new Promise((_, reject) => { failBuild = reject; });
  const admin = store.update(file, () => ({ items: ["admin"] }), {
    afterWrite: async () => {
      releaseBuild();
      await buildFailure;
    },
    rollbackOnAfterWriteError: true,
  });
  await buildStarted;
  const publicWrite = store.update(file, (current) => ({ items: [...current.items, "public"] }));
  failBuild(new Error("synthetic build failure"));
  await assert.rejects(admin, (error) => error.atomicJsonRolledBack === true);
  await publicWrite;
  assert.deepEqual(await store.read(file), { items: ["before", "public"] });
});
