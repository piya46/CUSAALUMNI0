# Validation record

- `npm run typecheck`: passes for server and React.
- `npm run build`: passes; Express TypeScript output and Vite production assets generated.
- Full server suite with `RUN_DB_TESTS=1`: **62 tests passed, 0 failed, 0 skipped** against isolated local MariaDB12.0.2 at127.0.0.1:33307.
- `npm run test:browser`: **3 browser scenarios passed** with installed Chrome, using a separate built-app server at127.0.0.1:4188.
- Migration first run succeeds; rerun reports `Already applied: 001_initial.sql` without repeating DDL.
- Dependency install audit reported0 known vulnerabilities at installation time.

Server coverage includes Google-flow return-path restrictions, cryptographic tampering, OTP/TOTP verification, replay and concurrency, account lockout, recovery codes, session rotation/limits, CSRF/roles, allowlist/soft deletion, API key scopes/audience/revocation, PKCE, cache isolation/effective expiry, transactional audit rollback, worker poison-batch fail-fast, archive checksums and pagination/filter validation.

Browser coverage includes login/setup page, explicit demo mode, every navigation page, adding allowed email, application/API key creation with one-time reveal, key revocation, TOTP QR/recovery UI, mobile drawer/layout and demo reset after reload. Screenshots are generated in ignored `test-results/`.

Integration tests restrict database use to loopback and an explicit name ending `_test`. Fixture cleanup is limited to created IDs; audit evidence remains append-only. Test identities and credentials are synthetic. Browser demo tests never authenticate a real Google account or call Gmail.

Not verified in this workspace: actual Google/Gmail authorization or email delivery, remote MariaDB203.170.190.137 connectivity/certificates, Redis outage/recovery against a running Redis service, Docker image execution (local Docker daemon unavailable), deployment, production load or independent penetration testing. These require target infrastructure/credentials. Architecture claims do not imply compliance certification or guaranteed throughput.
