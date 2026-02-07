# Stratos E2E Test Suite

End-to-end tests for the Stratos private namespace service. Exercises OAuth enrollment, record CRUD, and boundary-based access control against a real PDS and a Dockerized Stratos instance.

## Prerequisites

- Deno ≥ 2.x
- Docker
- Playwright Chromium for OAuth flow validation

Install Playwright's Chromium browser (one-time):

```bash
npx playwright install chromium
```

## Test Users

| User     | Boundaries   |
|----------|--------------|
| Rei      | `swordsmith` |
| Sakura   | `swordsmith` |
| kaoruko  | `aekea`      |

Rei and Sakura share the **swordsmith** boundary. kaoruko is in **aekea** only.

## Configuration

### Environment (`.env.test`)

The test suite uses `.env.test` at the project root. This file is created for you and ships with the repo (gitignored). Key variables:

| Variable | Value | Purpose |
|----------|-------|---------|
| `STRATOS_SERVICE_DID` | `did:web:localhost` | Service identity for local testing |
| `STRATOS_PUBLIC_URL` | `http://localhost:3100` | Public URL; also used as the OAuth `client_id` (ATProto loopback client) |
| `STRATOS_ALLOWED_DOMAINS` | `swordsmith,aekea` | Boundary domains available in this Stratos instance |
| `STRATOS_ENROLLMENT_MODE` | `open` | Allows any DID from the allowed PDS to enroll |
| `STRATOS_ALLOWED_PDS_ENDPOINTS` | `https://pds.host.com` | Restricts enrollment to accounts on this PDS |
| `STRATOS_OAUTH_ISSUER` | `https://pds.host.com` | Enables the OAuth client — required for the Playwright enrollment flow |
| `STRATOS_ADMIN_PASSWORD` | `stratos-test-admin` | Admin auth (available but not used by the test scripts directly) |
| `LOG_LEVEL` | `debug` | Verbose logging for troubleshooting |

If you need to point at a different PDS, update `STRATOS_OAUTH_ISSUER`, `STRATOS_ALLOWED_PDS_ENDPOINTS`, and the user handles in `test/scripts/lib/config.ts`.

### Starting Docker Compose manually

If you want to start the container outside of the test scripts:

```bash

docker compose -f docker-compose.test.yml up -d --build

```

### PDS Configuration

The tests require a running PDS. The PDS admin password is configured in `.env` and is used to generate invite codes used to create the test accounts.

The PDS admin credentials are only used during setup and teardown to delete the accounts. After that, all authentication goes through OAuth and the Stratos API.

## Running

### Full suite

```bash
deno run -A test/scripts/run-all.ts
```

Runs all five stages in order. On any stage failure the remaining stages (except teardown) are skipped.

### Direct mode (bypass OAuth)

If you cannot use Playwright browser automation (e.g., headless environment, PDS OAuth issues), use `--direct` to bypass OAuth enrollment:

```bash
deno run -A test/scripts/run-all.ts --direct
```

This mode:
1. Skips stage 2 (OAuth enrollment via Playwright)
2. Instead runs `direct-enroll.ts` which:
   - Inserts enrollment rows directly into `service.sqlite`
   - Creates actor store directories and databases under `test-data/actors/`
   - Authenticates via `Bearer <did>` header (enrollment check falls back to database lookup)

Direct mode is useful when:
- Playwright/Chromium setup is unavailable
- PDS OAuth flow is broken or changed
- You need faster iteration on boundary/record tests

### Individual stages

Each script can be run independently. stages 2–4 require the prior stages to have been run.

```bash
deno run -A test/scripts/setup.ts
deno run -A test/scripts/test-enrollment.ts
deno run -A test/scripts/configure-boundaries.ts
deno run -A test/scripts/test-posts.ts
deno run -A test/scripts/teardown.ts
```

## Stages

### Stage 1 — Setup (`setup.ts`)

Creates the test environment from scratch.

**What it does:**
1. Creates three PDS accounts on the pds via the admin API (generating invite codes, since the PDS requires them). Skips accounts that already exist.
2. Builds and starts Stratos via `docker compose -f docker-compose.test.yml up -d --build`.
3. Polls `GET /health` until the service reports `{"status":"ok"}` (up to 60 s).

