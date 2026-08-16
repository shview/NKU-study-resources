# Security and encoding audit — 2026-08-16

## Confirmed security findings

The production Node service was correctly bound to `127.0.0.1:8787`, runtime secrets/data were mode `0600`, the data directory was mode `0700`, Caddy was the only API proxy, and persistent write-rate limits were already active.

The audit also confirmed these gaps:

- Administrator cookies contained stateless HMAC tokens. Browser expiry existed, but the server had no absolute/idle expiry and logout could not revoke a copied token.
- Administrator POST routes relied mainly on `SameSite=Strict`; they did not independently require an exact `Origin`, Fetch Metadata, a non-simple custom header, or the expected content type.
- The canonical site lacked HSTS, anti-framing, MIME-sniffing, referrer and permissions response headers. The raw server IP served the complete static site over HTTP.
- SSH allowed public root/password login, had no Fail2ban jail, and UFW exposed unused TCP 8080.
- Dependency audit reported five high-severity and one moderate advisory in the Astro build dependency tree.

Implemented application controls:

- Administrator session tokens are random opaque values; only secret-bound HMAC hashes are persisted in SQLite.
- Sessions have a 30-minute idle timeout, an 8-hour absolute timeout, a maximum active-session count, and server-side logout revocation.
- Every administrator mutation requires exact `ADMIN_ORIGIN`, same-origin Fetch Metadata when present, `X-NKUStudy-Admin-Request: 1`, and JSON or multipart content type as appropriate.
- Password comparison is constant-time, malformed cookies fail closed, and unexpected public 500 responses do not expose exception details.
- The administrator cookie uses the `__Host-` prefix with `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/`.
- A dependency lock-file update removes all currently reported `npm audit` findings.

Host controls and the exact Caddy baseline are in [DEPLOYMENT.md](./DEPLOYMENT.md). Password SSH must not be disabled until a tested non-root sudo account and working administrator public keys exist.

Production enforcement completed on 2026-08-16: Caddy now applies the documented headers and canonical-host redirect, the raw IP returns 404, TCP 8080 is closed, SSH is UFW-rate-limited with three attempts and a 30-second login grace period, and Fail2ban has an enabled `sshd` jail. Root/password SSH remains the explicit residual risk until a tested key-based administrator path is installed; rotate the currently exposed password as part of that key migration.

## U+FFFD encoding incident

`U+FFFD` is the Unicode replacement character. Once a decoder has replaced unknown input bytes with this character, later valid UTF-8 reads and atomic JSON writes preserve it exactly; they cannot reconstruct the lost bytes.

Evidence from the server:

- The runtime migration reads bytes as UTF-8 and writes JSON atomically; it does not perform an ANSI/GBK conversion.
- The earliest retained 68-course source snapshot and the migration-precheck backup already contained nine JSON string paths with `U+FFFD`.
- Three of those manifest paths were subsequently corrected through content edits. Six remain in the current manifest: one course ID, four course summaries (one contains multiple replacement runs), and one resource path.
- The complete runtime audit also found two existing review-content strings with `U+FFFD`, so the production data set currently has eight findings in total. These review findings were outside the earlier manifest-only comparison; the audit did not create them.
- The repository intentionally does not version production `src/data/*.json`, and no earlier clean 68-course snapshot is available. Therefore the exact program or edit that first decoded the bytes cannot be proven from retained evidence.
- The replacement-run shapes are consistent with legacy Chinese bytes (commonly GBK/ANSI) being decoded as UTF-8 before the earliest retained snapshot. This is an inference, not proof of the exact tool.

Prevention now consists of strict fatal UTF-8 decoding, rejection of `U+FFFD` on public writes and runtime imports, plus a deterministic audit command:

```bash
DATA_DIR=/var/lib/nkustudy/json npm run audit:encoding
```

The eight current values are deliberately not guessed or rewritten. Correct each field only from an authoritative original or an explicit content-owner decision, then rerun the audit. After the six manifest values are repaired, the same no-`U+FFFD` rule can be enabled for complete administrator manifest submissions without blocking all current course edits.
