# Validation record

Updated 2026-09-29. Database tests use loopback only; no migrations were applied to the configured remote host.

- `npm run typecheck`: passes for server and React.
- `npm run build`: passes; Express TypeScript output and Vite production assets generated.
- Full server suite with `RUN_DB_TESTS=1`: **66 tests passed, 0 failed, 0 skipped** against isolated local MariaDB12.0.2 at127.0.0.1:33307.
- `npm run test:browser`: **6 browser scenarios passed** with installed Chrome, using a separate built-app server at127.0.0.1:4188.
- Migration first run succeeds; rerun reports `Already applied: 001_initial.sql` / `Already applied: 002_service_roles.sql` without repeating DDL.
- Dependency install audit reported0 known vulnerabilities at installation time.

Server coverage includes Google-flow return-path restrictions, cryptographic tampering, OTP/TOTP verification, replay and concurrency, account lockout, recovery codes, session rotation/limits, CSRF/roles, allowlist/soft deletion, API key scopes/audience/revocation, PKCE, cache isolation/effective expiry, transactional audit rollback, worker poison-batch fail-fast, archive checksums and pagination/filter validation. Service coverage includes default deny, active role requirements, cross-service role rejection, prevention of platform privilege escalation, app-scoped claims, membership/token/code revocation, profile updates and audit rollback.

Browser coverage includes the CUSA SSO login, validated service context, invalid return paths, MFA resume, existing-session continuation, profile editing, custom service roles, multiple role assignment, cross-service isolation and role/member removal, plus explicit demo mode, every navigation page, adding allowed email, application/API key creation with one-time reveal, key revocation, TOTP QR/recovery UI, mobile drawer/layout and demo reset after reload. Screenshots are generated in ignored `test-results/`.

Integration tests restrict database use to loopback and an explicit name ending `_test`. Fixture cleanup is limited to created IDs; audit evidence remains append-only. Test identities and credentials are synthetic. Browser demo tests never authenticate a real Google account or call Gmail.

Not verified in this workspace: interactive Google sign-in or Gmail email delivery, authenticated remote MariaDB queries/certificates, Redis outage/recovery against a running Redis service, Docker image execution (local Docker daemon unavailable), deployment, production load or independent penetration testing. See the credential checks below for the limited live checks performed later. Architecture claims do not imply compliance certification or guaranteed throughput.

## Configured service checks — 2026-09-29

- Required credential fields are present and basic formats pass; no secret values were printed. `.env` remains ignored and has mode `0600`.
- Google accepted the configured Gmail refresh token. The resulting token matches the configured sending OAuth client and includes `gmail.send`. Token metadata did not disclose the account email, so this check does not prove that the authorizing account matches `GMAIL_SENDER`. No email was sent; the interactive Google Login client has not been exercised.
- Configured Redis returned `PONG` over TLS. This is a connectivity check, not a failover/load test.
- Configured MariaDB rejected TLS negotiation with `HANDSHAKE_NO_SSL_SUPPORT`. Database credentials, schema and migrations could not be validated; no database mutation or TLS downgrade was performed. A CA file alone cannot enable TLS support on that endpoint.
- User selected `http://localhost:5173` for local development. Only `APP_ORIGIN` was updated in `.env`. Configuration now rejects comma-combined origins; isolated import checks accept the local and HTTPS origins and reject combined origins and paths. Server build passes.
- Port 5173 is occupied by another project (`psweb`); its process was preserved. The existing CUSA preview on 4188 continues to run with demo-only environment overrides and is not a live credential test.

### Follow-up: explicit user-requested test without DB TLS

- At the user's request, changed only `DB_TLS=false` in `.env` and retained mode `0600`.
- Connection and read-only probes succeeded against MariaDB `10.11.18-MariaDB-0+deb12u1-log`, with session timezone `+00:00`. `Ssl_cipher` is empty, confirming this connection is not encrypted.
- The configured database account sees zero tables in the selected schema; none of the required CUSA tables were visible. No migration, bootstrap or application-data mutation was performed.
- The tested endpoint is a public IP; Production requires verified TLS for that endpoint. The later local/private deployment exception below does not change that result.

### HostAtom local/private database deployment

