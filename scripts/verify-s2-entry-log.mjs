// Local-only Caddy acceptance. Usage: CADDY_BIN=/path/to/caddy node scripts/verify-s2-entry-log.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const executable = process.env.CADDY_BIN || 'caddy';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 's2-caddy-'));
const snippet = path.resolve(import.meta.dirname, '../ops/Caddyfile.s2-log-snippet');
const results = [];
try {
  for (const trustedProxy of [false, true]) {
    const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
    const logfile = path.join(directory, `access-${trustedProxy}.jsonl`);
    const config = path.join(directory, `Caddyfile-${trustedProxy}`);
    await fs.writeFile(config, `{
  admin off
  auto_https off
  ${trustedProxy ? 'servers {\n    trusted_proxies static 127.0.0.1/32\n    trusted_proxies_strict\n  }' : ''}
}
import "${snippet}"
http://127.0.0.1:${port} {
  bind 127.0.0.1
  import s2_access_log
  respond "synthetic only" 200
}
`);
    const env = { ...process.env, S2_ACCESS_LOG: logfile, XDG_DATA_HOME: directory, XDG_CONFIG_HOME: directory };
    const valid = spawnSync(executable, ['validate', '--config', config, '--adapter', 'caddyfile'], { env, encoding: 'utf8' });
    assert.equal(valid.status, 0, valid.stderr || valid.error?.message);
    const adapted = spawnSync(executable, ['adapt', '--config', config, '--adapter', 'caddyfile'], { env, encoding: 'utf8' });
    assert.equal(adapted.status, 0, adapted.stderr);
    const parsed = JSON.parse(adapted.stdout);
    const writer = parsed.logging.logs.s2_access.writer;
    assert.equal(writer.roll_keep, -1); assert.equal(writer.roll_keep_days, 400); assert.equal(writer.mode, '0600');
    const child = spawn(executable, ['run', '--config', config, '--adapter', 'caddyfile'], { env, stdio: ['ignore','pipe','pipe'] });
    let output = '';
    try {
      await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(output)), 10000);
        const collect = chunk => { output += chunk; if (output.includes('serving initial configuration')) { clearTimeout(timer); resolve(); } };
        child.stdout.on('data', collect); child.stderr.on('data', collect); child.once('exit', () => { clearTimeout(timer); reject(new Error(output)); }); });
      let localPort;
      await new Promise((resolve, reject) => {
        const request = http.get({ hostname: '127.0.0.1', port, path: '/probe?ticket=SECRET_QUERY&value=SECRET_PERSON&unknown_secret=SECRET_UNKNOWN', headers: {
          authorization: 'Bearer SECRET_AUTH', cookie: 'session=SECRET_COOKIE', 'x-service-key': 'SECRET_SERVICE', referer: 'https://example.invalid/?token=SECRET_REFERER', 'x-forwarded-for': '198.51.100.70', 'x-forwarded-port': '9999', 'user-agent': 'S2-synthetic-UA',
        } }, response => { assert.equal(response.statusCode, 200); response.resume(); response.on('end', resolve); });
        request.on('socket', socket => socket.once('connect', () => { localPort = socket.localPort; })); request.on('error', reject);
      });
      let text = '';
      for (let attempt = 0; attempt < 50; attempt++) { text = await fs.readFile(logfile, 'utf8').catch(() => ''); if (text.includes('/probe')) break; await new Promise(resolve => setTimeout(resolve, 20)); }
      assert.equal(text.includes('SECRET_'), false, text);
      const row = text.trim().split('\n').map(JSON.parse).find(row => row.request?.uri === '/probe'); assert.ok(row);
      assert.equal(row.request.remote_ip, '127.0.0.1'); assert.equal(Number(row.request.remote_port), localPort);
      assert.equal(row.request.client_ip, trustedProxy ? '198.51.100.70' : '127.0.0.1');
      assert.equal(row.source_port_kind, 'direct_peer'); assert.equal(row.user_agent, 'S2-synthetic-UA'); assert.equal(row.request.headers, undefined); assert.equal(row.status, 200); assert.ok(row.ts);
      assert.equal((await fs.stat(logfile)).mode & 0o077, 0);
      results.push({ topology: trustedProxy ? 'explicit synthetic trusted proxy' : 'direct peer, forged forwarding ignored', fields: ['timestamp','direct peer IP/port','trusted client IP','method','host','path without query','status','UA'], redaction: 'PASS', permissions: '0600', countRetentionDisabled: true, retentionDays: 400 });
    } finally { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } }
  }
  const version = spawnSync(executable, ['version'], { encoding: 'utf8' }).stdout.trim();
  console.log(JSON.stringify({ ok: true, version, syntheticOnly: true, results }, null, 2));
} finally { await fs.rm(directory, { recursive: true, force: true }); }
