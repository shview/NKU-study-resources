import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const fixtures = path.join(root, 'src/data/fixtures');

async function startup(data, dir) {
  const child = spawn(process.execPath, ['server/admin-server.mjs'], {
    cwd: root,
    env: {
      PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_ENV: 'test',
      DATA_DIR: data, STATE_DB_PATH: path.join(dir, 'state.sqlite'),
      ADMIN_SECRET_FILE: path.join(dir, 'admin-secret'),
      BACKUP_SECRET_FILE: path.join(data, 'backup-secrets.json'),
      ADMIN_INITIAL_PASSWORD: 'synthetic-startup-only-password',
      ADMIN_HOST: '127.0.0.1', ADMIN_PORT: '0', ADMIN_ORIGIN: 'http://127.0.0.1',
      PUBLIC_DIR: path.join(dir, 'publish/current'),
      PUBLIC_RELEASES_DIR: path.join(dir, 'publish/releases'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let output = '', started = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10000);
    const collect = chunk => {
      output += chunk;
      if (output.includes('NKUStudy admin API listening')) {
        started = true;
        child.kill('SIGTERM');
      }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve({ code, started, timedOut, output }); });
  });
}

test('startup validates both moderation documents before migrating either file', { timeout: 120000 }, async t => {
  const scenarios = [
    ['reviews', { reviews: { id: 'must-not-disappear' } }],
    ['reviews', { reviews: [], rules: [] }],
    ['reviews', null],
    ['feedback', []],
    ['feedback', { items: [], rules: 'must-not-become-character-keys' }],
    ['feedback', { items: [], rules: null }],
  ];
  for (const [index, [kind, invalid]] of scenarios.entries()) {
    await t.test(`${kind} invalid shape ${index + 1} fails without rewriting either source`, async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nku-s3-invalid-migration-'));
      const data = path.join(dir, 'data'); await fs.mkdir(data);
      try {
        for (const name of ['about', 'feedback', 'footer', 'guides', 'home', 'links', 'manifest', 'participate', 'reviews']) {
          await fs.copyFile(path.join(fixtures, `${name}.json`), path.join(data, `${name}.json`));
        }
        await fs.writeFile(path.join(data, 'notify-settings.json'), '{"enabled":false}');
        await fs.writeFile(path.join(data, 'backup-settings.json'), '{"autoEnabled":false,"r2DataBackup":false,"webdavEnabled":false}');
        await fs.writeFile(path.join(data, `${kind}.json`), JSON.stringify(invalid));
        const before = Object.fromEntries(await Promise.all(['feedback', 'reviews'].map(async name => [name, await fs.readFile(path.join(data, `${name}.json`), 'utf8')])));
        const result = await startup(data, dir);
        assert.equal(result.timedOut, false, 'startup must fail promptly');
        assert.equal(result.started, false, 'invalid moderation data must not become a running empty store');
        assert.notEqual(result.code, 0);
        assert.match(result.output, /INVALID_MODERATION_DOCUMENT/);
        for (const name of ['feedback', 'reviews']) {
          assert.equal(await fs.readFile(path.join(data, `${name}.json`), 'utf8'), before[name], `${name} source must remain unchanged`);
        }
      } finally { await fs.rm(dir, { recursive: true, force: true }); }
    });
  }
});
