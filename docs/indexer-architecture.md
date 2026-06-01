# Stratos Indexer Architecture

The `stratos-indexer` is a standalone service that consumes the ATProtocol PDS firehose and Stratos
sync streams to index private domain-scoped records for downstream consumption by AppViews.

## High-Level Pipeline

1. **PDS Firehose (`pds-firehose.ts`)**: Connects to the PDS firehose (
   `com.atproto.sync.subscribeRepos`) to discover `zone.stratos.actor.enrollment` records. These
   records indicate that a user has enrolled in a Stratos service.
2. **Stratos Enrollment Stream (`stratos-sync.ts`)**: Connects to a Stratos service's service-level
   enrollment stream to receive real-time notifications about user enrollments and unenrollments.
3. **Actor Synchronization (`stratos-sync.ts`)**: For each enrolled user, the indexer maintains a
   WebSocket connection to the user's Stratos service via the `zone.stratos.sync.subscribeRecords`
   endpoint. This stream provides actor-scoped Stratos-backed records (e.g.,
   `zone.stratos.feed.post`).
4. **Indexing (`db.ts`, `stratos-sync.ts`)**: Records discovered from the actor sync streams are
   indexed into a PostgreSQL database. Stratos-specific metadata (like boundaries) is extracted and
   stored to support boundary-aware hydration.

## Key Components

- **`Indexer`**: The main entry point that manages the lifecycle of all other components.
- **`WorkerPool`**: Manages a pool of concurrent workers to process PDS firehose messages. Provides
  backpressure to prevent the indexer from being overwhelmed.
- **`StratosActorSync`**: Manages a pool of WebSocket connections to various Stratos services.
  Handles connection pooling, idle eviction, and exponential backoff for reconnections.
- **`CursorManager`**: Tracks the processing position (sequence numbers) for both the PDS firehose
  and each individual actor sync stream. Periodically flushes these cursors to the database.
- **`Backfill`**: On startup, the indexer can backfill existing repositories from the PDS to ensure
  all previously enrolled users are captured.

## Reliability and Performance

- **Health Checks**: The indexer provides `/health` and `/ready` endpoints to monitor database
  connectivity and stream connection status.
- **Traceability**: Trace IDs are propagated through the firehose processing pipeline and included
  in structured logs.
- **Backpressure**: Multiple levels of backpressure are implemented (WorkerPool, ActorSync queues)
  to ensure stable performance under high load.
- **Graceful Shutdown**: All components are shut down in a specific sequence to ensure no data loss
  and proper flushing of state.

## Configuration

The indexer is configured via environment variables, validated using Zod. See `src/config.ts` for a
full list of available options and their defaults.
