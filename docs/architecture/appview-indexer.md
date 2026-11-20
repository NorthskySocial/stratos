---
audience: Maintainers
type: Explanation
status: legacy
---

# AppView indexer <Badge type="warning" text="legacy" />

::: danger Deprecated, and it does not run against the current service
`stratos-indexer` is deprecated. As shipped, it cannot authenticate to the
current Stratos service. It opens its sync WebSockets with a `syncToken`
query parameter and no `Authorization` header. The Stratos service accepts
only a service-auth JWT in `Authorization: Bearer` on
`zone.stratos.sync.subscribeRecords`, so it rejects the connection.

The base `docker-compose.yml` still defines an `indexer` service with
`STRATOS_SYNC_TOKEN`. That service does not receive Stratos records.

The current way to serve boundary-scoped feeds is the
[Run the feed generator](/operator/feedgen-ng). It does not use this indexer or the
AppView PostgreSQL projection.
:::

This page records how the indexer was designed. Use it to read the code in
`stratos-indexer/`, not to plan a deployment.

## What it was for

The indexer was a standalone service. It consumed the ATProtocol PDS firehose
and the Stratos sync streams. It wrote private boundary-scoped records into
the AppView's PostgreSQL database, where the AppView served them.

## Pipeline as designed

1. **PDS firehose (`pds/pds-firehose.ts`)**: connected to
   `com.atproto.sync.subscribeRepos` to discover `zone.stratos.actor.enrollment`
   records. Each record showed that a user had enrolled in a Stratos service.
2. **Stratos enrollment stream (`sync/stratos-sync.ts`)**: connected to the
   service-level stream of a Stratos service to learn about enrollments and
   unenrollments.
3. **Actor sync (`sync/stratos-sync.ts`, `sync/actor-syncer.ts`)**: for each
   enrolled user, opened a WebSocket to `zone.stratos.sync.subscribeRecords`
   for that user's records, such as `zone.stratos.feed.post`.
4. **Indexing (`storage/db.ts`, `sync/actor-syncer.ts`)**: wrote the records
   into PostgreSQL and stored each record's boundaries beside it.

Steps 2 and 3 are the ones that fail today, for the reason in the notice
above.

## Components

- **`Indexer`**: the entry point. It managed the lifecycle of the other
  components.
- **`WorkerPool`**: a pool of workers for PDS firehose messages, with
  backpressure.
- **`StratosActorSync`**: a pool of WebSocket connections to Stratos, with
  idle eviction and exponential backoff on reconnect.
- **`CursorManager`**: tracked the sequence position of the PDS firehose and
  of each actor stream, and flushed the cursors to the database on a timer.
- **Backfill (`backfill.ts`)**: on startup, read existing repositories from
  the PDS so that earlier enrollments were captured.

## Operations

- **Health checks**: the indexer serves `/health` and `/ready`.
- **Trace IDs**: firehose processing attaches a trace ID to its structured
  logs.
- **Shutdown**: components stop in a fixed order so that cursors flush.

## Configuration

The indexer reads environment variables and validates them with Zod. The
list is in `stratos-indexer/src/config.ts`.

## See also

- [Shared Stratos sync-client library](https://github.com/NorthskySocial/stratos/blob/main/docs/design/sync-client-library.md): the
  design note that first recorded why the indexer's sync path does not run.
- [AppView Integration](/operator/appview-integration): the stream contract
  the indexer was written against.
