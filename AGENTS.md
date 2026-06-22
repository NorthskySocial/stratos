# Stratos Project - Copilot Instructions

## Project Overview

Stratos is a **standalone private permissioned data service** for ATProtocol. It provides
domain-scoped private data storage with boundary-based access control. Users enroll via OAuth, their
enrollment is published to their PDS, and downstream indexers or AppViews discover that enrollment
through `zone.stratos.actor.enrollment` records.

## Architecture

### Key Concepts

| Concept            | Description                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Boundary**       | Access control scope (e.g., "engineering", "leadership"). Records have boundaries; viewers must share at least one.                                     |
| **Enrollment**     | User registration with a Stratos service via OAuth. Creates profile record on user's PDS.                                                               |
| **Hydration**      | Clients or AppViews fetch Stratos-backed records and filter by viewer boundaries.                                                                       |
| **Profile Record** | `zone.stratos.actor.enrollment` - published to user's PDS for endpoint discovery and enrollment verification.                                           |
| **Sync Stream**    | `zone.stratos.sync.subscribeRecords` - actor-scoped WebSocket stream consumed by sync clients (the standalone `stratos-indexer` and `stratos-feedgen`). |

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

**Port/Domain pattern** (enrollment, hydration, stub, attestation):

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

| Module        | Pattern           | Description                                                        |
| ------------- | ----------------- | ------------------------------------------------------------------ |
| `enrollment`  | Port/Domain       | OAuth enrollment validation and business logic                     |
| `hydration`   | Port/Domain       | Boundary-aware record hydration for AppViews and clients           |
| `stub`        | Port/Domain       | Stub record generation with source field for PDS dual-write        |
| `attestation` | Port/Domain       | Enrollment attestation signing and verification                    |
| `record`      | Reader/Transactor | Record metadata read/write operations                              |
| `repo`        | Reader/Transactor | Repository block storage operations (IPLD blocks)                  |
| `blob`        | Reader/Transactor | Blob metadata and content read/write operations                    |
| `mst`         | Utility           | Merkle Search Tree commit builder (`builder.ts`)                   |
| `validation`  | Utility           | Stratos-specific validation rules for boundaries and records       |
| `storage`     | Ports             | Storage interface definitions (Reader/Writer ports for all stores) |
| `db`          | Infrastructure    | Database schema (Drizzle), SQLite + Postgres support, migrations   |
| `shared`      | Infrastructure    | Shared error types and domain-specific exceptions                  |

**Service feature modules** (`stratos-service/src/features/`):

| Module       | Files                                         | Description                                              |
| ------------ | --------------------------------------------- | -------------------------------------------------------- |
| `enrollment` | `adapter.ts`, `handler.ts`, `index.ts`        | Enrollment port implementation and XRPC handlers         |
| `hydration`  | `adapter.ts`, `handler.ts`, `index.ts`        | Hydration adapter and batch/single record endpoints      |
| `mst`        | `signer.ts`, `storage-adapter.ts`, `index.ts` | MST signer and storage adapter (no handlers)             |
| `stub`       | `adapter.ts`, `index.ts`                      | Stub generation adapter for PDS dual-write (no handlers) |

**Service infrastructure** (`stratos-service/src/`):

