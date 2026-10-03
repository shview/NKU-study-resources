// Read-only local operator check; no row content or credentials are printed.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readEnvelope, archivedRows } from '../server/durable-log.mjs';
try {
  if (!process.env.DATA_DIR || !process.env.STATE_DB_PATH) throw new Error('Explicit DATA_DIR and STATE_DB_PATH are required');
  const directory = path.resolve(process.env.DATA_DIR);
  const db = new Database(process.env.STATE_DB_PATH, { readonly: true, fileMustExist: true });
  const report = { integrity: db.pragma('integrity_check', { simple: true }), queues: {}, archives: {}, privateFiles: true };
  db.close();
  for (const kind of ['user','admin','law']) {
    const queue = path.join(directory, 'log-queue', kind);
    const files = fs.readdirSync(queue).filter(name => name.endsWith('.json'));
    for (const name of files) readEnvelope(path.join(queue, name), kind);
    report.queues[kind] = files.length;
  }
  for (const [folder, table] of [['audit-archive','admin_audit_log'],['security-archive','user_security_logs'],['law-archive','law_enforcement_logs']]) report.archives[folder] = archivedRows(path.join(directory, folder), table).length;
  for (const file of [process.env.STATE_DB_PATH, `${process.env.STATE_DB_PATH}-wal`, `${process.env.STATE_DB_PATH}-shm`]) if (fs.existsSync(file) && (fs.statSync(file).mode & 0o077)) report.privateFiles = false;
  const stat = fs.statfsSync(directory); report.freeBytes = stat.bavail * stat.bsize;
  report.ok = report.integrity === 'ok' && report.privateFiles && Object.values(report.queues).every(count => count === 0);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) { console.error(JSON.stringify({ ok: false, error: error.code || 'STORAGE_CHECK_FAILED', message: error.message })); process.exitCode = 1; }
