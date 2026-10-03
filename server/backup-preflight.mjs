// Static, read-only checks. This module deliberately imports no server, database
// or network client: running it cannot start the site, capture or upload a backup.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const releaseRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeJsonFiles = [
  'manifest.json', 'about.json', 'home.json', 'participate.json', 'links.json',
  'footer.json', 'reviews.json', 'feedback.json', 'visit-stats.json', 'editor-settings.json',
];
const sensitiveKey = /password|passphrase|secret|token|credential|access.?key|api.?key/i;
const failureCodes = new Set([
  'PATH_REQUIRED', 'PATH_NOT_ABSOLUTE', 'PATH_INSIDE_RELEASE', 'PATH_MISSING',
  'SYMLINK_REFUSED', 'UNSAFE_PARENT', 'PRIVATE_PERMISSIONS_REQUIRED',
  'WRITABLE_CONFIGURATION_REFUSED', 'REGULAR_FILE_REQUIRED', 'DIRECTORY_REQUIRED',
  'UNREADABLE_OR_UNSAFE', 'INVALID_JSON', 'JSON_OBJECT_REQUIRED', 'FILE_CHANGED',
  'SENTINEL_INVALID', 'RESTORE_QUARANTINE_PRESENT', 'PASSWORD_NOT_CONFIGURED',
  'ADMIN_SECRET_INVALID', 'LEGACY_SECRET_COPY_PRESENT', 'SETTINGS_INVALID',
  'R2_CREDENTIALS_INCOMPLETE', 'R2_ACCOUNT_INVALID', 'R2_BUCKET_NOT_SEPARATE',
  'R2_PRIVATE_CONFIRMATION_MISSING', 'WEBDAV_DESTINATION_MISSING',
  'WEBDAV_DESTINATION_INVALID', 'WEBDAV_CREDENTIALS_INCOMPLETE',
  'COURSE_SOURCE_INCOMPLETE',
]);
function refuse(code) { throw Object.assign(new Error('Static backup preflight failed'), { preflightCode: code }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function configuredPath(value, { outsideRelease = false } = {}) {
  if (typeof value !== 'string' || !value) refuse('PATH_REQUIRED');
  if (!path.isAbsolute(value) || value.includes('\0')) refuse('PATH_NOT_ABSOLUTE');
  const resolved = path.resolve(value);
  if (outsideRelease && within(releaseRoot, resolved)) refuse('PATH_INSIDE_RELEASE');
  return resolved;
}

// Check every component, including parents of an explicitly external secret.
// Sticky shared temporary directories are safe ancestors of private test roots.
function inspectPath(file, { privateMode = true, directory = false, platform } = {}) {
  const root = path.parse(file).root;
  const parts = file.slice(root.length).split(path.sep).filter(Boolean);
  let current = root, stat = fs.lstatSync(root);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) refuse('SYMLINK_REFUSED');
    const last = index === parts.length - 1;
    if (!last) {
      if (!stat.isDirectory()) refuse('DIRECTORY_REQUIRED');
      if (platform !== 'win32' && (stat.mode & 0o022) && !(stat.mode & 0o1000)) refuse('UNSAFE_PARENT');
    }
  }
  if (directory ? !stat.isDirectory() : !stat.isFile()) refuse(directory ? 'DIRECTORY_REQUIRED' : 'REGULAR_FILE_REQUIRED');
  if (platform !== 'win32') {
    if (privateMode && (stat.mode & 0o077)) refuse('PRIVATE_PERMISSIONS_REQUIRED');
    if (!privateMode && (stat.mode & 0o022)) refuse('WRITABLE_CONFIGURATION_REFUSED');
  }
  return stat;
}

function directory(file, platform, { writable = false } = {}) {
  inspectPath(file, { directory: true, platform });
  fs.accessSync(file, fs.constants.R_OK | fs.constants.X_OK | (writable ? fs.constants.W_OK : 0));
}

