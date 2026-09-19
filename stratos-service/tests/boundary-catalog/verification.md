# Boundary administration verification

Validation uses local fixtures and local PostgreSQL. No remote host or deployment is required.

## Behavior and builds

- The complete service suite passed: 1,567 tests in 130 files, including PostgreSQL. Later focused regression runs passed after additional tests and the worker error-handler cleanup.
- Core boundary-domain tests and service-enrollment parsing tests passed.
- Core, client, service and admin UI typechecks/builds passed; the public docs build passed.
- The admin UI passed 19 tests and desktop, narrow-mobile and dark-mode browser workflow checks. Its reusable browser smoke script is in `admin-ui/tests/browser-smoke.mjs`.
- Generated lexicons must be regenerated **after** formatting source JSON. The generator preserves JSON whitespace; check regeneration leaves `stratos-client/src/lexicons.gen.ts` unchanged.

## Scoped mutation checks

Mutation runs used isolated copies (`inPlace: false`) to avoid rewriting another worker's source. They kept the repository thresholds and included every changed behavior file, with changed-line ranges for existing large modules.

- Core boundary validation: 79/79 detected. Service enrollment parser: 69/69 killed.
- New service feature files: credential access, enrollment store, XRPC handler and storage behavior passed. Worker lifecycle survivors were addressed with periodic retry, shared drain, shutdown and optional logging regression tests.
- SQLite migrations and store behavior were exercised with real databases. Separate PostgreSQL runs detected all 11 adapter mutants and all six PostgreSQL migration mutants; the fixture resets catalog tables and the guard function before each migration run so prior state cannot mask missing DDL.
- Existing runtime wiring was checked on changed lines, including startup normalization, durable invalidation, application policy, credential revision, OAuth refresh and service reconciliation. Follow-up tests address its behavior-changing survivors.
- Subscription revocation: 48/48 killed, with 81 focused tests.
- Admin UI: 73/73 killed.

Four residual mutants are equivalent, rather than uncovered behavior:

1. Changing the absent-room catalog fallback from `[]` to a string-only array cannot match a boundary or reserve a valid string room ID: the placeholder has no `boundary` or `id` property.
2. Changing the configuration object's initial definitions to a string-only array still yields an empty room list because the placeholder has no `listed` property; a successful refresh replaces the array completely.
3. Changing the initial automatic-enrollment fallback array is erased by the immediately following `splice(0, current.length, ...desired)` before any await or exposure.
4. Replacing the internal `allowList` tag with an empty string still follows the closed-policy path, verifies the client attestation, and checks the same client ID list. The tag never leaves that function. Tests prove permitted clients succeed and unlisted clients fail using actual signed attestations and a local JWKS fixture.

No mutation suppressions or lowered thresholds were added.

## Reproduce relevant checks

From `stratos-service`:

```sh
DOCKER_HOST=unix:///var/run/docker.sock TESTCONTAINERS_RYUK_DISABLED=true pnpm exec vitest run tests/boundary-catalog tests/subscription-revocation.test.ts
pnpm exec stryker run --inPlace false --mutate 'src/features/boundary/configuration.ts,src/features/boundary/credential-access.ts,src/features/boundary/enrollment-store.ts,src/features/boundary/handler.ts,src/features/boundary/manager.ts,src/features/boundary/migrate.ts,src/features/boundary/store.ts' > /tmp/boundary-mutation.log 2>&1
```

Use a dedicated local database if setting `BOUNDARY_TEST_POSTGRES_URL`; the PostgreSQL fixture intentionally resets its catalog tables. Follow `AGENTS.md` when scoping further mutation runs.
