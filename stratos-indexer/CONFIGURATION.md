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

| Variable                       | Default | Description                                                                                                                                                                                  |
| ------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKER_CONCURRENCY`           | `4`     | Number of concurrent PDS firehose message processors. Each worker may perform multiple DB operations per message.                                                                            |
| `WORKER_MAX_QUEUE_SIZE`        | `100`   | Maximum queued firehose messages before backpressure pauses the firehose consumer. Higher values increase memory usage; lower values throttle indexing throughput.                           |
| `BACKGROUND_QUEUE_CONCURRENCY` | `10`    | Maximum concurrent tasks in the background queue (handle resolution, DID indexing). The upstream `BackgroundQueue` defaults to unlimited — this cap prevents unbounded promise accumulation. |
| `ACTOR_SYNC_CONCURRENCY`       | `8`     | Maximum concurrent per-actor Stratos WebSocket drains. Each active drain holds a DB connection while processing.                                                                             |
| `ACTOR_SYNC_QUEUE_PER_ACTOR`   | `10`    | Maximum buffered WebSocket messages per actor. When exceeded, the oldest message is dropped. Keep this low to bound memory under high write rates.                                           |

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

### Health

| Variable      | Default | Description                                         |
| ------------- | ------- | --------------------------------------------------- |
| `HEALTH_PORT` | `3002`  | Port for the HTTP health check endpoint (`/health`) |

## Tuning Guide

### Memory-constrained environments (< 4 GiB)

Reduce queue sizes and concurrency:

```
WORKER_MAX_QUEUE_SIZE=50
ACTOR_SYNC_QUEUE_PER_ACTOR=5
BACKGROUND_QUEUE_CONCURRENCY=5
ACTOR_SYNC_CONCURRENCY=4
```

### High-throughput environments (> 200 posts/sec)

Increase pool and concurrency:

```
BSKY_DB_POOL_SIZE=30
WORKER_CONCURRENCY=8
BACKGROUND_QUEUE_CONCURRENCY=15
ACTOR_SYNC_CONCURRENCY=12
WORKER_MAX_QUEUE_SIZE=200
```

### Connection pool sizing

The pool should accommodate all concurrent consumers:

```
BSKY_DB_POOL_SIZE ≥ WORKER_CONCURRENCY + ACTOR_SYNC_CONCURRENCY + BACKGROUND_QUEUE_CONCURRENCY
```

With defaults: `20 ≥ 4 + 8 + 10 = 22` — consider increasing to 25 if you see
pool wait warnings under sustained load.
