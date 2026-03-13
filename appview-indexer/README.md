# Appview Indexer

Ingests data from a PDS firehose and Stratos sync streams into the Bluesky AppView database. This bridges standard ATProto records from the PDS with boundary-scoped Stratos records, populating the Postgres tables that the AppView DataPlane reads from.

## Architecture

The indexer operates three subscription paths in parallel:

```
┌─ PDS Firehose (com.atproto.sync.subscribeRepos) ──────────────────┐
│  #commit: app.bsky.* records → IndexingService → Postgres          │
│  #commit: zone.stratos.actor.enrollment (create) → register DID    │
│  #commit: zone.stratos.actor.enrollment (delete) → deregister DID  │
│  #identity → re-resolve DID → handle PDS migration                 │
│  #account → track hosting status                                   │
└────────────────────────────────────────────────────────────────────┘

┌─ Stratos Service Subscription (subscribeRecords, no did) ──────────┐
│  #enrollment: real-time enroll/unenroll notifications               │
│  → start/stop per-actor sync subscriptions                         │
└────────────────────────────────────────────────────────────────────┘

┌─ Stratos Per-Actor Subscriptions (subscribeRecords?did=X) ─────────┐
│  #commit: zone.stratos.feed.post → stratos_post table → Postgres   │
│  One WebSocket per enrolled actor                                  │
└────────────────────────────────────────────────────────────────────┘
```

### Startup Sequence

1. Initialize Postgres connection via `@atproto/bsky` Database
2. Connect to Stratos service-level enrollment stream
3. Backfill existing repos from the seed PDS (discovers enrollments during processing)
4. Start PDS firehose subscription (continues discovering enrollments live)
5. Per-actor Stratos sync subscriptions auto-start as enrollments are discovered

### Enrollment Discovery

Enrollments are discovered through two paths:

- **PDS firehose**: `zone.stratos.actor.enrollment` stub records contain a `service` field pointing to the Stratos instance. Create events register, delete events deregister.
- **Stratos service stream**: `#enrollment` messages on the service-level `subscribeRecords` endpoint provide real-time enrollment notifications before PDS propagation.

Either path triggers a per-actor Stratos sync subscription.

### Stratos Record Indexing

Per-actor `subscribeRecords` streams deliver `#commit` events containing `zone.stratos.feed.post` records. These are indexed to the `stratos_post` and `stratos_post_boundary` tables with field extraction for text, reply refs, embeds, facets, langs, tags, and boundaries.

### Backfill

On startup, the indexer enumerates repos via `com.atproto.sync.listRepos` and fetches records via `com.atproto.repo.listRecords`. Enrollment records discovered during backfill automatically start per-actor Stratos subscriptions.

## Environment Variables

### Required

| Variable               | Description                                                        |
| ---------------------- | ------------------------------------------------------------------ |
| `BSKY_DB_POSTGRES_URL` | Postgres connection URL for the AppView DataPlane database         |
| `BSKY_REPO_PROVIDER`   | PDS WebSocket URL for the firehose (`wss://hostname`)              |
| `STRATOS_SERVICE_URL`  | Stratos service HTTPS URL                                          |
| `STRATOS_SYNC_TOKEN`   | Pre-shared token for authenticating with the Stratos sync endpoint |

### Optional

| Variable                  | Default                 | Description                             |
| ------------------------- | ----------------------- | --------------------------------------- |
| `BSKY_DB_POSTGRES_SCHEMA` | `bsky`                  | Postgres schema name                    |
| `BSKY_DB_POOL_SIZE`       | `10`                    | Postgres connection pool size           |
| `BSKY_DID_PLC_URL`        | `https://plc.directory` | PLC directory URL for DID resolution    |
| `HEALTH_PORT`             | `3002`                  | HTTP port for the health check endpoint |

## Local Development

### Prerequisites

- [Deno](https://deno.com/) v2+
- A running Postgres instance with the AppView schema
- Access to a PDS and Stratos service

### Run

```bash
# Set required environment variables
export BSKY_DB_POSTGRES_URL=postgresql://localhost:5432/bsky
export BSKY_REPO_PROVIDER=wss://your-pds.example.com
export STRATOS_SERVICE_URL=https://stratos.example.com
export STRATOS_SYNC_TOKEN=your-sync-token

deno task start
```

### Test

```bash
deno task test
```

### Docker

```bash
docker build -t appview-indexer .
docker run --env-file .env appview-indexer
```

## Health Check

`GET /health` on the configured port (default 3002) returns:

```json
{
  "ok": true,
  "enrolledActors": 42,
  "activeActorSyncs": 42
}
```

## Module Overview

| Module                    | Description                                                       |
| ------------------------- | ----------------------------------------------------------------- |
| `src/config.ts`           | Environment variable parsing and validation                       |
| `src/db.ts`               | Database, IdResolver, and IndexingService initialization          |
| `src/pds-subscription.ts` | PDS firehose consumer with CBOR decoding and enrollment discovery |
| `src/stratos-sync.ts`     | Stratos service-level enrollment stream and per-actor record sync |
| `src/backfill.ts`         | Startup repo backfill via listRepos/listRecords                   |
| `src/indexer.ts`          | Orchestrator that wires all components together                   |
| `src/bin/main.ts`         | Entrypoint with signal handling                                   |
