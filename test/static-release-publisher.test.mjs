import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StaticReleasePublisher, syncDirectory, validateStaticReleasePaths } from "../server/static-release-publisher.mjs";

async function symlinkDirectory(target, link) {
  await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

async function fixture(t, { keepReleases = 3, syncDirectoryFn } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nkustudy-static-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const publishRoot = path.join(root, "publish");
  const releaseRoot = path.join(publishRoot, "releases");
  const publicDir = path.join(publishRoot, "current");
  const distDir = path.join(root, "dist");
  const initialRelease = path.join(releaseRoot, "release-1-aabbccdd");
  await fs.mkdir(initialRelease, { recursive: true });
  await fs.writeFile(path.join(initialRelease, "index.html"), "initial");
  await fs.mkdir(distDir);
  await fs.writeFile(path.join(distDir, "index.html"), "next");
  await symlinkDirectory(initialRelease, publicDir);
  const publisher = new StaticReleasePublisher({ publicDir, releaseRoot, distDir, production: true, keepReleases, syncDirectoryFn });
  return { root, publishRoot, releaseRoot, publicDir, distDir, initialRelease, publisher };
}

test("production layout confines releases and the mutable current symlink to one publish root", () => {
  assert.throws(() => validateStaticReleasePaths({
    publicDir: "/var/www/nkustudy-current",
    releaseRoot: "/var/www/nkustudy-releases",
    production: true,
  }), /must be the current symlink inside the service-owned publish directory/);
  assert.deepEqual(validateStaticReleasePaths({
    publicDir: "/var/www/nkustudy-publish/current",
    releaseRoot: "/var/www/nkustudy-publish/releases",
    production: true,
  }), {
    publicDir: path.resolve("/var/www/nkustudy-publish/current"),
    releaseRoot: path.resolve("/var/www/nkustudy-publish/releases"),
    publishRoot: path.resolve("/var/www/nkustudy-publish"),
  });
});

test("publishes a Caddy-readable tree and atomically advances current", async (t) => {
  const state = await fixture(t);
  await state.publisher.recoverStartup();
  const proof = await state.publisher.publish(async () => {});
  assert.equal(await fs.readFile(path.join(state.publicDir, "index.html"), "utf8"), "next");
  assert.equal(await fs.realpath(state.publicDir), proof.activeTarget);
  assert.match(path.basename(proof.activeTarget), /^release-\d+-[a-f0-9]+$/);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(proof.activeTarget)).mode & 0o777, 0o755);
    assert.equal((await fs.stat(path.join(proof.activeTarget, "index.html"))).mode & 0o777, 0o644);
  }
});

test("first local publish succeeds when current does not exist", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nkustudy-static-first-publish-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const publishRoot = path.join(root, "publish");
  const releaseRoot = path.join(publishRoot, "releases");
  const publicDir = path.join(publishRoot, "current");
  const distDir = path.join(root, "dist");
  await fs.mkdir(releaseRoot, { recursive: true });
  await fs.mkdir(distDir);
  await fs.writeFile(path.join(distDir, "index.html"), "first");
  const publisher = new StaticReleasePublisher({ publicDir, releaseRoot, distDir, production: false });
  const result = await publisher.publish(async () => {});
  assert.equal(await fs.readFile(path.join(publicDir, "index.html"), "utf8"), "first");
  assert.equal(await fs.realpath(publicDir), result.activeTarget);
});

test("production startup fails closed when current is missing", async (t) => {
  const state = await fixture(t);
  await fs.unlink(state.publicDir);
  assert.equal(state.publisher.readDeploymentProof(), null);
  await assert.rejects(state.publisher.recoverStartup(), /PUBLIC_DIR symlink is missing/);
});

test("production startup fails closed when current is a dangling symlink", async (t) => {
  const state = await fixture(t);
  await fs.unlink(state.publicDir);
  await symlinkDirectory(path.join(state.releaseRoot, "release-404-deadbeef"), state.publicDir);
  assert.throws(() => state.publisher.readDeploymentProof(), /PUBLIC_DIR symlink is dangling/);
  await assert.rejects(state.publisher.recoverStartup(), /PUBLIC_DIR symlink is dangling/);
});

