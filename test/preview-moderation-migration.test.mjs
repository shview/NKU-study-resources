import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { normalizeFeedbackDocument, normalizeReviewsDocument, reviewPublicationFields } from '../server/moderation-model.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'scripts/preview-moderation-migration.mjs');
const secret = 'SYNTHETIC_PRIVATE_CONTENT_ACCOUNT_SECRET_SENTINEL';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const past = '2026-01-02T03:04:05.000Z';

async function fixture(t, feedback = { items: [] }, reviews = { reviews: [] }) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'preview-account-sentinel-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const [kind, value] of Object.entries({ feedback, reviews })) {
    const filename = path.join(directory, `${kind}.json`);
    await fs.writeFile(filename, Buffer.isBuffer(value) ? value : jsonBytes(value));
    await fs.utimes(filename, new Date(past), new Date(past));
  }
  return directory;
}

async function snapshot(directory) {
  const result = {};
  for (const filename of await fs.readdir(directory)) {
    const target = path.join(directory, filename);
    const stat = await fs.lstat(target, { bigint: true });
    result[filename] = {
      mtimeNs: stat.mtimeNs, size: stat.size,
      bytes: stat.isFile() ? await fs.readFile(target) : null,
      link: stat.isSymbolicLink() ? await fs.readlink(target) : null,
    };
  }
  return result;
}

