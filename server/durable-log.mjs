import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function syncDir(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function privateDir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe private directory');
  fs.chmodSync(directory, 0o700);
}
export function durableWrite(file, bytes, fault = () => {}) {
  const directory = path.dirname(file);
  privateDir(directory);
  if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw new Error('Unsafe output file');
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fault('beforeRename');
    fs.renameSync(temporary, file);
    syncDir(directory);
    fault('afterRename');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
export function readEnvelope(file, kind) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe log artifact');
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (envelope.version !== 1 || envelope.kind !== kind || digest(JSON.stringify(envelope.payload)) !== envelope.sha256) throw new Error('Log artifact checksum mismatch');
  return envelope.payload;
}
export function writeEnvelope(file, kind, payload, fault) {
  durableWrite(file, JSON.stringify({ version: 1, kind, sha256: digest(JSON.stringify(payload)), payload }), fault);
  return readEnvelope(file, kind);
}

// Admission is durable before business work. A crash leaves an explicit interrupted
// intent; a completed outcome is replayable with the same event_id, never duplicated.
export class DurableLog {
  constructor({ directory, kind, insert, fault = () => {}, alert = (state) => console.error(JSON.stringify({ component: 'durable-log', ...state })) }) {
    Object.assign(this, { directory, kind, insert, fault, alert });
    this.inFlight = new Set(); this.lastError = null; this.maintenanceError = null;
    privateDir(directory);
    this.replay();
  }
  fail(error, phase) {
    this.lastError = { phase, code: /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'LOG_IO_FAILED', at: Date.now() };
    if (["archive", "maintenance"].includes(phase)) this.maintenanceError = this.lastError;
    this.alert({ kind: this.kind, ...this.lastError });
  }
  file(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid log event id');
    return path.join(this.directory, `${id}.json`);
  }
  begin(row) {
    const id = randomUUID();
    try {
      writeEnvelope(this.file(id), this.kind, { id, row, pending: true }, this.fault);
      this.inFlight.add(id);
      return id;
    } catch (error) { this.fail(error, 'admission'); throw Object.assign(new Error('日志存储不可用，请稍后重试。'), { statusCode: 503, code: 'LOG_UNAVAILABLE' }); }
  }
  write(row, id = randomUUID()) {
    try {
      writeEnvelope(this.file(id), this.kind, { id, row, pending: false }, this.fault);
    } catch (error) {
      this.inFlight.delete(id); this.fail(error, 'outcome');
      throw Object.assign(new Error('日志结果保存失败；操作状态需核对，请勿重复提交。'), { statusCode: 503, code: 'LOG_OUTCOME_UNKNOWN' });
    }
    this.inFlight.delete(id);
    try { this.deliver(this.file(id)); this.lastError = null; }
    catch (error) { this.fail(error, 'queued'); }
    return true; // Either SQLite FULL commit, or fsynced replay queue.
  }
  deliver(file) {
    const entry = readEnvelope(file, this.kind);
    if (path.basename(file) !== `${entry.id}.json`) throw new Error('Invalid log filename');
    this.fault('beforeInsert');
    this.insert(entry.row, entry.id, entry.pending);
    this.fault('afterInsert');
    fs.unlinkSync(file); syncDir(this.directory);
  }
  replay() {
    let failed = false;
    try {
      for (const name of fs.readdirSync(this.directory).sort()) {
        if (!name.endsWith('.json') || this.inFlight.has(name.slice(0, -5))) continue;
        try { this.deliver(path.join(this.directory, name)); }
        catch (error) { failed = true; this.fail(error, 'replay'); }
      }
      if (!failed) this.lastError = null;
    } catch (error) { this.fail(error, 'queue-read'); }
    return this.health();
  }
  health() {
    try {
      const pending = fs.readdirSync(this.directory).filter((name) => name.endsWith('.json')).length - this.inFlight.size;
      return { ok: pending === 0 && !this.lastError && !this.maintenanceError, pending, inFlight: this.inFlight.size, error: this.lastError, maintenanceError: this.maintenanceError };
    } catch (error) { this.fail(error, 'queue-read'); return { ok: false, pending: null, error: this.lastError }; }
  }
}

export function ensureEventId(db, table) {
  if (!db.pragma(`table_info(${table})`).some((column) => column.name === 'event_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN event_id TEXT`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_event_idx ON ${table}(event_id)`);
  db.pragma('synchronous = FULL');
  for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(db.name + suffix)) fs.chmodSync(db.name + suffix, 0o600);
}

export function archiveRows({ db, table, directory, keepRows, threshold, fault = () => {} }) {
  if (!directory) return null; // No destination means no deletion, even above the row cap.
  const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  if (count < threshold) return null;
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id ASC LIMIT ?`).all(count - keepRows);
  if (!rows.length) return null;
  const file = path.join(directory, `${table}-${rows[0].id}-${rows.at(-1).id}.json`);
  // Keep top-level rows for compatibility with existing archive consumers.
  const payload = { rows, first: rows[0].id, last: rows.at(-1).id };
  const envelope = { version: 1, kind: table, payload, sha256: digest(JSON.stringify(payload)), rows };
  durableWrite(file, JSON.stringify(envelope), fault);
  const verified = readEnvelope(file, table);
  if (JSON.stringify(verified.rows) !== JSON.stringify(rows)) throw new Error('Archive readback differs');
  fault('beforeDelete');
  db.prepare(`DELETE FROM ${table} WHERE id <= ?`).run(rows.at(-1).id);
  return file;
}

export function archivedRows(directory, table) {
  if (!directory || !fs.existsSync(directory)) return [];
  const rows = [];
  for (const name of fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort()) {
    const file = path.join(directory, name);
    if (name.startsWith(`${table}-`)) rows.push(...readEnvelope(file, table).rows);
    // Old admin archives had no checksum. Preserve and read them; never silently delete.
    else if (table === 'admin_audit_log' && /^audit-\d+-\d+-\d+\.json$/.test(name)) {
      const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(legacy.rows)) throw new Error('Invalid legacy audit archive');
      rows.push(...legacy.rows);
    }
  }
  return rows;
}

export function pruneArchives(directory, table, cutoff) {
  if (!directory || !fs.existsSync(directory)) return;
  for (const name of fs.readdirSync(directory).filter((name) => name.startsWith(`${table}-`) && name.endsWith('.json'))) {
    const file = path.join(directory, name);
    const rows = readEnvelope(file, table).rows;
    // Mixed files retain every row until their newest event has expired. No count cap.
    if (rows.length && rows.every((row) => row.at < cutoff)) { fs.unlinkSync(file); syncDir(directory); }
  }
}
