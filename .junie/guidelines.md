# Stratos Project Development Guidelines

## Project Overview

Stratos is a **standalone private permissioned data service** for ATProtocol. It provides
domain-scoped private data storage with boundary-based access control. Users enroll via OAuth, their
enrollment is published to their PDS, and downstream indexers or AppViews discover that enrollment
through `zone.stratos.actor.enrollment` records.

## Architecture & Design Patterns

### Key Concepts

| Concept            | Description                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| **Boundary**       | Access control scope (e.g., "engineering", "leadership"). Records have boundaries; viewers must share at least one. |
| **Enrollment**     | User registration with a Stratos service via OAuth. Creates profile record on user's PDS.                           |
| **Hydration**      | Clients or AppViews fetch Stratos-backed records and filter by viewer boundaries.                                   |
| **Profile Record** | `zone.stratos.actor.enrollment` - published to user's PDS for endpoint discovery and enrollment verification.       |
| **Sync Stream**    | `zone.stratos.sync.subscribeRecords` - actor-scoped stream consumed by the standalone `stratos-indexer`.            |

### Packages

```
stratos/
├── stratos-core/       # Domain logic, ports (interfaces)
├── stratos-service/    # HTTP service, adapters (implementations)
├── stratos-client/     # Client library (discovery, routing, verification, scopes)
├── stratos-indexer/    # Standalone indexer for AppViews
├── webapp/             # Svelte-based reference web application
├── lexicons/           # ATProto lexicon definitions
└── docs/               # Technical documentation
```

### Feature-Sliced Architecture

Each feature is self-contained with its own:

- **Port** (interface in `stratos-core`)
- **Domain logic** (business rules in `stratos-core`)
- **Adapter** (implementation in `stratos-service`)
- **Handler** (XRPC/HTTP endpoints in `stratos-service`)
- **Tests** (unit in `stratos-core`, integration in `stratos-service`)

### Feature Patterns

Features in `stratos-core` follow one of two patterns:

**Port/Domain pattern** (enrollment, hydration, stub, attestation):

- `port.ts`: Interface definition.
- `domain.ts`: Pure business logic and helper functions.
- `types.ts`: Feature-specific types.

```
stratos-core/src/{feature}/
├── index.ts          # Public exports
├── port.ts           # Interface definition
├── domain.ts         # Business logic (pure functions)
└── types.ts          # Feature-specific types
```

**Reader/Transactor pattern** (record, repo, blob):

- `reader.ts`: Read-only operations (with caching).
- `transactor.ts`: Write operations (extends reader).

```
stratos-core/src/{feature}/
├── index.ts          # Public exports
├── reader.ts         # Read-only operations (with caching)
└── transactor.ts     # Write operations (extends reader)
```

**Service-side features** in `stratos-service/src/features/`:

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

**Webapp** (`webapp/src/`):

| File                  | Description                                       |
| --------------------- | ------------------------------------------------- |
| `App.svelte`          | Root component; manages global state and routing  |
| `lib/auth.ts`         | OAuth client initialization and token management  |
| `lib/feed.ts`         | Feed fetching and filtering logic                 |
| `lib/stratos.ts`      | Stratos-specific client wrappers and utilities    |
| `lib/Composer.svelte` | Record creation component with boundary selection |
| `lib/Feed.svelte`     | Main feed display component                       |

### Namespace & Isolation

- **Namespace**: Stratos uses the `zone.stratos.*` namespace for its records (e.g.,
  `zone.stratos.feed.post`).
- **Isolation**: Stratos records are strictly isolated from the `app.bsky.*` namespace.
  - Stratos posts cannot reply to or embed Bsky content.
  - Bsky posts should not embed Stratos content.
  - Stratos records are stored in separate databases and excluded from public sync/firehose.

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

**Database Details**:

- **SQLite Backend**: Per-actor databases at `{dataDir}/actors/{did-prefix}/{did}/stratos.sqlite` (
  tables: `stratos_record`, `stratos_blob`, `stratos_repo_block`, `stratos_repo_root`,
  `stratos_seq`). Service-level data in `{dataDir}/service.sqlite`.
- **Postgres Backend**: Actor data stored in per-actor schemas. Postgres-specific tables in
  `stratos-core/src/db/schema/pg-tables.ts`.
- **Schema**: Managed via Drizzle in `stratos-core/src/db/schema/`.

---

## Build & Configuration

### Prerequisites

- **pnpm**: Used for package management in this monorepo.
- **Node.js**: v20 or later.
- **Deno**: Required for running end-to-end tests.
- **SQLite/PostgreSQL**: Supported databases. SQLite is typically used for local development and
  per-actor storage.

