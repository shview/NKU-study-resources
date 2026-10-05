# Deployment safety

This repository is a source candidate, not authorization to deploy. Production data and secrets remain outside every release. Website administration is the only content-management surface; future `/api/v1` routes are public/user-facing only.

## Production fail-closed contract

Set all of these explicitly to absolute paths outside the release tree:

```ini
NODE_ENV=production
DATA_DIR=/var/lib/nkustudy/json
STATE_DB_PATH=/var/lib/nkustudy/miniprogram.sqlite
ADMIN_SECRET_FILE=/var/lib/nkustudy/admin-secret
ADMIN_ORIGIN=https://nkustudy.top
TRUSTED_PROXIES=127.0.0.1/32,::1/128
PUBLIC_RESOURCE_ORIGIN=https://resources.nkustudy.top
PUBLIC_GUIDE_CORRECTION_URL=https://nkustudy.top/feedback
PUBLIC_DIR=/var/www/nkustudy-publish/current
PUBLIC_RELEASES_DIR=/var/www/nkustudy-publish/releases
```

Before startup, create `/var/lib/nkustudy` and `${DATA_DIR}` as mode `0700`, create `${DATA_DIR}/.nkustudy-data-root` containing exactly `NKUSTUDY_RUNTIME_DATA_V1`, and install all core JSON files. Use `STATE_DB_PATH=/var/lib/nkustudy/miniprogram.sqlite` and `ADMIN_SECRET_FILE=/var/lib/nkustudy/admin-secret`; all data, database and secret files are mode `0600`. `ADMIN_SECRET_FILE` must already exist and contain at least 32 random characters. Production startup validates the sentinel, core JSON, paths, symlinks, permissions, secret and trusted proxy configuration before SQLite or mutable JSON is created.

Administrator sessions are opaque random tokens whose HMAC hashes, absolute expiry and last-use time are stored in `STATE_DB_PATH`. The defaults are a 30-minute idle timeout and an 8-hour absolute timeout; logout revokes the session in SQLite. Every non-GET `/admin-api/*` request must come from the exact `ADMIN_ORIGIN`, carry `X-NKUStudy-Admin-Request: 1`, and use the expected JSON or multipart content type. Keep `ADMIN_ORIGIN` canonical and redirect alternate hostnames to it.

## Reverse-proxy and host baseline

The public Node listener stays on `127.0.0.1:8787`. Caddy is the only public HTTP entry point. Install `ops/Caddyfile.s2-security-headers` and `ops/Caddyfile.s2-log-snippet` as service-readable snippets at the paths below (or adjust the imports to their actual locations). Apply the baseline and redacted access logging to every public site block, including OpenList and redirects. Keep existing upstream, TLS, route and application-specific header settings; do not expose the static site on the raw server IP:

```caddyfile
import /etc/caddy/snippets/nkustudy-s2-headers
import /etc/caddy/snippets/nkustudy-s2-logs

www.nkustudy.top {
  import s2_security_headers
  import s2_access_log
  redir https://nkustudy.top{uri} permanent
}

nkustudy.top {
  import s2_security_headers
  import s2_access_log
  header {
    X-Frame-Options "DENY"
    Content-Security-Policy "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'"
  }
  # Existing API handlers and static root follow here.
}

pan.nkustudy.top {
  import s2_security_headers
  import s2_access_log
  # Retain the EXISTING OpenList reverse_proxy and all of its route settings here.
  # This is an integration example, not a complete replacement site block.
}

http://8.217.248.245 {
  respond 404
}
```

The shared logger retains `request.host`, so main, www and pan requests can be distinguished in the same private archive. Each site's query string and request/response headers are removed; only User-Agent is explicitly retained. Use the existing S2 archive timer for this shared log. Do not blindly apply the main site's CSP or frame restrictions to OpenList: verify its document/media previews first. Caddy's `rate_limit` is a non-standard module, so adding that directive to a stock binary is not a safe configuration-only change; retain Node's existing limits and plan any edge module separately.

Do not leave a second unfiltered `log { output stdout; format json }` access logger alongside `import s2_access_log`. Caddy sends each request to both loggers: the S2 file is redacted, but the other logger still includes query parameters, custom request headers and redirect response headers in journal output. Remove only that redundant site-level access-log block from main/www, keeping the S2 import and Caddy's normal process/runtime logging. If a separate access-log destination is required, apply the same filter to that destination as well. Do not delete historical logs as part of this configuration change.

Maintainer update received 2026-10-03 (the supplied receipt is dated 2026-10-02): pan and www now have baseline headers and the S2 import; independent public GET checks returned 200/301 with those headers. The supplied main/www configuration also contained the extra stdout access logger described above. Its disclosure was reproduced locally with synthetic values; removal and production readback remain pending. The receipt's archive and service-health statements are operator evidence, not an independent server inspection. Keep existing `includeSubDomains`, CSP and frame policy unless a separate reviewed change is needed.

