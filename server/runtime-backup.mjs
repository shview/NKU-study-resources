import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import Database from 'better-sqlite3';
import { digest, durableWrite, privateDir, syncDir } from './durable-log.mjs';

export class SnapshotGate {
  constructor() { this.active = 0; this.locked = false; this.waiters = new Set(); }
  enter() {
    if (this.locked) throw Object.assign(new Error('正在制作一致性备份，请稍后重试。'), { statusCode: 503, code: 'BACKUP_BUSY' });
    this.active++;
    let done = false;
    return () => { if (done) return; done = true; this.active--; for (const wake of this.waiters) wake(); };
  }
  async capture(operation, timeoutMs = 30000) {
    if (this.locked) throw Object.assign(new Error('Backup is already running'), { statusCode: 409 });
    this.locked = true;
    try {
      if (this.active) await new Promise((resolve, reject) => {
        const wake = () => { if (!this.active) { clearTimeout(timer); this.waiters.delete(wake); resolve(); } };
        const timer = setTimeout(() => { this.waiters.delete(wake); reject(new Error('Snapshot drain timed out')); }, timeoutMs);
        this.waiters.add(wake); wake();
      });
      return await operation();
    } finally { this.locked = false; }
  }
}

function safeName(name) {
  if (typeof name !== 'string' || !name || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe backup entry');
  return name;
}
function fileEntry(name, bytes) { return { name: safeName(name), bytes: bytes.length, sha256: digest(bytes), base64: bytes.toString('base64') }; }
function tableCounts(db) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT COUNT(*) n FROM "${name.replaceAll('"', '""')}"`).get().n]));
}
function validateDatabase(bytes, counts) {
  // A serialized WAL-mode database cannot be deserialized as an in-memory DB
  // by SQLite. Validate on private disk, without copying the live main file.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nku-backup-check-'));
  const file = path.join(directory, 'state.sqlite');
  let restored;
  try {
    durableWrite(file, bytes);
    restored = new Database(file);
    if (restored.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('SQLite integrity check failed');
    if (JSON.stringify(tableCounts(restored)) !== JSON.stringify(counts)) throw new Error('SQLite table counts differ');
  } finally { restored?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}

// Called with the process request gate held and JSON mutation queues drained.
// Synchronous serialization sees committed WAL contents and cannot interleave with
// other JavaScript work. Production must retain the existing single-process setup.
export function captureRuntime({ db, dataDir, extraFiles = {}, requiredFiles = [], fault = () => {} }) {
  for (const name of requiredFiles) if (!fs.existsSync(path.join(dataDir, name))) throw new Error(`Required runtime file missing: ${name}`);
  for (const directory of ['.publish-journal', '.manifest-journal']) {
    if (fs.existsSync(path.join(dataDir, directory)) && fs.readdirSync(path.join(dataDir, directory)).length) throw new Error('Unresolved publication journal; backup incomplete');
  }
  const files = [];
  const walk = (directory, relative = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const relativeName = relative ? `${relative}/${name}` : name;
      if (['private-backups', '.restore-quarantine'].includes(relativeName)) continue;
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('Symlink in runtime data; backup refused');
      if (stat.isDirectory()) walk(file, relativeName);
      else if (name.endsWith('.json') || name === '.nkustudy-data-root') {
        const bytes = fs.readFileSync(file);
        if (name.endsWith('.json')) JSON.parse(bytes.toString('utf8'));
        files.push(fileEntry(`data/${relativeName}`, bytes));
      }
    }
  };
  const counts = tableCounts(db);
  const sqlite = db.serialize();
  validateDatabase(sqlite, counts);
  files.push(fileEntry('state.sqlite', sqlite));
  fault('afterSqlite');
  walk(dataDir);
  for (const [name, file] of Object.entries(extraFiles)) files.push(fileEntry(`config/${safeName(name)}`, fs.readFileSync(file)));
  if (new Set(files.map(file => file.name)).size !== files.length) throw new Error('Duplicate backup file');
  const snapshot = { format: 'nkustudy-runtime-v2', createdAt: new Date().toISOString(), complete: true,
    scope: 'SQLite and runtime JSON, private configuration, local audit archives and replay queues',
    externalAssetsIncluded: false, tables: counts, files };
  verifySnapshot(snapshot);
  return snapshot;
}
export function verifySnapshot(snapshot) {
  if (snapshot?.format !== 'nkustudy-runtime-v2' || snapshot.complete !== true || !Array.isArray(snapshot.files)) throw new Error('Incomplete or unsupported backup');
  const seen = new Set();
  for (const entry of snapshot.files) {
    safeName(entry.name);
    if (seen.has(entry.name)) throw new Error('Duplicate backup entry'); seen.add(entry.name);
    const bytes = Buffer.from(entry.base64, 'base64');
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) throw new Error('Backup checksum mismatch');
    if (entry.name.endsWith('.json')) JSON.parse(bytes.toString('utf8'));
  }
  const state = snapshot.files.find(file => file.name === 'state.sqlite');
  if (!state) throw new Error('Missing SQLite snapshot');
  validateDatabase(Buffer.from(state.base64, 'base64'), snapshot.tables);
  return snapshot;
}
export function encryptSnapshot(snapshot, password) {
  if (typeof password !== 'string' || password.length < 16) throw new Error('备份加密口令至少需要16个字符；未配置时不生成完整备份。');
  verifySnapshot(snapshot);
  const salt = randomBytes(16), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(password, salt, 32), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(snapshot)), cipher.final()]);
  return Buffer.from(JSON.stringify({ format: 'nkustudy-encrypted-v2', kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
}
export function decryptSnapshot(bytes, password) {
  const value = JSON.parse(bytes);
  if (value.format !== 'nkustudy-encrypted-v2' || value.kdf !== 'scrypt') throw new Error('Unsupported encrypted backup');
  const decipher = createDecipheriv('aes-256-gcm', scryptSync(password, Buffer.from(value.salt, 'base64'), 32), Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return verifySnapshot(JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()])));
}
export function pruneEncryptedBackups({ directory, password, now = Date.now(), keepDays = 400 }) {
  if (keepDays < 400) throw new Error('S2 backup retention cannot be shortened before the retention decision');
  let removed = 0;
  for (const name of fs.readdirSync(directory).filter(name => /^runtime-.*\.json\.enc$/.test(name))) {
    const file = path.join(directory, name);
    if (!fs.lstatSync(file).isFile()) throw new Error('Unsafe backup archive');
    const snapshot = decryptSnapshot(fs.readFileSync(file), password);
    const created = Date.parse(snapshot.createdAt);
    if (!Number.isFinite(created)) throw new Error('Invalid backup timestamp');
    if (created < now - keepDays * 86400000) { fs.unlinkSync(file); syncDir(directory); removed++; }
  }
  return removed;
}

