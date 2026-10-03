#!/usr/bin/env node
// Re-run the S2 acceptance tests, then verify that four deliberate regressions
// are detected. Mutations and synthetic runtime data live only in temporary copies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output') {
  console.error('Usage: node scripts/verify-s2-claims.mjs --output NEW_EVIDENCE_DIRECTORY');
  process.exit(2);
}
const output = path.resolve(args[1]);
if (fs.existsSync(output)) throw new Error('Evidence destination must not exist; use a new directory.');
const dependencies = fs.realpathSync(path.join(root, 'node_modules'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const tests = ['test/s2-user-events.integration.test.mjs', 'test/s2-admin-runtime.integration.test.mjs', 'test/s2-durability.test.mjs'];
const paths = [
  'package.json', 'scripts/runtime-backup.mjs', 'server/data/learning-compass-snapshot.json', ...tests,
  ...fs.readdirSync(path.join(root, 'server')).filter(name => name.endsWith('.mjs')).map(name => `server/${name}`),
  ...fs.readdirSync(path.join(root, 'src/data/fixtures')).filter(name => name.endsWith('.json')).map(name => `src/data/fixtures/${name}`),
].sort();
// Freeze the inputs once so every control tests exactly the same candidate.
const inputs = new Map(paths.map(name => [name, fs.readFileSync(path.join(root, name))]));
const sourceHashes = Object.fromEntries([...inputs].map(([name, bytes]) => [name, hash(bytes)]));
const runnerHash = hash(fs.readFileSync(import.meta.filename));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 's2-claim-check-'));
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const report = {
  startedAt: new Date().toISOString(), node: process.version,
  head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim(),
  scope: 'Synthetic local tests of the uncommitted candidate; not an independent review or production acceptance.',
  dependencyScope: 'Uses the existing installed node_modules; dependency versions are not frozen by this receipt.',
  syntheticOnly: true, sourceHashes, runnerHash, cases: [], passed: false,
};

function materialize(name) {
  const directory = path.join(scratch, name);
  for (const [file, bytes] of inputs) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  fs.symlinkSync(dependencies, path.join(directory, 'node_modules'), 'dir');
  return directory;
}

function mutate(directory, { file, before, after }) {
  const target = path.join(directory, file);
  const original = fs.readFileSync(target, 'utf8');
  if (original.split(before).length !== 2) throw new Error(`Mutation anchor must match exactly once: ${file}`);
  fs.writeFileSync(target, original.replace(before, after));
}

function run(name, directory, testArgs, expectedFailure) {
  console.log(`Running ${name}...`);
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...testArgs], {
    cwd: directory, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024,
    // No inherited production DATA_DIR, credentials, NODE_OPTIONS or preload hooks.
    env: { PATH: process.env.PATH, TMPDIR: scratch, NODE_ENV: 'test' },
  });
  const raw = `${result.stdout || ''}${result.stderr || ''}`;
  const log = `${name}.tap`;
  fs.writeFileSync(path.join(output, log), raw, { mode: 0o600 });
  const count = key => Number(raw.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] ?? NaN);
  // A crash, timeout, missing dependency or permission failure is never accepted
  // as evidence that a deliberately broken business behavior was caught.
  const detected = !result.error && !result.signal && (expectedFailure
    ? result.status === 1 && count('fail') > 0 && expectedFailure.every(pattern => pattern.test(raw))
    : result.status === 0 && count('tests') > 0 && count('fail') === 0 && count('skipped') === 0);
  const item = { name, exitCode: result.status, signal: result.signal, error: result.error?.message,
    tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped'),
    expected: expectedFailure ? 'The deliberate regression must fail at the specified behavior.' : 'All selected tests must pass without skips.',
    verified: detected, log, sha256: hash(raw) };
  report.cases.push(item);
  console.log(`${name}: ${detected ? 'VERIFIED' : 'NOT VERIFIED'} (test exit ${result.status})`);
  if (!detected) throw new Error(`Unexpected result in ${name}; inspect ${path.join(output, log)}`);
}

const controls = [
  {
    name: 'missing-user-event', description: 'Disable user outcome persistence; HTTP tests must find a missing event.',
    file: 'server/user-security-log-store.mjs',
    before: 'record(event) { return this.writer.write(this.normalize(event), event.eventId); }',
    after: 'record(event) { return undefined; }',
    args: [tests[0]], patterns: [/should emit exactly one outcome/, /ERR_ASSERTION/, /actual: 0/],
  },
  {
    name: 'wrong-admin-target', description: 'Replace each changed content ID with a wrong ID; HTTP tests must reject the audit target.',
    file: 'server/admin-audit.mjs', before: 'changes.push({ id, operation:',
    after: "changes.push({ id: 's2-deliberately-wrong-target', operation:",
    args: [tests[1]], patterns: [/saved\.rows\.some/, /ERR_ASSERTION/],
  },
  {
    name: 'missing-archived-query', description: 'Omit archived user rows from queries; the 20,010-row test must detect the missing 10,010 records.',
    file: 'server/user-security-log-store.mjs', before: '...archivedRows(this.archiveDir, "user_security_logs"), ', after: '',
    args: ['--test-name-pattern=20,010 user records', tests[2]], patterns: [/actual: 10000/, /expected: 20010/, /ERR_ASSERTION/],
  },
  {
    name: 'missing-backup-wal', description: 'Copy only the live SQLite main file, omitting committed WAL; snapshot validation must reject the incomplete database.',
    file: 'server/runtime-backup.mjs', before: 'const sqlite = db.serialize();', after: 'const sqlite = fs.readFileSync(db.name);',
    args: ['--test-name-pattern=complete encrypted snapshot', tests[2]], patterns: [/SQLite table counts differ/, /testCodeFailure/],
  },
];

try {
  run('candidate', materialize('candidate'), tests);
  for (const control of controls) {
    const directory = materialize(control.name);
    mutate(directory, control);
    run(control.name, directory, control.args, control.patterns);
    Object.assign(report.cases.at(-1), { deliberateChange: control.description, mutation: { file: control.file, before: control.before, after: control.after } });
  }
  report.sourceUnchanged = paths.every(name => hash(fs.readFileSync(path.join(root, name))) === sourceHashes[name]);
  if (!report.sourceUnchanged) throw new Error('Source changed during verification; rerun against a stable candidate.');
  report.passed = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(`Receipt: ${path.join(output, 'receipt.json')}`);
console.log(report.passed ? 'Candidate passed; all four deliberate regressions were detected.' : `NOT VERIFIED: ${report.error}`);
