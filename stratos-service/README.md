# Stratos Service

The Stratos Service is a standalone private permissioned data service for ATProtocol. It provides domain-scoped private data storage with boundary-based access control, allowing users to store and share records within specific organizational or community boundaries (e.g., "engineering", "leadership").

## Overview

Stratos acts as a specialized PDS (Personal Data Server) for private data. Enrollment is discovered via `zone.stratos.actor.enrollment` records on the user's PDS. Depending on custody, private records are hosted by Stratos or by the user's spaces-capable PDS.

Key features:

- **Boundary-based Access Control**: Records are associated with boundaries, and only viewers who share at least one boundary can hydrate/view the records.
- **ATProtocol Compatibility**: Implements standard `com.atproto.repo.*` and `com.atproto.sync.*` XRPC methods for familiar integration.
- **Flexible Storage**: Supports SQLite (local) or PostgreSQL (scalable) backends, and local disk or S3 for blob storage.
- **OAuth Integration**: Secure enrollment and authentication via ATProtocol OAuth.

## Installation

Use Linux with `flock` installed and a local filesystem for the service data directory.
The Docker image includes `flock`. See [service signing key history](../docs/architecture/service-key-history.md) for persistence and rotation requirements.

```bash
cd stratos-service
pnpm install
```

## Configuration

The service is configured via environment variables. See `src/config.ts` for the full schema.

### Core Settings

- `STRATOS_SERVICE_DID`: The DID of the Stratos service.
- `STRATOS_PUBLIC_URL`: The public-facing URL of the service.
- `STRATOS_PORT`: Port to listen on (default: `3100`).
- `STRATOS_SIGNING_KEY_HEX`: Hex-encoded private key for signing repo commits and attestations.

### Database

Stratos supports both SQLite and PostgreSQL.

- `STORAGE_BACKEND`: `sqlite` or `postgres`.
- `STRATOS_DATA_DIR`: Local data directory.
- `STRATOS_POSTGRES_URL`: PostgreSQL connection string when using the Postgres backend.

### Blob Storage

- `STRATOS_BLOB_STORAGE`: `local` or `s3`.
- `STRATOS_S3_BUCKET`, `STRATOS_S3_REGION`, etc. (if using S3).

### Enrollment & Boundaries

- `STRATOS_ENROLLMENT_MODE`: `open`, `allowlist`, or `closed`.
- `STRATOS_ALLOWED_DOMAINS`: Comma-separated list of allowed boundary domains.
- `STRATOS_AUTO_ENROLL_DOMAINS`: Domains that are automatically granted boundaries upon enrollment.

## API Endpoints

### Standard ATProto Methods

- `com.atproto.repo.createRecord`: Create a new record.
- `com.atproto.repo.getRecord`: Retrieve a record (with boundary check).
- `com.atproto.repo.listRecords`: List records in a collection.
- `com.atproto.repo.deleteRecord`: Delete a record.
- `com.atproto.repo.uploadBlob`: Upload a blob.
- `com.atproto.sync.getBlob`: Fetch a blob from a repository.
- `com.atproto.sync.getRecord`: Get a record by CID.

### Stratos-Specific Methods

- `zone.stratos.repo.hydrateRecord`: Hydrate a single record with boundary filtering.
- `zone.stratos.repo.hydrateRecords`: Batch hydration for up to 100 records.
- `zone.stratos.sync.getRepo`: Export a full repository as a CAR file.
- `zone.stratos.repo.importRepo`: Import a repository from a CAR file.
- `zone.stratos.sync.subscribeRecords`: Actor-scoped WebSocket stream for record updates.
- `zone.stratos.sync.getBlob`: Retrieve a blob by CID with boundary filtering.
- `zone.stratos.repo.uploadBlob`: Upload a blob with boundary filtering.

## Development

### Run in Development Mode

```bash
pnpm dev
```

### Build

```bash
pnpm build
```

### Test

```bash
pnpm test
```

## Admin UI

