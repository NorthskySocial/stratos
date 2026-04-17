# Stratos Service

The Stratos Service is a standalone private permissioned data service for ATProtocol. It provides domain-scoped private data storage with boundary-based access control, allowing users to store and share records within specific organizational or community boundaries (e.g., "engineering", "leadership").

## Overview

Stratos acts as a specialized PDS (Personal Data Server) for private data. While public data is stored on a user's primary PDS, Stratos-backed records are stored here and discovered via `zone.stratos.actor.enrollment` records on the user's PDS.

Key features:

- **Boundary-based Access Control**: Records are associated with boundaries, and only viewers who share at least one boundary can hydrate/view the records.
- **ATProtocol Compatibility**: Implements standard `com.atproto.repo.*` and `com.atproto.sync.*` XRPC methods for familiar integration.
- **Flexible Storage**: Supports SQLite (local) or PostgreSQL (scalable) backends, and local disk or S3 for blob storage.
- **OAuth Integration**: Secure enrollment and authentication via ATProtocol OAuth.

## Installation

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

- `STRATOS_DB_DIALECT`: `sqlite` or `postgres`.
- `STRATOS_DB_URL`: Connection string (e.g., `file:./data/service.sqlite` or `postgres://...`).

### Blob Storage

- `STRATOS_BLOB_STORAGE`: `local` or `s3`.
- `STRATOS_S3_BUCKET`, `STRATOS_S3_REGION`, etc. (if using S3).

### Enrollment & Boundaries

- `STRATOS_ENROLLMENT_MODE`: `open`, `allowlist`, or `invite`.
- `STRATOS_ALLOWED_DOMAINS`: Comma-separated list of allowed email/identity domains.
- `STRATOS_AUTO_ENROLL_DOMAINS`: Domains that are automatically granted boundaries upon enrollment.

## API Endpoints

### Standard ATProto Methods

- `com.atproto.repo.createRecord`: Create a new record.
- `com.atproto.repo.getRecord`: Retrieve a record (with boundary check).
- `com.atproto.repo.listRecords`: List records in a collection.
- `com.atproto.repo.deleteRecord`: Delete a record.
- `com.atproto.repo.uploadBlob`: Upload a blob.
- `com.atproto.sync.getRecord`: Get a record by CID.

### Stratos-Specific Methods

- `zone.stratos.repo.hydrateRecord`: Hydrate a single record with boundary filtering.
- `zone.stratos.repo.hydrateRecords`: Batch hydration for up to 100 records.
- `zone.stratos.sync.getRepo`: Export a full repository as a CAR file.
- `zone.stratos.repo.importRepo`: Import a repository from a CAR file.
- `zone.stratos.sync.subscribeRecords`: Actor-scoped WebSocket stream for record updates.
- `zone.stratos.sync.getBlob`: Retrieve a blob by CID with boundary filtering.
- `zone.stratos.sync.uploadBlob`: Upload a blob with boundary filtering.

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

## License

MIT