**Expected output:**
```
stage 1: Setup
  ℹ Preparing test-data directory...

Creating PDS accounts
  ℹ Checking account: rei.pds.host.com
  ℹ Creating invite code for rei.pds.host.com...
  ℹ Creating account rei.pds.host.com...
  ✓ Created rei.pds.host.com — did:plc:...
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
stage 2: OAuth Enrollment
  ℹ Launching headless browser...
  ℹ Enrolling Rei (rei.pds.host.com)...
  ✓ Rei enrolled successfully — did:plc:...
  ℹ Enrolling Sakura (sakura.pds.host.com)...
  ✓ Sakura enrolled successfully — did:plc:...
  ℹ Enrolling kaoruko (kaoruko.pds.host.com)...
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
stage 3: Configure Boundaries
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

All API calls use `Authorization: Bearer <did>` for authentication, which works because the OAuth sessions from stage 2 are stored in Stratos's database.

**Tests:**

| # | Test | Endpoint | Expected |
|---|------|----------|----------|
| 1 | Rei creates a post with `swordsmith` boundary | `POST com.atproto.repo.createRecord` | 200 — returns `uri` and `cid` |
| 2 | Rei reads own post | `GET com.atproto.repo.getRecord` as Rei | 200 — full record with text and boundary |
| 3 | Sakura reads Rei's post (shared boundary) | `GET com.atproto.repo.getRecord` as Sakura | 200 — record returned |
| 4 | kaoruko denied Rei's post (no boundary intersection) | `GET com.atproto.repo.getRecord` as kaoruko | 400 `RecordNotFound` (opaque denial) |
| 5 | Unauthenticated caller denied | `GET com.atproto.repo.getRecord` no auth | 400 `RecordNotFound` |
| 6a | Sakura `listRecords` sees Rei's post | `GET com.atproto.repo.listRecords` as Sakura | records array length > 0 |
| 6b | kaoruko `listRecords` filtered out | `GET com.atproto.repo.listRecords` as kaoruko | empty records array |
| 6c | Unauthenticated `listRecords` filtered out | `GET com.atproto.repo.listRecords` no auth | empty records array |
| 7a | kaoruko creates an `aekea` post | `POST com.atproto.repo.createRecord` | 200 — returns `uri` and `cid` |
| 7b | Rei denied kaoruko's `aekea` post | `GET com.atproto.repo.getRecord` as Rei | 400 `RecordNotFound` |
| 7c | kaoruko reads own `aekea` post | `GET com.atproto.repo.getRecord` as kaoruko | 200 — record returned |
| 8a | Rei deletes own post | `POST com.atproto.repo.deleteRecord` | 200 |
| 8b | Deleted post no longer retrievable | `GET com.atproto.repo.getRecord` as Rei | 400 `RecordNotFound` |
| 8c | kaoruko deletes own post | `POST com.atproto.repo.deleteRecord` | 200 |

**Expected output:**
```
stage 4: Post CRUD & Boundary Tests

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
1. Runs `docker compose -f docker-compose.test.yml down --volumes --remove-orphans`.
2. Removes the `test-data/` directory.

PDS accounts on `pds.host.com` are **not** deleted (the PDS admin API doesn't expose account deletion). They persist but are harmless test accounts.

**Expected output:**
```
Teardown
  ℹ Stopping Stratos container...
  ✓ Container stopped
  ℹ Removing test-data directory...
  ✓ test-data removed
  ℹ Teardown complete
```

## Files

```
test/
├── README.md                          # This file
└── scripts/
    ├── deno.json                      # Deno config (isolates from project tsconfig)
    ├── setup.ts                       # stage 1: PDS accounts + start Stratos
    ├── test-enrollment.ts             # stage 2: OAuth enrollment via Playwright
    ├── direct-enroll.ts               # stage 2 alternative: Direct DB enrollment (--direct mode)
    ├── configure-boundaries.ts        # stage 3: Per-user boundary assignment
    ├── test-posts.ts                  # stage 4: CRUD + boundary access tests
    ├── teardown.ts                    # stage 5: Cleanup
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

**Boundary configuration fails**
Ensure the container has written to `test-data/service.sqlite` (the SQLite DB is created on first request, not on startup). Verify the bind mount: `ls -la test-data/`.

**"No valid session for user" on API calls**
The `Bearer <did>` auth validates against OAuth sessions first, then falls back to enrollment check. If using `--direct` mode, ensure enrollment rows exist in `service.sqlite`. Re-run enrollment (or `direct-enroll.ts`) if authentication fails.
