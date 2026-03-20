# Stratos Indexer Configuration

The indexer is configured entirely via environment variables. All concurrency
and queue settings have sensible defaults but can be tuned for different
workloads.

## Environment Variables

### Required

| Variable               | Description                                        |
| ---------------------- | -------------------------------------------------- |
| `BSKY_DB_POSTGRES_URL` | PostgreSQL connection string                       |
| `BSKY_REPO_PROVIDER`   | PDS WebSocket endpoint (e.g. `wss://bsky.network`) |
| `STRATOS_SERVICE_URL`  | Stratos service HTTP endpoint                      |
| `STRATOS_SYNC_TOKEN`   | Auth token for Stratos WebSocket subscriptions     |

### Database

| Variable                  | Default | Description                                                                                                                                                               |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BSKY_DB_POSTGRES_URL`    | —       | PostgreSQL connection string                                                                                                                                              |
| `BSKY_DB_POSTGRES_SCHEMA` | `bsky`  | Database schema name                                                                                                                                                      |
| `BSKY_DB_POOL_SIZE`       | `20`    | PostgreSQL connection pool size. Should be at least the sum of `WORKER_CONCURRENCY` + `ACTOR_SYNC_CONCURRENCY` + `BACKGROUND_QUEUE_CONCURRENCY` to avoid pool contention. |

### Concurrency

| Variable                        | Default | Description                                                                                                                                                                                  |
| ------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKER_CONCURRENCY`            | `4`     | Number of concurrent PDS firehose message processors. Each worker may perform multiple DB operations per message.                                                                            |
| `WORKER_MAX_QUEUE_SIZE`         | `100`   | Maximum queued firehose messages before backpressure pauses the firehose consumer. Higher values increase memory usage; lower values throttle indexing throughput.                           |
| `BACKGROUND_QUEUE_CONCURRENCY`  | `10`    | Maximum concurrent tasks in the background queue (handle resolution, DID indexing). The upstream `BackgroundQueue` defaults to unlimited — this cap prevents unbounded promise accumulation. |
| `ACTOR_SYNC_CONCURRENCY`        | `8`     | Maximum concurrent per-actor Stratos WebSocket drains. Each active drain holds a DB connection while processing.                                                                             |
| `ACTOR_SYNC_QUEUE_PER_ACTOR`    | `10`    | Maximum buffered WebSocket messages per actor. When exceeded, the oldest message is dropped. Keep this low to bound memory under high write rates.                                           |
| `ACTOR_SYNC_GLOBAL_MAX_PENDING` | `500`   | Maximum total pending messages across all actor sync queues. When exceeded, new messages are dropped until the queue drains.                                                                 |
| `ACTOR_SYNC_DRAIN_DELAY_MS`     | `5`     | Delay in milliseconds between processing batches in actor sync drains. Prevents a single actor from monopolizing a worker.                                                                   |
| `ACTOR_SYNC_MAX_CONNECTIONS`    | `20`    | Maximum simultaneous WebSocket connections to Stratos. Actors beyond this limit are queued and connected as slots free up. Limits native memory from WebSocket buffers.                      |
| `ACTOR_SYNC_CONNECT_DELAY_MS`   | `200`   | Delay in milliseconds between opening successive WebSocket connections. Staggers connection establishment to prevent thundering herd on startup.                                             |
| `BACKGROUND_QUEUE_MAX_SIZE`     | `1000`  | Maximum items in the background queue (handle resolution, DID indexing). Tasks submitted beyond this limit are dropped to prevent unbounded memory growth.                                   |

### Timing

| Variable                   | Default | Description                                                                                                         |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `CURSOR_FLUSH_INTERVAL_MS` | `5000`  | How often sync cursors are flushed to the database (in ms). All actor cursors are written in a single batch INSERT. |

### Identity

| Variable           | Default                 | Description                          |
| ------------------ | ----------------------- | ------------------------------------ |
| `BSKY_DID_PLC_URL` | `https://plc.directory` | PLC directory URL for DID resolution |

### Backfill

| Variable                 | Default | Description                                                                                 |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------- |
| `BACKFILL_ENROLLED_ONLY` | `false` | When `true`, only backfill actors that are enrolled in Stratos (skips full PDS repo crawl). |

### Memory

| Variable    | Default | Description                                                                                                                                                                                                         |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEM_LIMIT` | —       | Override V8 heap size in megabytes. When set, this value is used directly as `--max-old-space-size`. When unset, the heap is auto-sized to 80% of the container's cgroup memory limit (or host memory as fallback). |

### Health

| Variable      | Default | Description                                         |
| ------------- | ------- | --------------------------------------------------- |
| `HEALTH_PORT` | `3002`  | Port for the HTTP health check endpoint (`/health`) |

## Tuning Guide

### Memory-constrained environments (< 4 GiB)

Reduce queue sizes and concurrency:

```
MEM_LIMIT=2048
WORKER_MAX_QUEUE_SIZE=50
ACTOR_SYNC_QUEUE_PER_ACTOR=5
ACTOR_SYNC_GLOBAL_MAX_PENDING=200
BACKGROUND_QUEUE_CONCURRENCY=5
BACKGROUND_QUEUE_MAX_SIZE=500
ACTOR_SYNC_CONCURRENCY=4
ACTOR_SYNC_MAX_CONNECTIONS=10
```

### High-throughput environments (> 200 posts/sec)

Increase pool and concurrency:

```
BSKY_DB_POOL_SIZE=40
WORKER_CONCURRENCY=8
WORKER_MAX_QUEUE_SIZE=200
BACKGROUND_QUEUE_CONCURRENCY=15
BACKGROUND_QUEUE_MAX_SIZE=2000
ACTOR_SYNC_CONCURRENCY=12
ACTOR_SYNC_GLOBAL_MAX_PENDING=1000
ACTOR_SYNC_MAX_CONNECTIONS=40
```

### Connection pool sizing

The pool should accommodate all concurrent consumers:

```
BSKY_DB_POOL_SIZE ≥ WORKER_CONCURRENCY + ACTOR_SYNC_CONCURRENCY + BACKGROUND_QUEUE_CONCURRENCY
```

With defaults: `20 ≥ 4 + 8 + 10 = 22` — consider increasing to 25 if you see
pool wait warnings under sustained load.
