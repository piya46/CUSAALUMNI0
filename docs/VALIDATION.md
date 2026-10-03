# Validation record

## Admin Passkey assurance and phone reminder — 2026-10-04

- Production server/React build passes; no new dependencies, database migration or private `.env` changes.
- Server suite: **81 passed, 44 skipped, 0 failed**. Skipped tests require live local MariaDB/Redis; no production database was contacted.
- **25 targeted browser scenarios passed across runs** for auth UX, additional factors, admin Passkeys and hardening. Chrome's virtual authenticator uses `localhost` (an IP literal is not a valid WebAuthn RP ID). Browser provider/backend responses are synthetic; no real Google/LINE/Firebase login or SMS was sent.
- Signed P-256 assertions pass through the real WebAuthn verifier and Passkey model with a transactional in-memory DB adapter. Coverage includes origin/RP ID/UV/presence/signature/counter/user-handle checks, credential ownership, account/session/factor/purpose binding, challenge replacement/expiry/replay, account lockout, recovery-session restrictions and audit-failure rollback. Reauthentication refreshes assurance without changing session/CSRF credentials or absolute expiry.
- Both middleware and locked admin mutation checks accept fresh TOTP/Passkey, deny weaker methods and timestamps outside policy, and preserve access revocation. Ordinary admin reads require strong MFA but do not prompt again solely because five minutes passed; sensitive evidence reads still require freshness.
- Browser tests cover Admin Passkey login, fresh-assurance reuse, stale-assurance modal with both methods, cancellation without executing the operation, CSRF-protected retry after Passkey, and reuse for a subsequent operation.
- Phone reminders appear only when the provider is enabled and the account is unverified; CTA focuses Thai phone entry, no SMS sends on its own, and the reminder disappears after the complete mocked Firebase/server verification flow. Required-phone accounts remain gated. Mobile layout has no horizontal overflow.
- HostAtom deployment, real authenticator testing on the production RP ID, provider configuration/delivery, database grants and independent security review remain operator checks; local results do not certify them.

## Current Node maintenance / waiting-room revision — 2026-10-04

- Server + React typecheck and production build pass. Existing dependencies were reused; no package or lockfile change. Secret-bearing `.env` values were preserved; only `BACKGROUND_JOBS_ENABLED=true` was added and file permissions remain 0600.
- Full backend suite on isolated loopback MariaDB: **127 passed, 0 failed, 1 skipped** (installer needs a fresh database). The separate fresh installer check then **1 passed** through seven migrations, including partial-DDL retry, checksum protection and permanent lock. **128 distinct backend checks passed across these runs**, not one combined output.
- Local Redis 7.4.11 was built in a temporary folder from the official archive with SHA-256 verified against redis-hashes. It listened only on 127.0.0.1:36380, with persistence disabled and a 64 MB/noeviction test limit. No Upstash instance or real Redis credentials were used. Tests found and fixed a connection-start race: all concurrent callers now await the same connection promise before sending commands; queued commands are bounded.
- Queue tests cover concurrent tabs, shared dispatch budget, FIFO ordering, cookie/Service binding, expiry, capacity/IP limits, single-use redemption and account cooldown, forged parameters, cross-origin rejection, bypass attempts, pending MFA, admin TOTP and audit rollback, successful policy change and Redis unavailability. The augmented real gate suite was rechecked: **5 passed**. This is not a high-load/eviction/provider-failover benchmark.
- Session-control tests prove scoped API-key revocation cannot revoke another Service or the global SSO session; logout-all requires own full session/CSRF and rolls back on audit failure. Existing Google/MFA/role/PKCE/audit regression tests remain passing. A rejected extra branding query now returns 400 rather than being silently ignored; the contract and test were updated to reflect this intentional tightening.
- Browser suite: **23 passed**. A subsequent run of the four queue/session scenarios (including a new admin policy/step-up/scope-default check) also passed: **24 distinct browser scenarios** across runs. Mobile waiting-room screenshot was inspected; no overflow, real login, email, LINE message or SMS was used.
- Scheduler tests cover startup catch-up, independent cadences, no overlap, abort/graceful stop, sanitized failure/retry, busy-lock retry, disabled/install mode and bounded cleanup. MariaDB tests verify named lock ownership survives transaction commit and is released after failure; live rows/audit records survive expiry cleanup. MFA evidence destruction/retention regression passes.
- Built server startup was exercised against the local test DB with synthetic provider credentials: evidence purge and credential cleanup completed; operations check correctly reported broad test-account privileges and an old fixture outbox backlog, then detected the drained queue. These expected alerts are not a claim that HostAtom production grants are correct. No actual provider calls were made.
- No HostAtom migration/deployment, Plesk/OS configuration, live Redis policy, production traffic test, backup upload, external messages or secret rotation was performed. FIFO stays disabled by default per Service. Node timers pause while Passenger is stopped and catch up at startup; an internal scheduler does not guarantee execution while the process is down.

