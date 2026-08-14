# NKUStudy website and server

This repository is the code base for the NKUStudy Astro website and its Node.js server.

Production content, reviews, feedback, visit records, credentials, backups, generated output, SQLite databases, and course resource files are deliberately excluded from Git. The website remains the only administration surface. The WeChat mini program API must expose public/user operations only and must never expose `/admin-api/*` functionality.

This source baseline replaces the repository's former resource-archive purpose. Importing it does not authorize a production deployment.

See `docs/DEPLOYMENT.md` before deploying. Never copy a local `src/data` directory over production data.