A Svelte 5 admin interface lives in `admin-ui/` and is served by the service at
`/admin` (built output in `dist/admin-ui`, produced by `pnpm build`). Admin
access uses an admin OAuth session cookie that holds only an opaque session
key; the service authorizes the session DID against the `STRATOS_ADMIN_DIDS`
config list and runtime grants in the `admin_user` table. The UI holds no
credential.

### Development

```bash
pnpm dev:admin
```

Starts a Vite dev server with HMR that proxies `/xrpc`, `/health`, and
`/admin` to the running service. The proxy target is read from
`VITE_STRATOS_SERVICE_URL` (default `http://localhost:3100`). The service must
run with `STRATOS_DEV_MODE=true`, or the CSRF origin screen rejects proxied
admin calls with 403. The OAuth round-trip lands on the service origin once;
development then continues on the Vite origin with the same session cookie.

### Build

```bash
pnpm build:admin
```

## License

MIT

## Contributor architecture

| Module               | Files                                                                                               | Description                                                                                                                                                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `blob`               | `adapter.ts`, `index.ts`, `init.ts`                                                                 | Blob access checks (`BlobAuthServiceImpl`): takedown denies all viewers; otherwise the owner may read, while other viewers need access to a referencing record under its stored boundaries (orphaned blobs are denied to them)                                                                                                             |
| `enrollment`         | `adapter.ts`, `handler.ts`, `holds.ts`, `index.ts`, `init.ts`, `internal/`, `service-reconciler.ts` | Enrollment port implementation and XRPC handlers; `holds.ts` recomputes `active` from the operator hold and the takedown hold                                                                                                                                                                                                              |
| `hydration`          | `adapter.ts`, `handler.ts`, `index.ts`, `init.ts`                                                   | Hydration adapter and batch/single record endpoints                                                                                                                                                                                                                                                                                        |
| `mst`                | `index.ts`, `init.ts`, `internal/`                                                                  | MST signer and storage adapter (`internal/signer.ts`, `internal/storage-adapter.ts`, `internal/adapters.ts`; no handlers)                                                                                                                                                                                                                  |
| `pull-sync`          | `handler.ts`, `index.ts`, `oplog.ts`, `recovery.ts`                                                 | Serves `listRepoOps` (signed-commit oplog with truncation detection) and its full-state recovery fallback `listRecordPaths` to callers holding either inter-service auth or a space credential                                                                                                                                             |
| `repo-update-notice` | `handler.ts`, `index.ts`                                                                            | Accepts `com.atproto.space.notifyRepoUpdate` from a `pds`-custody member's PDS as a plain express route (no pinned package ships that lexicon). It checks the notice and answers 200; it stores and forwards nothing, because the feed generator polls. A PDS finds the route through the `#atproto_pds` entry of the service DID document |
| `repo`               | `index.ts`, `init.ts`                                                                               | Builds the repo write context (write rate limiter, per-repo write locks) consumed by record CRUD                                                                                                                                                                                                                                           |
| `space-credential`   | `app-access.ts`, `handler.ts`, `index.ts`, `minter.ts`                                              | Mints and serves `zone.stratos.space.getSpaceCredential` — signed, multi-use JWTs granting space access; always requires an active enrollment carrying the space's boundary, plus an opt-in per-space client allow-list (`appAccess`, default open)                                                                                        |
| `space-read`         | `handler.ts`, `index.ts`                                                                            | Serves `zone.stratos.space.getRecord` for space-scoped record reads                                                                                                                                                                                                                                                                        |
| `sync`               | `handler.ts`, `index.ts`                                                                            | Registers the `getBlob` and pull-sync XRPC handlers                                                                                                                                                                                                                                                                                        |

**Service infrastructure** (`stratos-service/src/`):

