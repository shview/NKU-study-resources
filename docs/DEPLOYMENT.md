# Deployment safety

This repository is a source candidate, not authorization to deploy. Production data and secrets remain outside every release. Website administration is the only content-management surface; future `/api/v1` routes are public/user-facing only.

## Production fail-closed contract

Set all of these explicitly to absolute paths outside the release tree:

```ini
NODE_ENV=production
DATA_DIR=/var/lib/nkustudy/json
STATE_DB_PATH=/var/lib/nkustudy/miniprogram.sqlite
ADMIN_SECRET_FILE=/var/lib/nkustudy/admin-secret
TRUSTED_PROXIES=127.0.0.1/32,::1/128
PUBLIC_RESOURCE_ORIGIN=https://resources.nkustudy.top
PUBLIC_DIR=/var/www/nkustudy-current
PUBLIC_RELEASES_DIR=/var/www/nkustudy-releases
```

Before startup, create `/var/lib/nkustudy` and `${DATA_DIR}` as mode `0700`, create `${DATA_DIR}/.nkustudy-data-root` containing exactly `NKUSTUDY_RUNTIME_DATA_V1`, and install all core JSON files. Use `STATE_DB_PATH=/var/lib/nkustudy/miniprogram.sqlite` and `ADMIN_SECRET_FILE=/var/lib/nkustudy/admin-secret`; all data, database and secret files are mode `0600`. `ADMIN_SECRET_FILE` must already exist and contain at least 32 random characters. Production startup validates the sentinel, core JSON, paths, symlinks, permissions, secret and trusted proxy configuration before SQLite or mutable JSON is created.

`PUBLIC_DIR` must be a symlink on production. Publishing builds a fresh versioned directory and switches that symlink with a same-filesystem rename; it never deletes the live tree in place. Keep the prior release target for rollback.

## systemd example

```ini
[Service]
User=nkustudy
Group=nkustudy
WorkingDirectory=/opt/nkustudy/current
EnvironmentFile=/etc/nkustudy/admin.env
ExecStart=/usr/bin/node /opt/nkustudy/current/server/admin-server.mjs
Restart=on-failure
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ReadWritePaths=/var/lib/nkustudy /var/www/nkustudy-releases /var/www
```

Only one server process may write a `DATA_DIR`; the in-process queues are not a distributed lock.

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

Before every manifest draft or publish, the server writes and fsyncs a mode-0600 snapshot under `${DATA_DIR}/.manifest-backups/`. The newest 20 snapshots are retained. Every manifest and static-content replacement also records a mode-0600 snapshot and durable journal under `${DATA_DIR}/.publish-snapshots/` and `${DATA_DIR}/.publish-journal/`; both directories are mode `0700`. A handled build failure restores the prior JSON in the same per-file queue and removes its journal. Startup recovery runs before the HTTP listener is created and safely removes a journal only when the JSON is still at its previous revision, or when a durably published journal matches its recorded next revision. An ambiguous crash after JSON replacement fails startup closed with `PUBLISH_RECOVERY_REQUIRED`; reconcile the named JSON against its snapshot and active `/var/www/nkustudy-current` release before removing the journal. Do not delete these artifacts blindly.

All administrator full-manifest, R2 synchronization and static-content writes use revision CAS. HTTP 409 means nothing was overwritten: reload, inspect the other edit, then retry. Legacy R2 delete/move endpoints intentionally return 410. A dedicated in-process R2 queue serializes revision read, planning, collision checks, copy/verification, manifest CAS publish, and exact cleanup recording. Raw object keys remain opaque during deletion; no normalizer is allowed in cleanup. The safe route copies and verifies exact destination keys, publishes the CAS-protected manifest, and only then deletes the exact authorized old keys. Cleanup prefixes/keys that equal, contain, or sit beneath a copy target are rejected before copying. Cleanup failures leave harmless unreferenced objects for later removal.
