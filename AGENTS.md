# Stratos Project - Copilot Instructions

## Project Overview

Stratos is a **standalone private permissioned data service** for ATProtocol. It provides
domain-scoped private data storage with boundary-based access control. Users enroll via OAuth, their
enrollment is published to their PDS, and downstream indexers or AppViews discover that enrollment
through `zone.stratos.actor.enrollment` records.

## Architecture

### Key Concepts

| Concept            | Description                                                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Boundary**       | Access control scope (e.g., "engineering", "leadership"). Records have boundaries; viewers must share at least one.                                                                             |
| **Enrollment**     | User registration with a Stratos service via OAuth. Creates profile record on user's PDS.                                                                                                       |
| **Hydration**      | Clients or AppViews fetch Stratos-backed records and filter by viewer boundaries.                                                                                                               |
| **Profile Record** | `zone.stratos.actor.enrollment` - published to user's PDS for endpoint discovery and enrollment verification.                                                                                   |
| **Sync Stream**    | `zone.stratos.sync.subscribeRecords` - actor-scoped WebSocket stream consumed by sync clients (the standalone `stratos-indexer` and `stratos-feedgen`).                                         |
| **Custody**        | Which party holds a user's records. `stratos` = Stratos hosts the repo and signs. `pds` = the user's own spaces-capable PDS hosts the repo and the user signs.                                  |
| **Space**          | An upstream permissioned-data container (proposal 0016). Stratos is always the space **authority**. For a `pds`-custody user it is only the authority, and the user's PDS is the repo **host**. |

### Mixed-mode custody

Stratos supports two custody classes at once. Read the class before you change
any write, sync, or boundary code.

| User's PDS     | Custody   | Repo host          | Who signs                    |
| -------------- | --------- | ------------------ | ---------------------------- |
| non-spaces     | `stratos` | Stratos            | Stratos, per-actor P-256 key |
| spaces-capable | `pds`     | the user's own PDS | the user                     |

Three rules follow. They are load-bearing, and each was proven against the
upstream alpha PDS rather than read from the spec.

1. **Never trust a boundary on a `pds`-custody record.** A repo host does not
   authorize writes against the space authority. Any account can write records
   into a Stratos-owned space URI in its own repo. A boundary on such a record is
   a user-supplied claim. Always re-derive the boundary from Stratos enrollment
   state. See `stratos-feedgen/src/subscription/indexer.ts` for the ingest path.
2. **Membership decides whose repo the syncer reads.** It is the only write-side
   control that exists. Removing a member does not stop them writing; it stops us
   reading. The syncer iterates the member list. Do not add writer discovery.
3. **A space record URI has seven segments and starts with the authority**:
   `at://{authorityDid}/space/{type}/{skey}/{authorDid}/{collection}/{rkey}`.
   A custody record keeps the familiar `at://{authorDid}/{collection}/{rkey}`.
   Code that takes the first segment as the author is wrong for a space record.

`zone.stratos.space.feed` must stay published as a `com.atproto.lexicon.schema`
record with `defs.main.type` of `space`. A user's PDS resolves that NSID before
it grants a space scope. If the record is missing, authorization fails with
`invalid_scope`, and nothing in the Stratos logs explains why.

Interop regression scripts live in `test/spike/spaces/`. Run them when you change
credentials, host discovery, or ingest.

### Packages

```
stratos/
├── stratos-core/       # Domain logic, ports (interfaces)
├── stratos-service/    # HTTP service, adapters (implementations)
├── stratos-client/     # Client library (discovery, routing, verification, scopes)
├── stratos-indexer/    # Standalone indexer that writes Stratos data into an AppView database
├── stratos-feedgen/    # Standalone feed generator; serves boundary-scoped hydrated feeds to clients
├── lexicons/           # ATProto lexicon definitions
└── docs/               # Technical documentation
```

---

## Clean Code

Follow Clean code design patterns and prioritize the following parts fo it:

- Keep it simple stupid. Simpler is always better. Reduce complexity as much as possible.
- Keep configurable data at high levels
- Use explanatory variables
- Encapsulate boundary conditions
- Choose descriptive and unambiguous names
- Don't use flag arguments. Split method into several independent methods that can be called from
  the client without the flag.