Run `CADDY_BIN=/path/to/caddy node scripts/verify-s2-entry-log.mjs` locally before handing off. This exercises main, redirect and simulated OpenList responses, including downloads and errors; it does not attest to the production configuration. After the operator applies the imports, check real GET responses and read back one synthetic log entry per hostname, with a synthetic query/header secret, to confirm redaction and archive coverage. Follow the service-identity validation procedure in [S2 server acceptance](compliance/S2_SERVER_ACCEPTANCE.md); root validation can create root-owned log files and prevent startup.

Validate the Caddy configuration before reloading it. The host firewall should expose only 22, 80 and 443; use a rate-limited SSH rule and remove unused public ports. Do not disable password authentication or root login until a tested non-root sudo account and at least two working administrator public keys exist.

## Text-encoding integrity

All JSON transport is decoded as strict UTF-8. Public write requests containing the Unicode replacement character `U+FFFD` are rejected, and runtime-data migration rejects both malformed UTF-8 and existing replacement characters. Run `DATA_DIR=/var/lib/nkustudy/json npm run audit:encoding` before deployment and after bulk import. If it reports a finding, restore the exact field from a verified earlier source or ask the content owner; never guess the missing character or add a display-time substitution rule.

`PUBLIC_DIR` must be the `current` symlink beside `PUBLIC_RELEASES_DIR` in one service-owned publish directory. Publishing builds a fresh versioned directory and switches that inner symlink with a same-filesystem rename; it never deletes the live tree in place. A root-owned stable symlink keeps Caddy outside that writable boundary:

```text
/var/www/nkustudy-current -> /var/www/nkustudy-publish/current
/var/www/nkustudy-publish/                 nkustudy:nkustudy 0755
/var/www/nkustudy-publish/current           managed symlink
/var/www/nkustudy-publish/releases/         nkustudy:nkustudy 0755
```

Create the outer symlink once as root. The service account owns only `nkustudy-publish`, not `/var/www`. Seed `releases/` with the currently active static tree and point the inner `current` symlink at that seed before restarting the service. New published directories and files are explicitly normalized to `0755` and `0644`, so Caddy can read them even though the service uses `UMask=0077`. The publisher keeps the active release plus a bounded rollback history; it removes only strictly named managed releases and startup residue.

## One-time static topology migration

Run this in a maintenance window as root. Review every resolved path before copying or replacing links. The example uses the production environment file currently installed at `/etc/nkustudy-admin.env`; adjust the filename consistently if the unit uses a different one.

The command blocks below assume one continuous root shell: `deploy_stamp`, `backup_dir`, and later `candidate` are deliberately reused. If the shell is interrupted, do not guess them. Before each later block, set `backup_dir` to the exact reviewed backup directory, then run `deploy_stamp="$(cat "$backup_dir/deploy-stamp")"`; set `candidate="$(cat "$backup_dir/application-candidate")"` only after step 4 has created that file.

1. Stop writes, resolve the old target, verify space and device boundaries, and create root-only backups:

```bash
set -eu
systemctl stop nkustudy-admin.service
deploy_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="/root/nkustudy-backups/static-topology-${deploy_stamp}"
install -d -o root -g root -m 0700 "$backup_dir"
printf '%s\n' "$deploy_stamp" >"$backup_dir/deploy-stamp"

old_static_target="$(readlink -f /var/www/nkustudy-current)"
case "$old_static_target" in
  /var/www/.nkustudy-releases/release-*|/var/www/nkustudy-publish/releases/release-*) ;;
  *) echo "Unexpected active static target: $old_static_target" >&2; exit 1 ;;
esac
test -d "$old_static_target"
printf '%s\n' "$old_static_target" >"$backup_dir/old-static-target"
cp --preserve=mode,timestamps /etc/nkustudy-admin.env "$backup_dir/nkustudy-admin.env"
cp --preserve=mode,timestamps /etc/systemd/system/nkustudy-admin.service "$backup_dir/nkustudy-admin.service"
systemctl show --value -p WorkingDirectory nkustudy-admin.service >"$backup_dir/old-working-directory"
systemctl show --value -p ExecStart nkustudy-admin.service >"$backup_dir/old-exec-start"
if test -f /etc/systemd/system/nkustudy-admin.service.d/application-release.conf; then
  cp --preserve=mode,timestamps /etc/systemd/system/nkustudy-admin.service.d/application-release.conf "$backup_dir/application-release.conf"
else
  : >"$backup_dir/application-release.conf.absent"
fi
cp --preserve=mode,timestamps /var/lib/nkustudy/admin-secret "$backup_dir/admin-secret"
test ! -f /var/lib/nkustudy/backup-secrets.json || cp --preserve=mode,timestamps /var/lib/nkustudy/backup-secrets.json "$backup_dir/backup-secrets.json"
tar -C / -czf "$backup_dir/runtime-data.tar.gz" var/lib/nkustudy
tar -C / -czf "$backup_dir/static-release.tar.gz" "${old_static_target#/}"
chown -R root:root "$backup_dir"
find "$backup_dir" -type d -exec chmod 0700 {} +
find "$backup_dir" -type f -exec chmod 0600 {} +
(cd "$backup_dir" && find . -maxdepth 1 -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS)
chmod 0600 "$backup_dir/SHA256SUMS"

df -P /var/www /var/lib/nkustudy /opt/nkustudy-releases
test "$(stat -c %d /var/www)" = "$(stat -c %d /var/www/nkustudy-current)"
du -sh "$old_static_target" /var/lib/nkustudy
```

