import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { backupPreflight } from '../server/backup-preflight.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'scripts/s2-backup-preflight.mjs');
const password = 'synthetic-backup-password-never-print';
const webdavPassword = 'synthetic-webdav-secret-never-print';
const targetUrl = 'https://synthetic-private.invalid/secret-destination';
const dedicatedR2 = {
  BACKUP_R2_ACCOUNT_ID: 'a'.repeat(32), BACKUP_R2_ACCESS_KEY_ID: 'synthetic-private-access-key',
  BACKUP_R2_SECRET_ACCESS_KEY: 'synthetic-private-secret-key', BACKUP_R2_BUCKET: 'synthetic-private-bucket', BACKUP_R2_PRIVATE_CONFIRMED: '1',
  R2_ACCOUNT_ID: 'b'.repeat(32), R2_ACCESS_KEY_ID: 'synthetic-public-access-key', R2_SECRET_ACCESS_KEY: 'synthetic-public-secret-key', R2_BUCKET: 'synthetic-public-bucket',
};

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'nku-backup-preflight-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dataDir = path.join(directory, 'data');
  const stateDir = path.join(directory, 'state');
  const configDir = path.join(directory, 'configuration');
  for (const file of [directory, dataDir, stateDir, configDir]) { fs.mkdirSync(file, { recursive: true, mode: 0o700 }); fs.chmodSync(file, 0o700); }
  const write = (file, value, mode = 0o600) => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode });
  const settingsPath = path.join(dataDir, 'backup-settings.json');
  const secretPath = path.join(dataDir, 'backup-secrets.json');
  const settings = { r2DataBackup: false, webdavEnabled: false, includeCourseFiles: false, destinations: [] };
  const secrets = { encryptionPassword: password, webdav: { synthetic: { password: webdavPassword } } };
  write(path.join(dataDir, '.nkustudy-data-root'), 'NKUSTUDY_RUNTIME_DATA_V1\n');
  for (const name of ['manifest', 'about', 'home', 'participate', 'links', 'footer', 'reviews', 'feedback', 'visit-stats', 'editor-settings']) write(path.join(dataDir, `${name}.json`), {});
  write(settingsPath, settings);
  write(secretPath, secrets);
  const env = {
    DATA_DIR: dataDir, STATE_DB_PATH: path.join(stateDir, 'state.sqlite'), ADMIN_SECRET_FILE: path.join(configDir, 'admin-secret'),
    BACKUP_ENV_FILE: path.join(configDir, 'admin.env'), BACKUP_CADDY_FILE: path.join(configDir, 'Caddyfile'), BACKUP_SERVICE_FILE: path.join(configDir, 'service.conf'),
  };
  write(env.STATE_DB_PATH, 'synthetic database bytes: no SQLite integrity claim');
  write(env.ADMIN_SECRET_FILE, 'synthetic-admin-secret-'.repeat(3));
  write(env.BACKUP_ENV_FILE, 'SYNTHETIC_ENV=must-not-print\n');
  write(env.BACKUP_CADDY_FILE, 'synthetic Caddy configuration', 0o644);
  write(env.BACKUP_SERVICE_FILE, 'synthetic service configuration', 0o644);
  return { directory, dataDir, settingsPath, secretPath, settings, secrets, env, write };
}
function byId(report, id) { return report.checks.find(check => check.id === id); }
function noLeaks(value, example) {
  const output = typeof value === 'string' ? value : JSON.stringify(value);
  for (const forbidden of [password, webdavPassword, targetUrl, example.directory, ...Object.values(dedicatedR2).filter(value => value !== '1'), 'SYNTHETIC_ENV=must-not-print']) assert.equal(output.includes(forbidden), false, 'output must not contain configuration values');
}
function runCli(env, args = []) { return spawnSync(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }); }
function tree(directory) {
  const entries = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    entries.push({ name, mode: stat.mode, mtime: stat.mtimeMs, bytes: stat.isFile() ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : tree(file) });
  }
  return entries;
}

