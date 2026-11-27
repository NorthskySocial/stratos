# Stratos E2E Test Suite

End-to-end tests for the Stratos private namespace service. Exercises OAuth enrollment, record CRUD,
and boundary-based access control against a real PDS and a Dockerized Stratos instance.

## Prerequisites

- Deno ≥ 2.x
- Docker Compose
- Playwright Chromium (for OAuth browser automation)

Install Playwright's Chromium browser:

```bash
npx playwright install chromium
```

Run it again whenever the `playwright` version in the scripts changes. Each
Playwright release needs its own browser build.

## Test Users

| User    | Handle pattern            | Boundaries   |
| ------- | ------------------------- | ------------ |
| Rei     | `rei-{id}.{PDS_HOST}`     | `swordsmith` |
| Sakura  | `sakura-{id}.{PDS_HOST}`  | `swordsmith` |
| kaoruko | `kaoruko-{id}.{PDS_HOST}` | `aekea`      |

Handles include a random 5-digit suffix (`{id}`) to avoid collisions with previous test runs.
`{PDS_HOST}` comes from `test/.env`.

Rei and Sakura share the **swordsmith** boundary. kaoruko is in **aekea** only.

## Configuration

### Test scripts environment (`test/.env`)

The Deno test scripts load `.env` from the `test/` directory. Copy from `.env.example` in the
same directory and fill in the values:

| Variable             | Example                 | Purpose                                                                      |
| -------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| `PDS_HOST`           | `pds.example.com`       | PDS hostname (without protocol) — used for handle construction and API calls |
| `PDS_ADMIN_PASSWORD` | `your-admin-password`   | PDS admin password for account creation/deletion                             |
| `STRATOS_URL`        | `http://localhost:3100` | Stratos service URL the scripts call                                         |
| `USE_OAUTH`          | `true`                  | Enable OAuth enrollment routes (`/oauth/*`)                                  |

If you need to point at a different PDS, update these variables and the user handles in
`scripts/lib/config.ts`.

### Stratos container environment (`.env`)

The Docker Compose file (`docker-compose.test.yml`) loads `.env` from the project root into the
Stratos container via `env_file`. Create it by copying `.env.example` and adjusting for testing:

```bash
cp .env.example .env
```

For the test suite, set `STRATOS_ENROLLMENT_MODE=open`, `STRATOS_ALLOWED_DOMAINS=swordsmith,aekea`
(the reserved all-members domain `general` is implicitly included), and point
`STRATOS_ALLOWED_PDS_ENDPOINTS` at your PDS. `USE_OAUTH=true` must be set or the OAuth
routes won't be registered and enrollment will fail with "Cannot GET /oauth/authorize". See
the [project README](../README.md) for the full list of available variables.

### Docker Compose (`docker-compose.test.yml`)

A standalone compose file (does **not** inherit from `docker-compose.yml`) that builds and runs
Stratos for testing:

The compose file defines these services:

- ssl-init — one-shot Alpine container that generates a self-signed TLS certificate (stored in a
  `ssl-certs` volume).
