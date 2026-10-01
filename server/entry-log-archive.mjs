import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { digest, durableWrite, privateDir, syncDir } from './durable-log.mjs';

// Copies only closed Caddy rotations; the active access.jsonl is never truncated.
// Retention is based on the newest record, not number of files or archive capacity.
export function archiveEntryLogs({ sourceDir, destination, now = Date.now(), keepDays = 400, fault = () => {} }) {
  if (keepDays < 400) throw new Error('This S2 configuration must not shorten the configured 400-day retention');
  if (path.resolve(sourceDir) === path.resolve(destination)) throw new Error('Archive destination must differ from source');
  privateDir(destination);
  const result = { verified: 0, expired: 0, bytes: 0 };
  const cutoff = now - keepDays * 86400000;
  for (const name of fs.readdirSync(sourceDir).sort()) {
    if (!/^access-\d{4}-\d{2}-\d{2}T[\d:.-]+(?:-(?:size|time))?\.(?:jsonl|log)(?:\.gz)?$/.test(name)) continue;
    const source = path.join(sourceDir, name);
    if (!fs.lstatSync(source).isFile()) throw new Error('Entry log must be a regular file');
    const bytes = fs.readFileSync(source);
    const text = (name.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8');
    const lines = text.trim().split('\n').filter(Boolean).map(JSON.parse);
    if (!lines.length || lines.some(row => !Number.isFinite(row.ts))) throw new Error('Invalid entry log timestamps');
    const latest = lines.reduce((latest, row) => Math.max(latest, row.ts * 1000), 0);
    const target = path.join(destination, name);
    durableWrite(target, bytes, fault);
    if (digest(fs.readFileSync(target)) !== digest(bytes)) throw new Error('Entry archive readback mismatch');
    durableWrite(`${target}.receipt.json`, JSON.stringify({ name, sha256: digest(bytes), rows: lines.length, latest, verifiedAt: now }));
    result.verified++; result.bytes += bytes.length;
    if (latest < cutoff) {
      // Source and archive copies expire together only after verified readback.
      fault('beforeExpire'); fs.unlinkSync(source); syncDir(sourceDir);
      fs.unlinkSync(target); fs.unlinkSync(`${target}.receipt.json`); syncDir(destination); result.expired++;
    }
  }
  // A Caddy rotation may already have aged out locally. Receipts keep private
  // copies recoverable and allow only age-based cleanup, never a file-count cap.
  for (const name of fs.readdirSync(destination).filter(name => name.endsWith('.receipt.json'))) {
    const receipt = JSON.parse(fs.readFileSync(path.join(destination, name), 'utf8'));
    if (receipt.latest >= cutoff) continue;
    if (path.basename(receipt.name) !== receipt.name) throw new Error('Invalid archive receipt');
    const target = path.join(destination, receipt.name);
    if (digest(fs.readFileSync(target)) !== receipt.sha256) throw new Error('Archived entry log checksum mismatch');
    fs.unlinkSync(target); fs.unlinkSync(path.join(destination, name)); syncDir(destination); result.expired++;
  }
  return result;
}
