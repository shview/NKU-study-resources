import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeModerationDocument, isFeedbackPublicEligible, isReviewPublicEligible } from '../server/moderation-model.mjs';

// Read-only deployment preflight. Never prints rows, identities, replies or contact details.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--data-dir' || !path.isAbsolute(args[1])) {
  throw new Error('Usage: node scripts/preview-moderation-migration.mjs --data-dir /absolute/runtime/data');
}
const now = new Date().toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
const output = { dryRun: true, generatedAt: now, schemaVersion: 2, files: {} };
for (const kind of ['feedback', 'reviews']) {
  const filename = path.join(args[1], `${kind}.json`);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${kind}.json must be a regular non-symlink file.`);
  const raw = fs.readFileSync(filename, 'utf8');
  const current = JSON.parse(raw);
  const next = normalizeModerationDocument(current, { kind, nowIso: now });
  const rows = next[kind === 'reviews' ? 'reviews' : 'items'];
  const publicGate = kind === 'reviews' ? isReviewPublicEligible : isFeedbackPublicEligible;
  const twice = normalizeModerationDocument(next, { kind, nowIso: now });
  if (JSON.stringify(next) !== JSON.stringify(twice)) throw new Error('Migration must be idempotent.');
  output.files[kind] = {
    sourceSha256: hash(raw), previewSha256: hash(JSON.stringify(next)), total: rows.length,
    private: rows.filter(item => item.private === true).length,
    publicationBlocked: rows.filter(item => item.publicationBlocked === true).length,
    publicEligible: rows.filter(publicGate).length,
    importedLegacyVisibility: rows.filter(item => item.decisionSource === 'legacy_visibility_import').length,
    pending: rows.filter(item => item.publicationState === 'pending').length,
    alreadyMigrated: current.schemaVersion === 2,
  };
}
console.log(JSON.stringify(output, null, 2));
