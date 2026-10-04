import fs from 'node:fs';
import path from 'node:path';
import { decryptSnapshot, restoreSnapshot, pruneEncryptedBackups } from '../server/runtime-backup.mjs';

const [command, source, destination] = process.argv.slice(2);
try {
  if (!['verify', 'restore', 'prune'].includes(command) || !source || (command === 'restore' && !destination)) throw new Error('Usage: BACKUP_PASSWORD_FILE=/private/key node scripts/runtime-backup.mjs verify <file> | restore <file> <NEW-EMPTY-DIRECTORY> | prune <PRIVATE-BACKUP-DIR>');
  const keyFile = process.env.BACKUP_PASSWORD_FILE;
  if (!keyFile) throw new Error('BACKUP_PASSWORD_FILE is required; never put the passphrase in command arguments');
  const stat = fs.lstatSync(keyFile);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Password file must be a private 0600 regular file');
  const password = fs.readFileSync(keyFile, 'utf8').replace(/\r?\n$/, '');
  if (command === 'prune') {
    console.log(JSON.stringify({ removed: pruneEncryptedBackups({ directory: path.resolve(source), password }) }));
    process.exit(0);
  }
  const snapshot = decryptSnapshot(fs.readFileSync(source), password);
  const result = command === 'restore' ? restoreSnapshot({ snapshot, destination: path.resolve(destination) }) : { verified: true, createdAt: snapshot.createdAt, files: snapshot.files.length, tables: snapshot.tables };
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(`Backup verification/recovery failed: ${error.message}`); process.exitCode = 1; }
