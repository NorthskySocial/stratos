# Stratos

Stratos is a private, boundary-aware data layer for AT Protocol. It keeps private records off the
user's PDS, publishes enrollment metadata back to the PDS for discovery, and lets downstream
AppViews serve boundary-filtered content without inventing a separate identity model.

## Documentation

For full documentation, including architecture deep-dives, operator guides, and client integration, visit the [Stratos Homepage](https://stratos.zone/) (or browse the `docs/` directory).

- [**Introduction**](./docs/guide/introduction.md) — What is Stratos and how does it work?
- [**Quick Start (Docker)**](#quick-start-docker) — Get running in minutes.
- [**Client Integration**](./docs/client/getting-started.md) — Add Stratos to your ATProtocol app.
- [**Operator Guide**](./docs/operator/overview.md) — Deploy and manage a Stratos service.
- [**Architecture**](./docs/architecture/hydration.md) — Technical details on repositories and hydration.
- [**Glossary**](./docs/guide/glossary.md) — Key terms and concepts.

## What the Repository Contains

| Package           | Purpose                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------- |
| `stratos-core`    | Domain logic, storage interfaces, schema, validation, MST commit builder                |
| `stratos-service` | HTTP/XRPC service, OAuth enrollment flow, repo CRUD, sync export, adapters              |
| `stratos-client`  | Discovery, routing, verification, and OAuth scope helpers for clients                   |
| `stratos-indexer` | Standalone indexer that consumes PDS + Stratos streams and writes to AppView PostgreSQL |
| `webapp`          | Svelte demo client for enrollment and private posting                                   |
| `docs`            | Full project documentation                                                              |

## Quick Start (Docker)

The easiest way to get the full stack running (Service + Indexer + Postgres) is using Docker Compose:

```bash
cp .env.example .env
# Edit .env and set required variables:
# STRATOS_SERVICE_DID=did:web:localhost
# STRATOS_PUBLIC_URL=http://localhost:3100
# STRATOS_ALLOWED_DOMAINS=example.com

docker compose up --build
```

### Manual Setup

1. **Install dependencies and build packages:**

   ```bash
   pnpm install
   pnpm build
   ```

2. **Configure the environment:**

   ```bash
   cp .env.example .env
   # Edit .env with your local settings
   ```

3. **Start for Local Development (with localtunnel):**

   This is the recommended way to develop locally, as it automatically sets up HTTPS tunnels required for ATProto OAuth.

   ```bash
   pnpm dev:local
   ```

   This will start both the Stratos Service and the Web UI, and provide you with public URLs.

   > [!NOTE]
   > This command runs in the foreground. Open a separate terminal for any other commands (like starting the indexer or running tests).

4. **Start the Stratos Service (Direct):**

   ```bash
   pnpm --filter @northskysocial/stratos-service dev
   ```

5. **Start the Indexer (requires Deno):**

   ```bash
   # In a separate terminal
   cd stratos-indexer
   deno run --allow-all src/bin/main.ts
   ```

6. **Start the Web UI (Direct):**

   ```bash
   # In a separate terminal
   pnpm --filter @northskysocial/stratos-webapp dev
   ```

### Running Tests

| Scope               | Command        |
| ------------------- | -------------- |
| Unit tests (Vitest) | `pnpm test`    |
| End-to-end (Deno)   | `pnpm e2etest` |

## Configuration Highlights

The service reads its configuration from environment variables in `stratos-service/src/config.ts`.

### Required

| Variable                  | Description                                   |
| ------------------------- | --------------------------------------------- |
| `STRATOS_SERVICE_DID`     | Service DID, typically `did:web:<host>`       |
| `STRATOS_PUBLIC_URL`      | Public base URL for the service               |
| `STRATOS_ALLOWED_DOMAINS` | Comma-separated list of valid boundary values |

### Storage

| Variable                     | Description                                       | Default  |
| ---------------------------- | ------------------------------------------------- | -------- |
| `STORAGE_BACKEND`            | `sqlite` or `postgres`                            | `sqlite` |
| `STRATOS_DATA_DIR`           | Base data directory for sqlite-backed deployments | `./data` |
| `STRATOS_POSTGRES_URL`       | Full Postgres DSN when using `postgres` storage   | unset    |
| `STRATOS_PG_ACTOR_POOL_SIZE` | Actor transaction pool size for Postgres storage  | unset    |
| `STRATOS_PG_ADMIN_POOL_SIZE` | Admin/schema pool size for Postgres storage       | unset    |
| `STRATOS_BLOCK_CACHE_SIZE`   | Block cache size for Postgres-backed actor repos  | unset    |

### Enrollment

| Variable                        | Description                                             | Default     |
| ------------------------------- | ------------------------------------------------------- | ----------- |
| `STRATOS_ENROLLMENT_MODE`       | `open` or `allowlist`                                   | `allowlist` |
| `STRATOS_ALLOWED_DIDS`          | Allowed DIDs when running in allowlist mode             | empty       |
| `STRATOS_ALLOWED_PDS_ENDPOINTS` | Allowed PDS origins when running in allowlist mode      | empty       |
| `STRATOS_AUTO_ENROLL_DOMAINS`   | Domains automatically assigned at enrollment time       | empty       |
| `STRATOS_ALLOW_LIST_URI`        | Optional external allow-list source                     | unset       |
| `STRATOS_VALKEY_URL`            | Optional Valkey/Redis backing store for allow-list data | unset       |

### Storage for blobs

| Variable               | Description                                | Default |
| ---------------------- | ------------------------------------------ | ------- |
| `STRATOS_BLOB_STORAGE` | `local` or `s3`                            | `local` |
| `STRATOS_S3_BUCKET`    | Bucket name for S3-compatible blob storage | unset   |
| `STRATOS_S3_REGION`    | Region for S3-compatible blob storage      | unset   |
| `STRATOS_S3_ENDPOINT`  | Custom S3 endpoint, including MinIO        | unset   |

### Operational

| Variable                         | Description                                         | Default     |
| -------------------------------- | --------------------------------------------------- | ----------- |
| `STRATOS_PORT`                   | HTTP port                                           | `3100`      |
| `STRATOS_IMPORT_MAX_BYTES`       | CAR import size limit                               | `268435456` |
| `STRATOS_WRITE_RATE_MAX_WRITES`  | Write-rate limit window quota                       | `300`       |
| `STRATOS_WRITE_RATE_WINDOW_MS`   | Write-rate limit window size                        | `60000`     |
| `STRATOS_WRITE_RATE_COOLDOWN_MS` | Cooldown after exceeding the limit                  | `10000`     |
| `STRATOS_DPOP_REQUIRE_NONCE`     | Require DPoP nonces for protected requests          | `true`      |
| `USE_OAUTH`                      | Enable OAuth enrollment routes in local/test setups | `false`     |

## Storage Model

Stratos supports two repo storage modes:

- `sqlite`: one sqlite database per actor plus a service-level sqlite database.
- `postgres`: one Postgres schema per actor plus shared service tables.

Blob content is stored separately through the configured blob provider (`local` or `s3`).

## Indexing Model

The AppView-facing indexing path is not embedded in `stratos-service` or the AppView fork. The
standalone `stratos-indexer` package is responsible for:

- reading PDS enrollment events,
- connecting to `zone.stratos.sync.subscribeRecords`,
- decoding commit payloads,
- writing `stratos_post`, `stratos_post_boundary`, `stratos_enrollment`, and `stratos_sync_cursor`
  rows into the AppView database.

That separation matters when updating docs or deployment plans: query-time Stratos behavior lives in
`atproto-stratos`, while ingestion lives here in `stratos-indexer`.

## Related Docs

- [Operator Overview](./docs/operator/overview.md)
- [Client Getting Started](./docs/client/getting-started.md)
- [Hydration Architecture](./docs/architecture/hydration.md)
- [Enrollment Signing](./docs/architecture/enrollment-signing.md)
- [Glossary](./docs/guide/glossary.md)
