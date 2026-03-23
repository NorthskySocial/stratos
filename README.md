# Stratos

Stratos is a private, boundary-aware data layer for AT Protocol. It keeps private records off the user's PDS, publishes enrollment metadata back to the PDS for discovery, and lets downstream AppViews serve boundary-filtered content without inventing a separate identity model. The service is written in typescript with postgres and sqlite support.

## What the Repository Contains

| Package           | Purpose                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------- |
| `stratos-core`    | Domain logic, storage interfaces, schema, validation, MST commit builder                |
| `stratos-service` | HTTP/XRPC service, OAuth enrollment flow, repo CRUD, sync export, adapters              |
| `stratos-client`  | Discovery, routing, verification, and OAuth scope helpers for clients                   |
| `stratos-indexer` | Standalone indexer that consumes PDS + Stratos streams and writes to AppView PostgreSQL |
| `webapp`          | Svelte demo client for enrollment and private posting                                   |
| `test`            | Deno end-to-end test suite                                                              |
| `docs`            | Operator, client, and architecture documentation                                        |

## Core Model

- Users enroll with a Stratos service via OAuth.
- The service writes a `zone.stratos.actor.enrollment` record to the user's PDS.
- Private records live in Stratos, not on the user's PDS.
- Records can carry one or more boundary values such as `posters-madness` or `tech`.
- A viewer can access a record only if they share at least one boundary with it.

## Request Flow

```text
User -> OAuth enrollment -> Stratos service
     -> enrollment record on PDS (`zone.stratos.actor.enrollment`)
     -> private records stored in Stratos
     -> standalone stratos-indexer writes boundary-aware rows into AppView Postgres
     -> AppView serves `zone.stratos.feed.*` queries
```

## Local Development

### Install and verify

```bash
pnpm install
pnpm build
pnpm test
```

### Start the service

```bash
cp .env.example .env
pnpm --filter @northskysocial/stratos-service dev
```

For end-to-end coverage, run the integration suite from the repo root, see `test/` for details:

```bash
pnpm e2etest
```

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

The AppView-facing indexing path is not embedded in `stratos-service` or the AppView fork. The standalone `stratos-indexer` package is responsible for:

- reading PDS enrollment events,
- connecting to `zone.stratos.sync.subscribeRecords`,
- decoding commit payloads,
- writing `stratos_post`, `stratos_post_boundary`, `stratos_enrollment`, and `stratos_sync_cursor` rows into the AppView database.

That separation matters when updating docs or deployment plans: query-time Stratos behavior lives in `atproto-stratos`, while ingestion lives here in `stratos-indexer`.

## Testing

| Command        | Scope                  |
| -------------- | ---------------------- |
| `pnpm test`    | Vitest across packages |
| `pnpm e2etest` | End-to-end suite       |

## Related Docs

- `docs/operator-guide.md`
- `docs/client-guide.md`
- `docs/hydration-architecture.md`
- `docs/enrollment-signing.md`
- `stratos-client/README.md`
- `stratos-indexer/CONFIGURATION.md`