Stop if the backup fails, free space is insufficient, the active target is unexpected, or the link and its parent are on different devices. Copying `DATA_DIR` is a safety backup only; do not roll runtime data backward during an ordinary code/static rollback.

2. Seed the service-owned publish root without making `/var/www` writable:

```bash
set -eu
old_static_target="$(cat "$backup_dir/old-static-target")"
seed_release="$(basename "$old_static_target")"
printf '%s' "$seed_release" | grep -Eq '^release-[0-9]+-[a-f0-9]+$'

install -d -o nkustudy -g nkustudy -m 0755 /var/www/nkustudy-publish
install -d -o nkustudy -g nkustudy -m 0755 /var/www/nkustudy-publish/releases
test ! -e "/var/www/nkustudy-publish/releases/$seed_release"
cp -a --no-target-directory "$old_static_target" "/var/www/nkustudy-publish/releases/$seed_release"
chown -R nkustudy:nkustudy "/var/www/nkustudy-publish/releases/$seed_release"
find "/var/www/nkustudy-publish/releases/$seed_release" -type d -exec chmod 0755 {} +
find "/var/www/nkustudy-publish/releases/$seed_release" -type f -exec chmod 0644 {} +

runuser -u nkustudy -- ln -s "releases/$seed_release" /var/www/nkustudy-publish/current
ln -s /var/www/nkustudy-publish/current "/var/www/.nkustudy-current.next-$deploy_stamp"
mv -T "/var/www/.nkustudy-current.next-$deploy_stamp" /var/www/nkustudy-current

test "$(stat -c %U:%G /var/www/nkustudy-publish)" = "nkustudy:nkustudy"
test "$(stat -c %a /var/www/nkustudy-publish)" = "755"
test "$(readlink -f /var/www/nkustudy-current)" = "/var/www/nkustudy-publish/releases/$seed_release"
runuser -u nkustudy -- test -w /var/www/nkustudy-publish
! runuser -u nkustudy -- test -w /var/www
```

3. Update the environment file to the inner managed paths and install a systemd drop-in. `ReadWritePaths` must not contain `/var/www`:

```bash
set -eu
sed -i -E 's#^PUBLIC_DIR=.*#PUBLIC_DIR=/var/www/nkustudy-publish/current#' /etc/nkustudy-admin.env
sed -i -E 's#^PUBLIC_RELEASES_DIR=.*#PUBLIC_RELEASES_DIR=/var/www/nkustudy-publish/releases#' /etc/nkustudy-admin.env
grep -qx 'PUBLIC_DIR=/var/www/nkustudy-publish/current' /etc/nkustudy-admin.env
grep -qx 'PUBLIC_RELEASES_DIR=/var/www/nkustudy-publish/releases' /etc/nkustudy-admin.env

install -d -o root -g root -m 0755 /etc/systemd/system/nkustudy-admin.service.d
cat >/etc/systemd/system/nkustudy-admin.service.d/publish-paths.conf <<'EOF'
[Service]
ReadWritePaths=/var/lib/nkustudy /var/www/nkustudy-publish
EOF
chmod 0644 /etc/systemd/system/nkustudy-admin.service.d/publish-paths.conf
systemctl daemon-reload
systemctl cat nkustudy-admin.service
```

If either environment key is absent rather than replaced, stop and add it once; do not append duplicate keys blindly.

4. From the candidate code release, run checks, build, and one real static publish as `User=nkustudy` with the same environment file as the service:

```bash
candidate=/opt/nkustudy-releases/REVIEWED-CANDIDATE
test -d "$candidate"
printf '%s\n' "$candidate" >"$backup_dir/application-candidate"

systemd-run --quiet --wait --pipe --collect \
  -p User=nkustudy -p Group=nkustudy -p UMask=0077 \
  -p WorkingDirectory="$candidate" -p EnvironmentFile=/etc/nkustudy-admin.env \
  /usr/bin/npm run check:content
systemd-run --quiet --wait --pipe --collect \
  -p User=nkustudy -p Group=nkustudy -p UMask=0077 \
  -p WorkingDirectory="$candidate" -p EnvironmentFile=/etc/nkustudy-admin.env \
  /usr/bin/npm run build
systemd-run --quiet --wait --pipe --collect \
  -p User=nkustudy -p Group=nkustudy -p UMask=0077 \
  -p WorkingDirectory="$candidate" -p EnvironmentFile=/etc/nkustudy-admin.env \
  /usr/bin/node --input-type=module -e \
  'import path from "node:path"; import { StaticReleasePublisher } from "./server/static-release-publisher.mjs"; const publisher = new StaticReleasePublisher({ publicDir: process.env.PUBLIC_DIR, releaseRoot: process.env.PUBLIC_RELEASES_DIR, distDir: path.resolve("dist"), production: true }); await publisher.recoverStartup(); const result = await publisher.publish(async () => {}); console.log(JSON.stringify(result)); if (result.warnings?.length) process.exitCode = 2;'
```

