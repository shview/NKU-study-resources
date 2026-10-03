import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { uploadPrivateR2Backup } from '../server/backup-r2.mjs';

const env = {
  BACKUP_R2_BUCKET: 'synthetic-private-backups', BACKUP_R2_PRIVATE_CONFIRMED: '1',
  BACKUP_R2_ACCOUNT_ID: 'a'.repeat(32), BACKUP_R2_ACCESS_KEY_ID: 'synthetic-backup-key', BACKUP_R2_SECRET_ACCESS_KEY: 'synthetic-backup-secret',
  R2_BUCKET: 'synthetic-public-resources', R2_ACCOUNT_ID: 'b'.repeat(32), R2_ACCESS_KEY_ID: 'synthetic-resource-key', R2_SECRET_ACCESS_KEY: 'synthetic-resource-secret',
};
const bytes = Buffer.from('synthetic-encrypted-backup-bytes');
const filename = 'runtime-2026-10-02T00-00-00.000Z-12345678.json.enc';

function sdkTransport({ corrupt = false, denied = false } = {}) {
  const requests = [];
  let stored, destroyed = false;
  return {
    requests,
    get destroyed() { return destroyed; },
    createClient: options => new S3Client({ ...options, requestHandler: {
      async handle(request) {
        requests.push(request);
        if (denied) return { response: { statusCode: 403, headers: { 'content-type': 'application/xml' }, body: Readable.from([`<Error><Code>AccessDenied</Code><Message>${env.BACKUP_R2_SECRET_ACCESS_KEY}</Message></Error>`]) } };
        if (request.method === 'PUT') {
          assert.ok(Buffer.isBuffer(request.body));
          stored = Buffer.from(request.body);
          return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } };
        }
        assert.equal(request.method, 'GET');
        return { response: { statusCode: 200, headers: {}, body: Readable.from([corrupt ? Buffer.from('corrupted') : stored]) } };
      },
      destroy() { destroyed = true; },
    } }),
  };
}

test('private R2 backup signs actual SDK requests with the dedicated key/account and verifies the returned bytes', async () => {
  const original = structuredClone(env);
  const transport = sdkTransport();
  const result = await uploadPrivateR2Backup({ bytes, filename, env, createClient: transport.createClient });
  assert.equal(result.verified, true);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.key, `runtime-backups/${filename}`);
  assert.deepEqual(transport.requests.map(request => request.method), ['PUT', 'GET']);
  for (const request of transport.requests) {
    assert.equal(request.hostname, `${env.BACKUP_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    assert.equal(request.path, `/${env.BACKUP_R2_BUCKET}/runtime-backups/${filename}`);
    assert.match(request.headers.authorization, /Credential=synthetic-backup-key\//);
    assert.equal(request.headers.authorization.includes(env.R2_ACCESS_KEY_ID), false);
    assert.equal(request.headers['x-amz-acl'], undefined);
  }
  assert.equal(transport.destroyed, true);
  assert.deepEqual(env, original, 'resource configuration must not be replaced');
});

test('private R2 backup works without resource credentials and never falls back to them', async () => {
  const dedicatedOnly = { ...env };
  for (const field of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) delete dedicatedOnly[field];
  const transport = sdkTransport();
  assert.equal((await uploadPrivateR2Backup({ bytes, filename, env: dedicatedOnly, createClient: transport.createClient })).verified, true);
  for (const field of ['BACKUP_R2_ACCOUNT_ID', 'BACKUP_R2_ACCESS_KEY_ID', 'BACKUP_R2_SECRET_ACCESS_KEY']) {
    const incomplete = { ...env }; delete incomplete[field];
    let created = false;
    await assert.rejects(uploadPrivateR2Backup({ bytes, filename, env: incomplete, createClient: () => { created = true; } }), /独立配置/);
    assert.equal(created, false);
  }
});

test('unconfirmed/public buckets, malformed accounts and unsafe backup names fail before any SDK request', async () => {
  for (const [changes, name] of [
    [{ BACKUP_R2_PRIVATE_CONFIRMED: '0' }, filename], [{ BACKUP_R2_BUCKET: '' }, filename],
    [{ BACKUP_R2_BUCKET: env.R2_BUCKET }, filename], [{ BACKUP_R2_ACCOUNT_ID: 'invalid/account' }, filename],
    [{}, '../runtime-other.json.enc'], [{}, 'runtime-plaintext.json'],
  ]) {
    let created = false;
    await assert.rejects(uploadPrivateR2Backup({ bytes, filename: name, env: { ...env, ...changes }, createClient: () => { created = true; } }));
    assert.equal(created, false);
  }
});

test('corrupt readback and access denial fail without echoing provider messages or secrets', async () => {
  for (const mode of [{ corrupt: true }, { denied: true }]) {
    const transport = sdkTransport(mode);
    await assert.rejects(uploadPrivateR2Backup({ bytes, filename, env, createClient: transport.createClient }), error => {
      assert.match(error.message, /上传或读回校验失败/);
      if (mode.denied) assert.match(error.message, /HTTP 403/);
      for (const secret of [env.BACKUP_R2_SECRET_ACCESS_KEY, env.R2_SECRET_ACCESS_KEY]) assert.equal(error.message.includes(secret), false);
      return true;
    });
    assert.equal(transport.destroyed, true);
  }
});