function readFile(file, platform, { privateMode = true, json = false, jsonObject = false, content = true } = {}) {
  const before = inspectPath(file, { privateMode, platform });
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.mode !== before.mode) refuse('FILE_CHANGED');
    if (!content) return;
    const text = fs.readFileSync(descriptor, 'utf8');
    if (!json) return text;
    let value;
    try { value = JSON.parse(text); } catch { refuse('INVALID_JSON'); }
    if (jsonObject && !object(value)) refuse('JSON_OBJECT_REQUIRED');
    return value;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function absent(file) {
  try { fs.lstatSync(file); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

function hasSecretCopy(value, secrets) {
  if (typeof value === 'string') return secrets.some(secret => value === secret || (secret.length >= 16 && value.includes(secret)));
  if (Array.isArray(value)) return value.some(item => hasSecretCopy(item, secrets));
  if (!object(value)) return false;
  return Object.entries(value).some(([key, item]) => sensitiveKey.test(key) || hasSecretCopy(item, secrets));
}

function r2Configuration(env) {
  const bucket = typeof env.BACKUP_R2_BUCKET === 'string' ? env.BACKUP_R2_BUCKET.trim() : '';
  if (!bucket || bucket === String(env.R2_BUCKET || '').trim()) refuse('R2_BUCKET_NOT_SEPARATE');
  if (env.BACKUP_R2_PRIVATE_CONFIRMED !== '1') refuse('R2_PRIVATE_CONFIRMATION_MISSING');
  if (['BACKUP_R2_ACCOUNT_ID', 'BACKUP_R2_ACCESS_KEY_ID', 'BACKUP_R2_SECRET_ACCESS_KEY']
    .some(key => typeof env[key] !== 'string' || !env[key].trim())) refuse('R2_CREDENTIALS_INCOMPLETE');
  if (!/^[a-f0-9]{32}$/i.test(env.BACKUP_R2_ACCOUNT_ID.trim())) refuse('R2_ACCOUNT_INVALID');
}

function webdavConfiguration(settings, secrets, env) {
  const destinations = (settings.destinations || []).filter(destination => destination.enabled !== false && destination.url);
  if (!destinations.length) refuse('WEBDAV_DESTINATION_MISSING');
  for (const destination of destinations) {
    let url;
    try { url = new URL(destination.url); } catch { refuse('WEBDAV_DESTINATION_INVALID'); }
    // Production destinations must not transport Basic credentials over HTTP or
    // store them inline in an ordinary setting URL.
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) refuse('WEBDAV_DESTINATION_INVALID');
    if (destination.username && (typeof secrets?.webdav?.[destination.id]?.password !== 'string' || !secrets.webdav[destination.id].password)) refuse('WEBDAV_CREDENTIALS_INCOMPLETE');
  }
  if (settings.includeCourseFiles !== false && ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']
    .some(key => typeof env[key] !== 'string' || !env[key].trim())) refuse('COURSE_SOURCE_INCOMPLETE');
}

export function backupPreflight({ env = process.env, platform = process.platform } = {}) {
  const checks = [];
  const local = [];
  function check(id, operation, { required = true, success = 'CHECK_PASSED', skip = false } = {}) {
    if (skip) { checks.push({ id, status: 'skip', code: 'DEPENDENCY_UNAVAILABLE' }); if (required) local.push(false); return; }
    try {
      const value = operation();
      checks.push({ id, status: 'pass', code: success });
      if (required) local.push(true);
      return value;
    } catch (error) {
      const code = failureCodes.has(error?.preflightCode) ? error.preflightCode : error?.code === 'ENOENT' ? 'PATH_MISSING' : 'UNREADABLE_OR_UNSAFE';
      checks.push({ id, status: 'fail', code });
      if (required) local.push(false);
    }
  }
  checks.push({ id: 'permissions.platform', status: platform === 'win32' ? 'unknown' : 'pass', code: platform === 'win32' ? 'WINDOWS_ACL_UNVERIFIED' : 'POSIX_MODE_CHECKED' });
  local.push(platform !== 'win32');
  const dataDir = check('data.directory', () => {
    const file = configuredPath(env.DATA_DIR, { outsideRelease: true });
    directory(file, platform, { writable: true });
    return file;
  });
  check('data.sentinel', () => {
    if (readFile(path.join(dataDir, '.nkustudy-data-root'), platform).trim() !== 'NKUSTUDY_RUNTIME_DATA_V1') refuse('SENTINEL_INVALID');
  }, { skip: !dataDir });
  check('data.runtime_json', () => {
    for (const name of runtimeJsonFiles) readFile(path.join(dataDir, name), platform, { json: true });
  }, { skip: !dataDir });
  check('data.local_backup_directory', () => {
    const file = path.join(dataDir, 'private-backups');
    if (!absent(file)) directory(file, platform, { writable: true });
  }, { skip: !dataDir, success: 'LOCAL_STORAGE_LOCATION_CHECKED' });
  const settings = check('backup.settings_file', () => readFile(path.join(dataDir, 'backup-settings.json'), platform, { json: true, jsonObject: true }), { skip: !dataDir });
  const secrets = check('backup.secret_file', () => {
    const file = configuredPath(env.BACKUP_SECRET_FILE || (dataDir && path.join(dataDir, 'backup-secrets.json')), { outsideRelease: true });
    directory(path.dirname(file), platform);
    return readFile(file, platform, { json: true, jsonObject: true });
  });
  check('backup.encryption_password', () => {
    if (typeof secrets.encryptionPassword !== 'string' || secrets.encryptionPassword.length < 16) refuse('PASSWORD_NOT_CONFIGURED');
  }, { skip: !secrets, success: 'MINIMUM_PASSWORD_LENGTH_MET' });
  check('backup.settings_no_secrets', () => {
    const sensitiveValues = [secrets?.encryptionPassword, ...Object.values(object(secrets?.webdav) ? secrets.webdav : {}).map(item => item?.password),
      env.BACKUP_R2_SECRET_ACCESS_KEY, env.R2_SECRET_ACCESS_KEY].filter(value => typeof value === 'string' && value);
    if (hasSecretCopy(settings, sensitiveValues)) refuse('LEGACY_SECRET_COPY_PRESENT');
    for (const destination of Array.isArray(settings.destinations) ? settings.destinations : []) {
      let url;
      try { url = new URL(destination?.url); } catch { continue; }
      if (url.username || url.password) refuse('LEGACY_SECRET_COPY_PRESENT');
    }
  }, { skip: !settings });
  const stateFile = check('snapshot.state_database', () => {
    const file = configuredPath(env.STATE_DB_PATH, { outsideRelease: true });
    directory(path.dirname(file), platform);
    readFile(file, platform, { content: false });
    return file;
  });
  check('data.quarantine', () => {
    if (!absent(path.join(dataDir, '.restore-quarantine')) || !absent(path.join(path.dirname(stateFile), '.restore-quarantine'))) refuse('RESTORE_QUARANTINE_PRESENT');
  }, { skip: !dataDir || !stateFile, success: 'NO_RESTORE_QUARANTINE_MARKER' });
  check('snapshot.admin_secret', () => {
    const file = configuredPath(env.ADMIN_SECRET_FILE, { outsideRelease: true });
    if (readFile(file, platform).trim().length < 32) refuse('ADMIN_SECRET_INVALID');
  });
  for (const [id, field, fallback, privateMode] of [
    ['snapshot.environment', 'BACKUP_ENV_FILE', '/etc/nkustudy/admin.env', true],
    ['snapshot.caddy', 'BACKUP_CADDY_FILE', '/etc/caddy/Caddyfile', false],
    ['snapshot.service', 'BACKUP_SERVICE_FILE', '/etc/systemd/system/nkustudy-admin.service', false],
  ]) check(id, () => readFile(configuredPath(env[field] || fallback), platform, { privateMode, content: false }));

  const selection = check('destination.selection', () => {
    for (const key of ['r2DataBackup', 'webdavEnabled', 'includeCourseFiles']) {
      if (Object.hasOwn(settings, key) && typeof settings[key] !== 'boolean') refuse('SETTINGS_INVALID');
    }
    if (Object.hasOwn(settings, 'destinations') && (!Array.isArray(settings.destinations) || settings.destinations.some(item => !object(item)))) refuse('SETTINGS_INVALID');
    return { r2: settings.r2DataBackup ?? true, webdav: settings.webdavEnabled ?? false };
  }, { skip: !settings });
  const enabled = Boolean(selection && (selection.r2 || selection.webdav));
  const remote = [];
  for (const [id, selected, operation] of [
    ['destination.r2', selection?.r2, () => r2Configuration(env)],
    ['destination.webdav', selection?.webdav, () => webdavConfiguration(settings, secrets, env)],
  ]) {
    if (selected) {
      check(id, operation, { required: false, success: 'STATIC_CONFIGURATION_ONLY' });
      remote.push(checks.at(-1).status === 'pass');
    } else checks.push({ id, status: 'skip', code: selection ? 'DESTINATION_DISABLED' : 'DEPENDENCY_UNAVAILABLE' });
  }
  const localReady = local.every(Boolean);
  const remoteConfigured = enabled && remote.every(Boolean);
  return {
    schema: 'nkustudy-backup-preflight-v1', readOnly: true,
    ok: localReady && (!enabled || remoteConfigured), localReady,
    remoteEnabled: enabled, remoteConfigured, remoteVerified: false,
    restoreVerified: false, notificationsVerified: false, s2Accepted: false,
    limitations: ['CURRENT_PROCESS_STATIC_CONFIGURATION_ONLY', 'NO_SQLITE_INTEGRITY_OR_SNAPSHOT_CAPTURE', 'NO_REMOTE_ACCESS_OR_PRIVACY_VERIFICATION', 'NO_RESTORE_OR_NOTIFICATION_TEST'],
    checks,
  };
}