Reproduction uses synthetic settings and a disposable `_test` MariaDB schema. Queue integration requires `RUN_QUEUE_TESTS=1`, `RUN_DB_TESTS=1` and `QUEUE_TEST_REDIS_URL=redis://127.0.0.1:36380`; guards reject other Redis hosts/ports. See [queue contract](WAITING-ROOM.md) and [HostAtom upgrade](HOSTATOM-RELEASE.md). Browser API responses are simulated; they are not evidence of live Google/LINE/Firebase integration.

## Earlier additional-factor / deployment revision — 2026-09-30 (UTC)

- Server + React typecheck and production build pass. Firebase browser SDK and WebAuthn UI helpers are dynamically imported; existing public homepage remains separately bundled.
- Full backend run after adding factors/metrics: **108 passed, 0 failed, 1 installer scenario skipped** in the reused DB. Fresh empty-database installer separately **1 passed** through all six migrations. A final dependency compatibility regression separately **1 passed** after the uuid patch: **110 distinct backend checks passed across these runs**, not one combined test output.
- Chrome browser suite: **20 passed**. The five additional-factor/admin scenarios were rechecked successfully after the 60-second countdown/mobile reCAPTCHA adjustment. The screenshot was inspected for layout; no real account or phone was used.
- WebAuthn integration uses Chrome CDP virtual authenticator and real key signatures: registration, RP/origin, required user verification, credential ownership, cookie-token rotation and replay rejection. LINE tests use a simulated HTTP provider plus actual raw-body HMAC webhook validation: OAuth state/nonce ownership, wrong sender, wrong/declined choice, replay, cooldown and delivery failure. No real LINE push was sent.
- Firebase tests exercise fresh phone-provider claim validation, session/phone binding, encrypted storage, uniqueness, expired proof, required-phone authorization gate and UI notice gating. Firebase Admin SDK verifies issuer/audience/signature/revocation in production; live Firebase/reCAPTCHA/SMS delivery still requires configured staging credentials. No real SMS was sent and no Firebase user was created by these tests.
- Kill-switch regression proves durable audit failure rolls back revocation, and successful revocation preserves account/MFA/membership. Browser test proves the Users action calls the sessions endpoint and retains the directory entry. Metrics test checks disabled/unauthenticated/authorized behavior and absence of identity/secret output.
- Release allowlist/secret/symlink test: **1 passed**. Offline deployment/evidence-directory tests: **2 passed** (also part of the backend run). An actual local MariaDB Unix-socket query confirmed UTC initialization. Docker runtime was not tested because no local Docker daemon was available.
- Dependency audit initially found 2 moderate transitive findings from optional Google Storage → gaxios 6 → uuid 9. Standard `npm audit fix` could not resolve them. A scoped `gaxios@^6.0.0` override now resolves uuid **11.1.1**, preserving the CommonJS v4 API; regression checks v4 and the patched v5 buffer-bound rejection. Final `npm audit --omit=dev`: **0 known vulnerabilities reported**. This is an advisory-database result, not proof that the application has no vulnerabilities. See [upstream advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq).
- Local production preflight intentionally fails on the existing development configuration: NODE_ENV, leftover installer token, public DB endpoint without TLS. It does not overwrite those user settings. Host deployment must use production mode, disabled/cleared installer and host-provided localhost/socket or verified TLS, then run checks on that host.
- `.env` received only missing option names/defaults (LINE/Firebase disabled) with 0600 permissions; existing credential values were preserved and are excluded from release archives. No HostAtom migration/deployment, DNS changes, provider-console writes or messages to users were performed.