A non-empty `warnings` array means the link switched but durability or cleanup degraded; keep the previous release and investigate before declaring the migration complete.

Only after all three candidate checks pass, atomically make the service use that same candidate. This drop-in resets `ExecStart` explicitly so both the working directory and executable source refer to one compatible application release; merely testing a candidate while restarting the old code is not a deployment.

```bash
set -eu
candidate="$(cat "$backup_dir/application-candidate")"
test -d "$candidate/server"
install -d -o root -g root -m 0755 /etc/systemd/system/nkustudy-admin.service.d
application_tmp="/etc/systemd/system/nkustudy-admin.service.d/.application-release.conf.next-$deploy_stamp"
cat >"$application_tmp" <<EOF
[Service]
WorkingDirectory=$candidate
ExecStart=
ExecStart=/usr/bin/node $candidate/server/admin-server.mjs
EOF
chown root:root "$application_tmp"
chmod 0644 "$application_tmp"
mv -T "$application_tmp" /etc/systemd/system/nkustudy-admin.service.d/application-release.conf
systemctl daemon-reload

test "$(systemctl show --value -p WorkingDirectory nkustudy-admin.service)" = "$candidate"
systemctl show --value -p ExecStart nkustudy-admin.service | grep -F -- "$candidate/server/admin-server.mjs"
systemctl cat nkustudy-admin.service
```

If production already has an atomically managed application pointer, it may be switched instead, but the two `systemctl show` checks remain mandatory and must resolve the effective `WorkingDirectory` and `ExecStart` to the reviewed candidate.

5. Start and verify the service, Caddy-visible files, management rebuild, legacy routes and public v1 routes:

```bash
systemctl restart nkustudy-admin.service
systemctl --no-pager --full status nkustudy-admin.service
runuser -u caddy -- test -r /var/www/nkustudy-current/index.html
curl -fsS https://nkustudy.top/api/v1/health
curl -fsS https://nkustudy.top/ >/dev/null
journalctl -u nkustudy-admin.service --since '-10 minutes' --no-pager
```

Perform one authenticated rebuild from the administration page and require a success response with no `warnings`. Do not put the administrator password in a command line. Keep the backup, seed release and old release tree until this check and the next planned restart both pass.

Rollback topology without rolling runtime data backward:

```bash
set -eu
systemctl stop nkustudy-admin.service
old_static_target="$(cat "$backup_dir/old-static-target")"
test -d "$old_static_target"
ln -s "$old_static_target" "/var/www/.nkustudy-current.rollback-$deploy_stamp"
mv -T "/var/www/.nkustudy-current.rollback-$deploy_stamp" /var/www/nkustudy-current
cp "$backup_dir/nkustudy-admin.env" /etc/nkustudy-admin.env
cp "$backup_dir/nkustudy-admin.service" /etc/systemd/system/nkustudy-admin.service
chown root:root /etc/nkustudy-admin.env /etc/systemd/system/nkustudy-admin.service
chmod 0600 /etc/nkustudy-admin.env
chmod 0644 /etc/systemd/system/nkustudy-admin.service
rm -f /etc/systemd/system/nkustudy-admin.service.d/publish-paths.conf
if test -f "$backup_dir/application-release.conf"; then
  cp "$backup_dir/application-release.conf" /etc/systemd/system/nkustudy-admin.service.d/application-release.conf
  chown root:root /etc/systemd/system/nkustudy-admin.service.d/application-release.conf
  chmod 0644 /etc/systemd/system/nkustudy-admin.service.d/application-release.conf
else
  test -f "$backup_dir/application-release.conf.absent"
  rm -f /etc/systemd/system/nkustudy-admin.service.d/application-release.conf
fi
systemctl daemon-reload
test "$(systemctl show --value -p WorkingDirectory nkustudy-admin.service)" = "$(cat "$backup_dir/old-working-directory")"
test "$(systemctl show --value -p ExecStart nkustudy-admin.service)" = "$(cat "$backup_dir/old-exec-start")"
systemctl restart nkustudy-admin.service
```

The application-release drop-in restoration is part of rollback: restoring only the static link while leaving the service on incompatible candidate code is not a valid rollback.

Only after an agreed stability period may the separately backed-up old static directories be removed. Do not delete `/var/lib/nkustudy` during topology cleanup.

## systemd example

```ini
[Service]
User=nkustudy
Group=nkustudy
WorkingDirectory=/opt/nkustudy/current
EnvironmentFile=/etc/nkustudy-admin.env
ExecStart=/usr/bin/node /opt/nkustudy/current/server/admin-server.mjs
Restart=on-failure
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ReadWritePaths=/var/lib/nkustudy /var/www/nkustudy-publish
```

Do not add `/var/www` to `ReadWritePaths` and do not make it writable by `nkustudy`. The code release still needs its build outputs (`dist`, `.astro`, and tool caches) writable for administrator-triggered rebuilds; source and package files do not need broad write permissions. Only one server process may write a `DATA_DIR` or publish root; the in-process queues are not a distributed lock.

