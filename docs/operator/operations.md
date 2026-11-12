# Operations

A quiet Stratos is a healthy Stratos. Most days you only watch three things:
the service answers, the enrollment records reach members' PDS hosts, and the
backup ran. This page covers each of them, then scaling.

## Health checks

```bash
curl localhost:3100/health
# {"status":"ok","components":{"db":"ok","blobstore":"ok"},"version":"0.3.1"}
```

`/health` and `/ready` return the same body. Both return HTTP 200 when the
database answers and HTTP 503 when it does not. Use either one for a load
balancer or container health check.

The **Health** tab of the admin interface shows the same information.

## Monitoring

Stratos exports OpenTelemetry metrics when you set
`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`. See
[Observability](/operator/configuration#observability).

| Metric                                      | Type      | Meaning                                            |
| ------------------------------------------- | --------- | -------------------------------------------------- |
| `stratos.service.ready`                     | Gauge     | `1` when the service has started                   |
| `stratos.telemetry.heartbeat`               | Gauge     | Unix time of the latest observation                |
| `http.server.request.duration`              | Histogram | Request latency, by method, route, and status      |
| `http.server.active_requests`               | Gauge     | Requests in flight                                 |
| `stratos.service.auth.requests`             | Counter   | Authentication outcomes: `ok`, `rejected`, `error` |
| `stratos.service.record.operations`         | Counter   | Record writes, by operation and outcome            |
| `stratos.service.sync.connections`          | Gauge     | Open sync stream connections                       |
| `stratos.service.sync.events`               | Counter   | Sync events: `applied` or `dropped`                |
| `stratos.service.pds_sync.attempts`         | Counter   | PDS sync attempts: `ok`, `retry`, `failed`         |
| `stratos.service.pds_sync.queue.jobs`       | Gauge     | PDS sync jobs, by state `pending` or `failed`      |
| `stratos.service.pds_sync.queue.oldest_age` | Gauge     | Age in seconds of the oldest pending PDS sync job  |
| `stratos.service.repo.lock.wait.duration`   | Histogram | Time a write waited for a repository lock          |
| `stratos.service.repo.lock.waiters`         | Gauge     | Writes waiting for a repository lock               |
| `stratos.storage.operation.duration`        | Histogram | Storage latency, by backend and operation          |
| `stratos.storage.operations`                | Counter   | Storage operations, by backend, operation, outcome |

Routes are reported with a small fixed vocabulary. An unknown XRPC method is
reported as `/xrpc/:nsid`.

Alert on these first:

- `stratos.service.ready` is `0`, or the heartbeat stops.
- `stratos.service.pds_sync.queue.jobs` with state `failed` is above zero.
- `stratos.service.pds_sync.queue.oldest_age` keeps growing.
- `stratos.service.repo.lock.waiters` stays above zero.

### Write latency in the logs

Each record write logs `record created` with timing fields:

- `durationMs`: total time for the write.
- `phases.prepareCommitBuild`: time spent building the commit.
- `buildShare`: the commit build's share of the total.

## PDS sync queue

Stratos publishes each member's enrollment record to their PDS through a
queue. A boundary change applies in Stratos first, and the PDS record follows.

A job that keeps failing is marked failed after
`STRATOS_PDS_SYNC_MAX_ATTEMPTS`. Admins have two XRPC methods for the queue:

| Method                                 | Purpose                                |
| -------------------------------------- | -------------------------------------- |
| `zone.stratos.admin.listPdsSyncStatus` | Lists the queued jobs                  |
| `zone.stratos.admin.requeuePdsSync`    | Moves every failed job back to pending |

Requeue after a fault that failed many jobs at once, such as a service key
rotation or clock skew.

## Backup

Back up these together. A restore needs all of them from the same moment.

| What                     | Where                                              |
| ------------------------ | -------------------------------------------------- |
| Service signing identity | `{STRATOS_DATA_DIR}/service-signing-identity.json` |
| Service database         | `{STRATOS_DATA_DIR}/service.sqlite`, or PostgreSQL |
| Member data and keys     | `{STRATOS_DATA_DIR}/actors/`, or PostgreSQL        |
| Blobs                    | `{STRATOS_DATA_DIR}/blobs/`, or the S3 bucket      |
| Static assets            | `{STRATOS_DATA_DIR}/assets/`                       |

For the `sqlite` backend:

```bash
# Service database
sqlite3 /var/lib/stratos/data/service.sqlite \
  ".backup /backup/service-$(date +%Y%m%d).sqlite"

# Signing identity, member databases and keys, blobs, assets
tar -czf /backup/stratos-data-$(date +%Y%m%d).tar.gz \
  --exclude service.sqlite \
  /var/lib/stratos/data/
```

For the `postgres` backend, dump the database and still archive the data
directory:

```bash
pg_dump "$STRATOS_POSTGRES_URL" > /backup/stratos-$(date +%Y%m%d).sql

tar -czf /backup/stratos-data-$(date +%Y%m%d).tar.gz /var/lib/stratos/data/
```

Three warnings:

- **The signing identity is the service.** Lose it and the signed key history breaks: a
  new key cannot prove it follows the old one. Store the backup as a secret.
- **Never restore an older signing identity after a key rotation.** That rolls
  back the published key. See
  [Service signing key history](/architecture/service-key-history).
- **Posts of `pds` custody members are not in this backup.** They live on each
  member's PDS. See [Mixed-mode custody](/operator/architecture#mixed-mode-custody).

## Scaling

Run one Stratos process for each service DID.

The service holds an exclusive lock on
`{STRATOS_DATA_DIR}/service-signing-identity.lock` for its whole lifetime. A
second process on the same data directory refuses to start. The data directory
must be on a local filesystem. Network filesystems are not supported.

The write rate limiter and the per-repository write locks also live in process
memory.

Scale the one process up instead:

1. **Use the `postgres` backend.** It moves member data off the local disk.
2. **Use `s3` blob storage.** It moves blobs off the local disk.
3. **Raise `STRATOS_PG_ACTOR_POOL_SIZE`** when writes queue for a connection.
4. **Give the process more CPU.** Node.js runs requests on one thread.

The feed generator is a separate service and scales separately.

## Key rotation

Rotate the service key with the offline `stratos-rotate-service-key` command.
Stop the service first. Follow
[Service signing key history](/architecture/service-key-history#durable-storage-and-local-rotation).

## Debug logging

```bash
LOG_LEVEL=debug node dist/bin/stratos.js
```

## Manual enrollment check

```bash
curl "localhost:3100/xrpc/zone.stratos.enrollment.status?did=did:plc:abc"
```

An anonymous caller sees whether the DID is enrolled, since when, whether the
enrollment is active, and its signing key. Boundaries are returned only to an
authenticated caller.

## Test the sync stream

`zone.stratos.sync.subscribeRecords` requires a service-auth token from a
service enrollment that holds at least one boundary. An anonymous connection is
rejected.

```bash
wscat -H "Authorization: Bearer $SERVICE_JWT" \
  -c "ws://localhost:3100/xrpc/zone.stratos.sync.subscribeRecords?did=did:plc:abc"
```

With `did`, the stream carries that member's record changes. Without `did`, it
carries enrollment events for the whole service. A stream closes when the
caller's membership changes, and the client must reconnect.