- nginx — reverse proxy that terminates TLS on port `8443` and forwards to Stratos.
- stratos — the Stratos service itself, built from the project `Dockerfile`.
- pds-spaces — a spaces-capable PDS pinned by digest, behind the `spaces-pds` compose profile. It
  starts only for a run that asks for it (see [Spaces PDS phases](#spaces-pds-phases-opt-in)).

Key design choices:

- **Bind mount** (`./test-data:/app/data`): The Stratos SQLite databases are written to `test-data/`
  on the host. This allows Stage 3 to modify `service.sqlite` directly (for boundary configuration)
  without `docker exec`.
- **`ssl-certs` named volume**: Shared between `ssl-init` and `nginx` for TLS certificates.
- **`restart: "no"`**: The container won't auto-restart after `teardown.ts` stops it.

### Starting Docker Compose manually

If you want to start the container outside of the test scripts (e.g. for manual exploration):

```bash
# Build and start
docker compose -f docker-compose.test.yml up -d --build

# Check health
curl http://localhost:3100/health
# → {"status":"ok","version":"0.1.0"}

# View logs
docker compose -f docker-compose.test.yml logs -f

# Stop and clean up
docker compose -f docker-compose.test.yml down --volumes --remove-orphans
rm -rf test-data/
```

### PDS Configuration

The tests require a running PDS. The PDS host and admin password are configured in `scripts/.env`
and are used to create invite codes then three test accounts with randomized handles. The PDS admin
credentials are only used during setup and teardown (to delete the users). After that, all
authentication goes through OAuth and the Stratos API.

## Running

### Full suite

```bash
deno run -A scripts/run-all.ts
```

Runs the stages in order. On any stage failure the remaining stages (except teardown) are
skipped. The default run starts no spaces PDS.

### Spaces PDS phases (opt-in)

Two phases drive a member whose repository lives on a spaces PDS: `test-mixed-mode.ts` and
`test-webapp-mixed-mode.ts`. They run only when the run asks for them:

```bash
deno run -A scripts/run-all.ts --spaces-pds
```

With `--spaces-pds`, `setup.ts` also starts the `pds-spaces` service (compose profile
`spaces-pds`), waits for it and creates its two fixture accounts. The pinned image refuses the
`at:space/` URI spelling, so these two phases cannot pass against it; they are there for the day a
host that accepts the spelling is pinned. To run `setup.ts` on its own with the same choice, set
`STRATOS_E2E_SPACES_PDS=true` in the environment.

The admin phases (`test-admin-api.ts`, `test-admin-ui.ts`) check the PDS-custody member only when
the run asks for a spaces PDS, so a default run needs nothing those two phases create. A deno test
in `test/scripts/lib/phases.test.ts` holds that: it fails if a default-run script reads the PDS
fixture, or calls its PDS-custody check, outside the option.

### Host-free checks

Type-check the scripts and run their unit tests from `test/scripts`. That directory's own
`deno.json` is not a member of the repository's Deno workspace, so these commands use
`test/scripts/deno.lock` and leave it unchanged:

```bash
cd test/scripts
deno check *.ts lib/*.ts
deno test --allow-read --allow-env lib
```

Run from the repository root, `deno check` uses the root `deno.json` workspace and `deno.lock`
instead.

### Public-alpha Clubhouse release check

The Clubhouse check drives a deployed browser session against a real
spaces-capable PDS account. It is intentionally excluded from the local suite:
the account file is operator-owned and should never be committed. With a
pre-enrolled account it verifies sign-in, resolved handle, room status, room
feed, and sign-out without writing. Set the explicit mutation opt-in only when
the account may be enrolled in the selected room and receive disposable posts.

```bash
CLUBHOUSE_PUBLIC_E2E_USERS_FILE=/secure/alpha-users.json \
CLUBHOUSE_PUBLIC_E2E_BROWSER_PATH=/path/to/chromium \
deno run -A scripts/test-clubhouse-public-alpha.ts

CLUBHOUSE_PUBLIC_E2E_USERS_FILE=/secure/alpha-users.json \
CLUBHOUSE_PUBLIC_E2E_BROWSER_PATH=/path/to/chromium \
CLUBHOUSE_PUBLIC_E2E_MUTATE=true \
deno run -A scripts/test-clubhouse-public-alpha.ts
```

The mutation run also starts selected-room enrollment when necessary, waits for
Feedgen reconciliation, creates a PDS-custody topic and reply, checks their
strong references and shareable topic URL, then signs out.

### PostgreSQL mode

Run the full E2E suite against PostgreSQL instead of SQLite:

```bash
deno run -A scripts/run-all.ts --postgres
```

This mode:

1. Starts a `postgres:19-alpine` container alongside Stratos via `docker-compose.postgres.yml`
   overlay
2. Configures the Stratos container with `STORAGE_BACKEND=postgres` and `STRATOS_POSTGRES_URL`

The PostgreSQL compose overlay (`docker-compose.postgres.yml`) adds:

- A `postgres` service with healthcheck
- Overrides on the `stratos` service for PG environment variables and dependency ordering

To start the PostgreSQL stack manually:

```bash
docker compose -f docker-compose.test.yml -f docker-compose.postgres.yml up -d --build
```

If running individual scripts with PostgreSQL, set the environment variable:

```bash
export STRATOS_E2E_BACKEND=postgres
deno run -A scripts/setup.ts
```

### Individual stages

Each script can be run independently. Stages 2–4 require the prior stages to have been run.

```bash
deno run -A scripts/setup.ts
deno run -A scripts/test-enrollment.ts
deno run -A scripts/configure-boundaries.ts
deno run -A scripts/test-posts.ts
deno run -A scripts/teardown.ts
```

## Stages

### Stage 1 — Setup (`setup.ts`)

Creates the test environment from scratch.

**What it does:**

1. Creates three PDS accounts on the configured PDS via the admin API (generating invite codes,
   since the PDS requires them). Skips accounts that already exist.
2. Builds and starts Stratos via `docker-compose -f docker-compose.test.yml up -d --build`.
3. Polls `GET /health` until the service reports `{"status":"ok"}` (up to 60 s).

**Expected output:**

```
Phase 1: Setup
Creating PDS accounts
  ℹ Checking account: rei-12345.pds.example.com
  ℹ Creating invite code for rei-12345.pds.example.com...
  ℹ Creating account rei-12345.pds.example.com...
  ✓ Created rei-12345.pds.example.com — did:plc:...
  ...same for sakura and kaoruko...

Starting Stratos
  ℹ Building and starting container...
  ✓ Container started
  ℹ Waiting for Stratos to become healthy...
  ✓ Stratos is healthy
  ✓ Setup complete
```

**State persisted:** `test-data/test-state.json` — contains each user's DID, handle, and password.

---

### Stage 2 — OAuth Enrollment (`test-enrollment.ts`)

Enrolls all three users via the real PDS OAuth authorization flow.

**What it does:**

1. Launches headless Chromium via Playwright.
2. For each user:
   - Navigates to `http://localhost:3100/oauth/authorize?handle=<handle>`.
   - Stratos initiates a PAR and redirects to the PDS OAuth sign-in page.
   - Fills the password field (username is pre-filled via `login_hint`) and submits.
   - Clicks the consent/authorize button on the PDS approval page.
   - PDS redirects back to Stratos `/oauth/callback`, which completes enrollment.
   - Verifies enrollment via `GET /xrpc/zone.stratos.enrollment.status?did=<did>`.
3. Saves screenshots to `test-data/screenshots/` at each step (useful for debugging selector
   issues).

**Expected output:**

```
Phase 2: OAuth Enrollment
  ℹ Launching headless browser...
  ℹ Enrolling Rei (rei-12345.pds.example.com)...
  ✓ Rei enrolled successfully — did:plc:...
  ℹ Enrolling Sakura (sakura-12345.pds.example.com)...
  ✓ Sakura enrolled successfully — did:plc:...
  ℹ Enrolling kaoruko (kaoruko-12345.pds.example.com)...
  ✓ kaoruko enrolled successfully — did:plc:...

Enrollment Summary
  ℹ 3 enrolled, 0 failed
```

**On failure:** Check `test-data/screenshots/` for page captures at each step.

---

### Stage 3 — Configure Boundaries (`configure-boundaries.ts`)

Assigns per-user boundaries through the admin API to create the asymmetric test scenario.

**What it does:**

1. Logs in as the admin operator via the real OAuth flow (headless Chromium) and captures the
   admin session cookie. The cookie is persisted to `test-state.json` for later phases.
2. Sets each user's boundaries via `zone.stratos.admin.setBoundaries`:
   - Rei → `[swordsmith]`
   - Sakura → `[swordsmith]`
   - kaoruko → `[aekea]`
3. Verifies three surfaces per user: the mutation response, the admin read-back
   (`listEnrollments`), and the rewritten enrollment record on the user's PDS.

**Expected output:**

```
Phase 3: Configure Boundaries
  ℹ Setting boundaries for Rei: [swordsmith]
  ✓ Rei boundaries set — [swordsmith]
  ℹ Setting boundaries for Sakura: [swordsmith]
  ✓ Sakura boundaries set — [swordsmith]
  ℹ Setting boundaries for kaoruko: [aekea]
  ✓ kaoruko boundaries set — [aekea]

Boundary Configuration Summary
  ℹ 3 configured, 0 failed
```

---

### Stage 4 — Post CRUD & Boundary Tests (`test-posts.ts`)

The main test stage. Validates record creation, retrieval, boundary filtering, and deletion.

All API calls use `Authorization: Bearer <did>` for authentication, which works because the OAuth
sessions from Stage 2 are stored in Stratos's database.

**Tests:**

| #   | Test                                                 | Endpoint                                      | Expected                                 |
| --- | ---------------------------------------------------- | --------------------------------------------- | ---------------------------------------- |
| 1   | Rei creates a post with `swordsmith` boundary        | `POST com.atproto.repo.createRecord`          | 200 — returns `uri` and `cid`            |
| 2   | Rei reads own post                                   | `GET com.atproto.repo.getRecord` as Rei       | 200 — full record with text and boundary |
| 3   | Sakura reads Rei's post (shared boundary)            | `GET com.atproto.repo.getRecord` as Sakura    | 200 — record returned                    |
| 4   | kaoruko denied Rei's post (no boundary intersection) | `GET com.atproto.repo.getRecord` as kaoruko   | 400 `RecordNotFound` (opaque denial)     |
| 5   | Unauthenticated caller denied                        | `GET com.atproto.repo.getRecord` no auth      | 400 `RecordNotFound`                     |
| 6a  | Sakura `listRecords` sees Rei's post                 | `GET com.atproto.repo.listRecords` as Sakura  | records array length > 0                 |
| 6b  | kaoruko `listRecords` filtered out                   | `GET com.atproto.repo.listRecords` as kaoruko | empty records array                      |
| 6c  | Unauthenticated `listRecords` filtered out           | `GET com.atproto.repo.listRecords` no auth    | empty records array                      |
| 7a  | kaoruko creates an `aekea` post                      | `POST com.atproto.repo.createRecord`          | 200 — returns `uri` and `cid`            |
| 7b  | Rei denied kaoruko's `aekea` post                    | `GET com.atproto.repo.getRecord` as Rei       | 400 `RecordNotFound`                     |
| 7c  | kaoruko reads own `aekea` post                       | `GET com.atproto.repo.getRecord` as kaoruko   | 200 — record returned                    |
| 8a  | Rei deletes own post                                 | `POST com.atproto.repo.deleteRecord`          | 200                                      |
| 8b  | Deleted post no longer retrievable                   | `GET com.atproto.repo.getRecord` as Rei       | 400 `RecordNotFound`                     |
| 8c  | kaoruko deletes own post                             | `POST com.atproto.repo.deleteRecord`          | 200                                      |

**Expected output:**

```
Phase 4: Post CRUD & Boundary Tests

Test 1: Create post with boundary
  ✓ Rei created post — at://did:plc:.../zone.stratos.feed.post/...

Test 2: Owner retrieves own post
  ✓ Rei reads own post — URI matches
  ✓ Rei reads own post — text matches
  ✓ Rei reads own post — boundary is swordsmith

Test 3: Same-boundary user reads post
  ✓ Sakura reads Rei's post (shared swordsmith boundary) — at://...

Test 4: Cross-boundary user denied
  ✓ kaoruko denied Rei's post (aekea ≠ swordsmith) — status=400

Test 5: Unauthenticated access denied
  ✓ Unauthenticated caller denied — status=400

Test 6: listRecords boundary filtering
  ✓ Sakura listRecords — sees Rei's post — count=1
  ✓ kaoruko listRecords — empty (no swordsmith boundary) — count=0
  ✓ Unauthenticated listRecords — empty — count=0

Test 7: kaoruko writes aekea-scoped post
  ✓ kaoruko created aekea post — at://...
  ✓ Rei denied kaoruko's aekea post (swordsmith ≠ aekea) — status=400
  ✓ kaoruko reads own aekea post

Test 8: Delete records
  ✓ Rei's swordsmith post deleted
  ✓ Rei's post no longer retrievable after delete
  ✓ kaoruko's aekea post deleted

Results: 15/15 passed
```

---

### Stage 4b — Spaces (`test-spaces.ts`)

Validates the permissioned-spaces (0016-shaped) flow end to end: a PDS user who is a **member of
a space** obtains a space credential and uses it to read and sync records hosted **only in
Stratos** (Reading A: Stratos is the repo host).

| #   | Test                                            | What it proves                                             |
| --- | ----------------------------------------------- | ---------------------------------------------------------- |
| 1   | Member obtains a space credential               | membership → `getSpaceCredential` → JWT + expiry           |
| 2   | Non-member is denied a credential               | `NotEnrolled` gating                                       |
| 3   | Foreign / malformed space URIs rejected         | `at:space/…` addressing enforced                           |
| 4   | Credential-authed read of a member record       | credential admits the space, not a user identity           |
| 5   | Credential fails closed on out-of-space records | no cross-space leakage                                     |
| 6   | Pull sync (`listRepoOps`) with a credential     | syncer flow: boundary-gated ops + signed head commit       |
| 7   | Writes never accept a credential                | credentials are read/sync capabilities; writes stay bound  |
| 8   | Revocation invalidates future credentials       | boundary removal → `NotEnrolled`                           |
| 9   | Migration anchors                               | single-boundary records, no PDS post records, `signingKey` |

---

### Stage 5 — Teardown (`teardown.ts`)

Cleans up the test environment.

**What it does:**

1. Deletes the three test accounts from the PDS via the admin API.
2. Runs `docker compose -f docker-compose.test.yml stop` to stop the containers.

**Expected output:**

```
Teardown
  ℹ Deleting test accounts from PDS...
  ✓ Deleted rei-12345.pds.example.com (did:plc:...)
  ✓ Deleted sakura-12345.pds.example.com (did:plc:...)
  ✓ Deleted kaoruko-12345.pds.example.com (did:plc:...)
  ℹ Stopping Stratos container...
  ✓ Container stopped
  ℹ Teardown complete
```

## Files

```

└── scripts/
    ├── .env.example                   # Template for test scripts environment
    ├── deno.json                      # Deno config (isolates from project tsconfig)
    ├── setup.ts                       # Stage 1: PDS accounts + start Stratos
    ├── test-enrollment.ts             # Stage 2: OAuth enrollment via Playwright
    ├── configure-boundaries.ts        # Stage 3: Boundary assignment via the admin API
    ├── test-posts.ts                  # Stage 4: CRUD + boundary access tests
    ├── teardown.ts                    # Stage 5: Cleanup
    ├── run-all.ts                     # Orchestrator (all stages)
    └── lib/
        ├── admin.ts                   # Admin API fetch helpers + PDS boundary polling
        ├── admin-login.ts             # Admin OAuth login via Playwright
        ├── backend.ts                 # Storage backend / appview env switches
        ├── config.ts                  # Test constants and user definitions
        ├── config.test.ts             # Host-free test of the space URI formatter
        ├── log.ts                     # Colored test output helpers
        ├── phases.ts                  # Ordered phase list and the --spaces-pds option
        ├── phases.test.ts             # Host-free test of the phase list in both modes
        ├── pds.ts                     # PDS admin API (invite codes, accounts)
        ├── state.ts                   # Test state persistence between stages
        └── stratos.ts                 # Stratos XRPC API helpers
```

## Troubleshooting

**Stratos fails to start**
Check container logs: `docker compose -f docker-compose.test.yml logs`

**OAuth enrollment fails**
Inspect screenshots in `test-data/screenshots/`. The PDS OAuth UI may have changed selectors.

If you see **"Cannot GET /oauth/authorize"**, `USE_OAUTH` is not set to `true` in `.env`. This env
var gates whether Stratos registers OAuth routes at all.

**Boundary configuration fails**
The stage needs a working admin OAuth login (the operator DID is injected into
`STRATOS_ADMIN_DIDS` at setup). Inspect `test-data/screenshots/` for the login flow captures.

**"No valid session for user" on API calls**
The `Bearer <did>` auth validates against OAuth sessions first, then falls back to enrollment check.
Re-run `test-enrollment.ts` if authentication fails.

## Mutation testing for TypeScript changes

Mutation testing (StrykerJS) exists to validate that tests actually catch regressions — it is the
primary gate for trusting AI-generated code and the tests that accompany it. It is **not**
CI-enforced; it is a local verification step the agent is responsible for running.

**Scope the run to the files you changed.** Do not run the whole package config
(`pnpm --filter <package> mutation`): a full `stratos-service` sweep is 5,600+ mutants and takes
about three hours, and it reports overwhelmingly on code you did not touch. Scope it instead:

```bash
cd <package> && pnpm exec stryker run --mutate 'src/a/changed.ts,src/b/changed.ts' \
  > stratos-mutation.log 2>&1
```

Do not append `; echo exit=$?`. That reports the status of `echo`, which always succeeds, so a
Stryker run that broke the threshold looks green. Let the command return its own status.

Three traps that make a scoped run lie to you:

- **Repeated `--mutate` flags do not accumulate — the last one silently wins.** Passing
  `--mutate 'a.ts' --mutate 'b.ts'` mutates only `b.ts` and still reports a healthy score. Use ONE
  flag with a comma-separated list, then confirm every expected filename appears in the results
  table before believing the number.
- **`--mutate` replaces the configured `mutate` list, including its exclusions.** Stryker merges CLI
  options over the config file, and an array override wins whole, so `!src/**/index.ts` and
  `!src/**/*.d.ts` stop applying. Name only the changed source files you mean to mutate; a barrel or
  a declaration file passed by hand will be mutated.
- The configs set `inPlace: true`, so Stryker rewrites sources on disk while it runs. Never pipe its
  output into `head`/`grep` — the closed pipe kills it mid-run and leaves mutated files behind.
  Always redirect to a file. Delete a stale `<package>/reports/stryker-incremental.json` first, or it
  will serve results from a previous, differently-scoped run.

When a change requires adding or running tests to validate behaviour, you MUST:

- Run scoped mutation testing on the files you changed and address surviving mutants before
  considering the work done. A green test suite alone is insufficient.
- Judge survivors **on the lines your change touched**. Pulling a file into `mutate` scope for the
  first time surfaces its pre-existing survivors too; those are not yours to fix, and they are not a
  reason to abandon the gate.
- Check whether the `mutate` globs in `stryker.config.json` already cover a new file you added
  (broad globs like `src/auth/**/*.ts` usually do) and add an entry only if none matches.
- Treat surviving mutants in changed code as a signal that the tests are weak — strengthen the tests,
  or review the code and improve it. Never weaken the thresholds. If a mutant is unkillable because
  the branch is genuinely unreachable, delete the dead branch rather than testing around it.

Note: `stratos-service`'s package-wide score is currently **below** its `break: 60` threshold
(pre-existing, dominated by uncovered dead code). A failing full-package run is therefore not by
itself evidence that your change regressed anything.