`ProtectSystem` hardening and making the code release root-owned/read-only are valuable follow-up work, but are deliberately not part of this topology repair. They require a separate test of every Astro build/cache write path; do not enable them opportunistically during this migration.

## Runtime-data migration maintenance window

1. Make a verified root-only backup.
2. Stop the service and freeze website administration.
3. Run the plan-only `npm run migrate:runtime-data` command from `docs/data-schema.md` and save its JSON report.
4. Stop if course, review, or resource counts fall, if the unmatched-review list is unexpectedly large, or if any manual-fix item exists. Report the impact before proceeding; do not hide it with compatibility code.
5. Apply only with the plan SHA, a new root-only backup directory, and exact reviewed confirmation counts. The command refuses to overwrite an existing target.
6. Point `DATA_DIR` at the migrated target, then run tests/content validation/build and start one service process.

Before exposing the mini program, proxy only `/api/v1/*` to `127.0.0.1:8787`; do not map `/admin-api/*` beneath that prefix. Verify the exact public route list in `docs/public-api.md`, and configure the WeChat request/download legal domains listed there.

## Release gate

Run `npm ci`, `npm test`, `npm run check`, `npm run check:fixtures`, `npm run build:fixtures`, then run the production-data checks with an explicit path: `DATA_DIR=/var/lib/nkustudy/json npm run check:content`, `DATA_DIR=/var/lib/nkustudy/json npm run check`, and `DATA_DIR=/var/lib/nkustudy/json npm run build`. Record the existing Astro diagnostic baseline, but reject every newly introduced diagnostic. Run `npm run smoke:public-api`, then continue with the legacy website/API regression suite. Dependency audit is an online deployment gate and must be run in the connected release environment. A fixture build is disposable and must never be copied to the server.

Switch both application and static release pointers only after backups and candidate checks pass. On failure, restore the previous pointers and restart. Runtime data is restored only after separately proving data corruption; normal code rollback must not roll data backward.

## Manifest publish recovery

Before every manifest draft or publish, the server writes and fsyncs a mode-0600 snapshot under `${DATA_DIR}/.manifest-backups/`. The newest 20 snapshots are retained. Every manifest and static-content replacement also records a mode-0600 snapshot and durable journal under `${DATA_DIR}/.publish-snapshots/` and `${DATA_DIR}/.publish-journal/`; both directories are mode `0700`. A handled build failure restores the prior JSON in the same per-file queue and removes its journal. Startup recovery runs before the HTTP listener is created. It removes strictly named incomplete static build directories and temporary `current` links, then validates that the inner `current` link points to a managed release. Journal recovery safely removes a journal only when the JSON is still at its previous revision, or when a durably published journal matches its recorded next revision. An ambiguous crash after JSON replacement fails startup closed with `PUBLISH_RECOVERY_REQUIRED`; reconcile the named JSON against its snapshot and active `/var/www/nkustudy-publish/current` release before removing the journal. Do not delete these artifacts blindly.

All administrator full-manifest, R2 synchronization and static-content writes use revision CAS. HTTP 409 means nothing was overwritten: reload, inspect the other edit, then retry. Legacy R2 delete/move endpoints intentionally return 410. A dedicated in-process R2 queue serializes revision read, planning, collision checks, copy/verification, manifest CAS publish, and exact cleanup recording. Raw object keys remain opaque during deletion; no normalizer is allowed in cleanup. The safe route copies and verifies exact destination keys, publishes the CAS-protected manifest, and only then deletes the exact authorized old keys. Cleanup prefixes/keys that equal, contain, or sit beneath a copy target are rejected before copying. Cleanup failures leave harmless unreferenced objects for later removal.


## S2 日志与完整备份（2026-10-03收尾更新）

本地修复、真实Caddy隔离验证、WAL/JSON恢复结果见 [S2验收报告](compliance/S2_ACCEPTANCE.md)。发布前及生产回执按 [S2服务器操作单](compliance/S2_SERVER_ACCEPTANCE.md) 逐项执行，不能用旧的“JSON备份已上传”代替完整恢复验证。

S2完整备份必须加密，包含账号、运行JSON、日志和必要配置；公开资源桶不再接收私密备份或审计。新增配置路径`BACKUP_ENV_FILE/BACKUP_CADDY_FILE/BACKUP_SERVICE_FILE`须对应实际systemd/Caddy文件，独立私密桶使用`BACKUP_R2_BUCKET`并由维护者完成权限核验。恢复工具只创建隔离目录，D-01与恢复后删除状态核对完成前不能直接切换为生产。

维护者回执中的477b191已上线，这是20261001-s2的历史回执；2026-10-02新增的备份凭据隔离与设置口令修复已提交为49507d9，未部署。当前收尾的新包还包含其后的运行告警、只读备份预检及指南冒烟修复，**部署候选必须以新包`RELEASE.json`中的完整提交编号为准**。477b191旧包和49507d9前置提交不代表这份新包；先核对包内`SHA256SUMS`，Git检出时核对候选目录的`git rev-parse HEAD`，其他接收方式按新包README核对版本，再按操作单复跑。原254/254、后续260/260及296/296分别对应不同历史采样；本轮后台选项的保存、刷新回填及取消编辑已通过主窗口合成浏览器验收，证据见S2验收报告。代码固定版本以本次随附`RELEASE.json`为准，包校验以随附`verification/package-integrity.json`为准。

