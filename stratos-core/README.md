# Stratos Core

Stratos Core is the shared library containing the domain logic, port definitions (interfaces), and
foundational infrastructure for the Stratos private data service. It is designed to be consumed by
both the Stratos service and the Stratos indexer.

## Overview

The core library implements the business rules of the Stratos ecosystem, including boundary-based
access control, enrollment validation, and the foundational storage patterns used across the
project. It follows a strict "Port and Adapter" architecture where core defines the interfaces (
ports) and domain logic, leaving implementations (adapters) to the service layer.

## Module Layout

Stratos Core is organized into feature-sliced modules, each following specific design patterns:

### Core Domain Modules

| Module        | Pattern           | Description                                                         |
| :------------ | :---------------- | :------------------------------------------------------------------ |
| `enrollment`  | Port/Domain       | OAuth enrollment validation and registration business logic.        |
| `hydration`   | Port/Domain       | Boundary-aware record hydration for AppViews and clients.           |
| `stub`        | Port/Domain       | Stub record generation for public PDS dual-write operations.        |
| `attestation` | Port/Domain       | Enrollment attestation signing and verification logic.              |
| `record`      | Reader/Transactor | High-level record metadata read/write operations.                   |
| `atproto`     | Utility           | ATProto/CBOR utilities (CID computation, record encoding/decoding). |
| `config`      | Utility           | Shared configuration schemas and validation helpers.                |
| `repo`        | Reader/Transactor | Repository block storage operations (IPLD blocks).                  |
| `blob`        | Reader/Transactor | Blob metadata and content management.                               |
| `mst`         | Utility           | Merkle Search Tree (MST) commit builder.                            |
| `validation`  | Utility           | Stratos-specific validation rules for boundaries and records.       |
| `storage`     | Ports             | Interface definitions for all storage backends.                     |
| `db`          | Infrastructure    | Database schema definitions using Drizzle ORM.                      |
| `shared`      | Infrastructure    | Shared error types (`StratosError`) and domain exceptions.          |

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