### Build Instructions

To build all workspaces in the monorepo:

```bash
pnpm install
pnpm run build
```

This will compile `stratos-core`, `stratos-service`, `stratos-client`, and the `webapp`.

### Lexicon Codegen

If you modify lexicons in the `lexicons/` directory, update the generated types by running:

```bash
pnpm run codegen
```

---

## XRPC Handlers & Context

### XRPC Context (`ctx`)

Handlers receive a `ctx` (AppContext) object containing:

- `cfg`: Service configuration.
- `actorStore`: Access to per-actor databases (Read/Transact).
- `enrollmentStore`: Access to service-level enrollment data.
- `authVerifier`: Standard verifiers for OAuth (`ctx.authVerifier.standard`), service JWTs (
  `.service`), or admin access (`.admin`).
- `logger`: Structured pino logger.

### Handler Structure

Handlers should focus on input validation, calling domain logic via ports, and returning
XRPC-compliant responses. Follow the pattern in `stratos-service/src/api/records.ts` for handler
structure.

- **Location**: Implementation-specific handlers in
  `stratos-service/src/features/{feature}/handler.ts`; general handlers in
  `stratos-service/src/api/`.
- **Errors**: Use `XRPCError` for protocol-level errors and `StratosError` for domain logic.
- **Auth Options**: `ctx.authVerifier.standard` (OAuth), `.optionalStandard`, `.service` (
  inter-service JWT), `.admin` (basic/bearer).

### Key Lexicons

Lexicon files live in `lexicons/zone/stratos/`.

| Lexicon                              | Type         | Description                                  |
| ------------------------------------ | ------------ | -------------------------------------------- |
| `zone.stratos.actor.enrollment`      | record       | User's Stratos service enrollments           |
| `zone.stratos.boundary.defs`         | defs         | Domain/Domains type definitions              |
| `zone.stratos.feed.post`             | record       | Post with boundary                           |
| `zone.stratos.repo.hydrateRecord`    | query        | Single record hydration endpoint             |
| `zone.stratos.repo.hydrateRecords`   | procedure    | Batch hydration endpoint (up to 100 records) |
| `zone.stratos.sync.subscribeRecords` | subscription | WebSocket firehose                           |
| `zone.stratos.sync.getRepo`          | query        | Export full repository as CAR file           |
| `zone.stratos.repo.importRepo`       | procedure    | Import repository from CAR file              |

**Adding New Lexicons**:

1. Create JSON file in `lexicons/zone/stratos/{namespace}/{name}.json`
2. Run codegen: `pnpm run codegen`
3. Import generated types in handlers

---

## Coding Standards & Conventions

### Clean Code

Follow Clean code design patterns and prioritize the following:

- **Simplicity**: Keep it simple stupid. Simpler is always better. Reduce complexity as much as
  possible.
  - **Maximum Complexity**: 15 (ESLint `complexity` rule).
  - **Maximum Cognitive Complexity**: 15 (SonarJS `cognitive-complexity` rule).
  - **Maximum Function Length**: 100 lines (ESLint `max-lines-per-function` rule).
- **Configurable Data**: Keep configurable data at high levels.
- **Explanatory Variables**: Use names that describe the "why" and "what".
- **Encapsulate Boundary Conditions**: Handle edges explicitly.
- **Descriptive Names**: Choose descriptive and unambiguous names.
- **No Flag Arguments**: Split method into several independent methods that can be called from the
  client without the flag.
- **Type Safety**: The use of `any` should be avoided; prefer `unknown` and explicit type
  guards/assertions. Do not use `as any` type assertions.
- **ATProtocol Identifiers**:
  - Use the `Cid` interface (lowercase 'i') for all new development involving Content Identifiers. Avoid the deprecated `CID` class.
  - Use the `parseCid` utility from `@northskysocial/stratos-core/atproto` for all CID parsing needs. It handles `string`, `CidLink`, and `Uint8Array` inputs.

### TypeScript

- Use strict TypeScript (`strict: true`)
- Prefer interfaces over types for public APIs
- Use `unknown` over `any` (avoid `any` and `as any` whenever possible)
- Export types explicitly from index files
- Use named exports (no default exports)

### Naming Conventions