| Module          | Description                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/`          | XRPC handlers: `records.ts` (CRUD), `handlers.ts` (getRecord, getRepo, importRepo)                                                                        |
| `auth/`         | DPoP verification (`dpop-verifier.ts`), token introspection (`introspection-client.ts`), auth verifier (`verifier.ts`), enrollment auth (`enrollment.ts`) |
| `oauth/`        | OAuth client (`client.ts`), authorization routes (`routes.ts`)                                                                                            |
| `subscription/` | WebSocket firehose (`subscribe-records.ts`) for Stratos sync consumers                                                                                    |
| `blobstore/`    | Blob storage backends: disk (`disk.ts`), S3 (`s3.ts`)                                                                                                     |
| `adapters/`     | Storage backend implementations: `sqlite/`, `postgres/`                                                                                                   |

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

| File                | Description                                                   |
| ------------------- | ------------------------------------------------------------- |
| `indexer.ts`        | Main Indexer class — health server, lifecycle management      |
| `config.ts`         | IndexerConfig interface, environment variable loading         |
| `pds-firehose.ts`   | Connects to the PDS firehose and discovers enrollment records |
| `stratos-sync.ts`   | Service and actor-level WebSocket subscription handlers       |
| `record-decoder.ts` | Decodes CBOR records, extracts boundaries                     |
| `cursor-manager.ts` | Manages PDS and Stratos sync cursors with periodic flush      |
| `worker-pool.ts`    | Thread pool for concurrent processing                         |
| `backfill.ts`       | Backfill existing repos on startup                            |

**Feed generator** (`stratos-feedgen/src/`):

Standalone service that subscribes to a single upstream Stratos, indexes posts
into a local SQLite (WAL) store, and serves boundary-scoped, hydrated feeds to
clients. Inbound requests carry a user service-auth JWT (`iss=userDID`,
`aud=feedgenDID`); the feedgen resolves the user DID, looks up the viewer's
boundaries, and returns only posts the viewer may see. Outbound calls to the
upstream Stratos (including the sync WebSocket) use a feedgen-minted service-auth
JWT (`iss=feedgenDID`, `aud=stratosDID`).

| File / dir      | Description                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `server.ts`     | Express app: XRPC handlers, `/health`, `/.well-known/did.json` DID document                    |
| `api/feed/`     | `getFeed.ts`, `describeFeed.ts` XRPC handlers                                                  |
| `auth/`         | Inbound service-auth JWT verifier (`verifier.ts`, `identity.ts`)                               |
| `subscription/` | Background sync workers: `service-stream.ts`, `actor-syncer.ts`, `actor-pool.ts`, `indexer.ts` |
| `upstream/`     | `UpstreamStratosClient` (`client.ts`) + `mintServiceJwt` (`jwt.ts`) to the upstream Stratos    |
| `enrollment/`   | Viewer-boundary cache (`manager.ts` + TTL/LRU in `lru.ts`)                                     |
| `db/`           | Local post/boundary/cursor index (`sqlite.ts`, `postgres.ts`, `schema/`)                       |
| `feeds/`        | Feed registry and static feed config (`config.ts`, `index.ts`)                                 |

**Feed generator lexicons** (`lexicons/zone/stratos/feedgen/`): `getFeed`
(authenticated), `describeFeed` (unauthenticated). Required env vars:
`FEEDGEN_SERVICE_DID`, `FEEDGEN_SIGNING_KEY`, `STRATOS_SERVICE_URL`,
`STRATOS_SERVICE_DID`. See `stratos-feedgen/README.md` for the full architecture
diagram and auth-flow table.

### Storage Architecture

Storage interfaces are defined in `stratos-core/src/storage/*.ts` with adapters in
`stratos-service/src/adapters/` (sqlite and postgres). Each store has a Reader (read-only) and
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

Mutation testing (StrykerJS, via `pnpm --filter <package> mutation`) exists to validate that tests
actually catch regressions — it is the primary gate for trusting AI-generated code and the tests that
accompany it. It is **not** CI-enforced; it is a local verification step the agent is responsible for
running.

When a change requires adding or running tests to validate behaviour, you MUST:

- Run mutation testing on the modules you changed and confirm surviving mutants are addressed (or
  explicitly justified) before considering the work done. A green test suite alone is insufficient.
- Extend the mutation `mutate` globs in the relevant `stryker.config.json` to cover any new
  source files/modules you introduced, so the new code is actually under mutation analysis.
- Treat surviving mutants in changed code as a signal that the tests are weak — strengthen the tests or review the code and improve it
  rather than weakening the thresholds.

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

Follow the pattern in `stratos-service/src/api/records.ts` for handler structure.

Auth verifier options: `ctx.authVerifier.standard` (OAuth), `.optionalStandard`, `.service` (
inter-service JWT), `.admin` (basic/bearer).

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

## Logging Guidelines

Use structured logging: `logger.level({ contextObj }, 'message')`. Log request completion with
duration, business events, and failures with IDs. Never log tokens, passwords, PII, or record
contents. Don't log per-iteration in loops.

---

## References

- [Hydration Architecture](../docs/hydration-architecture.md)
- [Operator Guide](../docs/operator-guide.md)
- [Client Integration Guide](../stratos-client/README.md)
- [Client Guide](../docs/client-guide.md)
- [ATProto Documentation](https://atproto.com/docs)

### External Repository Research

- `github.com/bluesky-social/atproto` — AT Protocol reference implementation, lexicons, XRPC
- `github.com/bluesky-social/social-app` — Bluesky app patterns, API usage examples
- `github.com/bluesky-social/proposals` — AT Protocol proposals and specifications
- `github.com/DavidBuchanan314/atmst` — MST implementation in Python (@atcute/mst is derived from
  this)
