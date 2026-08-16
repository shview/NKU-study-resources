# Runtime data and stable identifiers

## Course identity

Every course in `manifest.json` has two identifiers:

- `uid`: immutable UUID used by databases, favorites, submissions, and future public API routes;
- `id`: existing human-readable website route key, retained for backward compatibility.

Changing a course title or website `id` must never change its `uid`. Future favorite rows must use `course_uid` as their foreign key and resolve the current title from the manifest, so renaming a course does not orphan favorites.

For an in-place development-only UID backfill, the narrow command remains available:

```powershell
$env:DATA_DIR = "C:\authorized\runtime-data"
npm run migrate:course-uids
npm run migrate:course-uids -- --write --expected-sha256=<dry-run-sha256>
```

The first command is a dry run and prints the manifest hash. Stop the server and freeze administration before write mode. `--write` requires that hash, acquires an exclusive lock, validates existing values, creates a same-directory timestamped backup, assigns UUIDs only where missing, validates uniqueness, rechecks the hash, and atomically replaces the manifest. Re-running it is idempotent.

## One-time production data cutover

Do not keep compatibility branches for missing UIDs, Windows paths, backslashes, or non-canonical R2 paths. Correct the current data set once, review the report, and then enforce the schema.

With the service stopped and website administration frozen, plan a move from the old release-owned data directory into the persistent directory:

```bash
npm run migrate:runtime-data -- \
  --source-dir=/opt/nkustudy/src/data \
  --target-dir=/var/lib/nkustudy/json
```

The JSON report includes:

- course/review/resource counts before and after;
- every generated deterministic course UID;
- every normalized `basePath` and file path;
- preserves `repository`, global `hiddenMetaTags`, and per-course `hiddenMetaTags` because the website still uses them, while removing only the confirmed-unused per-course `source` field;
- every review whose `courseTitle` does not exactly match a current course;
- record deletion counts and schema problems requiring manual edits;
- hashes for every source file and the complete plan.

Every path change is treated as possible logical data loss: JSON records can
remain while their R2 objects become unreachable. Write mode therefore
requires both `--confirm-path-changes=<exact-count>` and a server-generated JSON
object inventory passed as `--r2-inventory=<path>`. Every normalized exact
`resources/<basePath>/<file.path>` key affected by a path change must exist in
that inventory. Missing keys cannot be overridden; correct the source JSON or
R2 layout and create a fresh plan.

Plan mode never writes. Before apply, review and retain the report. Any nonzero deletion or unmatched-review count requires an exact explicit confirmation; schema errors and duplicate normalized course titles cannot be overridden and must be fixed in source data. This is where a potentially large loss or remapping is reported before anything changes.

```bash
npm run migrate:runtime-data -- --write \
  --source-dir=/opt/nkustudy/src/data \
  --target-dir=/var/lib/nkustudy/json \
  --backup-dir=/root/nkustudy-backups/runtime-data-before-cutover-YYYYMMDD \
  --expected-plan-sha256=<planSha256> \
  --confirm-unmatched=<reviewed-count> \
  --confirm-deletions=<reviewed-count> \
  --confirm-path-changes=<reviewed-count> \
  --r2-inventory=/root/nkustudy-backups/r2-inventory-YYYYMMDD.json
```

Write mode takes an exclusive lock, rechecks every source hash, creates a private full JSON backup, stages mode-0600 files under a mode-0700 directory with the production sentinel, verifies record counts, and renames the new directory into place. It refuses to merge with or overwrite an existing target. After cutover, `uid` and canonical paths are required; fix invalid source data rather than adding fallback parsing.

## Runtime files

`DATA_DIR` defaults to `src/data` only for compatibility with an authorized local checkout. Production uses `DATA_DIR=/var/lib/nkustudy/json`. Core content (`manifest`, `about`, `home`, `participate`, `links`, and `footer`) fails closed when absent. Only explicitly allowlisted mutable state (`reviews`, `feedback`, `visit-stats`, `editor-settings`, and `backup-settings`) may be initialized by the server.

`guides.json` is an optional public-content source until the first reviewed guide batch is delivered. Absence means an empty guide collection, not fixture data. Its top-level shape is `{version,updated_at,correction_url,items}`. Items use a stable lowercase slug `id`, one of `course-selection`/`training-program`/`add-drop`/`exam-grade`, a timezone-bearing `updated_at`, public steps, and current course UUIDs in `related_course_ids`. Invalid categories, timestamps, course references, duplicate IDs, or non-HTTPS public URLs fail the public API closed. Guide content is installed into `DATA_DIR` through the same reviewed content deployment process; no guide management route is exposed under `/api/v1`.

Optional course search metadata is stored directly on each manifest course as `shortName: string` and `aliases: string[]`. The website course editor preserves and edits both fields. Empty values are explicit and no compatibility parser derives aliases from a title.

JSON mutations use a per-file queue and same-directory atomic replacement. Updaters re-read inside that queue, preventing concurrent review, feedback, and visit writes from overwriting each other.

## Persistent state and privacy

In local development, `STATE_DB_PATH` defaults to `${DATA_DIR}/miniprogram.sqlite`. Production sets `STATE_DB_PATH=/var/lib/nkustudy/miniprogram.sqlite` and `ADMIN_SECRET_FILE=/var/lib/nkustudy/admin-secret`. The SQLite database holds persistent rate-limit counters and is excluded from Git. Rate-limit actors are HMAC hashes produced with the server secret; raw IP addresses are not stored in the database. Legacy visit entries containing an `ip` field are converted to `actorHash` and stripped on the next visit-stat update.

The server trusts `X-Forwarded-For` only when the direct peer matches an explicit production `TRUSTED_PROXIES` address or CIDR. For loopback Caddy use `127.0.0.1/32,::1/128`. Invalid and overlong forwarding chains fail closed.