## Feature-Sliced Architecture

Each feature is self-contained with its own:

- **Port** (interface in stratos-core)
- **Domain logic** (business rules in stratos-core)
- **Adapter** (implementation in stratos-service)
- **Handler** (XRPC/HTTP endpoints in stratos-service)
- **Tests** (unit in stratos-core, integration in stratos-service)

### Feature Patterns

Features in stratos-core follow one of two patterns:

**Port/Domain pattern** (enrollment, hydration):

```
stratos-core/src/{feature}/
├── index.ts          # Public exports
├── port.ts           # Interface definition
├── domain.ts         # Business logic (pure functions)
└── types.ts          # Feature-specific types
```

**Reader/Transactor pattern** (record, repo, blob):

```
stratos-core/src/{feature}/
├── index.ts          # Public exports
├── reader.ts         # Read-only operations (with caching)
└── transactor.ts     # Write operations (extends reader)
```

Service-side features in `stratos-service/src/features/`:

```
stratos-service/src/features/{feature}/
├── index.ts          # Public exports
├── adapter.ts        # Port implementation
└── handler.ts        # XRPC handlers (if applicable)
```

### Module Layout

**Core domain modules** (`stratos-core/src/`):

| Module        | Pattern           | Description                                                                                                                                |
| ------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `enrollment`  | Port/Domain       | OAuth enrollment validation and business logic                                                                                             |
| `hydration`   | Port/Domain       | Boundary-aware record hydration for AppViews and clients                                                                                   |
| `attestation` | Utility           | Deterministic attestation payload construction (`createAttestationPayload` in `domain.ts`; callers sign and verify; no port)               |
| `record`      | Reader/Transactor | Record metadata read/write operations                                                                                                      |
| `repo`        | Reader/Transactor | Repository block storage operations (IPLD blocks)                                                                                          |
| `blob`        | Reader/Transactor | Blob metadata and content read/write operations                                                                                            |
| `mst`         | Utility           | Merkle Search Tree commit builder (`builder.ts`)                                                                                           |
| `validation`  | Utility           | Stratos-specific validation rules for boundaries and records                                                                               |
| `spaces`      | Utility           | Pure parsing, validation, and formatting of space/record `at://` URIs, plus boundary-to-space-URI mapping (`domain.ts`)                    |
| `atproto`     | Utility           | CBOR record encoding, CID computation/parsing, CAR block reading, commit-op decoding, and boundary extraction (`index.ts`)                 |
| `config`      | Infrastructure    | Zod schemas for storage backend, logging, and Redis env config, plus comma-list helpers (`parseCommaList`, `commaListSchema`) (`index.ts`) |
| `lexicons`    | Infrastructure    | `DefaultLexiconProvider` bundling Stratos + embedded `com.atproto.*` lexicons (`index.ts`)                                                 |
| `storage`     | Ports             | Storage interface definitions (Reader/Writer ports for all stores)                                                                         |
| `db`          | Infrastructure    | Database schema (Drizzle), SQLite + Postgres support, migrations                                                                           |
| `shared`      | Infrastructure    | Shared error types and domain-specific exceptions                                                                                          |

**Service feature modules** (`stratos-service/src/features/`):

