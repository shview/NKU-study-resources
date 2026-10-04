import { archiveEntryLogs } from '../server/entry-log-archive.mjs';
try {
  const [sourceDir, destination] = process.argv.slice(2);
  if (!sourceDir || !destination) throw new Error('Usage: node scripts/archive-entry-logs.mjs <CADDY-LOG-DIR> <PRIVATE-ARCHIVE-DIR>');
  console.log(JSON.stringify(archiveEntryLogs({ sourceDir, destination })));
} catch (error) { console.error(`Entry log archive FAILED: ${error.code || error.message}`); process.exitCode = 1; }
