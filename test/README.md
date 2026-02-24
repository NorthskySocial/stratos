# Stratos E2E Test Suite

End-to-end tests for the Stratos private namespace service. Exercises OAuth enrollment, record CRUD, and boundary-based access control against a real PDS and a Dockerized Stratos instance.

## Prerequisites

- Deno ≥ 2.x
- Docker Compose
- Playwright Chromium (for OAuth browser automation)

Install Playwright's Chromium browser (one-time):

```bash
npx playwright install chromium
```

## Test Users

| User    | Handle pattern            | Boundaries   |
| ------- | ------------------------- | ------------ |
| Rei     | `rei-{id}.{PDS_HOST}`     | `swordsmith` |
| Sakura  | `sakura-{id}.{PDS_HOST}`  | `swordsmith` |
| kaoruko | `kaoruko-{id}.{PDS_HOST}` | `aekea`      |

Handles include a random 5-digit suffix (`{id}`) to avoid collisions with previous test runs. `{PDS_HOST}` comes from `scripts/.env`.

Rei and Sakura share the **swordsmith** boundary. kaoruko is in **aekea** only.

## Configuration

### Test scripts environment (`scripts/.env`)

The Deno test scripts load their own `.env` from `scripts/.env`. Copy from `.env.example` in the same directory and fill in the values:

| Variable               | Example                   | Purpose                                                                      |
| ---------------------- | ------------------------- | ---------------------------------------------------------------------------- |
| `PDS_HOST`             | `pds.example.com`         | PDS hostname (without protocol) — used for handle construction and API calls |
| `PDS_ADMIN_PASSWORD`   | `your-admin-password`     | PDS admin password for account creation/deletion                             |
| `STRATOS_URL`          | `http://localhost:3100`   | Stratos service URL the scripts call                                         |
| `STRATOS_OAUTH_ISSUER` | `https://pds.example.com` | PDS OAuth issuer URL — **required** to enable `/oauth/*` routes              |

If you need to point at a different PDS, update these variables and the user handles in `scripts/lib/config.ts`.

### Stratos container environment (`.env.test`)

The Docker Compose file (`docker-compose.test.yml`) loads `.env.test` from the project root into the Stratos container via `env_file`. Create it by copying `.env.example` and adjusting for testing:

```bash
cp .env.example .env.test
```

For the test suite, set `STRATOS_ENROLLMENT_MODE=open`, `STRATOS_ALLOWED_DOMAINS=swordsmith,aekea`, and point `STRATOS_ALLOWED_PDS_ENDPOINTS` / `STRATOS_OAUTH_ISSUER` at your PDS. `STRATOS_OAUTH_ISSUER` must be set to a valid URL (e.g., `https://pds.example.com`) or the OAuth routes won't be registered and enrollment will fail with "Cannot GET /oauth/authorize". See the [project README](../README.md) for the full list of available variables.

### Docker Compose (`docker-compose.test.yml`)

A standalone compose file (does **not** inherit from `docker-compose.yml`) that builds and runs Stratos for testing:

The compose file defines three services:

- ssl-init — one-shot Alpine container that generates a self-signed TLS certificate (stored in a `ssl-certs` volume).
- nginx — reverse proxy that terminates TLS on port `8443` and forwards to Stratos.
- stratos — the Stratos service itself, built from the project `Dockerfile`.

Key design choices:

- **Bind mount** (`./test-data:/app/data`): The Stratos SQLite databases are written to `test-data/` on the host. This allows Stage 3 to modify `service.sqlite` directly (for boundary configuration) without `docker exec`.
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

The tests require a running PDS. The PDS host and admin password are configured in `scripts/.env` and are used to create invite codes then three test accounts with randomized handles. The PDS admin credentials are only used during setup and teardown (to delete the users). After that, all authentication goes through OAuth and the Stratos API.

## Running

### Full suite

```bash
deno run -A scripts/run-all.ts
```

Runs all five stages in order. On any stage failure the remaining stages (except teardown) are skipped.

### Direct mode (bypass OAuth)

If you cannot use Playwright browser automation (e.g., headless environment, PDS OAuth issues), use `--direct` to bypass OAuth enrollment:

```bash
deno run -A scripts/run-all.ts --direct
```

This mode:

1. Skips Stage 2 (OAuth enrollment via Playwright)
2. Instead runs `direct-enroll.ts` which:
   - Inserts enrollment rows directly into `service.sqlite`
   - Creates actor store directories and databases under `test-data/actors/`
   - Authenticates via `Bearer <did>` header (enrollment check falls back to database lookup)

Direct mode is useful when:

- Playwright/Chromium setup is unavailable
- PDS OAuth flow is broken or changed
- You need faster iteration on boundary/record tests

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

1. Creates three PDS accounts on the configured PDS via the admin API (generating invite codes, since the PDS requires them). Skips accounts that already exist.
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
   - Verifies enrollment via `GET /xrpc/app.stratos.enrollment.status?did=<did>`.
3. Saves screenshots to `test-data/screenshots/` at each step (useful for debugging selector issues).

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

Adjusts per-user boundaries in the Stratos service database.

By default, OAuth enrollment assigns all configured domains (`swordsmith` + `aekea`) to every user. This stage narrows them to create the asymmetric test scenario.

**What it does:**

1. Opens `test-data/service.sqlite` directly from the host (bind-mounted volume).
2. Replaces each user's `enrollment_boundary` rows:
   - Rei → `[swordsmith]`
   - Sakura → `[swordsmith]`
   - kaoruko → `[aekea]`
3. Reads back and verifies the boundaries match expectations.

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

All API calls use `Authorization: Bearer <did>` for authentication, which works because the OAuth sessions from Stage 2 are stored in Stratos's database.

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
  ✓ Rei created post — at://did:plc:.../app.stratos.feed.post/...

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
    ├── direct-enroll.ts               # Stage 2 alternative: Direct DB enrollment (--direct mode)
    ├── configure-boundaries.ts        # Stage 3: Per-user boundary assignment
    ├── test-posts.ts                  # Stage 4: CRUD + boundary access tests
    ├── teardown.ts                    # Stage 5: Cleanup
    ├── run-all.ts                     # Orchestrator (all stages, supports --direct flag)
    └── lib/
        ├── config.ts                  # Test constants and user definitions
        ├── db.ts                      # Direct SQLite access (enrollment + actor store creation)
        ├── log.ts                     # Colored test output helpers
        ├── pds.ts                     # PDS admin API (invite codes, accounts)
        ├── state.ts                   # Test state persistence between stages
        └── stratos.ts                 # Stratos XRPC API helpers
```

## Troubleshooting

**Stratos fails to start**
Check container logs: `docker compose -f docker-compose.test.yml logs`

**OAuth enrollment fails**
Inspect screenshots in `test-data/screenshots/`. The PDS OAuth UI may have changed selectors.

If you see **"Cannot GET /oauth/authorize"**, `STRATOS_OAUTH_ISSUER` is not set (or is empty) in `.env`. This env var gates whether Stratos registers OAuth routes at all. Set it to your PDS URL (e.g., `https://pds.example.com`).

**Boundary configuration fails**
Ensure the container has written to `test-data/service.sqlite` (the SQLite DB is created on first request, not on startup). Verify the bind mount: `ls -la test-data/`.

**"No valid session for user" on API calls**
The `Bearer <did>` auth validates against OAuth sessions first, then falls back to enrollment check. If using `--direct` mode, ensure enrollment rows exist in `service.sqlite`. Re-run enrollment (or `direct-enroll.ts`) if authentication fails.