| Module             | Files                                                                                   | Description                                                                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blob`             | `adapter.ts`, `bloom-manager.ts`, `index.ts`, `init.ts`                                 | Boundary-based blob access checks (`BlobAuthServiceImpl`) and a per-blob Bloom filter over each blob's boundaries for fast boundary-intersection rejection (unknown blobs fall back to the authoritative DB check)                                  |
| `enrollment`       | `adapter.ts`, `handler.ts`, `index.ts`, `init.ts`, `internal/`, `service-reconciler.ts` | Enrollment port implementation and XRPC handlers                                                                                                                                                                                                    |
| `hydration`        | `adapter.ts`, `handler.ts`, `index.ts`, `init.ts`                                       | Hydration adapter and batch/single record endpoints                                                                                                                                                                                                 |
| `mst`              | `index.ts`, `init.ts`, `internal/`                                                      | MST signer and storage adapter (`internal/signer.ts`, `internal/storage-adapter.ts`, `internal/adapters.ts`; no handlers)                                                                                                                           |
| `pull-sync`        | `handler.ts`, `index.ts`, `oplog.ts`, `recovery.ts`                                     | Serves `listRepoOps` (signed-commit oplog with truncation detection) and its full-state recovery fallback `listRecordPaths` to callers holding either inter-service auth or a space credential                                                      |
| `repo`             | `index.ts`, `init.ts`                                                                   | Builds the repo write context (write rate limiter, per-repo write locks) consumed by record CRUD                                                                                                                                                    |
| `space-credential` | `app-access.ts`, `handler.ts`, `index.ts`, `minter.ts`                                  | Mints and serves `zone.stratos.space.getSpaceCredential` — signed, multi-use JWTs granting space access; always requires an active enrollment carrying the space's boundary, plus an opt-in per-space client allow-list (`appAccess`, default open) |
| `space-read`       | `handler.ts`, `index.ts`                                                                | Serves `zone.stratos.space.getRecord` for space-scoped record reads                                                                                                                                                                                 |
| `sync`             | `adapter.ts`, `handler.ts`, `index.ts`, `init.ts`                                       | `SyncService` (`getBlob`) implementation and `getBlob`/pull-sync XRPC handler registration                                                                                                                                                          |

**Service infrastructure** (`stratos-service/src/`):

| Module             | Description                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/`             | XRPC handler registration (`handlers.ts`; `index.ts` is a barrel); `records/` (record CRUD: `create.ts`, `update.ts`, `delete.ts`, `read.ts`, `batch.ts`, plus `validation.ts`/`util.ts`/`types.ts`); `handlers/` (`describe-repo-handlers.ts`, `repo-read-handlers.ts`, `repo-write-handlers.ts`, `blob-handlers.ts`); root helpers `types.ts`, `util.ts`, `varint.ts` |
| `infra/auth/`      | DPoP verification (`dpop-verifier.ts`), token introspection (`introspection-client.ts`), auth verifiers (`verifier.ts`, `verifiers.ts`), service JWTs (`jwt.ts`, `jwks-resolver.ts`), space-credential/delegation/client-attestation verifiers, credential-scope resolution (`credential-scope.ts`), replay store (`replay-store.ts`)                                   |
| `oauth/`           | OAuth client (`client.ts`), enrollment authorization routes (`routes.ts`), admin authorization routes (`admin-routes.ts`), admin web-session store (`admin-session-store.ts`), admin flow handlers (`handlers/admin-authorize.ts`, `handlers/admin-callback.ts`)                                                                                                        |
| `subscription/`    | WebSocket firehose (`subscribe-records.ts`) for Stratos sync consumers                                                                                                                                                                                                                                                                                                  |
| `infra/blobstore/` | Blob storage backends: disk (`disk.ts`), S3 (`s3.ts`)                                                                                                                                                                                                                                                                                                                   |
| `infra/signing/`   | Per-actor signing seam (`ActorSigner` in `actor-signer.ts`); raw private key material never leaves this module                                                                                                                                                                                                                                                          |
| `storage/`         | SQLite storage adapters (`sqlite/`: `actor-store.ts`, `enrollment-store.ts`, `sequence-ops.ts`)                                                                                                                                                                                                                                                                         |
| `infra/storage/`   | Postgres storage adapters (`postgres/`); `cached-enrollment-store.ts` (enrollment read cache); `reserved-domain-enrollment-store.ts` (decorator that force-includes the reserved all-members domain — invariant chokepoint, no cache); `redis-cache.ts` (general-purpose `RedisCache implements Cache`, also used by the space-credential `ReplayStore`)                |
| `db/`              | Service-level Drizzle schema and connections: `schema.ts` (sqlite tables `oauth_session`, `oauth_state`, `admin_session`, `admin_user`, `enrollment`, `enrollment_boundary`), `pg-schema.ts` (Postgres twins), `pg.ts`, `index.ts`                                                                                                                                      |
| `shared/`          | Cross-feature service utilities: `rate-limiter.ts` and `repo-write-lock.ts` (consumed by the `repo` feature's write context), `domainless-invariant.ts`, `user-agent.ts`                                                                                                                                                                                                |
| `bin/`             | Service entry point (`stratos.ts`)                                                                                                                                                                                                                                                                                                                                      |

**Client library** (`stratos-client/src/`):

| File              | Description                                                                     |
| ----------------- | ------------------------------------------------------------------------------- |
| `discovery.ts`    | Enrollment discovery from user PDS; locates Stratos service endpoint            |
| `routing.ts`      | Service routing; directs requests to correct Stratos instance                   |
| `verification.ts` | Record verification with inclusion proofs and user/service key signature checks |
| `scopes.ts`       | OAuth scope declarations                                                        |
| `types.ts`        | Client type definitions                                                         |
| `lexicons.ts`     | Stable entry re-exporting the generated `zone.stratos.*` bundle (`./lexicons`)  |
| `lexicons.gen.ts` | Auto-generated LexiconDoc bundle; regenerate with `pnpm lexgen`                 |

**Indexer** (`stratos-indexer/src/`):

| File                        | Description                                                                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `indexer.ts`                | Main Indexer class — health server, lifecycle management                                                                                                                           |
| `config.ts`                 | IndexerConfig interface, environment variable loading                                                                                                                              |
| `index.ts`                  | Package barrel exporting the public indexer API                                                                                                                                    |
| `backfill.ts`               | Backfill existing repos on startup                                                                                                                                                 |
| `bin/main.ts`               | CLI entry point with signal handling                                                                                                                                               |
| `pds/pds-firehose.ts`       | Connects to the PDS firehose and discovers enrollment records                                                                                                                      |
| `pds/pds-subscriber.ts`     | Wires PDS firehose work into the indexing service, handle dedup, and the worker pool                                                                                               |
| `storage/cursor-manager.ts` | Manages PDS and Stratos sync cursors with periodic flush                                                                                                                           |
| `storage/db.ts`             | Kysely Postgres connection setup, DID-resolver cache, startup repair of legacy column layouts (renames + `boundaries` add)                                                         |
| `storage/schema.ts`         | Kysely table types for sync cursors, enrollments, indexed records, record boundaries, and posts                                                                                    |
| `sync/stratos-sync.ts`      | Service and actor-level WebSocket subscription handlers                                                                                                                            |
| `sync/actor-syncer.ts`      | Decodes per-actor sync frames; upserts every record into the AppView database (`stratos_record` + `stratos_record_boundary`, plus a `post` row for feed posts) and applies deletes |
| `sync/sync-manager.ts`      | Coordinates the service subscription and per-actor syncers                                                                                                                         |
| `util/record-decoder.ts`    | Decodes CBOR records, extracts boundaries                                                                                                                                          |
| `util/worker-pool.ts`       | Thread pool for concurrent processing                                                                                                                                              |
| `util/handle-dedup.ts`      | TTL cache that skips redundant `indexHandle` calls for recently-seen DIDs                                                                                                          |

**Feed generator** (`stratos-feedgen/src/`):

Standalone service that subscribes to a single upstream Stratos, indexes posts
into a local SQLite (WAL) store, and serves boundary-scoped, hydrated feeds to
clients. Inbound requests carry a user service-auth JWT (`iss=userDID`,
`aud=feedgenDID`); the feedgen resolves the user DID, looks up the viewer's
boundaries, and returns only posts the viewer may see. Outbound calls to the
upstream Stratos (including the sync WebSocket) use a feedgen-minted service-auth
JWT (`iss=feedgenDID`, `aud=stratosDID`).

| File / dir      | Description                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.ts`     | Express app: XRPC handlers, `/health`, `/.well-known/did.json` DID document                                                                           |
| `config.ts`     | `FeedgenConfig` interface and environment variable loading (`loadFeedgenConfig`)                                                                      |
| `index.ts`      | Package barrel exporting the public feedgen API                                                                                                       |
| `bin/`          | CLI entry point (`main.ts`)                                                                                                                           |
| `api/feed/`     | `getFeed.ts`, `describeFeed.ts` XRPC handlers                                                                                                         |
| `auth/`         | Inbound service-auth JWT verifier (`verifier.ts`, `identity.ts`)                                                                                      |
| `subscription/` | Background sync workers: `service-stream.ts`, `actor-syncer.ts`, `actor-pool.ts`, `indexer.ts`                                                        |
| `upstream/`     | `UpstreamStratosClient` (`client.ts`) + `mintServiceJwt` (`jwt.ts`) to the upstream Stratos                                                           |
| `enrollment/`   | Viewer-boundary cache (`manager.ts` + TTL/LRU in `lru.ts`)                                                                                            |
| `db/`           | Local post/boundary/cursor index (`sqlite.ts`, `postgres.ts`, `schema/`)                                                                              |
| `feeds/`        | Feed registry and static feed config (`config.ts`, `index.ts`)                                                                                        |
| `purge/`        | Purges a revoked/shrunk viewer's local index and boundary cache (`purger.ts`) and reconciles enrollment state against upstream (`reconcile.ts`)       |
| `lexicon/`      | Handwritten inline copies of the `zone.stratos.feedgen.*` lexicons (`schemas.ts`), kept in source so the package has no out-of-tree file dependencies |

**Feed generator lexicons** (`lexicons/zone/stratos/feedgen/`): `getFeed`
(authenticated), `describeFeed` (unauthenticated). Required env vars:
`FEEDGEN_SERVICE_DID`, `FEEDGEN_SIGNING_KEY`, `STRATOS_SERVICE_URL`,
`STRATOS_SERVICE_DID`. See `stratos-feedgen/README.md` for the full architecture
diagram and auth-flow table.

### Storage Architecture

Storage interfaces are defined in `stratos-core/src/storage/*.ts` with SQLite adapters in
`stratos-service/src/storage/sqlite/` and Postgres adapters in
`stratos-service/src/infra/storage/postgres/`. Each store has a Reader (read-only) and
Writer (extends Reader) variant. Read the interface files directly for method signatures.

Composite interfaces group stores per scope:

- `ActorStoreReaders` / `ActorStoreWriters` — per-actor stores: `record`, `blobMetadata`,
  `blobContent`, `repo`, `sequence`
- `ServiceStores` — service-level stores: `enrollment`

**Enrollment** uses a dual-type pattern: `Enrollment` (domain, with `Date`) vs `StoredEnrollment` (
storage, with string dates).

---

## Coding Conventions

### TypeScript

- Use strict TypeScript (`strict: true`)
- Prefer interfaces over types for public APIs
- Use `unknown` over `any`
- Export types explicitly from index files
- Use named exports (no default exports)

#### Two compilers

The workspace installs two TypeScript compilers. `package.json` cannot hold
comments, so the arrangement is recorded here.

| Binary | Compiler                                      | Used by              |
| ------ | --------------------------------------------- | -------------------- |
| `tsc`  | TypeScript 7.0 (Go), the `typescript-7` alias | `build`, `typecheck` |
| `tsc6` | TypeScript 6.0, the `typescript` alias        | typescript-eslint    |

typescript-eslint does not support the TypeScript 7 API. The `typescript` name
therefore stays aliased to `@typescript/typescript6`, which installs its binary
as `tsc6`. The names do not collide, so a plain `tsc` in a script is TypeScript 7.

The type-aware ESLint rules read TypeScript 6 semantics while the build reads
TypeScript 7 semantics. The two compilers can narrow a type differently. Trust
`pnpm run typecheck` when a lint result and a build result disagree.

Remove the `typescript` alias and use one compiler when typescript-eslint
supports TypeScript 7.

### Naming

| Item       | Convention      | Example                 |
| ---------- | --------------- | ----------------------- |
| Files      | kebab-case      | `enrollment-service.ts` |
| Interfaces | PascalCase      | `EnrollmentService`     |
| Types      | PascalCase      | `EnrollmentConfig`      |
| Functions  | camelCase       | `createEnrollment`      |
| Constants  | SCREAMING_SNAKE | `DEFAULT_TIMEOUT`       |

### Ports & Adapters

Follow the pattern in `stratos-core/src/enrollment/port.ts` (port) and
`stratos-service/src/features/enrollment/adapter.ts` (adapter).

### Error Handling

Use domain-specific error classes extending `StratosError`. See `stratos-core/src/shared/errors.ts`.

---

## Testing

Unit tests in `stratos-core/tests/`, integration tests in `stratos-service/tests/`, indexer tests in
`stratos-indexer/tests/`. Uses vitest. Follow patterns in existing test files. Run:
`pnpm exec vitest run`. When creating mock data, use names and places from popular 90s anime.

### Mutation testing (validating AI-generated code)

Mutation testing (StrykerJS) exists to validate that tests actually catch regressions — it is the
primary gate for trusting AI-generated code and the tests that accompany it. It is **not**
CI-enforced; it is a local verification step the agent is responsible for running.

**Scope the run to the files you changed.** Do not run the whole package config
(`pnpm --filter <package> mutation`): a full `stratos-service` sweep is 5,600+ mutants and takes
about three hours, and it reports overwhelmingly on code you did not touch. Scope it instead:

```bash
cd <package> && pnpm exec stryker run --mutate 'src/a/changed.ts,src/b/changed.ts' \
  > /tmp/mut.log 2>&1
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

---

## Database

Per-actor SQLite databases at `{dataDir}/actors/{did-prefix}/{did}/stratos.sqlite` (tables:
`stratos_record`, `stratos_blob`, `stratos_repo_block`, `stratos_repo_root`, `stratos_seq`) when
using the `sqlite` backend. With the `postgres` backend, actor data is stored in per-actor schemas.
Service-level data lives in `{dataDir}/service.sqlite` for sqlite-backed deployments, with schema
definitions in `stratos-core/src/db/schema/` and Postgres-specific tables in
`stratos-core/src/db/schema/pg-tables.ts`.

---

## XRPC Handlers

Follow the pattern in `stratos-service/src/api/records/create.ts` (a representative handler module) for handler structure.

Auth verifier options: `ctx.authVerifier.standard` (OAuth), `.optionalStandard`, `.service` (
inter-service JWT), `.admin` (OAuth-authorized operator via server-side session cookie; see Admin
Authorization below), `.spaceCredential` (space-credential JWT), and the fallback compositions
`.standardOrSpaceCredential`, `.optionalStandardOrSpaceCredential`, `.serviceOrSpaceCredential`.

---

## Admin Authorization

Admin access is OAuth-only — there is no shared admin password. An operator logs in through the
normal ATProto OAuth flow with identity-only scope (`OAUTH_ADMIN_SCOPE = 'atproto'`, no repo
writes), and their DID must be an **effective admin**: on the `STRATOS_ADMIN_DIDS` config list
(comma-separated env var, parsed into `config.adminDids`) or granted at runtime through the admin
management API (`admin_user` table via `AdminUserStore`). The union is decided by one predicate,
`isEffectiveAdmin` (`oauth/admin-user-store.ts`), used by login, session resolution, and the
request-time verifier alike. Config-listed DIDs are the un-revocable recovery floor and bootstrap
path — the only write into `admin_user` is itself admin-gated, so a blank config list with an empty
table locks everyone out.

**Flow** (routes in `stratos-service/src/oauth/admin-routes.ts`, mounted at `/admin/oauth`):

| Route                        | Handler                       | Purpose                                                     |
| ---------------------------- | ----------------------------- | ----------------------------------------------------------- |
| `GET /admin/oauth/authorize` | `handlers/admin-authorize.ts` | Starts OAuth; pins `redirect_uri` to the admin callback     |
| `GET /admin/oauth/callback`  | `handlers/admin-callback.ts`  | Token exchange, effective-admin check, establishes session  |
| `GET /admin/whoami`          | inline in `admin-routes.ts`   | Returns `{ did, isAdmin }` for the active session, else 401 |
| `POST /admin/oauth/logout`   | inline in `admin-routes.ts`   | Deletes the session and clears the cookie                   |

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

---

## Lexicons

Lexicon files live in `lexicons/zone/stratos/`. Key lexicons:

| Lexicon                              | Type         | Description                                                 |
| ------------------------------------ | ------------ | ----------------------------------------------------------- |
| `zone.stratos.actor.enrollment`      | record       | User's Stratos service enrollments                          |
| `zone.stratos.boundary.defs`         | defs         | Domain/Domains type definitions                             |
| `zone.stratos.feed.post`             | record       | Post with boundary                                          |
| `zone.stratos.repo.hydrateRecord`    | query        | Single record hydration endpoint                            |
| `zone.stratos.repo.hydrateRecords`   | procedure    | Batch hydration endpoint (up to 100 records)                |
| `zone.stratos.sync.subscribeRecords` | subscription | WebSocket firehose                                          |
| `zone.stratos.sync.getRepo`          | query        | Export full repository as CAR file                          |
| `zone.stratos.repo.importRepo`       | procedure    | Import repository from CAR file                             |
| `zone.stratos.feedgen.getFeed`       | query        | Authenticated; returns fully-hydrated boundary-scoped posts |
| `zone.stratos.feedgen.describeFeed`  | query        | Unauthenticated; returns the configured feed list           |

### Adding New Lexicons

1. Create JSON file in `lexicons/zone/stratos/{namespace}/{name}.json`
2. Run codegen: `pnpm run codegen` (if configured)
3. Import generated types in handlers

---

## Common Tasks

### Adding a New Feature

1. Create port in `stratos-core/src/{feature}/port.ts`
2. Implement domain logic in `stratos-core/src/{feature}/domain.ts`
3. Add unit tests in `stratos-core/tests/{feature}.test.ts`
4. Create adapter in `stratos-service/src/features/{feature}/adapter.ts`
5. Add handlers in `stratos-service/src/features/{feature}/handler.ts`
6. Register handlers in `stratos-service/src/api/index.ts`
7. Add integration tests in `stratos-service/tests/{feature}.integration.test.ts`

### Adding a New Boundary Type

1. Update `zone.stratos.boundary.defs` lexicon
2. Add validation in `stratos-core/src/validation/stratos-validation.ts`
3. Update boundary extraction in record handlers
4. Add tests

When modifying `stratos-client/` exports or XRPC endpoints, update `stratos-client/README.md`.

---

## Comment Guidelines

Minimal comments. Only explain _why_, not _what_. Never generate: commented-out code, restated
JSDoc, section divider comments (`// ====`), or TODOs without issue refs.

---

## Commit and Pull Request Guidelines

**Do not copy the tone of the existing git history.** An agent wrote much of it.
It is not a sample of the maintainer's voice.

Write in the maintainer's voice, inside the Simplified Technical English rules.
The two fit together like this.

The rules, which are not negotiable: imperative mood, present tense, one idea per
sentence, 20 words or fewer per sentence, the same word for the same thing every
time, no idiom and no metaphor.

The voice, which comes from how the maintainer writes:

- Say the decision flatly. "Error ordering is fine for beta." Not "it may be
  worth considering whether error ordering is acceptable".
- Give the reason in the same breath, and keep it to one short sentence. State a
  general principle when there is one.
- Use "we" for a product or team decision. Use the imperative for an instruction.
- Use plain domain words: boundary, custody, spaces PDS, feedgen, sync, enroll,
  flow. Do not reach for a longer word.
- No hedging, no pleasantries, no emphasis markup, no filler.
- Name the concrete thing that changed. Do not restate the diff.

Mechanics:

- Subject line: sentence case. Use a `fix:`, `chore:`, or `ci:` prefix for
  infrastructure. Use a plain imperative for a behaviour change.
- Add a body only when the reason is not evident from the subject.
- **Do not add a `Co-Authored-By` trailer.**

Stack dependent pull requests with the `gh-stack` extension. Open the stack once
the work is complete, not one PR at a time.

---

## Logging Guidelines

Use structured logging: `logger.level({ contextObj }, 'message')`. Log request completion with
duration, business events, and failures with IDs. Never log tokens, passwords, PII, or record
contents. Don't log per-iteration in loops.

---

## References

- [Hydration Architecture](docs/architecture/hydration.md)
- [Operator Guide](docs/operator/overview.md)
- [Client Integration Guide](stratos-client/README.md)
- [Client Guide](docs/client/getting-started.md)
- [ATProto Documentation](https://atproto.com/docs)

### External Repository Research

- `github.com/bluesky-social/atproto` — AT Protocol reference implementation, lexicons, XRPC
- `github.com/bluesky-social/social-app` — Bluesky app patterns, API usage examples
- `github.com/bluesky-social/proposals` — AT Protocol proposals and specifications
- `github.com/DavidBuchanan314/atmst` — MST implementation in Python (@atcute/mst is derived from
  this)