test("serializes concurrent rebuilds", async (t) => {
  const state = await fixture(t);
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = state.publisher.publish(async () => {
    events.push("first-start");
    await firstGate;
    events.push("first-end");
  });
  const second = state.publisher.publish(async () => {
    events.push("second-start");
    events.push("second-end");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second-start", "second-end"]);
});

test("failed build keeps the active release and leaves no publishing residue", async (t) => {
  const state = await fixture(t);
  const before = await fs.realpath(state.publicDir);
  await assert.rejects(state.publisher.publish(async () => { throw new Error("fixture build failed"); }), /fixture build failed/);
  assert.equal(await fs.realpath(state.publicDir), before);
  const publishNames = await fs.readdir(state.publishRoot);
  const releaseNames = await fs.readdir(state.releaseRoot);
  assert.equal(publishNames.some((name) => name.startsWith(".current.next-")), false);
  assert.equal(releaseNames.some((name) => name.startsWith(".building-release-")), false);
});

test("startup recovery removes only managed stale artifacts and validates current", async (t) => {
  const state = await fixture(t);
  const staleBuild = path.join(state.releaseRoot, ".building-release-2-aabbccdd");
  const unrelated = path.join(state.releaseRoot, "keep-me");
  const staleLink = path.join(state.publishRoot, ".current.next-20-30-aabb");
  const similarlyNamedLink = path.join(state.publishRoot, ".current.next-not-managed");
  await fs.mkdir(staleBuild);
  await fs.mkdir(unrelated);
  await symlinkDirectory(state.initialRelease, staleLink);
  await symlinkDirectory(state.initialRelease, similarlyNamedLink);
  await state.publisher.recoverStartup();
  await assert.rejects(fs.access(staleBuild));
  await assert.rejects(fs.access(staleLink));
  await fs.access(similarlyNamedLink);
  await fs.access(unrelated);
  assert.equal(state.publisher.readDeploymentProof().activeTarget, await fs.realpath(state.publicDir));
});

test("directory fsync never hides EACCES or EPERM and closes its handle", async () => {
  for (const code of ["EACCES", "EPERM"]) {
    let closed = false;
    const denied = Object.assign(new Error("denied"), { code });
    await assert.rejects(syncDirectory("/fixture", {
      platform: "linux",
      open: async () => ({ sync: async () => { throw denied; }, close: async () => { closed = true; } }),
    }), (error) => error === denied);
    assert.equal(closed, true);
  }
});

test("unsupported directory fsync is tolerated only for explicit unsupported errors", async () => {
  for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP"]) {
    let closed = false;
    const unsupported = Object.assign(new Error(code), { code });
    assert.deepEqual(await syncDirectory("/fixture", {
      platform: "linux",
      open: async () => ({ sync: async () => { throw unsupported; }, close: async () => { closed = true; } }),
    }), { supported: false });
    assert.equal(closed, true);
  }
});

test("post-switch fsync failure advances current but returns an explicit durability warning", async (t) => {
  const denied = Object.assign(new Error("fsync denied"), { code: "EACCES" });
  const state = await fixture(t, { syncDirectoryFn: async () => { throw denied; } });
  const before = await fs.realpath(state.publicDir);
  const result = await state.publisher.publish(async () => {});
  assert.notEqual(await fs.realpath(state.publicDir), before);
  assert.equal(await fs.realpath(state.publicDir), result.activeTarget);
  assert.ok(result.warnings.some((warning) => warning.includes("publish directory sync failed: fsync denied")));
  assert.ok(result.warnings.some((warning) => warning.includes("old release cleanup failed: fsync denied")));
});

test("unsupported post-switch directory fsync is reported instead of claiming full durability", async (t) => {
  const state = await fixture(t, { syncDirectoryFn: async () => ({ supported: false }) });
  const result = await state.publisher.publish(async () => {});
  assert.deepEqual(result.warnings, [
    "publish directory fsync is unsupported on this platform or filesystem",
    "release directory fsync is unsupported on this platform or filesystem",
  ]);
});

test("retains the active release and only the configured number of newest releases", async (t) => {
  const state = await fixture(t, { keepReleases: 2 });
  for (let index = 0; index < 3; index += 1) {
    await fs.writeFile(path.join(state.distDir, "index.html"), `release-${index}`);
    await state.publisher.publish(async () => {});
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const releases = (await fs.readdir(state.releaseRoot)).filter((name) => /^release-/.test(name));
  assert.equal(releases.length, 2);
  assert.ok(releases.includes(path.basename(await fs.realpath(state.publicDir))));
});
