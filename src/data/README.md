# Runtime data

Production JSON is mutable runtime state and is not stored in Git. After the planned `DATA_DIR` migration, production must read and write it only under `/var/lib/nkustudy`. Never copy this directory, its fixtures, or a local build over production data.

The current website build requires these files:

- `manifest.json`
- `reviews.json`
- `feedback.json`
- `about.json`
- `home.json`
- `participate.json`
- `links.json`
- `footer.json`

The server also maintains `editor-settings.json`, `visit-stats.json`, and `backup-settings.json`. These are production state even when they contain only configuration.

`fixtures/` is the only JSON subtree allowed in Git. Every fixture must be synthetic and must not contain real reviews, feedback, contact details, visitor data, credentials, private endpoints, internal filesystem paths, or copied production identifiers. `npm run build:fixtures` refuses to overwrite existing runtime JSON, builds only to `dist-fixture`, and removes staged files afterward. Never deploy `dist-fixture`.