| Module             | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/`             | XRPC handler registration (`handlers.ts`; `index.ts` is a barrel); `records/` (record CRUD: `create.ts`, `update.ts`, `delete.ts`, `read.ts`, `batch.ts`, plus `validation.ts`/`util.ts`/`types.ts`; boundary writes: `boundary-writes.ts`, `custody.ts`, `lexicon-validation.ts`, `references.ts`, `scope-check.ts`); `handlers/` (`describe-repo-handlers.ts`, `repo-read-handlers.ts`, `repo-write-handlers.ts`, `repo-boundary-write-handlers.ts`, `blob-handlers.ts`); root helpers `types.ts`, `util.ts`, `varint.ts` |
| `infra/auth/`      | DPoP verification (`dpop-verifier.ts`), token introspection (`introspection-client.ts`), auth verifiers (`verifier.ts`, `verifiers.ts`), service JWTs (`jwt.ts`, `jwks-resolver.ts`), space-credential/delegation/client-attestation verifiers, credential-scope resolution (`credential-scope.ts`), replay store (`replay-store.ts`)                                                                                                                                                                                       |
| `oauth/`           | OAuth client (`client.ts`), enrollment authorization routes (`routes.ts`), admin authorization routes (`admin-routes.ts`), admin web-session store (`admin-session-store.ts`), admin flow handlers (`handlers/admin-authorize.ts`, `handlers/admin-callback.ts`), space-grant parsing and capability detection (`spaces-capability.ts`)                                                                                                                                                                                     |
| `subscription/`    | WebSocket firehose (`subscribe-records.ts`) for Stratos sync consumers                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `infra/blobstore/` | Blob storage backends: disk (`disk.ts`), S3 (`s3.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `infra/signing/`   | Per-actor signing seam (`ActorSigner` in `actor-signer.ts`); raw private key material never leaves this module                                                                                                                                                                                                                                                                                                                                                                                                              |
| `storage/`         | SQLite storage adapters (`sqlite/`: `actor-store.ts`, `enrollment-store.ts`, `sequence-ops.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `infra/storage/`   | Postgres storage adapters (`postgres/`); `cached-enrollment-store.ts` (enrollment read cache); `reserved-domain-enrollment-store.ts` (decorator that force-includes the reserved all-members domain — invariant chokepoint, no cache); `redis-cache.ts` (general-purpose `RedisCache implements Cache`, also used by the space-credential `ReplayStore`)                                                                                                                                                                    |
| `db/`              | Service-level Drizzle schema and connections: `schema.ts` (sqlite tables `oauth_session`, `oauth_state`, `admin_session`, `admin_user`, `enrollment`, `enrollment_boundary`), `pg-schema.ts` (Postgres twins), `pg.ts`, `index.ts`                                                                                                                                                                                                                                                                                          |
| `shared/`          | Cross-feature service utilities: `rate-limiter.ts` and `repo-write-lock.ts` (consumed by the `repo` feature's write context), `domainless-invariant.ts`, `space-type-registry.ts` (the hosted space type and its collections), `user-agent.ts`                                                                                                                                                                                                                                                                              |
| `bin/`             | Service entry point (`stratos.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

`stratos-core/src/storage/` holds the enrollment store port (`EnrollmentStoreReader` /
`EnrollmentStoreWriter`, plus `StoredEnrollment`), the `BlobContentStore` blob-content port and the
`Cache` interfaces. The per-actor store contract (`ActorStore` and its record, repo, blob and
sequence interfaces) lives in `stratos-service/src/actor-store-types.ts`, with two implementations:
SQLite in `stratos-service/src/storage/sqlite/` and Postgres in
`stratos-service/src/infra/storage/postgres/`. Enrollment has a SQLite and a Postgres store in the
same directories. Read the interface files directly for method signatures.

**Enrollment** uses a dual-type pattern: `Enrollment` (domain, with `Date`) vs `StoredEnrollment` (
storage, with string dates).

## Database layout

Per-actor SQLite databases at `{dataDir}/actors/{did-hash-prefix}/{did}/stratos.sqlite` (tables:
`stratos_record`, `stratos_blob`, `stratos_repo_block`, `stratos_repo_root`, `stratos_seq`) when
using the `sqlite` backend. The prefix is the first two hexadecimal characters of SHA-256 of the DID. With the `postgres` backend, actor data is stored in per-actor schemas.
Service-level data lives in `{dataDir}/service.sqlite` for sqlite-backed deployments, with schema
definitions in `stratos-service/src/db/schema.ts` and Postgres counterparts in
`stratos-service/src/db/pg-schema.ts`.

## XRPC handlers

Follow the pattern in `stratos-service/src/api/records/create.ts` (a representative handler module) for handler structure.

Auth verifier options: `ctx.authVerifier.standard` (OAuth), `.optionalStandard`, `.service` (
inter-service JWT), `.admin` (OAuth-authorized operator via server-side session cookie; see Admin
Authorization below), `.spaceCredential` (space-credential JWT), and the fallback compositions
`.standardOrSpaceCredential`, `.optionalStandardOrSpaceCredential`, `.serviceOrSpaceCredential`.
The repo update notice uses `createRepoHostNoticeVerifier` (`infra/auth/verifiers.ts`) instead: its
`lxm` must be the method, its `aud` the service DID or `<service DID>#atproto_pds`, and only the
issuer's `#atproto` key verifies it. The other upstream `com.atproto.space.*` routes stay unserved
and answer 501.

## Admin authorization

Admin access is OAuth-only — there is no shared admin password. An operator logs in through the
normal ATProto OAuth flow with identity-only scope (`OAUTH_ADMIN_SCOPE = 'atproto'`, no repo
writes), and their DID must be an **effective admin**: on the `STRATOS_ADMIN_DIDS` config list
(comma-separated env var, parsed into `config.adminDids`) or granted at runtime through the admin
management API (`admin_user` table via `AdminUserStore`). The union is decided by one predicate,
`isEffectiveAdmin` (`oauth/admin-user-store.ts`), used by login, session resolution, and the
request-time verifier alike. Config-listed DIDs are the un-revocable recovery floor and bootstrap
path — the only write into `admin_user` is itself admin-gated, so a blank config list with an empty
table locks everyone out.

**Flow** (routes in `stratos-service/src/oauth/admin-routes.ts`, mounted at `/admin`):

| Route                        | Handler                       | Purpose                                                                    |
| ---------------------------- | ----------------------------- | -------------------------------------------------------------------------- |
| `GET /admin/oauth/authorize` | `handlers/admin-authorize.ts` | Starts OAuth; pins `redirect_uri` to the admin callback                    |
| `GET /admin/oauth/callback`  | `handlers/admin-callback.ts`  | Token exchange, effective-admin check, establishes session                 |
| `GET /admin/whoami`          | inline in `admin-routes.ts`   | Returns `{ did, isAdmin }` for an authorized session; otherwise 401 or 403 |
| `POST /admin/oauth/logout`   | inline in `admin-routes.ts`   | Deletes the session and clears the cookie                                  |

**Session model**: the callback enforces effective-admin membership (revoking the OAuth session and
returning `403 NotAdmin` on a miss), then mints an opaque server-side session via `AdminSessionStore`
(`admin-session-store.ts`; `SqliteAdminSessionStore` / `PgAdminSessionStore`). The only value placed
in the `stratos_admin_session` HttpOnly cookie is a 32-byte random key — the DID and expiry live in
the `admin_session` table. Sessions expire after `ADMIN_SESSION_TTL_MS` (12 hours) and are deleted on
read once expired.

**Request-time verification**: the `.admin` XRPC verifier (`createAdminVerifier` in
`infra/auth/verifiers.ts`) reads the cookie at the raw `IncomingMessage` level, requires a valid
unexpired session whose DID is still an effective admin, and applies a CSRF origin check
(cross-origin requests are rejected). On success it yields `{ type: 'admin', did }`.

## Adding a service feature

Define the relevant domain rules and port in `stratos-core`, implement the adapter and any XRPC handlers in `src/features/`, and register handlers through `src/api/handlers.ts` as appropriate. Add focused core unit tests and service integration tests. Follow existing feature patterns; not every feature needs each layer.
