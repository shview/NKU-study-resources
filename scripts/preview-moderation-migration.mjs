import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { moderationHash, normalizeModerationDocument, isFeedbackPublicEligible, isReviewPublicEligible } from '../server/moderation-model.mjs';

// Read-only deployment preflight. Never prints rows, identities, replies or contact details.
const hash = value => createHash('sha256').update(value).digest('hex');
const safeFailure = (code, kind) => Object.assign(new Error(code), {
  previewCode: code, ...(kind ? { previewFile: `${kind}.json` } : {}),
});

// These defaults mirror admin-server's startup normalizers. The CLI test compares
// against those actual functions without importing (and starting) the server.
function startupDefaults(kind, now) {
  if (kind === 'reviews') return {
    rules: {
      submissionOpen: true, moderationRequired: true, turnstileEnabled: false,
      hourlyLimit: 3, dailyLimit: 10, minLength: 12,
      submissionOptions: { allowCustomCourse: false, allowCustomTeacher: true },
      announcement: '评价按当前规则决定是否自动公开。请尽量描述授课风格、作业考试情况与适合人群，避免人身攻击或泄露隐私。',
      notes: '',
    },
  };
  return {
    version: 1, updated: now.slice(0, 10), title: '问题与建议', announcement: '',
    rules: {
      submissionOpen: true, hourlyLimit: 3, dailyLimit: 15, minLength: 5,
      notes: '反馈处理状态与公开批准分别记录；投诉举报始终私密。',
    },
    items: [],
  };
}

function readSource(dataDir, kind) {
  const filename = path.join(dataDir, `${kind}.json`);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw safeFailure('UNSAFE_FILE', kind);
  if (typeof fs.constants.O_NOFOLLOW !== 'number') throw safeFailure('NOFOLLOW_UNAVAILABLE', kind);
  let descriptor;
  try {
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw safeFailure('SOURCE_CHANGED', kind);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw safeFailure('SOURCE_CHANGED', kind);
    const raw = bytes.toString('utf8');
    if (!Buffer.from(raw, 'utf8').equals(bytes)) throw safeFailure('INVALID_UTF8', kind);
    let current;
    try {
      current = JSON.parse(raw);
    } catch {
      throw safeFailure('INVALID_JSON', kind);
    }
    return { bytes, current };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function previewSource(current, kind, now) {
  // Validate the source in the shared normalizer before adding top-level defaults.
  const defaults = startupDefaults(kind, now);
  const normalized = normalizeModerationDocument(current, { kind, nowIso: now, rulesDefaults: defaults.rules });
  return kind === 'feedback' ? { ...defaults, ...normalized } : normalized;
}

function main(args) {
  if (args.length !== 2 || args[0] !== '--data-dir' || !path.isAbsolute(args[1])) {
    throw safeFailure('INVALID_ARGUMENTS');
  }
  const dataDir = path.resolve(args[1]);
  const directory = fs.lstatSync(dataDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw safeFailure('UNSAFE_DATA_DIR');
  const now = new Date().toISOString();
  const output = {
    dryRun: true, generatedAt: now, schemaVersion: 2,
    hashSemantics: {
      sourceSha256: 'SHA-256 of the exact source bytes read.',
      previewSha256: 'SHA-256 of compact normalized JSON with startup defaults and generatedAt as migration time; not a startup persisted-file hash or moderation revision.',
    },
    files: {},
  };
  for (const kind of ['feedback', 'reviews']) {
    let bytes, current, next;
    try {
      ({ bytes, current } = readSource(dataDir, kind));
      next = previewSource(current, kind, now);
    } catch (error) {
      if (error.previewCode) throw error;
      throw safeFailure(error.code === 'INVALID_MODERATION_DOCUMENT' ? 'INVALID_MODERATION_DOCUMENT' : 'READ_OR_PREVIEW_FAILED', kind);
    }
    const rows = next[kind === 'reviews' ? 'reviews' : 'items'];
    const publicGate = kind === 'reviews' ? isReviewPublicEligible : isFeedbackPublicEligible;
    const twice = previewSource(next, kind, now);
    if (JSON.stringify(next) !== JSON.stringify(twice)) throw safeFailure('NON_IDEMPOTENT_PREVIEW', kind);
    output.files[kind] = {
      sourceSha256: hash(bytes), previewSha256: hash(JSON.stringify(next)), total: rows.length,
      private: rows.filter(item => item.private === true).length,
      publicationBlocked: rows.filter(item => item.publicationBlocked === true).length,
      publicEligible: rows.filter(publicGate).length,
      importedLegacyVisibility: rows.filter(item => item.decisionSource === 'legacy_visibility_import').length,
      pending: rows.filter(item => item.publicationState === 'pending').length,
      alreadyMigrated: current.schemaVersion === 2 && moderationHash(current) === moderationHash(next),
    };
  }
  console.log(JSON.stringify(output, null, 2));
}

try {
  main(process.argv.slice(2));
} catch (error) {
  // JSON parser/model/filesystem messages can contain source text, item IDs or
  // paths. Emit only locally created fixed codes and fixed document names.
  console.error(JSON.stringify({ dryRun: true, error: {
    code: error.previewCode || 'READ_OR_PREVIEW_FAILED',
    ...(error.previewFile ? { file: error.previewFile } : {}),
    ...(error.previewCode === 'INVALID_ARGUMENTS' ? { usage: 'node scripts/preview-moderation-migration.mjs --data-dir /absolute/runtime/data' } : {}),
  } }));
  process.exitCode = 1;
}