新备份客户端要求以下独立配置（值由维护者通过受控环境文件提供）：

```ini
BACKUP_R2_BUCKET=nkustudy-private-backups
BACKUP_R2_ACCOUNT_ID=<32位Account ID>
BACKUP_R2_ACCESS_KEY_ID=<备份专用Access Key ID>
BACKUP_R2_SECRET_ACCESS_KEY=<备份专用Secret Access Key>
BACKUP_R2_PRIVATE_CONFIRMED=1
```

最后一项只能在核验私密权限后设置，具体检查见服务器操作单。客户端使用标准`https://<Account ID>.r2.cloudflarestorage.com`端点；缺少专用凭据时拒绝远端备份并保留已完成的本地副本，不使用资源凭据兜底。现有`R2_*`资源配置继续供课程及头像访问，不能替换成仅限备份桶的令牌。

477b191曾把输入口令重复保存到普通备份设置中，认证后的设置接口可能回传明文。部署新包修复后，接口读取即隐藏旧副本；再正常保存一次备份设置（密码留空、开关保持原值）清理普通设置中的重复字段，并确认私密文件中的现有口令未变。已有加密备份和旧口令继续保留；不要为了此次清理直接轮换。私密桶、真实PUT/GET校验、匿名拒绝及保留设置仍待后续生产回执，本地合成测试不代替这些检查。

基于49507d9的后续并行工作增加只读`node scripts/s2-backup-preflight.mjs`和通知机器人`ops`用途。预检由服务账号使用服务环境运行，静态检查不通过时非零退出；退出0也不证明远端权限、恢复或通知送达。现有待审/日报配置不会自动订阅运行告警；后续获授权启用时，须在后台明确勾选“运行告警”。告警去重/重试在进程内维护，停机、Caddy和容量故障仍靠外部监控。

按2026-10-03用户决定C-11，当前仅收尾S2这一批，真实通知本轮暂缓：不重新接通、不新增真实运行告警订阅、不发送测试，也不把它列为本批提交/打包的阻塞项。用户表示通知服务以前接通过，这一历史反馈不能证明新`ops`用途已经生产投递验收。私密R2、外部监控、用户口令保管/独立解密、仍有1973条错误的类型检查、D-01及新包生产部署继续如实留待后续；S3/S4/S5未启动。当前阶段的实测和交付状态以S2验收报告的最新记录为准。

## S3 迁移预览与后续上线关卡（2026-10-05）

本节追加当前候选的操作要求，不改写上面的历史回执。S3核心已在本地提交为`98304954038735b8e437a43ea2a84f3b48816c94`；本轮后续修正及交付的固定版本须以最终候选提交和包内版本/校验清单为准。新S3尚未推送或部署，生产仍为`main 8ddcdc5`、维护者发布号`20261004-pr2`，依据见[S2最新生产回执](compliance/S2_SERVER_ACCEPTANCE.md)。当前仅准备本地交付，**以下第一步是只读影响预览，后续生产变更需另行安排**。

用户已决定保留评价原有`moderationRequired`及已启用关键词规则：需人工或命中规则时待审，否则自动公开；无需再次选择同一模式。历史已公开评价由`legacy_visibility_import`保持既有可见性，这不是历史管理员审批回填；原文、ID及隐藏状态保留。反馈的处理完成/回复不构成公开批准，已知投诉举报永久私密，未知历史反馈来源保持`publicationBlocked`。真实通知继续暂缓，本批不启用私密R2，不做S4。

### 维护者第一步：只读预览

2026-10-05交付准备复跑：启动坏结构保护与预览脱敏补丁后，`TMPDIR=/private/tmp npm test`为386/386，API文档130条一致、夹具检查通过、14页夹具构建通过。下文354/354保留为S3核心历史采样，不能与最终候选混用。新增32项覆盖预览及非法启动；本次未改前端、未重跑类型检查，1691条历史错误及生产/手机待验仍在。

候选源码必须解压到新建的独立目录，与当前应用、静态公开目录及运行数据目录分开。先核对源码包校验和固定版本；当前步骤不启动候选服务、不执行生产`npm run build`、不覆盖或修正任何原始data。预览只依赖Node内置模块，无需先安装npm依赖；不得以导入`server/admin-server.mjs`代替预览，那会触发初始化和迁移。

由维护者私下查看实际生效的systemd unit、drop-in及其环境文件，定位**确切的`DATA_DIR`绝对路径**，同时确认实际`User`、`Group`、Node可执行文件和候选目录读取权限。上文`/var/lib/nkustudy/json`及`nkustudy`只是历史示例，不能据此猜当前路径或身份；不要把环境文件、完整`systemctl cat/show`输出或秘密值发到聊天。数据根目录须为实际非符号链接目录，两份JSON须为非符号链接常规文件；缺文件时预览失败，不会创建默认文件。预览使用实际服务身份读取两份JSON，保持原有权限；若无读取权限就停止，不能为了预览把数据改为公开可读。