test('local-only preflight is explicit about unverified remote storage, recovery and S2 acceptance', t => {
  const example = fixture(t);
  const report = backupPreflight({ env: example.env });
  assert.equal(report.ok, true);
  assert.equal(report.localReady, true);
  assert.equal(report.remoteEnabled, false);
  assert.equal(report.remoteConfigured, false);
  for (const key of ['remoteVerified', 'restoreVerified', 'notificationsVerified', 's2Accepted']) assert.equal(report[key], false);
  assert.equal(byId(report, 'destination.r2').code, 'DESTINATION_DISABLED');
  assert.equal(fs.existsSync(path.join(example.dataDir, 'private-backups')), false, 'preflight must not create the future backup directory');
  noLeaks(report, example);
  const result = runCli(example.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), report);
});

test('dedicated R2 configuration is checked without claiming remote access and every missing field fails', t => {
  const example = fixture(t);
  example.write(example.settingsPath, { ...example.settings, r2DataBackup: true });
  const env = { ...example.env, ...dedicatedR2 };
  const report = backupPreflight({ env });
  assert.equal(report.ok, true);
  assert.equal(report.remoteEnabled, true);
  assert.equal(report.remoteConfigured, true);
  assert.equal(report.remoteVerified, false);
  noLeaks(report, example);
  for (const field of ['BACKUP_R2_ACCOUNT_ID', 'BACKUP_R2_ACCESS_KEY_ID', 'BACKUP_R2_SECRET_ACCESS_KEY', 'BACKUP_R2_BUCKET', 'BACKUP_R2_PRIVATE_CONFIRMED']) {
    const incomplete = { ...env }; delete incomplete[field];
    const failed = backupPreflight({ env: incomplete });
    assert.equal(failed.ok, false, field);
    assert.equal(failed.localReady, true, field);
    assert.equal(failed.remoteConfigured, false, field);
    assert.equal(byId(failed, 'destination.r2').status, 'fail');
    noLeaks(failed, example);
  }
  for (const overrides of [{ BACKUP_R2_BUCKET: dedicatedR2.R2_BUCKET }, { BACKUP_R2_PRIVATE_CONFIRMED: '0' }, { BACKUP_R2_ACCOUNT_ID: targetUrl }]) {
    assert.equal(backupPreflight({ env: { ...env, ...overrides } }).ok, false);
  }
  const result = runCli({ ...env, BACKUP_R2_SECRET_ACCESS_KEY: '' });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  noLeaks(result.stdout, example);
});

test('missing, relative or unsafe paths and invalid JSON never leak original error text', t => {
  const example = fixture(t);
  for (const field of ['DATA_DIR', 'STATE_DB_PATH', 'ADMIN_SECRET_FILE']) {
    for (const value of ['', 'relative-path-with-private-name', path.join(example.directory, 'missing-private-name')]) {
      const report = backupPreflight({ env: { ...example.env, [field]: value } });
      assert.equal(report.ok, false);
      assert.equal(report.localReady, false);
      noLeaks(report, example);
      assert.equal(JSON.stringify(report).includes('private-name'), false);
    }
  }
  example.write(example.settingsPath, `{"value":"${password}" INVALID JSON`);
  let result = runCli(example.env);
  assert.equal(result.status, 1);
  assert.equal(byId(JSON.parse(result.stdout), 'backup.settings_file').code, 'INVALID_JSON');
  assert.equal(result.stderr, '');
  noLeaks(result.stdout, example);
  example.write(example.settingsPath, []);
  assert.equal(byId(backupPreflight({ env: example.env }), 'backup.settings_file').code, 'JSON_OBJECT_REQUIRED');
  example.write(example.secretPath, `{"encryptionPassword":"${password}" INVALID JSON`);
  result = runCli(example.env);
  assert.equal(result.status, 1);
  assert.equal(byId(JSON.parse(result.stdout), 'backup.secret_file').code, 'INVALID_JSON');
  noLeaks(result.stdout + result.stderr, example);
});

