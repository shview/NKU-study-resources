import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Database from 'better-sqlite3';
import { UserSecurityLogStore, SECURITY_LOG_KEEP_DAYS } from '../server/user-security-log-store.mjs';
import { AdminAccountsStore } from '../server/admin-accounts-store.mjs';
import { archiveRows, readEnvelope } from '../server/durable-log.mjs';
import { SnapshotGate, captureRuntime, saveEncryptedBackup, decryptSnapshot, restoreSnapshot, verifiedUpload, pruneEncryptedBackups } from '../server/runtime-backup.mjs';
import { archiveEntryLogs } from '../server/entry-log-archive.mjs';
import { preflightProductionRuntime } from '../server/runtime-config.mjs';

function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's2-durable-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const busy = () => Object.assign(new Error('synthetic I/O fault'), { code: 'SQLITE_BUSY' });

test('S2 log recovery: failed SQLite commits queue durably, survive restart and replay exactly once', t => {
  const dir = temporary(t), dbPath = path.join(dir, 'state.sqlite');
  let fail = true; const alerts = [];
  const a = new UserSecurityLogStore({ dbPath, fault: phase => { if (fail && phase === 'beforeInsert') throw busy(); }, alert: event => alerts.push(event) });
  const id = a.begin({ action: 'review.submit', userId: 42 });
  a.record({ eventId: id, action: 'review.submit', userId: 42, targetId: 'synthetic-review', targetType: 'review' });
  assert.equal(a.count(), 0); assert.equal(a.writer.health().pending, 1); assert.ok(alerts.length);
  const queued = fs.readdirSync(a.writer.directory)[0];
  assert.equal(fs.statSync(path.join(a.writer.directory, queued)).mode & 0o777, 0o600);
  a.close();
  const b = new UserSecurityLogStore({ dbPath }); t.after(() => b.close());
  assert.equal(b.count(), 1); assert.equal(b.byUser(42)[0].target_id, 'synthetic-review');
  b.writer.replay(); assert.equal(b.count(), 1); assert.equal(b.writer.health().ok, true);
});