下面由维护者在具备`runuser`权限的受控shell中执行；先将所有占位符替换为已核对的实际值。回执目录须是发布目录、公开目录和`DATA_DIR`之外的新私密目录；它只保存预览输出，不是数据备份。

```bash
set -eu
candidate='/绝对路径/独立的S3候选源码目录'
node_bin='/绝对路径/现有Node可执行文件'
service_user='实际服务User'
service_group='实际服务Group'
actual_data_dir='/从现有生效配置确认的实际DATA_DIR'
preview_log_dir='/绝对路径/新建的私密预览回执目录'

umask 077
test ! -e "$preview_log_dir"
test ! -L "$preview_log_dir"
install -d -m 0700 "$preview_log_dir"
if runuser -u "$service_user" -g "$service_group" -- "$node_bin" \
  "$candidate/scripts/preview-moderation-migration.mjs" --data-dir "$actual_data_dir" \
  >"$preview_log_dir/stdout.json" 2>"$preview_log_dir/stderr.txt"; then
  preview_status=0
else
  preview_status=$?
fi
printf '%s\n' "$preview_status" >"$preview_log_dir/exit-code.txt"
chmod 0600 "$preview_log_dir/stdout.json" "$preview_log_dir/stderr.txt" "$preview_log_dir/exit-code.txt"
```

退出0仅表示此次两份输入均可只读预览，stdout为统计JSON；非0退出时停止后续步骤，保留原文件并调查原因。新版脚本失败时stdout为空、stderr为固定错误码JSON，但**stdout、stderr及外层shell错误仍须私下检查后再转发**，不能假设任意候选版本或系统错误都没有路径、标识符或原文。遇到非法JSON、UTF-8、数据结构、重复ID或不支持的版本，不得自动清空数组、用默认文档替换历史数据或继续部署。

仅回传退出码、候选固定版本，以及`files.feedback`/`files.reviews`各自的`sourceSha256`和以下统计：`total`、`private`、`publicationBlocked`、`publicEligible`、`importedLegacyVisibility`、`pending`、`alreadyMigrated`。这些统计可重叠，不能相加当作总量；`private:false`不等于允许公开。维护者在服务器私下核对总量、原文/ID保留及分类影响，异常时保留原始证据并停止。原文、条目/账号ID、联系方式、回复、举报链接及完整运行JSON不回传。

`sourceSha256`对应本次读取的**原始文件字节**，用于后续复核输入是否变化。`previewSha256`只对应以本次`generatedAt`模拟规范化后的compact JSON；时间和实际启动序列会影响结果，它不是启动后文件的字节哈希、内容revision或可用于apply的计划锁。`alreadyMigrated:true`表示输入已有v2标记且此次补默认设置、规范化后语义无需变化，不是一次生产迁移成功回执。预览不写源文件字节或mtime，系统读取仍可能更新atime；它不锁写入者，也不提供feedback/reviews共同时间点的快照。预览不检查完整生产配置、SQLite一致性、CDN、备份恢复、通知或R2权限；目前没有SOURCE_CHANGED竞态专项注入证据，不能把变化检测当作冻结保障。

可直接转发朋友的首步指令：

> 请先把S3候选源码解压到新的独立目录并核对固定版本；从现有生效的systemd配置私下确认真实DATA_DIR、服务User/Group及Node路径，不猜路径、不回传环境内容。保持旧服务，暂不启动候选、不做生产构建或覆盖data；仅运行候选的`node scripts/preview-moderation-migration.mjs --data-dir <真实绝对路径>`，stdout/stderr私密留存并检查脱敏后，只回传两文件统计、sourceSha256、固定版本及退出码。任何非法数据或非0退出均停止后续操作。

### 获授权后逐项满足上线关卡

1. **先在隔离环境复跑固定候选。** 按锁文件安装依赖，运行测试、API文档检查、内容检查与fixture构建；fixture只用于本地验收，不能发布。保留Linux实际结果及类型诊断差异。已保留的S3本地完整回归采样为`TMPDIR=/private/tmp npm test`的354/354，最终候选仍须按其固定提交复跑；默认macOS TMPDIR曾350/354，4个静态发布失败在旧HEAD也复现，不能写成默认命令全绿。已记录的候选类型检查仍1691个历史错误、exit 1；归一后的新增诊断为0、减少280，不代表类型检查通过。详细边界见[S3计划及逐项证据](compliance/plans/s3-20261004.json)。

