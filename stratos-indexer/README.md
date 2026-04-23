# Stratos Indexer

The Stratos Indexer is a standalone service designed to consume and index private records from Stratos services. It enables AppViews and other downstream consumers to discover and index data that is stored outside of the public ATProtocol network but within the Stratos ecosystem.

## Overview

Stratos records are stored in domain-scoped private storage. While the public PDS only contains "stub" records pointing to the Stratos service, the Indexer connects to both the public PDS firehose (to discover enrollments) and the Stratos service's sync streams (to fetch the actual private records).

### Key Features

- **Enrollment Discovery**: Monitors the PDS firehose for `zone.stratos.actor.enrollment` records.
- **Actor-Scoped Sync**: Subscribes to `zone.stratos.sync.subscribeRecords` streams for enrolled users.
- **Boundary Extraction**: Decodes records and extracts boundary information for access control.
- **Backfill Support**: Automatically backfills existing repositories upon discovery or startup.
- **Concurrency Management**: Efficiently handles multiple actor streams using a worker pool and configurable concurrency.

## Architecture

The indexer consists of several core components:

- **Indexer**: Main class managing the lifecycle, health server, and coordination between components.
- **PDS Firehose**: Connects to the public network to monitor for enrollment changes.
- **Stratos Sync**: Manages WebSocket connections to Stratos service instances for real-time record updates.
- **Record Decoder**: Handles CBOR decoding and boundary extraction from Stratos-specific lexicons.
- **Cursor Manager**: Persists sync progress to ensure no data is lost during restarts.
- **Worker Pool**: Manages concurrent processing of records and actor sync tasks.

## Configuration

The indexer is configured primarily through environment variables.

### Database

- `BSKY_DB_POSTGRES_URL` (Required): Connection string for the Postgres database.
- `BSKY_DB_POSTGRES_SCHEMA`: Database schema (default: `bsky`).
- `BSKY_DB_POOL_SIZE`: Database connection pool size (default: `20`).

### PDS Connection

- `BSKY_REPO_PROVIDER` (Required): URL of the PDS or relay providing the repo firehose.
- `BACKFILL_ENROLLED_ONLY`: If true, only backfills actors that are explicitly enrolled (default: `false`).

### Stratos Service

- `STRATOS_SERVICE_URL` (Required): Base URL of the Stratos service to sync from.
- `STRATOS_SYNC_TOKEN` (Required): Authentication token for subscribing to Stratos sync streams.

### Identity

- `BSKY_DID_PLC_URL`: URL of the DID PLC directory (default: `https://plc.directory`).

### Health & Monitoring

- `HEALTH_PORT`: Port for the health check server (default: `3002`).

### Worker & Sync Settings

- `WORKER_CONCURRENCY`: Number of concurrent workers for record processing (default: `4`).
- `WORKER_MAX_QUEUE_SIZE`: Maximum size of the worker queue (default: `100`).
- `CURSOR_FLUSH_INTERVAL_MS`: How often to persist cursors to the database (default: `5000`).
- `ACTOR_SYNC_CONCURRENCY`: Number of concurrent actor sync operations (default: `8`).
- `ACTOR_SYNC_MAX_CONNECTIONS`: Maximum number of simultaneous WebSocket connections to Stratos (default: `20`).

## Development

### Prerequisites

- Node.js (v20 or later)
- Pnpm
- Postgres database

### Running the Indexer

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Set environment variables (see Configuration section).

3. Start the indexer:
   ```bash
   # From the project root
   pnpm run start --project stratos-indexer
   ```

### Testing

Run unit tests:

```bash
pnpm exec vitest run stratos-indexer
```