test('password length, unsafe POSIX permissions and Windows ACL uncertainty fail closed', t => {
  const example = fixture(t);
  for (const value of [undefined, '', 'fifteen-chars!!', 123, {}]) {
    example.write(example.secretPath, { encryptionPassword: value });
    const report = backupPreflight({ env: example.env });
    assert.equal(report.ok, false);
    assert.equal(byId(report, 'backup.encryption_password').code, 'PASSWORD_NOT_CONFIGURED');
  }
  example.write(example.secretPath, example.secrets);
  for (const [file, badMode, goodMode] of [
    [example.secretPath, 0o644, 0o600], [example.settingsPath, 0o640, 0o600],
    [example.env.BACKUP_ENV_FILE, 0o644, 0o600], [example.dataDir, 0o755, 0o700],
    [example.env.BACKUP_CADDY_FILE, 0o666, 0o644],
  ]) {
    fs.chmodSync(file, badMode);
    assert.equal(backupPreflight({ env: example.env }).ok, false);
    fs.chmodSync(file, goodMode);
  }
  const windows = backupPreflight({ env: example.env, platform: 'win32' });
  assert.equal(windows.ok, false);
  assert.equal(windows.localReady, false);
  assert.equal(byId(windows, 'permissions.platform').status, 'unknown');
  assert.equal(byId(windows, 'permissions.platform').code, 'WINDOWS_ACL_UNVERIFIED');
});

test('legacy secret fields and copied values in ordinary settings are rejected without revealing them', t => {
  const example = fixture(t);
  for (const addition of [
    { encryptionPassword: password }, { arbitrary: { backupSecret: password } },
    { arbitrary: password }, { arbitrary: `prefix ${password} suffix` },
    { destinations: [{ id: 'synthetic', url: targetUrl, password: webdavPassword }] },
    { destinations: [{ id: 'synthetic', url: 'https://inline:unconfigured-password@synthetic-private.invalid' }] },
    { encryptionPasswordConfigured: true },
  ]) {
    example.write(example.settingsPath, { ...example.settings, ...addition });
    const report = backupPreflight({ env: example.env });
    assert.equal(report.ok, false);
    assert.equal(byId(report, 'backup.settings_no_secrets').code, 'LEGACY_SECRET_COPY_PRESENT');
    noLeaks(report, example);
  }
  example.write(example.settingsPath, example.settings);
  assert.equal(backupPreflight({ env: example.env }).ok, true);
});

test('explicit external secret paths work only as private regular files with safe parent paths', t => {
  const example = fixture(t);
  const externalDir = path.join(example.directory, 'external-private');
  fs.mkdirSync(externalDir, { mode: 0o700 });
  const externalFile = path.join(externalDir, 'backup-key.json');
  example.write(externalFile, example.secrets);
  fs.unlinkSync(example.secretPath);
  let env = { ...example.env, BACKUP_SECRET_FILE: externalFile };
  assert.equal(backupPreflight({ env }).ok, true);
  fs.chmodSync(externalDir, 0o755);
  assert.equal(byId(backupPreflight({ env }), 'backup.secret_file').code, 'PRIVATE_PERMISSIONS_REQUIRED');
  fs.chmodSync(externalDir, 0o700);
  const fileLink = path.join(externalDir, 'key-link.json');
  fs.symlinkSync(externalFile, fileLink);
  assert.equal(byId(backupPreflight({ env: { ...env, BACKUP_SECRET_FILE: fileLink } }), 'backup.secret_file').code, 'SYMLINK_REFUSED');
  const directoryLink = path.join(example.directory, 'directory-link');
  fs.symlinkSync(externalDir, directoryLink);
  env = { ...env, BACKUP_SECRET_FILE: path.join(directoryLink, 'backup-key.json') };
  assert.equal(byId(backupPreflight({ env }), 'backup.secret_file').code, 'SYMLINK_REFUSED');
  assert.equal(byId(backupPreflight({ env: { ...example.env, DATA_DIR: directoryLink } }), 'data.directory').code, 'SYMLINK_REFUSED');
});

