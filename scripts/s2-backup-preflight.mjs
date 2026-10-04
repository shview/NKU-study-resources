import { backupPreflight } from '../server/backup-preflight.mjs';

const args = process.argv.slice(2);
function failedReport(id, code) {
  return {
    schema: 'nkustudy-backup-preflight-v1', readOnly: true, ok: false, localReady: false,
    remoteEnabled: false, remoteConfigured: false, remoteVerified: false,
    restoreVerified: false, notificationsVerified: false, s2Accepted: false,
    checks: [{ id, status: 'fail', code }],
  };
}
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: node scripts/s2-backup-preflight.mjs\nRun as the service account with its existing environment. DATA_DIR, STATE_DB_PATH and ADMIN_SECRET_FILE must be explicit absolute paths. BACKUP_SECRET_FILE defaults to DATA_DIR/backup-secrets.json. BACKUP_ENV_FILE, BACKUP_CADDY_FILE and BACKUP_SERVICE_FILE must identify the actual production files when defaults differ. No passwords or tokens belong in command arguments.\nExit 0: static checks passed for local storage and enabled destinations; 1: failed or unverifiable checks; 2: invalid arguments. This does not verify R2 privacy/access, an actual backup/restore or notification delivery. Disabled remote storage is not full S2 acceptance.');
} else if (args.length) {
  console.log(JSON.stringify(failedReport('cli.arguments', 'UNSUPPORTED_ARGUMENTS')));
  process.exitCode = 2;
} else {
  try {
    const report = backupPreflight();
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch {
    // Never serialize exception messages: filesystem and parser errors can
    // contain paths or pieces of private configuration.
    console.log(JSON.stringify(failedReport('cli.internal', 'PREFLIGHT_UNAVAILABLE')));
    process.exitCode = 1;
  }
}