2. **维护窗口冻结全部写入，并做原始私密备份。** 先安排入口维护措施，再停止旧Node服务及其他会写运行JSON/SQLite的进程或任务，确认没有自动重启、第二实例或离线写入者；一致性保障依赖单写进程及运维停写，不存在可直接调用的S3维护锁。记录实际服务身份、有效`WorkingDirectory`/`ExecStart`及旧应用/静态指针。以现有受控备份流程保留迁移前的原始JSON、SQLite及所需秘密/配置；不能只复制活动SQLite主文件而遗漏WAL，停写复制或SQLite备份接口须形成一致快照。备份留在私密目录（目录0700、文件0600；原文和秘密按既有流程加密保管），校验并确认可隔离恢复，不上传公开桶、不接通私密R2、不删除历史队列/快照/journal。备份失败或空间不足时停止。

3. **停旧进程后复核同一候选、同一输入。** 在仍停写的状态再次运行只读预览，对照两个`sourceSha256`与已审阅的影响统计；备份中的原始两文件也须与这次源字节哈希对应。旧服务运行期间的预览不是冻结快照，任一source hash变化都必须重新预览、核对影响并更新备份，不能沿用旧结果。当前没有独立S3 apply CLI、`expectedPlanHash`检查或预览到启动的锁；维护者须保持停写边界直至候选接管，不能把`npm run migrate:runtime-data`的另一套迁移协议当作S3 apply。

4. **在维护状态切换候选，按真实启动顺序验收。** 核对服务User/Group、运行路径、sentinel、0700/0600、数据库父目录及发布目录权限；以实际服务身份使用实际环境，不用root测试代替服务权限验证。确认有效`WorkingDirectory`与`ExecStart`均指向已复跑的完整候选后，只启动一个候选进程。生产路径预检先于SQLite或可变文件创建；随后服务会初始化其状态组件，依次恢复静态发布、manifest journal、content journal，初始化/校验运行数据，再分别持久化`feedback.json`和`reviews.json`的v2规范化，最后才创建HTTP服务并监听。**两个迁移写入不是跨文件事务；启动失败可能已改写其中一份JSON。** 遇`PUBLISH_RECOVERY_REQUIRED`或迁移错误保持维护状态，按命名快照、journal及活跃静态发布核对，不删除恢复证据，也不反复切回旧进程尝试“自动修好”。

5. **发布新静态产物并清理旧缓存后才开放入口。** 自动启动迁移不会重建静态站点；维护状态下从同一候选、使用实际受控`DATA_DIR`完成生产内容检查、构建及受管理的静态发布，确认没有warnings、Caddy可读且活跃指针正确。核对现存自定义公告与实际自动公开规则一致；新默认公告不会覆盖旧自定义内容。清除CDN中旧UGC接口及受影响页面/搜索数据缓存，调整缓存规则使含评价派生内容的home/courses/review-groups/search-index/search-data和旧公开列表遵守`no-store`。从实际入口用新浏览器会话，并携带历史ETag请求，核验这些接口不再返回旧304/正文；核对旧公开目录不会绕过当前指针继续暴露。新响应头和本机测试不能召回已留在浏览器或第三方的旧副本，生产缓存清理必须另留回执。

6. **用最少合成数据核验，再清理自验影响并回执。** 合成投稿也可能触发现有自动通知，先只读核对现有目标不会实际投递；若不能保证，本批不做生产写入自验，改在隔离合成环境验证并明确记录生产链路未执行，不能只因没有点击通知“测试”按钮就声称未发送。不发送真实通知，不开私密R2。具备上述边界后，通过现有认证入口，以合成账号/内容验证投稿→后台单条处理/回复→刷新/重启读回，核对原有自动规则、冲突409、私密投诉始终不进入公开列表，以及公开评价隐藏/撤销后下一请求的列表、搜索和派生统计均无该内容。先登记自验所建账号/条目，结束后用受支持的单条处置隐藏并撤销合成公开内容，清空合成回复，核对公开出口及缓存已无自验标记；按现有账号流程关闭临时管理员或撤销合成用户凭据，保留必要审计，不直接改JSON/SQL抹去记录。本批没有条目删除、批量处置或合并接口。真实微信链路、实际手机键盘/390与320宽度联调等未执行项继续单列，不能用桌面浏览器或354个自动测试代替。

回执只含固定提交/实际发布号、Node版本、测试与未完成项、两文件迁移前source hash/影响计数、备份及隔离恢复结论、单进程/权限结论、新静态发布和实际入口缓存结果、合成自验及清理结论；不附原始数据、密钥或完整日志。通知写“用户暂缓，未发送”，私密R2写“本批未启用”，真机未跑就写“未执行”。原始私密备份保留至另行约定的稳定期。

### S3 数据兼容回退

上文普通代码/静态回退流程不能直接套到已迁移的S3数据：S2的旧公开gate不认识v2的`publicationBlocked`、批准依据和处理/公开分离，简单切回`8ddcdc5`或旧静态产物可能重新公开应受限内容。迁移后故障先保持维护状态、停止所有写入并留存失败时新数据、SQLite及journal；优先使用兼容schema v2且保留同一公开gate的修复/回退版本。若确需恢复迁移前完整备份，须单独评估停写后新增内容、账号及删除状态的取舍，验证隔离恢复并同步核对应用、静态产物、运行数据和缓存后再开放；不能只回退两份JSON、把正常代码回退当作可自动倒退运行数据的授权，或绕过S2恢复隔离标志。