test('snapshot sources, quarantine markers and destination selection are checked before readiness', t => {
  const example = fixture(t);
  for (const field of ['BACKUP_ENV_FILE', 'BACKUP_CADDY_FILE', 'BACKUP_SERVICE_FILE']) {
    const report = backupPreflight({ env: { ...example.env, [field]: path.join(example.directory, 'absent-config') } });
    assert.equal(report.ok, false);
    noLeaks(report, example);
  }
  const marker = path.join(example.dataDir, '.restore-quarantine');
  example.write(marker, 'synthetic incomplete recovery');
  assert.equal(byId(backupPreflight({ env: example.env }), 'data.quarantine').code, 'RESTORE_QUARANTINE_PRESENT');
  fs.unlinkSync(marker);
  for (const invalid of [{ r2DataBackup: 'false' }, { destinations: [null] }]) {
    example.write(example.settingsPath, { ...example.settings, ...invalid });
    assert.equal(byId(backupPreflight({ env: example.env }), 'destination.selection').code, 'SETTINGS_INVALID');
  }
  example.write(example.settingsPath, { ...example.settings, webdavEnabled: true });
  assert.equal(byId(backupPreflight({ env: example.env }), 'destination.webdav').code, 'WEBDAV_DESTINATION_MISSING');
  const settings = { ...example.settings, webdavEnabled: true, destinations: [{ id: 'synthetic', enabled: true, url: targetUrl, username: 'synthetic-operator' }] };
  example.write(example.settingsPath, settings);
  let report = backupPreflight({ env: example.env });
  assert.equal(report.ok, true);
  assert.equal(report.remoteConfigured, true);
  noLeaks(report, example);
  example.write(example.settingsPath, { ...settings, includeCourseFiles: true });
  assert.equal(byId(backupPreflight({ env: example.env }), 'destination.webdav').code, 'COURSE_SOURCE_INCOMPLETE');
  example.write(example.settingsPath, { ...settings, destinations: [{ ...settings.destinations[0], url: targetUrl.replace('https:', 'http:') }] });
  assert.equal(byId(backupPreflight({ env: example.env }), 'destination.webdav').code, 'WEBDAV_DESTINATION_INVALID');
});

test('preflight performs only read filesystem operations and does not request any network transport', t => {
  const example = fixture(t);
  example.write(example.settingsPath, { ...example.settings, r2DataBackup: true });
  const before = tree(example.directory);
  const originalOpen = fs.openSync;
  let writeAttempts = 0, networkAttempts = 0;
  const denyWrite = () => { writeAttempts++; throw new Error('write attempted'); };
  const denyNetwork = () => { networkAttempts++; throw new Error('network attempted'); };
  try {
    for (const method of ['writeFileSync', 'appendFileSync', 'writeSync', 'mkdirSync', 'mkdtempSync', 'renameSync', 'rmSync', 'unlinkSync', 'chmodSync', 'fchmodSync', 'chownSync', 'truncateSync']) t.mock.method(fs, method, denyWrite);
    t.mock.method(fs, 'openSync', (file, flags, ...args) => {
      assert.equal(typeof flags, 'number');
      assert.equal(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_TRUNC), 0);
      return originalOpen(file, flags, ...args);
    });
    t.mock.method(globalThis, 'fetch', denyNetwork);
    for (const transport of [http, https]) { t.mock.method(transport, 'request', denyNetwork); t.mock.method(transport, 'get', denyNetwork); }
    t.mock.method(net.Socket.prototype, 'connect', denyNetwork);
    const report = backupPreflight({ env: { ...example.env, ...dedicatedR2 } });
    assert.equal(report.ok, true);
    assert.equal(writeAttempts, 0);
    assert.equal(networkAttempts, 0);
  } finally { t.mock.restoreAll(); }
  assert.deepEqual(tree(example.directory), before);
});

test('CLI has stable help and failure exits, and never echoes unsupported arguments', t => {
  const example = fixture(t);
  let result = runCli({}, ['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Exit 0:/);
  assert.equal(result.stderr, '');
  result = runCli({}, [password, targetUrl]);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, '');
  noLeaks(result.stdout, example);
  // Keep even negative tests away from any real host production configuration.
  result = runCli({ BACKUP_ENV_FILE: path.join(example.directory, 'missing-env'), BACKUP_CADDY_FILE: path.join(example.directory, 'missing-caddy'), BACKUP_SERVICE_FILE: path.join(example.directory, 'missing-service') });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.equal(result.stderr, '');
  noLeaks(result.stdout, example);
});
