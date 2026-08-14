# Deployment safety

## Current status: production release is blocked

This repository is a reviewed **source-code baseline**, not a deployable production bundle. The current server still resolves runtime JSON from `src/data` and the existing publisher replaces the live web root non-atomically. Do not release from this repository until both follow-up changes are implemented and verified:

1. every runtime reader/writer uses an explicit `DATA_DIR` whose production value is `/var/lib/nkustudy`;
2. the site publisher builds a candidate release and switches the web root atomically, with a tested rollback.

Until that gate is removed, `npm run build` may be used only against an authorized copy of production data in an isolated release candidate. It must not be treated as a deploy command.

## Repository boundary

- Commit source code, tests, documentation, and deliberately sanitized fixtures only.
- Keep production JSON, credentials, logs, backups, generated output, SQLite files, and uploaded resources outside Git.
- Never commit server passwords, WeChat AppSecret values, R2 credentials, backup endpoints, or live configuration files.
- The mini program API is public/user-facing. Website administration remains the only content-management surface; `/api/v1` must not expose `/admin-api` capabilities.

## Fixture builds are disposable

`npm run build:fixtures` stages only the reviewed files in `src/data/fixtures`, refuses to run if any destination JSON already exists, and writes to `dist-fixture`. This command is for clean-clone validation. **A fixture build must never be copied to a server or published as the website.**

Production builds must use a read-only snapshot of the controlled `/var/lib/nkustudy` data. They must never fall back to fixtures when a production file is missing. The future `DATA_DIR` implementation must fail closed when required files are absent.

## Required release design (after the blockers are implemented)

1. Create and verify a root-only backup of `/var/lib/nkustudy`, service configuration, and the active release pointer.
2. Check out the intended commit into a new immutable candidate directory such as `/opt/nkustudy/releases/<release-id>`.
3. Attach or copy a read-only production-data snapshot from `/var/lib/nkustudy`; do not synchronize a local `src/data` directory to the server.
4. Install dependencies and build inside the candidate. Run unit tests, content validation, API smoke tests, and the legacy website/API regression suite there.
5. Publish static output into a new versioned web directory. Do not delete or overwrite `/var/www/nkustudy` in place.
6. Stop writes briefly if required, switch the service release pointer and web-root symlink (or same-filesystem renamed directory) atomically, then restart/reload.
7. Verify the website, review, feedback, visit, admin, and public `/api/v1` routes. Confirm production-data checksums and record the release ID.

## Rollback design

Keep the previous application release, previous static web directory, and previous pointer targets. On a failed health check, atomically restore both pointers, restart/reload, and re-run the legacy route checks. Runtime data is not rolled back automatically: restore it only from a verified backup after separately confirming a data-corruption incident.