| Item            | Convention             | Example                 |
| --------------- | ---------------------- | ----------------------- |
| Files           | `kebab-case`           | `enrollment-service.ts` |
| Components      | `PascalCase`           | `PostCard.svelte`       |
| Interfaces      | `PascalCase`           | `EnrollmentService`     |
| Classes / Types | `PascalCase`           | `EnrollmentConfig`      |
| Functions       | `camelCase`            | `createEnrollment`      |
| Constants       | `SCREAMING_SNAKE_CASE` | `DEFAULT_TIMEOUT`       |

### Svelte & Webapp

- Use Svelte 5 (Runes) for state management (`$state`, `$derived`, `$effect`)
- Prefer functional components and clear property definitions
- Keep library logic in `src/lib/*.ts` and UI in `src/lib/*.svelte`
- Use the Stratos client for all service interactions
- Ensure OAuth state is properly persisted and refreshed

### Ports & Adapters

Follow the pattern in `stratos-core/src/enrollment/port.ts` (port) and
`stratos-service/src/features/enrollment/adapter.ts` (adapter).

### Error Handling

- Use domain-specific error classes extending `StratosError` (see
  `stratos-core/src/shared/errors.ts`).
- Use `XRPCError` for errors that need to be returned over the wire.
- Never expose internal error details to the client in production.

### Comment Guidelines

- **Doc Comments**: Write JSDoc comments for all public classes, interfaces, methods, and functions
  to describe their purpose. Ensure that you include `@param`, `@throws`, and `@returns` tags
  where applicable to provide complete documentation.
- **Minimal Internal Comments**: Minimal internal comments. Only explain _why_, not _what_. Never
  generate: commented-out code, restated JSDoc, section divider comments (`// ====`), or TODOs
  without issue refs.

### Logging Guidelines

Use structured logging: `logger.level({ contextObj }, 'message')`.

- Log request completion with duration, business events, and failures with IDs.
- **Privacy**: Never log tokens, passwords, PII, or record contents.
- **Performance**: Don't log per-iteration in loops.

---

## Testing Information

### Running Tests

- **Unit & Integration Tests (Vitest)**:
  Run all: `pnpm run test` or `pnpm exec vitest run`
  Run specific: `pnpm run test path/to/file.test.ts`
  Note: Only output failed tests when running tests to minimize token usage.
- **End-to-End Tests (Deno)**:
  `pnpm run e2etest`

### Guidelines

- **Unit Tests**: `stratos-core/tests/` (naming: `*.test.ts`).
- **Integration Tests**: `stratos-service/tests/` (naming: `*.integration.test.ts`).
- **Indexer Tests**: `stratos-indexer/tests/`.
- **Mock Data**: Use names and places from popular 90s anime (e.g., "Usagi Tsukino", "Neo Tokyo").
- **Reproducers**: Always write a reproduction test for bugs before fixing them.

### Simple Test Example

```typescript
import { describe, it, expect } from 'vitest'

describe('Example Test', () => {
  it('demonstrates a simple test case with 90s anime reference', () => {
    const character = 'Hiei'
    const series = 'YuYu Hakusho'

    expect(character).toBeDefined()
    expect(series).toBe('YuYu Hakusho')
  })
})
```

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

## Agent Efficiency & Cost Optimization

To minimize token usage and operate efficiently, the agent should:

- **Targeted Investigation**: Use `get_file_structure` or `search_project` before opening large files. Avoid `open_entire_file` unless the file is small (< 200 lines).
- **Concise Context**: Only open relevant sections of files using the `line_number` parameter in `open`.
- **Minimized Iteration**: Plan complex changes thoroughly to avoid multiple `search_replace` calls on the same file. Use `multi_edit` when applying several changes.
- **Focused Testing**: Run only the most relevant tests (e.g., specific test files or test names) rather than entire directories or suites when possible.
- **Failures Only**: Only output failed tests when running tests to minimize token usage and improve readability.
- **Playwright Reports**: When analyzing Playwright test failures:
  - Locate the report at `webapp/playwright-report/index.html`.
  - Open the report using the `open` tool. It will be automatically converted to Markdown, allowing you to read test results, error messages, and logs.
  - Review the "Test Results" section for failed specs and check for attached screenshots, videos, or trace files.
  - Analyze the `stdout` and `stderr` logs captured for each failed test to identify root causes.
  - If a trace is available, use it to step through the test execution timeline.
- **Limited Exploration**: Avoid broad recursive searches or listing entire directories if the relevant path is already known or can be inferred.
- **Brief Updates**: Keep `update_status` and `submit` summaries concise, focusing on key outcomes and next steps without narrating every detail.
- **Direct Execution**: When a task is clearly understood and trivial, skip unnecessary analysis steps and proceed directly to implementation.

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
