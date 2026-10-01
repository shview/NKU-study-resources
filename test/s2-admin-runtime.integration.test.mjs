import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { decryptSnapshot, restoreSnapshot } from '../server/runtime-backup.mjs';
const root = path.resolve(import.meta.dirname, '..');
const password = 'synthetic-S2-admin-password';

test('S2 administrator HTTP audit, local I/O recovery, consistent private backup and restart', { timeout: 120000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nku-s2-admin-'));
  const app = path.join(dir, 'app'), dataDir = path.join(dir, 'data'), dbPath = path.join(dir, 'state.sqlite');
  await fs.mkdir(app); await fs.mkdir(dataDir);
  await fs.cp(path.join(root, 'server'), path.join(app, 'server'), { recursive: true });
  await fs.symlink(path.join(root, 'node_modules'), path.join(app, 'node_modules'));
  // Actual HTTP/publication/persistence, with a tiny synthetic static build in a
  // separate source tree. This is not an Astro UI/build acceptance test.
  await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({ type: 'module', scripts: { 'check:content': 'node fixture-build.mjs check', build: 'node fixture-build.mjs build' } }));
  await fs.writeFile(path.join(app, 'fixture-build.mjs'), "import fs from 'node:fs'; if(process.argv[2]==='build'){fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','<h1>synthetic S2 acceptance</h1>');}");
  for (const name of ['about','feedback','footer','guides','home','links','manifest','participate','reviews']) await fs.copyFile(path.join(root, 'src/data/fixtures', `${name}.json`), path.join(dataDir, `${name}.json`));
  await fs.writeFile(path.join(dataDir, 'notify-settings.json'), '{"enabled":false}');
  await fs.writeFile(path.join(dataDir, 'backup-settings.json'), '{"autoEnabled":false,"r2DataBackup":false,"webdavEnabled":false}');
  const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let child, db, output = '';
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_ENV: 'test', DATA_DIR: dataDir, STATE_DB_PATH: dbPath,
    ADMIN_HOST: '127.0.0.1', ADMIN_PORT: String(port), ADMIN_ORIGIN: base, ADMIN_INITIAL_PASSWORD: password,
    ADMIN_SECRET_FILE: path.join(dir, 'admin-secret'), BACKUP_SECRET_FILE: path.join(dataDir, 'backup-secrets.json'),
    PUBLIC_DIR: path.join(dir, 'public/current'), PUBLIC_RELEASES_DIR: path.join(dir, 'public/releases'), TRUSTED_PROXIES: '127.0.0.1/32' };
  async function start() {
    output = ''; child = spawn(process.execPath, ['server/admin-server.mjs'], { cwd: app, env, stdio: ['ignore','pipe','pipe'] });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(output)), 15000);
      const collect = chunk => { output += chunk; if (output.includes('NKUStudy admin API listening')) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', collect); child.stderr.on('data', collect); child.once('exit', () => { clearTimeout(timer); reject(new Error(output)); }); });
  }
  async function stop() { if (child?.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } }
  t.after(async () => { await stop(); db?.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await start(); db = new Database(dbPath); db.pragma('busy_timeout=5000');
  let sequence = 0;
  async function request(route, { method = 'GET', cookie = '', body, status = 200, provenance = true, binary = false } = {}) {
    const marker = `s2-admin-${++sequence}`;
    const headers = { cookie, 'user-agent': marker, 'x-forwarded-for': '198.51.100.75', 'content-type': 'application/json' };
    if (provenance) Object.assign(headers, { origin: base, 'sec-fetch-site': 'same-origin', 'x-nkustudy-admin-request': '1' });
    const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const bytes = Buffer.from(await response.arrayBuffer());
    const value = binary ? bytes : JSON.parse(bytes);
    assert.equal(response.status, status, `${route}: ${binary ? (response.status === status ? 'binary' : bytes.toString()) : JSON.stringify(value)}\n${output}`);
    const rows = db.prepare('SELECT * FROM admin_audit_log WHERE user_agent=? ORDER BY id').all(marker);
    if (route.startsWith('/admin-api/')) { assert.ok(rows.length >= 1, `missing audit ${route}`); assert.equal(rows[0].status, status); assert.equal(rows[0].path, route.split('?')[0]); }
    return { value, rows, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const login = await request('/admin-api/login', { method: 'POST', body: { username: 'Shview', password } }); const cookie = login.cookie;
  await request('/admin-api/accounts', { method: 'POST', cookie, body: { username: 'viewer1', password, permissions: ['content.read'] } });
  const viewer = (await request('/admin-api/login', { method: 'POST', body: { username: 'viewer1', password } })).cookie;
  const user = await request('/api/v1/auth/web-register', { method: 'POST', body: { nickname: 'S2-synthetic-account', password } });
  const userId = user.value.data.user.id;

  await t.test('sensitive reads, exports and backups audit success, missing target, anonymous, disabled and denied requests', async () => {
    for (const endpoint of ['law-query', 'law-export']) {
      const result = await request(`/admin-api/${endpoint}?type=account&value=${userId}`, { cookie: viewer });
      assert.equal(result.rows[0].username, 'viewer1'); assert.equal(result.rows[0].target, `user:${userId}`);
      await request(`/admin-api/${endpoint}?type=account&value=13912345678`, { cookie: viewer, status: 404 });
      await request(`/admin-api/${endpoint}?type=account&value=${userId}`, { status: 401 });
    }
    await request('/admin-api/backup?scope=all', { status: 401 });
    await request('/admin-api/backup?scope=all', { cookie: viewer, status: 403 });
    await request('/admin-api/backup?scope=invalid', { cookie, status: 400 });
    await request('/admin-api/backup?scope=all', { cookie, status: 503 });
    await request('/admin-api/mp-users', { cookie });
    await request('/admin-api/mp-users/' + userId + '/blocked', { cookie, method: 'POST', body: { blocked: true }, provenance: false, status: 403 });
    db.prepare("UPDATE admin_accounts SET enabled=0 WHERE username='viewer1'").run();
    const denied = await request('/admin-api/law-query?value=' + userId, { cookie: viewer, status: 401 });
    assert.equal(denied.rows[0].username, 'viewer1');
    db.prepare("UPDATE admin_accounts SET enabled=1 WHERE username='viewer1'").run();
    const serialized = JSON.stringify(db.prepare('SELECT * FROM admin_audit_log').all()) + JSON.stringify(db.prepare('SELECT * FROM law_enforcement_logs').all());
    for (const secret of ['13912345678', password, cookie.split('=')[1]]) assert.equal(serialized.includes(secret), false);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM law_enforcement_logs').get().n, 7);
  });

  await t.test('review and complaint changes stamp the real actor and audit IDs, fields, states, failures and deletions', async () => {
    const sample = { id: 's2-review', courseTitle: 'synthetic', teacher: 'synthetic', content: 'private original content', status: 'pending', hidden: false };
    const complaints = { id: 's2-complaint', title: 'private complaint title', content: 'private complaint body', type: 'report', private: true, status: 'pending', hidden: false };
    for (const [kind, key, initial] of [['reviews','reviews',sample],['feedback','items',complaints]]) {
      let current = (await request(`/admin-api/${kind}`, { cookie })).value;
      current.data[key] = [initial];
      const saved = await request(`/admin-api/${kind}`, { method: 'POST', cookie, body: { data: current.data, expectedRevision: current.revision } });
      assert.ok(saved.rows.some(row => row.target === `${kind === 'reviews' ? 'review' : 'feedback'}:${initial.id}`));
      current = (await request(`/admin-api/${kind}`, { cookie })).value;
      current.data[key][0] = { ...current.data[key][0], status: 'approved', hidden: true, reply: 'private reply text', handledBy: 'forged-actor', handledAt: '1900', repliedBy: 'forged-actor', repliedAt: '1900' };
      await request(`/admin-api/${kind}`, { method: 'POST', cookie, body: { data: current.data, expectedRevision: current.revision } });
      const readback = (await request(`/admin-api/${kind}`, { cookie })).value;
      assert.equal(readback.data[key][0].handledBy, 'Shview'); assert.equal(readback.data[key][0].repliedBy, 'Shview'); assert.notEqual(readback.data[key][0].handledAt, '1900');
      current.data[key][0].hidden = false;
      await request(`/admin-api/${kind}`, { method: 'POST', cookie, body: { data: current.data, expectedRevision: current.revision }, status: 409 });
      readback.data[key] = [];
      await request(`/admin-api/${kind}`, { method: 'POST', cookie, body: { data: readback.data, expectedRevision: readback.revision } });
      const rows = db.prepare('SELECT * FROM admin_audit_log WHERE target=?').all(`${kind === 'reviews' ? 'review' : 'feedback'}:${initial.id}`);
      assert.ok(rows.some(row => row.action === 'content.delete' && row.status === 200));
      assert.ok(rows.some(row => row.action === 'content.update' && row.status === 409));
      const log = JSON.stringify(rows); for (const value of [initial.content, 'private reply text', 'forged-actor']) assert.equal(log.includes(value), false);
    }
    const blocked = await request(`/admin-api/mp-users/${userId}/blocked`, { method: 'POST', cookie, body: { blocked: true } });
    assert.equal(blocked.rows[0].target, `user:${userId}`); assert.deepEqual(JSON.parse(blocked.rows[0].detail).blocked, { before: false, after: true });
    await request(`/admin-api/mp-users/${userId}/blocked`, { method: 'POST', cookie, body: { blocked: false } });
  });

  await t.test('SQLite log failure preserves successful HTTP outcomes in a private queue and restart replays them', async () => {
    db.exec("CREATE TRIGGER s2_fail_log BEFORE INSERT ON user_security_logs BEGIN SELECT RAISE(FAIL,'synthetic disk failure'); END;");
    await request('/api/v1/me/profile', { method: 'POST', cookie: user.cookie, body: { nickname: 'changed-with-queued-event' } });
    const files = await fs.readdir(path.join(dataDir, 'log-queue/user')); assert.equal(files.length, 1);
    assert.equal(db.prepare('SELECT nickname FROM mp_users WHERE id=?').get(userId).nickname, 'changed-with-queued-event');
    assert.match(output, /durable-log/);
    db.exec('DROP TRIGGER s2_fail_log'); await stop(); await start();
    assert.equal((await fs.readdir(path.join(dataDir, 'log-queue/user'))).length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM user_security_logs WHERE action='profile.update' AND user_id=?").get(userId).n, 1);
    // A queue that cannot be written blocks the business change before execution.
    const queue = path.join(dataDir, 'log-queue/user'); await fs.rmdir(queue); await fs.writeFile(queue, 'blocked');
    await request('/api/v1/me/profile', { method: 'POST', cookie: user.cookie, body: { nickname: 'must-not-save' }, status: 503 });
    assert.equal(db.prepare('SELECT nickname FROM mp_users WHERE id=?').get(userId).nickname, 'changed-with-queued-event');
    await fs.unlink(queue); await fs.mkdir(queue);
    // Fail only outcome replacement after the request's durable intent exists.
    // No failure response may recursively crash the HTTP process.
    const adminQueue = path.join(dataDir, 'log-queue/admin');
    await fs.rmdir(adminQueue); await fs.writeFile(adminQueue, 'blocked');
    const denied = await fetch(base + '/admin-api/mp-users', { headers: { cookie } });
    assert.equal(denied.status, 503); await denied.arrayBuffer();
    await fs.unlink(adminQueue); await fs.mkdir(adminQueue);
    await request('/admin-api/session', { cookie });
  });

  await t.test('HTTP full backup decrypts and restores all runtime tables; private remote failure is not complete success', async () => {
    const encryptionPassword = 'synthetic-backup-password-123';
    await request('/admin-api/backup-settings', { method: 'POST', cookie, body: { data: { encryptionPassword, r2DataBackup: false, webdavEnabled: false, autoEnabled: false } } });
    const result = await request('/admin-api/backup?scope=all', { cookie, binary: true });
    const snapshot = decryptSnapshot(result.value, encryptionPassword);
    assert.ok(snapshot.tables.mp_users >= 1); assert.ok(snapshot.tables.user_security_logs > 0); assert.ok(snapshot.tables.law_enforcement_logs > 0); assert.ok(snapshot.tables.admin_audit_log > 0);
    const restored = path.join(dir, 'restore'); const verified = restoreSnapshot({ snapshot, destination: restored }); assert.equal(verified.restored, true);
    assert.equal(JSON.parse(await fs.readFile(path.join(restored, 'data/backup-settings.json'))).r2DataBackup, false);
    await request('/admin-api/backup-settings', { method: 'POST', cookie, body: { data: { r2DataBackup: true } } });
    const failed = await request('/admin-api/backup-run', { cookie, method: 'POST', body: {}, status: 409 });
    assert.equal(failed.value.complete, false); assert.equal(failed.value.local.verified, true); assert.ok(failed.value.errors.length);
    assert.ok((await fs.readdir(path.join(dataDir, 'private-backups'))).length >= 2);
    const allLogs = JSON.stringify(db.prepare('SELECT * FROM admin_audit_log').all()); assert.equal(allLogs.includes(encryptionPassword), false);
    for (const suffix of ['', '-wal', '-shm']) assert.equal((await fs.stat(dbPath + suffix)).mode & 0o077, 0);
  });
  await t.test('WebDAV upload is verified through actual HTTP; corrupt readback fails and retry recovers', async () => {
    let corrupt = true; const objects = new Map();
    const remote = http.createServer((req, res) => {
      if (req.method === 'MKCOL') { res.writeHead(201); res.end(); return; }
      if (req.method === 'PUT') { const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => { objects.set(req.url, Buffer.concat(chunks)); res.writeHead(201); res.end(); }); return; }
      if (req.method === 'GET' && objects.has(req.url)) { res.end(corrupt ? 'corrupted' : objects.get(req.url)); return; }
      res.writeHead(404); res.end();
    });
    await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
    try {
      const encryptionPassword = 'synthetic-backup-password-123';
      await request('/admin-api/backup-settings', { method: 'POST', cookie, body: { data: { r2DataBackup: false, webdavEnabled: true, includeCourseFiles: false,
        destinations: [{ id: 'synthetic-dav', url: `http://127.0.0.1:${remote.address().port}/private/`, enabled: true }] } } });
      const failed = await request('/admin-api/backup-run', { method: 'POST', cookie, body: {}, status: 409 }); assert.equal(failed.value.complete, false);
      corrupt = false;
      const retried = await request('/admin-api/backup-run', { method: 'POST', cookie, body: {} }); assert.equal(retried.value.complete, true); assert.equal(retried.value.webdav[0].verified, true);
      for (const bytes of objects.values()) assert.ok(decryptSnapshot(bytes, encryptionPassword).complete);
    } finally { await new Promise(resolve => remote.close(resolve)); }
  });
});
