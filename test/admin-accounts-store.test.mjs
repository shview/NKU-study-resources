import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AdminAccountsStore, ADMIN_PERMISSION_POINTS, hasAdminPermission, normalizeAdminPermissions } from "../server/admin-accounts-store.mjs";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nkustudy-accounts-"));
  const store = new AdminAccountsStore({ dbPath: path.join(dir, "accounts.sqlite") });
  return { store, dir };
}

test("create and verify accounts with scrypt hashes", () => {
  const { store } = tempStore();
  const account = store.create({ username: "Shview", password: "super-password-123", permissions: ADMIN_PERMISSION_POINTS });
  assert.equal(account.username, "Shview");
  assert.equal(account.enabled, true);
  assert.deepEqual(account.permissions, ADMIN_PERMISSION_POINTS);
  assert.equal(store.verify("Shview", "wrong-password-1"), null);
  const verified = store.verify("Shview", "super-password-123");
  assert.equal(verified.username, "Shview");
  assert.equal(store.list().length, 1);
  assert.equal(JSON.stringify(store.list()).includes("super-password-123"), false, "plaintext passwords must never be returned");
});

test("disabled accounts fail verification but keep their row", () => {
  const { store } = tempStore();
  store.create({ username: "editor1", password: "editor-password-1", permissions: ["content.read"] });
  store.updateSettings(1, { enabled: false });
  assert.equal(store.verify("editor1", "editor-password-1"), null);
  assert.equal(store.getById(1).enabled, false);
});

test("last accounts.manage holder cannot be disabled, demoted, or removed", () => {
  const { store } = tempStore();
  const superAdmin = store.create({ username: "Shview", password: "super-password-123", permissions: ADMIN_PERMISSION_POINTS });
  store.create({ username: "helper", password: "helper-password-12", permissions: ["content.read"] });
  assert.throws(() => store.updateSettings(superAdmin.id, { permissions: ["content.read"] }), /最后一个/);
  assert.throws(() => store.updateSettings(superAdmin.id, { enabled: false }), /最后一个/);
  assert.throws(() => store.remove(superAdmin.id, { actorUsername: "helper" }), /最后一个/);
  store.updateSettings(2, { permissions: ADMIN_PERMISSION_POINTS });
  assert.doesNotThrow(() => store.updateSettings(superAdmin.id, { enabled: false }), "protection lifts once another holder exists");
});

test("self deletion is rejected", () => {
  const { store } = tempStore();
  const account = store.create({ username: "Shview", password: "super-password-123", permissions: ADMIN_PERMISSION_POINTS });
  store.create({ username: "helper", password: "helper-password-12", permissions: ADMIN_PERMISSION_POINTS });
  assert.throws(() => store.remove(account.id, { actorUsername: "Shview" }), /自己/);
});

test("password policy and username policy are enforced", () => {
  const { store } = tempStore();
  assert.throws(() => store.create({ username: "a", password: "long-enough-password", permissions: ["content.read"] }), /用户名/);
  assert.throws(() => store.create({ username: "valid_user", password: "short", permissions: ["content.read"] }), /密码/);
  assert.throws(() => store.create({ username: "valid_user", password: "long-enough-password", permissions: ["not-a-permission"] }), /权限/);
});

test("setPassword clears or forces the must-change notice", () => {
  const { store } = tempStore();
  const account = store.create({ username: "editor1", password: "initial-password-1", permissions: ["content.read"], mustChangePassword: true });
  assert.equal(store.getById(account.id).mustChangePassword, true);
  store.setPassword(account.id, "replaced-password-1");
  assert.equal(store.getById(account.id).mustChangePassword, false);
  store.setPassword(account.id, "reset-password-123", { forceChangeNextLogin: true });
  assert.equal(store.getById(account.id).mustChangePassword, true);
  assert.equal(store.verify("editor1", "reset-password-123").username, "editor1");
});

test("audit entries are recorded, filtered, and trimmed", () => {
  const { store } = tempStore();
  store.audit({ username: "Shview", action: "POST /admin-api/manifest", method: "POST", path: "/admin-api/manifest", status: 200, ip: "127.0.0.1" });
  store.audit({ username: "viewer1", action: "login.failed", method: "POST", path: "/admin-api/login", status: 403, ip: "127.0.0.1" });
  const all = store.queryAudit({ page: 1, pageSize: 10 });
  assert.equal(all.total, 2);
  assert.equal(all.items[0].username, "viewer1", "newest first");
  const filtered = store.queryAudit({ username: "Shview" });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].action, "POST /admin-api/manifest");
});

test("backup export and restore round-trip accounts without passwords", () => {
  const { store, dir } = tempStore();
  store.create({ username: "Shview", password: "super-password-123", permissions: ADMIN_PERMISSION_POINTS });
  const exported = store.exportForBackup();
  assert.equal(exported.accounts.length, 1);
  assert.equal(exported.accounts[0].password_hash.startsWith("scrypt$"), true);

  const restored = new AdminAccountsStore({ dbPath: path.join(dir, "accounts-restored.sqlite") });
  restored.restoreFromBackup(exported);
  assert.equal(restored.verify("Shview", "super-password-123").username, "Shview", "hashes survive the round-trip");
});

test("normalizeAdminPermissions drops unknown points and hasAdminPermission respects enabled state", () => {
  assert.deepEqual(normalizeAdminPermissions(["content.read", "bogus", "content.read"]), ["content.read"]);
  const { store } = tempStore();
  const account = store.create({ username: "viewer1", password: "viewer-password-123", permissions: ["content.read"] });
  assert.equal(hasAdminPermission(account, "content.read"), true);
  assert.equal(hasAdminPermission(account, "content.edit"), false);
  store.updateSettings(account.id, { enabled: false });
  assert.equal(hasAdminPermission(store.getById(account.id), "content.read"), false, "disabled accounts hold no permissions");
});

test("audit batches archive only at threshold and keeps the newest rows", () => {
  const { store } = tempStore();
  store.close();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nkustudy-accounts-batch-"));
  const archiveDir = path.join(dir, "archive");
  let archiveCalls = 0;
  const batched = new AdminAccountsStore({ dbPath: path.join(dir, "b.sqlite"), keepAuditRows: 3, archiveThreshold: 6, archiveDir, onArchive: () => { archiveCalls += 1; } });
  for (let index = 1; index <= 5; index += 1) {
    batched.audit({ username: `u${index}`, action: `act-${index}`, now: 1787000000000 + index });
  }
  assert.equal(batched.queryAudit({ pageSize: 50 }).total, 5, "below threshold nothing is archived");
  assert.equal(fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).length : 0, 0);
  assert.equal(archiveCalls, 0);
  batched.audit({ username: "u6", action: "act-6", now: 1787000006000 });
  const remaining = batched.queryAudit({ pageSize: 50 });
  assert.equal(remaining.total, 3, "threshold keeps only the newest rows");
  assert.equal(remaining.items[0].action, "act-6");
  const files = fs.readdirSync(archiveDir);
  assert.equal(files.length, 1, "one batch file per threshold crossing");
  const payload = JSON.parse(fs.readFileSync(path.join(archiveDir, files[0]), "utf8"));
  assert.equal(payload.rows.length, 3);
  assert.deepEqual(payload.rows.map((row) => row.action), ["act-1", "act-2", "act-3"], "oldest batch is archived");
  assert.equal(archiveCalls, 1, "archive callback fires once per batch");
  batched.close();
  store.close();
});
