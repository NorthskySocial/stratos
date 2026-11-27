# Stratos

Stratos is a private, boundary-aware data layer for AT Protocol. Depending on custody, private
records are hosted by Stratos or by the user's spaces-capable PDS. Enrollment metadata is
published to the user's PDS for discovery, and AppViews can serve boundary-filtered content.

## Documentation

For full documentation, including architecture deep-dives, operator guides, and client integration, visit the [Stratos Homepage](https://stratos.zone/) (or browse the `docs/` directory).

- [**Introduction**](./docs/guide/introduction.md) — What is Stratos and how does it work?
- [**Quick Start**](#quick-start) — Get running in minutes.
- [**Client Integration**](./docs/client/getting-started.md) — Add Stratos to your ATProtocol app.
- [**Operator Guide**](./docs/operator/overview.md) — Deploy and manage a Stratos service.
- [**Architecture**](./docs/architecture/hydration.md) — Technical details on repositories and hydration.
- [**Glossary**](./docs/reference/glossary.md) — Key terms and concepts.

## What the Repository Contains

| Package           | Purpose                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `stratos-core`    | Domain logic, storage interfaces, schema, validation, MST commit builder   |
| `stratos-service` | HTTP/XRPC service, OAuth enrollment flow, repo CRUD, sync export, adapters |
| `stratos-client`  | Discovery, routing, verification, and OAuth scope helpers for clients      |
| `webapp`          | Svelte demo client for enrollment and private posting                      |
| `docs`            | Full project documentation                                                 |

## Quick Start

1. **Install dependencies and build packages:**

   ```bash
   pnpm install
   pnpm --filter @northskysocial/stratos-service... --filter @northskysocial/stratos-webapp... build
   ```

2. **Configure the environment:**

   Copy `.env.example` to `.env` and set `STRATOS_SERVICE_DID` and the other values for your environment. The service loads this file when started with the command below. Configure `STRATOS_VALKEY_URL` for
   space-credential and client-attestation operations. For OAuth with a remote PDS, configure
   reachable HTTPS URLs and a service DID that resolves to the service. See the
   [operator guide](./docs/operator/overview.md) for deployment details.

3. **Start the Stratos service:**

   ```bash
   pnpm --filter @northskysocial/stratos-service dev
   ```

4. **Configure and start the Web UI in a separate terminal:**

   ```bash
   cp webapp/.env.example webapp/.env.local
   # Set VITE_STRATOS_URL and VITE_STRATOS_SERVICE_DID to match the service.
   pnpm --filter @northskysocial/stratos-webapp dev
   ```

### Running Tests

| Scope               | Command        |
| ------------------- | -------------- |
| Unit tests (Vitest) | `pnpm test`    |
| End-to-end (Deno)   | `pnpm e2etest` |

## Configuration Highlights

The service reads its configuration from environment variables in `stratos-service/src/config.ts`.

### Identity and boundaries

| Variable                  | Description                                      | Default                 |
| ------------------------- | ------------------------------------------------ | ----------------------- |
| `STRATOS_SERVICE_DID`     | Required service DID, typically `did:web:<host>` | none                    |
| `STRATOS_PUBLIC_URL`      | Public base URL for the service                  | `http://localhost:3100` |
| `STRATOS_ALLOWED_DOMAINS` | Comma-separated list of valid boundary values    | empty                   |

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

| Variable                        | Description                                                                                                                                          | Default     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `STRATOS_ENROLLMENT_MODE`       | `open`, `allowlist`, or `closed`                                                                                                                     | `allowlist` |
| `STRATOS_ALLOWED_DIDS`          | Allowed DIDs when running in allowlist mode                                                                                                          | empty       |
| `STRATOS_ALLOWED_PDS_ENDPOINTS` | Allowed PDS origins when running in allowlist mode                                                                                                   | empty       |
| `STRATOS_AUTO_ENROLL_DOMAINS`   | Domains automatically assigned at enrollment time                                                                                                    | empty       |
| `STRATOS_ALLOW_LIST_URI`        | Optional external allow-list source                                                                                                                  | unset       |
| `STRATOS_VALKEY_URL`            | Valkey/Redis backing store. Required for the space-credential delegation and mint paths and for client attestation: all three fail closed without it | unset       |

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

## Feed generation

The [Rust feed generator](stratos-feedgen-ng/README.md) ingests records and serves boundary-scoped feeds.

## Related Docs

- [Operator Overview](./docs/operator/overview.md)
- [Client Getting Started](./docs/client/getting-started.md)
- [Hydration Architecture](./docs/architecture/hydration.md)
- [Enrollment Signing](./docs/architecture/enrollment-signing.md)
- [Glossary](./docs/reference/glossary.md)