- The user supplied a Plesk Connection information screenshot showing `localhost:3306` for the app database. Documented `DB_HOST=localhost`, separate `DB_PORT=3306`, `DB_TLS=false` and blank `DB_CA_FILE` on the deployment host; the local development `.env` retains the remote IP.
- Production permits explicit non-TLS database connections to localhost, loopback IPs, RFC1918 IPv4 and ULA IPv6. Public endpoints and unverified DNS names require verified TLS. Production HTTPS and credential requirements remain enforced.
- `node --import tsx --test server/tests/databaseTransport.test.ts`: **3 tests passed**, covering private address boundaries, IPv4-mapped IPv6, public/adjacent ranges, multicast/unspecified/link-local addresses and deceptive hostnames/numeric spellings.
- **9 isolated configuration checks passed** for production local/private IPv4/private IPv6, public TLS, rejection of public non-TLS/unverified DNS/HTTP origin/incomplete credentials, and the development exception. They used synthetic credentials and performed no network or database operations.
- `npm run build` passes for server and web. Privacy wording and deployment documentation reflect the internal unencrypted-connection option. No deployment, remote migration or verification of routing from inside HostAtom was performed.

## Public legal pages — 2026-09-29

- `npm run build` passes after adding the public documents; the subsequent mobile contents-menu change also passes the React production build.
- All **6 existing browser scenarios pass again**, using a temporary Playwright configuration that reuses the isolated demo server on port 4188. Backend/database tests above are prior results; no backend logic or database schema changed for these pages.
- Browser checks verify `/privacy` and `/terms` direct loading and reload, document titles, organization/email contacts, section anchors, and zero API requests even with `/api/**` deliberately blocked.
- A privacy link from Login opens a separate tab with no `window.opener` and keeps the original Login URL unchanged.
- Additional checks cover trailing-slash routes, a direct `/privacy#requests` link, collapsible contents on 390px/320px viewports, no document-wide horizontal overflow, and PDF generation with print navigation hidden. Desktop/mobile screenshots and print PDFs are in ignored `test-results/legal/`.
- No organization email was sent, no Upstash resource was created, and no production deployment or remote database change was made. Legal content still requires organization-specific operational and legal review as described in `docs/LEGAL.md`.

## First-install wizard — 2026-09-29

- Added opt-in `/install`, an MVC install API, migration `003_installation_state.sql`, and shared migration/CLI bootstrap locking. `.env` has a generated random INSTALL_TOKEN with INSTALL_ENABLED=false; existing service credentials were preserved and no secret was printed. `.env` remains ignored with mode 0600.
- Server and React production builds pass; `git diff --check` passes.
- Full backend regression using local MariaDB and `--test-concurrency=1`: **75 passed, 0 failed, 1 intentionally skipped**. The skipped installer integration requires its own empty database and was run separately: **1 passed**. An earlier parallel run had two transient HTTP assertion failures (one installer test and an existing SSO CORS test); both passed in isolation and the complete sequential run. No SSO behavior was changed to accommodate these results.
- HTTP coverage verifies disabled routes, exact Origin/JSON, bearer-only token handling, throttling without a schema, confirmation validation, server-owned admin email, sanitized errors, API maintenance mode and install-page cache headers.
- Dedicated empty local database coverage verifies partial-schema retry, checksum validation, an existing-admin guard, rollback of admin/audit/marker when marker insertion fails, concurrent installers producing only one administrator, and persistent rejection after completion.
- Built `server/dist/index.js` exercised with NODE_ENV=production, a synthetic HTTPS APP_ORIGIN, synthetic credentials and a separate loopback database: check → install → duplicate rejection → shutdown → restart with flag disabled → `/install` and install API 404 → readiness 200 → re-enable flag → persistent INSTALL_LOCKED. HTTP transport in this local smoke test was loopback; it does not validate Plesk TLS termination. No Google/Gmail calls were made. Temporary smoke database was removed afterward.
- **8 browser scenarios passed**, including installer confirmation/success, bad credentials/locked states, no token in browser storage/URL, mobile layout and the six existing app scenarios. Installer component tests substitute the public document/API because the default server disables installation; real database installation was covered separately above.
- Screenshots reviewed for desktop success and mobile form. No HostAtom database was created/migrated, no real admin was provisioned, and no production deployment was performed. Follow [INSTALL.md](INSTALL.md) on the host.
