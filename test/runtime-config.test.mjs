import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { projectRoot, resolveAdminSecretPath, resolveDataDir, resolveDataPath, resolvePublicDir, resolvePublicReleasesDir, resolveStateDbPath } from "../server/runtime-config.mjs";

test("DATA_DIR and STATE_DB_PATH resolve runtime paths", () => {
  const dataDir = path.resolve("runtime-data-test");
  assert.equal(resolveDataDir({ DATA_DIR: dataDir }), dataDir);
  assert.equal(resolveDataPath("manifest.json", { DATA_DIR: dataDir }), path.join(dataDir, "manifest.json"));
  assert.equal(resolveStateDbPath({ DATA_DIR: dataDir }), path.join(dataDir, "miniprogram.sqlite"));
  assert.equal(resolveStateDbPath({ STATE_DB_PATH: path.join(dataDir, "state.sqlite") }), path.join(dataDir, "state.sqlite"));
  assert.throws(() => resolveDataPath("../secret.json", { DATA_DIR: dataDir }), /Invalid runtime data filename/);
});

test("production runtime paths are explicit, absolute, and outside releases", () => {
  assert.throws(() => resolveDataDir({ NODE_ENV: "production" }), /explicitly configured/);
  assert.throws(() => resolveDataDir({ NODE_ENV: "production", DATA_DIR: "relative" }), /absolute path/);
  assert.throws(() => resolveDataDir({ NODE_ENV: "production", DATA_DIR: path.join(projectRoot, "runtime") }), /outside the release tree/);
  assert.throws(() => resolveStateDbPath({ NODE_ENV: "production", STATE_DB_PATH: path.join(projectRoot, "state.sqlite") }), /outside the release tree/);
  assert.throws(() => resolveAdminSecretPath({ NODE_ENV: "production", ADMIN_SECRET_FILE: path.join(projectRoot, "secret") }), /outside the release tree/);
  assert.throws(() => resolvePublicDir({ NODE_ENV: "production" }), /explicitly configured/);
  assert.throws(() => resolvePublicDir({ NODE_ENV: "production", PUBLIC_DIR: "relative" }), /absolute path/);
  assert.throws(() => resolvePublicReleasesDir({ NODE_ENV: "production" }), /explicitly configured/);
  const publicReleasesDir = path.join(os.tmpdir(), "nkustudy-runtime-public", "releases");
  assert.equal(resolvePublicReleasesDir({ NODE_ENV: "production", PUBLIC_RELEASES_DIR: publicReleasesDir }), publicReleasesDir);
});

test("production preflight fails before creating SQLite or mutable files", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nkustudy-prod-preflight-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const stateDir = path.join(root, "state");
  const secretDir = path.join(root, "secrets");
  await Promise.all([fsp.mkdir(dataDir), fsp.mkdir(stateDir), fsp.mkdir(secretDir)]);
  await fsp.chmod(dataDir, 0o700);
  await fsp.chmod(stateDir, 0o700);
  await fsp.chmod(secretDir, 0o700);
  await fsp.writeFile(path.join(dataDir, ".nkustudy-data-root"), "NKUSTUDY_RUNTIME_DATA_V1\n", { mode: 0o600 });
  const secretPath = path.join(secretDir, "admin-hmac");
  await fsp.writeFile(secretPath, "x".repeat(64), { mode: 0o600 });
  const dbPath = path.join(stateDir, "state.sqlite");
  const result = spawnSync(process.execPath, [path.join(projectRoot, "server", "admin-server.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATA_DIR: dataDir,
      STATE_DB_PATH: dbPath,
      ADMIN_SECRET_FILE: secretPath,
      PUBLIC_DIR: path.join(root, "nkustudy-current"),
      PUBLIC_RELEASES_DIR: path.join(root, "releases"),
      TRUSTED_PROXIES: "127.0.0.1/32,::1/128",
      ADMIN_PASSWORD: "test-only-password",
    },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /Core data manifest\.json|ENOENT/);
  assert.equal(fs.existsSync(dbPath), false);
  assert.equal(fs.existsSync(path.join(dataDir, "reviews.json")), false);
});