function run(directory, args = ['--data-dir', directory]) {
  const child = spawnSync(process.execPath, [script, ...args], {
    cwd: root, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.ok(!`${child.stdout}${child.stderr}`.includes(secret), 'stdout/stderr must not disclose private fixture fields or identity');
  assert.ok(!`${child.stdout}${child.stderr}`.includes(directory), 'stdout/stderr must not disclose the supplied data path');
  assert.ok(!`${child.stdout}${child.stderr}`.includes('preview-account-sentinel-'));
  return child;
}

async function actualStartupNormalizers(now) {
  // Evaluate only the actual pure startup default/normalizer functions, never the
  // admin-server module (which would initialize runtime state and listen).
  const source = await fs.readFile(path.join(root, 'server/admin-server.mjs'), 'utf8');
  const start = source.indexOf('function defaultReviews() {');
  const end = source.indexOf('function readAbout() {', start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(`${source.slice(start, end)}\n({ feedback: normalizeFeedbackData, reviews: normalizeReviewData })`, {
    today: () => now.slice(0, 10), structuredClone,
    normalizeFeedbackDocument: (data, options = {}) => normalizeFeedbackDocument(data, { ...options, nowIso: now }),
    normalizeReviewsDocument: (data, options = {}) => normalizeReviewsDocument(data, { ...options, nowIso: now }),
  });
}

test('CLI preserves source bytes/mtime, returns expected visibility counts and matches actual startup defaults', async t => {
  const approval = {
    schemaVersion: 2, publicationState: 'approved', handlingStatus: 'completed',
    reviewedAt: past, reviewedBy: secret, decisionSource: 'admin_decision', replyVisibility: 'submitter',
  };
  const feedback = {
    version: 1, title: secret, rules: { submissionOpen: false, hourlyLimit: 8 },
    items: [
      { id: `old-approved-${secret}`, title: secret, content: secret, status: 'approved', contact: secret, user_id: secret, reply: secret },
      { id: 'report', content: secret, type: 'report', status: 'approved' },
      { id: 'target', content: secret, reportTarget: secret, status: 'approved' },
      { id: 'complaint', content: secret, type: 'complaint', status: 'completed' },
      { id: 'private', content: secret, private: true, status: 'approved' },
      { id: 'hidden', content: secret, hidden: true, status: 'pending' },
      { id: 'v2-approved', content: secret, privacySource: 'server_feedback_submission', ...approval },
      { id: 'v2-report', content: secret, type: 'complaint', private: false, privacySource: 'server_feedback_submission', ...approval },
      { id: 'v2-unknown', content: secret, schemaVersion: 2, publicationState: 'pending', handlingStatus: 'open' },
    ],
  };
  const rules = { moderationRequired: false, keywordFilter: { enabled: true, words: ['合成关键词'] }, minLength: 6 };
  const reviews = {
    version: 1, rules,
    reviews: [
      { id: 'approved', courseTitle: secret, teacher: secret, content: secret, status: 'approved', helpfulBy: [secret] },
      { id: 'hidden-approved', courseTitle: secret, content: secret, status: '通过', hidden: true },
      { id: 'pending', teacher: secret, content: secret, status: 'pending' },
      { id: 'private-approved', teacher: secret, content: secret, status: 'approved', private: true },
      { id: 'hidden-status', teacher: secret, content: secret, status: 'hidden' },
      { id: 'automatic', teacher: secret, content: secret, ...reviewPublicationFields({ rules, content: secret, now: past }) },
      { id: 'keyword-pending', teacher: secret, content: '合成关键词', ...reviewPublicationFields({ rules, content: '合成关键词', now: past }) },
    ],
  };
  const directory = await fixture(t, feedback, reviews);
  const before = await snapshot(directory);
  const child = run(directory);
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  assert.deepEqual(await snapshot(directory), before, 'the CLI must neither rewrite files nor change their modification times');
  const output = JSON.parse(child.stdout);
  assert.equal(output.dryRun, true);
  assert.equal(output.schemaVersion, 2);
  assert.ok(Number.isFinite(Date.parse(output.generatedAt)));
  assert.match(output.hashSemantics.previewSha256, /not a startup persisted-file hash or moderation revision/);
  const startup = await actualStartupNormalizers(output.generatedAt);
  const counts = {
    feedback: { total: 9, private: 5, publicationBlocked: 2, publicEligible: 2, importedLegacyVisibility: 1, pending: 6, alreadyMigrated: false, legacyPublicBefore: 1, legacyPublicPreserved: 1, legacyPublicRepliesBefore: 1, legacyPublicRepliesPreserved: 1 },
    reviews: { total: 7, private: 1, publicationBlocked: 0, publicEligible: 2, importedLegacyVisibility: 3, pending: 3, alreadyMigrated: false },
  };
  for (const [kind, source] of Object.entries({ feedback, reviews })) {
    const { sourceSha256, previewSha256, ...actualCounts } = output.files[kind];
    assert.deepEqual(actualCounts, counts[kind]);
    assert.equal(sourceSha256, sha256(before[`${kind}.json`].bytes), 'source hash must cover the original bytes including formatting');
    assert.equal(previewSha256, sha256(JSON.stringify(startup[kind](source))), 'preview must use the actual server startup defaults and preserve configured overrides');
    assert.notEqual(sourceSha256, previewSha256, 'pretty source bytes and compact normalized JSON are different hash domains');
  }
});

test('CLI recognizes fully normalized v2 data, but does not mistake a v2 document with old rows for completed migration', async t => {
  const startup = await actualStartupNormalizers(past);
  const feedback = startup.feedback({ items: [{ id: 'old-feedback', content: secret, status: 'approved' }] });
  const reviews = startup.reviews({ reviews: [{ id: 'old-review', teacher: secret, content: secret, status: 'approved' }] });
  const directory = await fixture(t, feedback, reviews);
  const before = await snapshot(directory);
  const first = run(directory);
  assert.equal(first.status, 0);
  const output = JSON.parse(first.stdout);
  assert.equal(output.files.feedback.alreadyMigrated, true);
  assert.equal(output.files.reviews.alreadyMigrated, true);
  assert.equal(output.files.feedback.publicEligible, 1);
  assert.equal(output.files.feedback.legacyPublicBefore, 0, 'already v2 rows are not a fresh legacy import');
  assert.equal(output.files.reviews.publicEligible, 1);
  assert.deepEqual(await snapshot(directory), before);
  reviews.reviews.push({ id: 'unmigrated-row', teacher: secret, content: secret, status: 'approved' });
  await fs.writeFile(path.join(directory, 'reviews.json'), jsonBytes(reviews));
  const mixedBefore = await snapshot(directory);
  const second = run(directory);
  assert.equal(second.status, 0);
  assert.equal(JSON.parse(second.stdout).files.reviews.alreadyMigrated, false);
  assert.deepEqual(await snapshot(directory), mixedBefore);
});

test('synthetic receipt-scale rehearsal preserves eight old public feedback rows and 1477 reviews', async t => {
  const feedback = { version: 1, items: Array.from({ length: 8 }, (_, index) => ({
    id: `historical-${index}`, title: secret, content: secret, type: 'bug',
    status: index < 4 ? 'approved' : 'completed',
    ...(index < 4 ? { reply: secret, repliedAt: past } : {}),
  })) };
  const reviews = { version: 1, reviews: Array.from({ length: 1477 }, (_, index) => ({
    id: `review-${index}`, courseTitle: secret, teacher: secret, content: secret, status: 'approved',
  })) };
  const directory = await fixture(t, feedback, reviews);
  const before = await snapshot(directory);
  const child = run(directory);
  assert.equal(child.status, 0);
  const { files } = JSON.parse(child.stdout);
  assert.equal(files.feedback.total, 8);
  assert.equal(files.feedback.publicEligible, 8);
  assert.equal(files.feedback.publicationBlocked, 0);
  assert.equal(files.feedback.importedLegacyVisibility, 8);
  assert.equal(files.feedback.legacyPublicBefore, 8);
  assert.equal(files.feedback.legacyPublicPreserved, 8);
  assert.equal(files.feedback.legacyPublicRepliesBefore, 4);
  assert.equal(files.feedback.legacyPublicRepliesPreserved, 4);
  assert.equal(files.reviews.total, 1477);
  assert.equal(files.reviews.publicEligible, 1477);
  assert.equal(files.reviews.importedLegacyVisibility, 1477);
  assert.deepEqual(await snapshot(directory), before);
});

test('CLI rejects malformed/unsupported source data without leaking parser snippets or item IDs', async t => {
  const cases = [
    ['feedback', Buffer.from(`{"items":[{"id":"${secret}","content":"${secret}"}, }`), 'INVALID_JSON'],
    ['reviews', Buffer.from(`{"reviews":[{"id":"${secret}"}],"trailing":"${secret}"}garbage`), 'INVALID_JSON'],
    ['feedback', { version: 3, items: [], secret }, 'INVALID_MODERATION_DOCUMENT'],
    ['reviews', { schemaVersion: 3, reviews: [], secret }, 'INVALID_MODERATION_DOCUMENT'],
    ['feedback', { items: [{ id: secret, schemaVersion: 3 }] }, 'INVALID_MODERATION_DOCUMENT'],
    ['reviews', { reviews: [{ id: secret }, { id: secret }] }, 'INVALID_MODERATION_DOCUMENT'],
    ['feedback', { items: [{ id: secret, private: 'true' }] }, 'INVALID_MODERATION_DOCUMENT'],
    ['reviews', { reviews: [{ id: secret, hidden: 'true' }] }, 'INVALID_MODERATION_DOCUMENT'],
    ['feedback', { items: [{ content: secret }] }, 'INVALID_MODERATION_DOCUMENT'],
    ['feedback', { items: { secret } }, 'INVALID_MODERATION_DOCUMENT'],
    ['reviews', { reviews: { secret } }, 'INVALID_MODERATION_DOCUMENT'],
    ['feedback', { items: [], rules: [secret] }, 'INVALID_MODERATION_DOCUMENT'],
    ['reviews', { reviews: [], rules: secret }, 'INVALID_MODERATION_DOCUMENT'],
    ['feedback', [secret], 'INVALID_MODERATION_DOCUMENT'],
    ['reviews', null, 'INVALID_MODERATION_DOCUMENT'],
    ['feedback', Buffer.concat([Buffer.from('{"items":[],"secret":"'), Buffer.from([0xff]), Buffer.from('"}')]), 'INVALID_UTF8'],
  ];
  for (const [index, [kind, value, expectedCode]] of cases.entries()) {
    await t.test(`${kind} invalid case ${index + 1}`, async sub => {
      const directory = await fixture(sub, kind === 'feedback' ? value : undefined, kind === 'reviews' ? value : undefined);
      const before = await snapshot(directory);
      const child = run(directory);
      assert.equal(child.status, 1);
      assert.equal(child.stdout, '', 'failure must not emit a misleading partial success report');
      assert.deepEqual(JSON.parse(child.stderr), { dryRun: true, error: { code: expectedCode, file: `${kind}.json` } });
      assert.deepEqual(await snapshot(directory), before);
    });
  }
});

test('CLI rejects symlink/nonregular/missing inputs and invalid arguments without printing supplied paths', async t => {
  await t.test('symlink file', async sub => {
    const directory = await fixture(sub);
    const outside = path.join(directory, `${secret}.json`);
    await fs.writeFile(outside, jsonBytes({ items: [{ id: secret, content: secret }] }));
    await fs.unlink(path.join(directory, 'feedback.json'));
    await fs.symlink(outside, path.join(directory, 'feedback.json'));
    const before = await snapshot(directory);
    const child = run(directory);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.deepEqual(JSON.parse(child.stderr), { dryRun: true, error: { code: 'UNSAFE_FILE', file: 'feedback.json' } });
    assert.deepEqual(await snapshot(directory), before);
  });
  await t.test('symlink data directory', async sub => {
    const directory = await fixture(sub);
    const alias = `${directory}-symlink`;
    sub.after(() => fs.unlink(alias));
    await fs.symlink(directory, alias);
    const before = await snapshot(directory);
    const child = run(alias);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.deepEqual(JSON.parse(child.stderr), { dryRun: true, error: { code: 'UNSAFE_DATA_DIR' } });
    assert.deepEqual(await snapshot(directory), before);
  });
  await t.test('nonregular file', async sub => {
    const directory = await fixture(sub);
    await fs.unlink(path.join(directory, 'reviews.json'));
    await fs.mkdir(path.join(directory, 'reviews.json'));
    const before = await snapshot(directory);
    const child = run(directory);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.deepEqual(JSON.parse(child.stderr), { dryRun: true, error: { code: 'UNSAFE_FILE', file: 'reviews.json' } });
    assert.deepEqual(await snapshot(directory), before);
  });
  await t.test('missing file', async sub => {
    const directory = await fixture(sub);
    await fs.unlink(path.join(directory, 'reviews.json'));
    const before = await snapshot(directory);
    const child = run(directory);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.deepEqual(JSON.parse(child.stderr), { dryRun: true, error: { code: 'READ_OR_PREVIEW_FAILED', file: 'reviews.json' } });
    assert.deepEqual(await snapshot(directory), before);
  });
  await t.test('invalid arguments', async sub => {
    const directory = await fixture(sub);
    const before = await snapshot(directory);
    for (const args of [[], ['--data-dir', secret], ['--unexpected', directory], ['--data-dir', directory, secret]]) {
      const child = run(directory, args);
      assert.equal(child.status, 1);
      assert.equal(child.stdout, '');
      assert.equal(JSON.parse(child.stderr).error.code, 'INVALID_ARGUMENTS');
    }
    assert.deepEqual(await snapshot(directory), before);
  });
});