test('S2 crash after SQLite commit does not duplicate an event, and hard process death keeps an interrupted intent', t => {
  const dir = temporary(t), dbPath = path.join(dir, 'state.sqlite');
  const a = new UserSecurityLogStore({ dbPath, fault: phase => { if (phase === 'afterInsert') throw busy(); }, alert: () => {} });
  a.record({ action: 'auth.logout', userId: 9 }); assert.equal(a.count(), 1); a.close();
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { UserSecurityLogStore } from './server/user-security-log-store.mjs'; const s = new UserSecurityLogStore({ dbPath: process.env.S2_TEST_DB }); s.begin({ action: 'account.delete', userId: 9 }); process.kill(process.pid, 'SIGKILL');`], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, S2_TEST_DB: dbPath } });
  assert.equal(result.signal, 'SIGKILL');
  const b = new UserSecurityLogStore({ dbPath }); t.after(() => b.close());
  assert.equal(b.count(), 2); assert.equal(b.byUser(9).find(row => row.action === 'account.delete').result, 'interrupted');
});

test('S2 unwritable journal refuses admission and corrupted queue remains visible rather than disappearing', t => {
  const dir = temporary(t), dbPath = path.join(dir, 'state.sqlite');
  const a = new UserSecurityLogStore({ dbPath, alert: () => {} }); t.after(() => a.close());
  fs.chmodSync(a.writer.directory, 0o500);
  // Use a real wrong filesystem object, deterministic even when tests run as root.
  fs.rmdirSync(a.writer.directory); fs.writeFileSync(a.writer.directory, 'blocked');
  assert.throws(() => a.begin({ action: 'profile.update' }), error => error.statusCode === 503);
  assert.equal(a.writer.health().ok, false);
  fs.unlinkSync(a.writer.directory); fs.mkdirSync(a.writer.directory);
  const file = path.join(a.writer.directory, '11111111-1111-1111-1111-111111111111.json'); fs.writeFileSync(file, '{broken');
  a.writer.replay(); assert.equal(a.writer.health().ok, false); assert.equal(fs.existsSync(file), true);
});

test('S2 archive requires durable readback before deletion; interruption and disk failure retain source', t => {
  const dir = temporary(t), store = new AdminAccountsStore({ dbPath: path.join(dir, 'state.sqlite') }); t.after(() => store.close());
  for (let i = 0; i < 6; i++) store.audit({ username: 'synthetic', action: `act-${i}` });
  const directory = path.join(dir, 'archive');
  for (const phase of ['beforeRename', 'afterRename', 'beforeDelete']) {
    assert.throws(() => archiveRows({ db: store.db, table: 'admin_audit_log', directory, keepRows: 2, threshold: 6, fault: current => { if (current === phase) throw Object.assign(new Error('disk fault'), { code: 'ENOSPC' }); } }));
    assert.equal(store.queryAudit().total, 6);
  }
  const file = archiveRows({ db: store.db, table: 'admin_audit_log', directory, keepRows: 2, threshold: 6 });
  assert.equal(store.queryAudit().total, 2); assert.equal(readEnvelope(file, 'admin_audit_log').rows.length, 4);
  store.archiveDir = directory; assert.equal(store.queryAudit({ includeArchived: true }).total, 6);
  const archived = JSON.parse(fs.readFileSync(file)); archived.payload.rows[0].action = 'tampered'; fs.writeFileSync(file, JSON.stringify(archived));
  assert.throws(() => store.queryAudit({ includeArchived: true }), /checksum/);
});

test('S2 20,010 user records survive quantity threshold; 400-day boundary and archived pagination are exact', t => {
  const dir = temporary(t), store = new UserSecurityLogStore({ dbPath: path.join(dir, 'state.sqlite') }); t.after(() => store.close());
  const now = Date.now(), cutoff = now - SECURITY_LOG_KEEP_DAYS * 86400000;
  const insert = store.db.prepare("INSERT INTO user_security_logs(at,user_id,action) VALUES(?,42,'synthetic')");
  store.db.transaction(() => { insert.run(cutoff - 1); insert.run(cutoff); for (let i = 0; i < 20008; i++) insert.run(now - i); })();
  store.maintain(now);
  assert.equal(store.query({ userId: 42 }).total, 20010, 'mixed archive retained until latest member expires');
  assert.equal(store.query({ userId: 42, from: cutoff }).total, 20009);
  const all = []; for (let page = 1; page <= 21; page++) all.push(...store.query({ userId: 42, page, pageSize: 1000 }).items);
  assert.equal(new Set(all.map(row => row.id)).size, 20010);
  assert.equal(store.count(), 10000);
  store.maintain(now + 401 * 86400000); assert.equal(store.query().total, 0);
  const single = new UserSecurityLogStore({ dbPath: path.join(dir, 'boundary.sqlite') }); t.after(() => single.close());
  single.record({ at: cutoff - 1, action: 'old' }); single.record({ at: cutoff, action: 'boundary' });
  single.prune(now); assert.equal(single.count(), 1); assert.equal(single.query().items[0].action, 'boundary');
});

test('S2 complete encrypted snapshot includes WAL, runtime JSON, logs and secrets; restore is isolated and sessions revoked', async t => {
  const dir = temporary(t), dataDir = path.join(dir, 'data'); fs.mkdirSync(dataDir);
  const db = new Database(path.join(dir, 'state.sqlite')); t.after(() => db.close());
  db.pragma('journal_mode=WAL'); db.pragma('wal_autocheckpoint=0');
  db.exec("CREATE TABLE mp_users(id INTEGER PRIMARY KEY, nickname TEXT, web_password_hash TEXT); CREATE TABLE mp_auth_tokens(token TEXT); CREATE TABLE admin_sessions(token TEXT); CREATE TABLE user_security_logs(action TEXT); CREATE TABLE law_enforcement_logs(action TEXT); INSERT INTO mp_users VALUES (1,'synthetic_已注销',NULL); INSERT INTO mp_auth_tokens VALUES ('old-token'); INSERT INTO admin_sessions VALUES ('old-admin'); INSERT INTO user_security_logs VALUES ('account.delete'); INSERT INTO law_enforcement_logs VALUES ('query');");
  fs.writeFileSync(path.join(dataDir, 'feedback.json'), JSON.stringify({ items: [{ id: 'synthetic-complaint', private: true }] }));
  fs.writeFileSync(path.join(dataDir, 'notify-secrets.json'), '{"synthetic":"private-secret"}');
  fs.writeFileSync(path.join(dir, 'secret'), 'synthetic-admin-secret');
  assert.ok(fs.statSync(db.name + '-wal').size > 0);
  const snapshot = captureRuntime({ db, dataDir, extraFiles: { 'admin-secret': path.join(dir, 'secret') }, requiredFiles: ['feedback.json'] });
  const password = 'synthetic-backup-passphrase';
  const backup = saveEncryptedBackup({ snapshot, password, directory: path.join(dataDir, 'private-backups') });
  assert.equal(fs.statSync(backup.file).mode & 0o777, 0o600);
  for (const text of ['private-secret', 'old-token', 'synthetic-complaint']) assert.equal(backup.bytes.includes(text), false);
  assert.throws(() => decryptSnapshot(backup.bytes, 'incorrect-password'));
  const keyFile = path.join(dir, 'backup-password'); fs.writeFileSync(keyFile, password + '\n', { mode: 0o600 });
  const cli = spawnSync(process.execPath, ['scripts/runtime-backup.mjs', 'verify', backup.file], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, BACKUP_PASSWORD_FILE: keyFile }, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).verified, true);
  const decrypted = decryptSnapshot(backup.bytes, password);
  const destination = path.join(dir, 'restored'); const result = restoreSnapshot({ snapshot: decrypted, destination });
  assert.equal(result.quarantined, true);
  const restored = new Database(path.join(destination, 'state.sqlite'));
  assert.equal(restored.prepare('SELECT nickname FROM mp_users').get().nickname, 'synthetic_已注销');
  assert.equal(restored.prepare('SELECT COUNT(*) n FROM mp_auth_tokens').get().n, 0);
  assert.equal(restored.prepare('SELECT COUNT(*) n FROM law_enforcement_logs').get().n, 1); restored.close();
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'data/feedback.json'))).items[0].private, true);
  assert.throws(() => preflightProductionRuntime({ NODE_ENV: 'test', DATA_DIR: path.join(destination, 'data'), STATE_DB_PATH: path.join(destination, 'state.sqlite') }), /quarantined/);
  assert.throws(() => restoreSnapshot({ snapshot, destination }), /must not exist/);
  assert.throws(() => captureRuntime({ db, dataDir, requiredFiles: ['missing.json'] }), /missing/);
  const tampered = structuredClone(snapshot); tampered.files[0].sha256 = 'bad'; assert.throws(() => restoreSnapshot({ snapshot: tampered, destination: path.join(dir, 'bad') }), /checksum/);
  const interrupted = path.join(dir, 'interrupted'); assert.throws(() => restoreSnapshot({ snapshot, destination: interrupted, fault: () => { throw new Error('ENOSPC'); } }), /ENOSPC/);
  assert.equal(fs.existsSync(path.join(interrupted, '.restore-quarantine')), true); assert.equal(fs.existsSync(path.join(interrupted, 'restore-result.json')), false);
  let remote; await verifiedUpload(backup.bytes, { put: async bytes => { remote = bytes; }, get: async () => remote });
  await assert.rejects(verifiedUpload(backup.bytes, { put: async () => {}, get: async () => Buffer.from('corrupted') }), /checksum/);
  await assert.rejects(verifiedUpload(backup.bytes, { put: async () => { throw new Error('offline'); }, get: async () => remote }), /offline/);
  assert.equal(fs.existsSync(backup.file), true);
  const created = Date.parse(snapshot.createdAt);
  assert.equal(pruneEncryptedBackups({ directory: path.dirname(backup.file), password, now: created + 400 * 86400000 }), 0);
  assert.equal(pruneEncryptedBackups({ directory: path.dirname(backup.file), password, now: created + 400 * 86400000 + 1 }), 1);
});

test('S2 snapshot gate waits for in-flight mutation and rejects overlap; failed snapshot reopens traffic', async () => {
  const gate = new SnapshotGate(); const leave = gate.enter(); let read = false;
  const capture = gate.capture(() => { read = true; return 42; });
  assert.equal(read, false); assert.throws(() => gate.enter(), error => error.statusCode === 503);
  leave(); assert.equal(await capture, 42); assert.equal(gate.locked, false);
  await assert.rejects(gate.capture(() => { throw new Error('disk'); }), /disk/);
  gate.enter()(); assert.equal(gate.active, 0);
});


test('S2 entry log archive readback, interruption, disk failure, corrupt input and time-only expiry', t => {
  const dir = temporary(t), sourceDir = path.join(dir, 'logs'), destination = path.join(dir, 'archive'); fs.mkdirSync(sourceDir);
  const now = Date.now();
  const live = path.join(sourceDir, 'access.jsonl'); fs.writeFileSync(live, '{partial live record');
  const name = 'access-2026-10-01T00-00-00.001-size.jsonl';
  const source = path.join(sourceDir, name); fs.writeFileSync(source, JSON.stringify({ ts: now / 1000, request: { uri: '/probe' }, status: 200 }) + '\n');
  assert.throws(() => archiveEntryLogs({ sourceDir, destination, now, fault: phase => { if (phase === 'beforeRename') throw new Error('ENOSPC'); } }), /ENOSPC/);
  assert.equal(fs.existsSync(source), true);
  const copied = archiveEntryLogs({ sourceDir, destination, now }); assert.equal(copied.verified, 1); assert.equal(copied.expired, 0);
  assert.equal(fs.readFileSync(path.join(destination, name), 'utf8'), fs.readFileSync(source, 'utf8'));
  assert.equal(fs.statSync(path.join(destination, name)).mode & 0o077, 0);
  assert.equal(archiveEntryLogs({ sourceDir, destination, now: now + 400 * 86400000 }).expired, 0);
  assert.equal(archiveEntryLogs({ sourceDir, destination, now: now + 400 * 86400000 + 1 }).expired, 1);
  assert.equal(fs.existsSync(live), true);
  fs.writeFileSync(source, '{broken'); assert.throws(() => archiveEntryLogs({ sourceDir, destination, now })); assert.equal(fs.existsSync(source), true);
});