Reproduction: backend tests require the isolated loopback `_test` database and synthetic configuration; the installer test requires a newly created `cusa_install_<digits>_test` schema. Browser tests use local port 4188 and synthetic routes, and never authenticate a user from demo data. See [provider setup](ADDITIONAL-FACTORS.md), [review decisions](DELTA-REVIEW.md), [release steps](HOSTATOM-RELEASE.md). Local logs were saved under `/private/tmp/cusa-delta-*`; the repository contains the tests, while these temporary logs are not part of a release.

## Earlier security / recovery revision — 2026-09-30

- Server and web typecheck/build pass. Production frontend uses route/code splitting for legal, installer, workspace and API docs.
- Final full backend run: **92 passed, 0 failed**, with the installer scenario intentionally skipped in the reused local test DB (93 total). Includes the stopped-audit-worker fail-closed regression.
- Fresh-database installer run: **1 passed**, exercising all five migrations, checksum protection, interrupted DDL retry, transactional bootstrap rollback, concurrency and permanent lock. Together with the backend run this covers **93 checks**; these were separate runs, not one combined output.
- Browser suite: **15 passed** (Chrome, local built server). Final image-ready guard was rechecked with **2 passing** owner-upload/admin-review browser scenarios against the final production build after the guard changed.
- Actual local MariaDB runtime grant probe: audit INSERT permitted; zero-row UPDATE/DELETE on audit_logs, UPDATE installation_state and DELETE schema_migrations rejected with ER_TABLEACCESS_DENIED_ERROR. Read-only operations check returned `{ok:true,queue:{pending:0,oldestAgeSeconds:0},issues:[]}` for this disposable restricted account. This is not proof of HostAtom grants.
- Evidence tests cover JPEG/PNG decoding, metadata removal, watermarking, AES-GCM tamper detection and request binding, 0700/0600 permissions, symlink/traversal rejection, CSRF/owner isolation, fresh TOTP access, two other reviewers for admin targets, stale-factor rejection, missing-file rejection, audit rollback, concurrent single decision, session/recovery revocation, expiry and idempotent destruction.
- OTP tests cover six input boxes/paste/leading zero, Ref binding, cross-session cooldown, reload persistence, mail-failure invalidation, escaped registered Service purpose and CUSA SSO MIME sender. Email preview uses synthetic code/Ref only; no Gmail message was sent.
- API docs browser check resolves all local OpenAPI references, tests endpoint search/mobile layout/download; BFF example passes `node --check`. This does not assert third-party OAuth/OIDC certification.
- New MFA_EVIDENCE_KEY was generated only in ignored local .env, with file mode0600; no value is included in logs/docs. Tests override it with synthetic keys and temporary private directories. No image with real personal data was used.

Artifacts: `test-results/` for browser screenshots (regenerated per run), [OTP email preview](previews/otp-email.html), [Google branding PNG](../web/public/cusa-sso.png). Deployment instructions: [Security upgrade](SECURITY-UPGRADE.md), [MFA recovery](MFA-RESET.md), [Google branding](GOOGLE-BRANDING.md).

Remaining environment checks: actual Google Login/Gmail delivery and Gmail inbox rendering; Google Search Console/branding approval; HostAtom proxy/header sanitization; real runtime grants; scheduled jobs, alerts and backup/snapshot exclusions; production load; legal/privacy review and independent penetration test. No hosting migrations, real email delivery, DNS changes or deployment were performed during this security implementation.

## Earlier validation and setup history

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
