import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('operational alerts follow real HTTP backup and log failures without notifying moderation bots', { timeout: 60_000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nku-ops-alerts-'));
  const app = path.join(dir, 'app'), data = path.join(dir, 'data');
  await fs.mkdir(app); await fs.mkdir(data);
  await fs.cp(path.join(root, 'server'), path.join(app, 'server'), { recursive: true });
  await fs.symlink(path.join(root, 'node_modules'), path.join(app, 'node_modules'));
  await fs.writeFile(path.join(app, 'package.json'), '{"type":"module"}');
  for (const name of ['about', 'feedback', 'footer', 'guides', 'home', 'links', 'manifest', 'participate', 'reviews']) {
    await fs.copyFile(path.join(root, 'src/data/fixtures', `${name}.json`), path.join(data, `${name}.json`));
  }
  await fs.writeFile(path.join(data, 'backup-settings.json'), '{"autoEnabled":false,"r2DataBackup":false,"webdavEnabled":false}');
  const opsHook = 'https://open.feishu.cn/open-apis/bot/v2/hook/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const moderationHook = 'https://open.feishu.cn/open-apis/bot/v2/hook/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  await fs.writeFile(path.join(data, 'notify-settings.json'), JSON.stringify({ version: 2, bots: [
    { id: 'ops', name: 'synthetic-ops', webhookUrl: opsHook, enabled: true, purposes: ['ops'] },
    { id: 'moderation', name: 'synthetic-moderation', webhookUrl: moderationHook, enabled: true, purposes: ['moderation'] },
  ] }));
  const probe = path.join(dir, 'notifications.jsonl'), failTransport = path.join(dir, 'fail-transport');
  const holdUpload = path.join(dir, 'hold-upload'), uploadStarted = path.join(dir, 'upload-started');
  const preload = path.join(app, 'synthetic-notifications.mjs');
  await fs.writeFile(preload, `import fs from 'node:fs';
let remoteBytes;
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith('https://synthetic-webdav.invalid/')) {
    if (options.method === 'MKCOL') return new Response('', { status: 201 });
    if (options.method === 'PUT') {
      remoteBytes = options.body;
      fs.writeFileSync(process.env.OPS_TEST_UPLOAD_STARTED, 'synthetic');
      while (fs.existsSync(process.env.OPS_TEST_HOLD_UPLOAD)) await new Promise(resolve => setTimeout(resolve, 10));
      return new Response('', { status: 201 });
    }
    if (options.method === 'GET') return new Response(remoteBytes, { status: 200 });
  }
  if (!String(url).startsWith('https://open.feishu.cn/open-apis/bot/v2/hook/')) throw new Error('External requests are disabled in this test');
  fs.appendFileSync(process.env.OPS_TEST_PROBE, JSON.stringify({ url, body: JSON.parse(options.body) }) + '\\n');
  return new Response(JSON.stringify({ code: 0 }), { status: fs.existsSync(process.env.OPS_TEST_FAIL) ? 500 : 200 });
};\n`);
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const base = `http://127.0.0.1:${port}`, password = 'synthetic-ops-admin-password';
  const child = spawn(process.execPath, [path.join(app, 'server/admin-server.mjs')], {
    cwd: app,
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_ENV: 'test', NODE_OPTIONS: `--import=${preload}`,
      DATA_DIR: data, STATE_DB_PATH: path.join(dir, 'state.sqlite'), ADMIN_HOST: '127.0.0.1', ADMIN_PORT: String(port), ADMIN_ORIGIN: base,
      ADMIN_INITIAL_PASSWORD: password, ADMIN_SECRET_FILE: path.join(dir, 'admin-secret'), BACKUP_SECRET_FILE: path.join(data, 'backup-secrets.json'),
      PUBLIC_DIR: path.join(dir, 'public/current'), PUBLIC_RELEASES_DIR: path.join(dir, 'public/releases'),
      OPS_TEST_PROBE: probe, OPS_TEST_FAIL: failTransport,
      OPS_TEST_HOLD_UPLOAD: holdUpload, OPS_TEST_UPLOAD_STARTED: uploadStarted },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await fs.rm(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output)), 15_000);
    const collect = chunk => {
      output += chunk.toString();
      if (output.includes('NKUStudy admin API listening')) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(output)); });
  });
  let cookie = '';
  async function request(route, { method = 'GET', body, status = 200, binary = false } = {}) {
    const response = await fetch(base + route, { method, headers: { cookie, origin: base, 'content-type': 'application/json', 'x-nkustudy-admin-request': '1' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, status, `${route}: ${bytes.toString()}`);
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return binary ? bytes : JSON.parse(bytes);
  }
  async function notifications() {
    try { return (await fs.readFile(probe, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async function expectCount(count) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const records = await notifications();
      if (records.length === count) return records;
      if (records.length > count) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal((await notifications()).length, count, output);
  }
  await request('/admin-api/login', { method: 'POST', body: { username: 'Shview', password } });
  await request('/admin-api/backup-run', { method: 'POST', body: {}, status: 409 });
  await expectCount(1);
  await request('/admin-api/backup-run', { method: 'POST', body: {}, status: 409 });
  assert.equal((await notifications()).length, 1, 'the same unresolved failure must be deduplicated');

  const encryptionPassword = 'synthetic-ops-backup-password';
  await request('/admin-api/backup-settings', { method: 'POST', body: { data: { encryptionPassword } } });
  assert.equal((await request('/admin-api/backup-run', { method: 'POST', body: {} })).complete, true);
  await request('/admin-api/backup-settings', { method: 'POST', body: { data: { r2DataBackup: true } } });
  const missingRemote = await request('/admin-api/backup-run', { method: 'POST', body: {}, status: 409 });
  assert.equal(missingRemote.local.verified, true);
  await expectCount(2);
  await request('/admin-api/backup?scope=all', { binary: true });
  await request('/admin-api/backup-run', { method: 'POST', body: {}, status: 409 });
  assert.equal((await notifications()).length, 2, 'local-only download must not rearm an unresolved remote failure');

  // A failed notification provider must not change the backup result or prevent
  // subsequent administrator requests. This provider returns HTTP 500 + code:0.
  await request('/admin-api/backup-settings', { method: 'POST', body: { data: { r2DataBackup: false } } });
  await request('/admin-api/backup-run', { method: 'POST', body: {} });
  await request('/admin-api/backup-settings', { method: 'POST', body: { data: {
    webdavEnabled: true, includeCourseFiles: false,
    destinations: [{ id: 'synthetic', url: 'https://synthetic-webdav.invalid/private/', enabled: true }],
  } } });
  await fs.writeFile(holdUpload, 'synthetic');
  const running = request('/admin-api/backup-run', { method: 'POST', body: {} });
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await fs.stat(uploadStarted).then(() => true, () => false)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(await fs.stat(uploadStarted));
    const overlap = await request('/admin-api/backup-run', { method: 'POST', body: {}, status: 409 });
    assert.equal(overlap.code, 'BACKUP_BUSY');
    assert.equal((await notifications()).length, 2, 'a busy backup is not a failed backup');
  } finally { await fs.unlink(holdUpload); }
  assert.equal((await running).complete, true);
  await fs.writeFile(failTransport, 'synthetic');
  await request('/admin-api/backup-settings', { method: 'POST', body: { data: { r2DataBackup: true, webdavEnabled: false } } });
  await request('/admin-api/backup-run', { method: 'POST', body: {}, status: 409 });
  await expectCount(3);
  await request('/admin-api/session');

  // Break only this temporary server's admission directory. Its original 503
  // behavior and local diagnostics remain, with an additional bounded alert.
  const queue = path.join(data, 'log-queue/admin');
  await fs.rmdir(queue); await fs.writeFile(queue, 'synthetic unavailable queue');
  await request('/admin-api/session', { status: 503 });
  const records = await expectCount(4);
  await fs.unlink(queue); await fs.mkdir(queue);
  await request('/admin-api/session');
  assert.ok(records.every(record => record.url === opsHook), 'moderation bots are not opted in');
  assert.match(JSON.stringify(records.at(-1).body), /管理员审计日志/);
  for (const secret of [password, encryptionPassword, data, cookie]) assert.equal(JSON.stringify(records).includes(secret), false);
  assert.match(output, /"component":"ops-alerts".*"status":"failed"/);
});