export function saveEncryptedBackup({ snapshot, password, directory, fault }) {
  privateDir(directory);
  const bytes = encryptSnapshot(snapshot, password);
  const file = path.join(directory, `runtime-${snapshot.createdAt.replaceAll(':', '-')}-${randomBytes(4).toString('hex')}.json.enc`);
  durableWrite(file, bytes, fault);
  decryptSnapshot(fs.readFileSync(file), password);
  return { file, bytes, sha256: digest(bytes), complete: true };
}

// Recovery never overwrites a live data directory. Restored credentials/sessions
// cannot go live until the operator reconciles post-snapshot account changes.
export function restoreSnapshot({ snapshot, destination, fault = () => {} }) {
  verifySnapshot(snapshot);
  if (fs.existsSync(destination)) throw new Error('Restore destination must not exist');
  privateDir(destination);
  durableWrite(path.join(destination, '.restore-quarantine'), 'Offline recovery only. Reconcile post-snapshot deletions/account status before production activation.\n');
  try {
    for (const entry of snapshot.files) { fault('beforeFile'); durableWrite(path.join(destination, entry.name), Buffer.from(entry.base64, 'base64')); }
    const db = new Database(path.join(destination, 'state.sqlite'));
    try {
      db.pragma('journal_mode = DELETE');
      const tables = new Set(Object.keys(snapshot.tables));
      for (const table of ['admin_sessions', 'mp_auth_tokens', 'web_login_tickets']) if (tables.has(table)) db.exec(`DELETE FROM ${table}`);
      if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Restored SQLite failed integrity check');
    } finally { db.close(); }
    // Both common DATA_DIR layouts fail closed until deliberate reconciliation.
    if (fs.existsSync(path.join(destination, 'data'))) durableWrite(path.join(destination, 'data', '.restore-quarantine'), 'Recovery reconciliation required\n');
    const result = { restored: true, quarantined: true, files: snapshot.files.length, originalTables: snapshot.tables, sessionsRevoked: true };
    durableWrite(path.join(destination, 'restore-result.json'), JSON.stringify(result, null, 2));
    syncDir(destination);
    return result;
  } catch (error) { throw Object.assign(error, { restoreIncomplete: true }); }
}

export async function verifiedUpload(bytes, { put, get }) {
  await put(bytes);
  const received = await get();
  if (!Buffer.isBuffer(received) || digest(received) !== digest(bytes)) throw new Error('Remote backup readback checksum mismatch');
  return { verified: true, sha256: digest(bytes) };
}
