# Stratos Core

Stratos Core is the shared library containing the domain logic, port definitions (interfaces), and
foundational infrastructure for the Stratos private data service. It is designed to be consumed by
the Stratos service.

## Overview

The core library implements the business rules of the Stratos ecosystem, including boundary-based
access control, enrollment validation, and the foundational storage patterns used across the
project. It follows a strict "Port and Adapter" architecture where core defines the interfaces (
ports) and domain logic, leaving implementations (adapters) to the service layer.

## Module Layout

Stratos Core is organized into feature-sliced modules, each following specific design patterns:

### Core Domain Modules

| Module        | Pattern           | Description                                                                                                                                                            |
| ------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enrollment`  | Port/Domain       | OAuth enrollment validation and business logic                                                                                                                         |
| `hydration`   | Port/Domain       | Boundary-aware record hydration for AppViews and clients                                                                                                               |
| `attestation` | Utility           | Deterministic attestation payload construction (`createAttestationPayload` in `domain.ts`; callers sign and verify; no port)                                           |
| `record`      | Reader/Transactor | Record metadata read/write operations                                                                                                                                  |
| `repo`        | Reader/Transactor | Repository block storage operations (IPLD blocks)                                                                                                                      |
| `blob`        | Reader/Transactor | Blob metadata and content read/write operations                                                                                                                        |
| `mst`         | Utility           | Merkle Search Tree commit builder (`builder.ts`)                                                                                                                       |
| `validation`  | Utility           | Stratos-specific validation rules for boundaries and records, including the like, repost and subject rules (`like-rule.ts`, `repost-rule.ts`, `subject.ts`)            |
| `spaces`      | Utility           | Pure parsing, validation, and formatting of space/record `at:space/` URIs, plus boundary-to-space-URI mapping (`domain.ts`)                                            |
| `atproto`     | Utility           | CBOR record encoding, CID computation/parsing, CAR block reading, commit-op decoding, and boundary extraction (`index.ts`)                                             |
| `config`      | Infrastructure    | Zod schemas for storage backend, logging, and Redis env config, plus comma-list helpers (`parseCommaList`, `commaListSchema`) (`index.ts`)                             |
| `lexicons`    | Infrastructure    | `DefaultLexiconProvider` bundling Stratos + embedded `com.atproto.*` lexicons, plus vendored `app.bsky.feed.like` and `app.bsky.feed.repost` (`index.ts`, `vendored/`) |
| `storage`     | Ports             | Enrollment store port, blob-content port and cache interfaces; the actor store contract is in stratos-service                                                          |
| `db`          | Infrastructure    | Database schema (Drizzle), SQLite + Postgres support, migrations                                                                                                       |
| `shared`      | Infrastructure    | Shared error types and domain-specific exceptions                                                                                                                      |

## Architectural Patterns

### Port/Domain Pattern

Used for feature-specific logic.

- `port.ts`: Interface definitions.
- `domain.ts`: Pure business logic and functions.
- `types.ts`: Feature-specific type definitions.

### Reader/Transactor Pattern

Used for low-level storage and data management.

- `reader.ts`: Read-only operations with built-in caching.
- `transactor.ts`: Write operations (extends the reader).

## Development

### Prerequisites

- Node.js (v20 or later)
- Pnpm

### Commands

- **Build**: `pnpm run build`
- **Lint**: `pnpm run lint`
- **Format**: `pnpm run format`
- **Test**: `pnpm run test` (runs unit tests via Vitest)

## Testing

Unit tests are located in `stratos-core/tests/` and use `vitest` for execution. Stratos Core also
utilizes `fast-check` for property-based testing in certain modules.

```bash
# Run all core tests
pnpm run test
```

## License

MIT

## Changing boundary validation

When adding a boundary type, update the relevant lexicon in `../lexicons/`, the validation rules in `src/validation/`, and boundary extraction or write handling as needed. Add tests for the new rules and affected service behavior, and regenerate the client lexicon bundle as described in [the lexicon guide](../lexicons/README.md).
