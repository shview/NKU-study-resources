# Runtime data

Production JSON is mutable runtime state and is not stored in Git. Production reads and writes it only through `DATA_DIR=/var/lib/nkustudy/json`; the SQLite state and admin secret live at `/var/lib/nkustudy/miniprogram.sqlite` and `/var/lib/nkustudy/admin-secret`. Never copy this directory, its fixtures, or a local build over production data.

The current website build requires these files:

- `manifest.json`
- `reviews.json`
- `feedback.json`
- `about.json`
- `home.json`
- `participate.json`
- `links.json`
- `footer.json`

The server also maintains `editor-settings.json`, `visit-stats.json`, `backup-settings.json`, and (by default) `miniprogram.sqlite`. These are production state even when they contain only configuration or rate-limit counters.

`guides.json` is optional until the first reviewed guide batch is installed. When absent, the public guide list and guide part of the search index are empty. Its schema and controlled content-import rules are documented in `docs/data-schema.md`; the synthetic fixture is not production content.

Each manifest course requires an immutable UUID `uid`; the legacy `id` remains the website route key. Optional `shortName` and `aliases` are the only authoritative sources for public search aliases. Use the reviewed migration command described in `docs/data-schema.md`, never an ad-hoc text replacement.

`fixtures/` is the only JSON subtree allowed in Git. Every fixture must be synthetic and must not contain real reviews, feedback, contact details, visitor data, credentials, private endpoints, internal filesystem paths, or copied production identifiers. `npm run build:fixtures` refuses to overwrite existing runtime JSON, builds only to `dist-fixture`, and removes staged files afterward. Never deploy `dist-fixture`.

Use `npm run check:fixtures` for repository samples. `npm run check:content` deliberately refuses to guess a data location and requires an explicit `DATA_DIR`; this prevents a release check from silently validating fixtures instead of production candidate data.
