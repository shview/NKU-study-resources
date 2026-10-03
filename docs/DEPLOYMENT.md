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

The public Node listener stays on `127.0.0.1:8787`. Caddy is the only public HTTP entry point. Apply response headers at the canonical site block and do not expose the static site on the raw server IP:

```caddyfile
www.nkustudy.top {
  redir https://nkustudy.top{uri} permanent
}

nkustudy.top {
  header {
    -Server
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "strict-origin-when-cross-origin"
    Permissions-Policy "camera=(), microphone=(), geolocation=()"
    Content-Security-Policy "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'"
  }
  # Existing API handlers and static root follow here.
}

http://8.217.248.245 {
  respond 404
}
```

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
