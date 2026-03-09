# Stratos Project - Copilot Instructions

## Project Overview

Stratos is a **standalone private permissioned data service** for ATProtocol. It provides domain-scoped private data storage with boundary-based access control. Users enroll via OAuth, their enrollment is published to their PDS, and AppViews hydrate records from Stratos at request time.

## Architecture

### Key Concepts

| Concept            | Description                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| **Boundary**       | Access control scope (e.g., "engineering", "leadership"). Records have boundaries; viewers must share at least one. |
| **Enrollment**     | User registration with a Stratos service via OAuth. Creates profile record on user's PDS.                           |
| **Hydration**      | AppView calls Stratos to fetch records, filtering by viewer's boundaries.                                           |
| **Profile Record** | `app.northsky.stratos.actor.enrollment` - published to user's PDS for endpoint discovery.                           |

### Packages

```
stratos/
├── stratos-core/       # Domain logic, ports (interfaces)
├── stratos-service/    # HTTP service, adapters (implementations)
├── stratos-client/     # Client library (discovery, routing, verification, scopes)
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
- Don't use flag arguments. Split method into several independent methods that can be called from the client without the flag.

## Feature-Sliced Architecture

Each feature is self-contained with its own:

- **Port** (interface in stratos-core)
- **Domain logic** (business rules in stratos-core)
- **Adapter** (implementation in stratos-service)
- **Handler** (XRPC/HTTP endpoints in stratos-service)
- **Tests** (unit in stratos-core, integration in stratos-service)

### Feature Patterns

Features in stratos-core follow one of two patterns:

**Port/Domain pattern** (enrollment, hydration, stub):

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

| Module       | Pattern           | Description                                                        |
| ------------ | ----------------- | ------------------------------------------------------------------ |
| `enrollment` | Port/Domain       | OAuth enrollment validation and business logic                     |
| `hydration`  | Port/Domain       | Boundary-aware record hydration for AppViews                       |
| `stub`       | Port/Domain       | Stub record generation with source field for PDS dual-write        |
| `record`     | Reader/Transactor | Record metadata read/write operations                              |
| `repo`       | Reader/Transactor | Repository block storage operations (IPLD blocks)                  |
| `blob`       | Reader/Transactor | Blob metadata and content read/write operations                    |
| `mst`        | Utility           | Merkle Search Tree commit builder (`builder.ts`)                   |
| `validation` | Utility           | Stratos-specific validation rules for boundaries and records       |
| `storage`    | Ports             | Storage interface definitions (Reader/Writer ports for all stores) |
| `db`         | Infrastructure    | Database schema (Drizzle), SQLite + Postgres support, migrations   |
| `shared`     | Infrastructure    | Shared error types and domain-specific exceptions                  |

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
| `subscription/` | WebSocket firehose (`subscribe-records.ts`) for AppView indexing                                                                                          |
| `blobstore/`    | Blob storage backends: disk (`disk.ts`), S3 (`s3.ts`)                                                                                                     |
| `adapters/`     | Storage backend implementations: `sqlite/`, `postgres/`                                                                                                   |

**Client library** (`stratos-client/src/`):

| File              | Description                                                          |
| ----------------- | -------------------------------------------------------------------- |
| `discovery.ts`    | Enrollment discovery from user PDS; locates Stratos service endpoint |
| `routing.ts`      | Service routing; directs requests to correct Stratos instance        |
| `verification.ts` | Record verification with inclusion proofs                            |
| `scopes.ts`       | OAuth scope declarations                                             |
| `types.ts`        | Client type definitions                                              |

### Storage Architecture

Storage interfaces are defined in `stratos-core/src/storage/*.ts` with adapters in `stratos-service/src/adapters/` (sqlite and postgres). Each store has a Reader (read-only) and Writer (extends Reader) variant. Read the interface files directly for method signatures.

Composite interfaces group stores per scope:

- `ActorStoreReaders` / `ActorStoreWriters` — per-actor stores: `record`, `blobMetadata`, `blobContent`, `repo`, `sequence`
- `ServiceStores` — service-level stores: `enrollment`

**Enrollment** uses a dual-type pattern: `Enrollment` (domain, with `Date`) vs `StoredEnrollment` (storage, with string dates).

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

Follow the pattern in `stratos-core/src/enrollment/port.ts` (port) and `stratos-service/src/features/enrollment/adapter.ts` (adapter).

### Error Handling

Use domain-specific error classes extending `StratosError`. See `stratos-core/src/shared/errors.ts`.

---

## Testing

Unit tests in `stratos-core/tests/`, integration tests in `stratos-service/tests/`. Uses vitest. Follow patterns in existing test files. Run: `pnpm exec vitest run`. When creating mock data, use names and places from popular 90s anime.

---

## Database

Per-actor SQLite databases at `{dataDir}/actors/{did-prefix}/{did}/stratos.sqlite` (tables: `stratos_record`, `stratos_blob`, `stratos_repo_block`, `stratos_repo_root`, `stratos_seq`). Service-level data in `{dataDir}/service.sqlite` (`enrollment`, `enrollment_boundary`, `oauth_session`, `oauth_state`). Schema defined via Drizzle in `stratos-core/src/db/schema/`.

---

## XRPC Handlers

Follow the pattern in `stratos-service/src/api/records.ts` for handler structure.

Auth verifier options: `ctx.authVerifier.standard` (OAuth), `.optionalStandard`, `.service` (inter-service JWT), `.admin` (basic/bearer).

---

## Lexicons

Lexicon files live in `lexicons/app/northsky/stratos/`. Key lexicons:

| Lexicon                                      | Type         | Description                                  |
| -------------------------------------------- | ------------ | -------------------------------------------- |
| `app.northsky.stratos.actor.enrollment`      | record       | User's Stratos service enrollments           |
| `app.northsky.stratos.boundary.defs`         | defs         | Domain/Domains type definitions              |
| `app.northsky.stratos.feed.post`             | record       | Post with boundary                           |
| `app.northsky.stratos.repo.hydrateRecord`    | query        | Single record hydration endpoint             |
| `app.northsky.stratos.repo.hydrateRecords`   | procedure    | Batch hydration endpoint (up to 100 records) |
| `app.northsky.stratos.sync.subscribeRecords` | subscription | WebSocket firehose                           |
| `app.northsky.stratos.sync.getRepo`          | query        | Export full repository as CAR file           |
| `app.northsky.stratos.repo.importRepo`       | procedure    | Import repository from CAR file              |

### Adding New Lexicons

1. Create JSON file in `lexicons/app/northsky/stratos/{namespace}/{name}.json`
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

1. Update `app.northsky.stratos.boundary.defs` lexicon
2. Add validation in `stratos-core/src/validation/stratos-validation.ts`
3. Update boundary extraction in record handlers
4. Add tests

When modifying `stratos-client/` exports or XRPC endpoints, update `stratos-client/README.md`.

---

## Comment Guidelines

Minimal comments. Only explain _why_, not _what_. Never generate: commented-out code, restated JSDoc, section divider comments (`// ====`), or TODOs without issue refs.

---

## Logging Guidelines

Use structured logging: `logger.level({ contextObj }, 'message')`. Log request completion with duration, business events, and failures with IDs. Never log tokens, passwords, PII, or record contents. Don't log per-iteration in loops.

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
- `github.com/DavidBuchanan314/atmst` — MST implementation in Python (@atcute/mst is derived from this)
- `github.com/DavidBuchanan314/atmst` — MST implementation in Python (@atcute/mst is derived from this)
