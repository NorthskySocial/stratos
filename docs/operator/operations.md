# Operations

## Monitoring

Key metrics to track:

| Metric                             | Description                    |
| ---------------------------------- | ------------------------------ |
| `stratos_enrolled_users`           | Total enrolled users           |
| `stratos_records_total`            | Total records stored           |
| `stratos_subscription_connections` | Active WebSocket subscriptions |
| `stratos_request_duration_seconds` | XRPC request latency           |

Feedgen is an independent service. When its OTLP exporter is enabled, monitor
these OpenTelemetry metric names through the deployment's private Collector:

| Metric                                     | Description                                                     |
| ------------------------------------------ | --------------------------------------------------------------- |
| `stratos.feedgen.feed.stage.duration`      | Read-path stage duration, labeled only by `stage` and `outcome` |
| `stratos.feedgen.process.memory.rss`       | Feedgen resident process memory, in bytes                       |
| `stratos.feedgen.process.memory.heap_used` | Feedgen used JavaScript heap, in bytes                          |
| `stratos.feedgen.ready`                    | Fail-closed read readiness; not merely process liveness         |

The repository's development Collector uses a debug exporter. Before adding
PromQL panels, the deployment owner must configure and verify a private
Collector-to-Prometheus route; do not expose Feedgen's local listener or add
identity-bearing labels to bridge this gap.

For create → index latency investigations also track:

- `record created` log `durationMs` and `phases.prepareCommitBuild`
- `record created` log `buildShare` (commit-build contribution to total)
- `high create-to-index lag observed` warnings in `stratos-indexer`
- Actor sync reconnect pressure (`max reconnect attempts`, WebSocket close/error events)

## Feedgen Low-Resource Triage

Use the Feedgen-only 1 vCPU / 512 MiB Compose overlay for measurements. It is
not an allocation for Stratos, Clubhouse, or the Collector.

1. If `stratos.feedgen.ready` is unavailable, inspect reconciliation and
   service-stream health first; a healthy process must still return
   `FeedNotReady` until authorization state is current.
2. If `viewer_boundaries` dominates `stratos.feedgen.feed.stage.duration`,
   check the bounded boundary-cache hit/miss metrics and upstream latency.
3. If `local_projection` dominates, compare RSS/heap growth and store latency
   before changing cache or persistence behavior.
4. If `author_handles` dominates, compare warm and cold identity-resolution
   samples. Do not remove verification or attach identity data to telemetry.

For all cases, verify a real authorized feed request after readiness recovers;
`/health` alone is not a readiness proof for a consumer journey.

## Backup

```bash
# Backup service database
sqlite3 /var/lib/stratos/data/service.sqlite \
  ".backup /backup/service-$(date +%Y%m%d).sqlite"

# Backup all actor databases
tar -czf /backup/actors-$(date +%Y%m%d).tar.gz \
  /var/lib/stratos/data/actors/
```

## Scaling

For high-traffic deployments:

1. **Horizontal scaling** — Run multiple Stratos instances behind a load balancer.
2. **Shared storage** — Use network-attached storage for actor databases, or switch to the
   `postgres` backend.
3. **Connection pooling** — WebSocket subscriptions should be load-balanced by user DID so one
   instance handles all subscriptions for a given user.
4. **S3 blobs** — Use the `s3` blob storage backend to decouple blob storage from the instance.

## Health Check

```bash
curl localhost:3100/health
# {"status":"ok","version":"0.1.0"}
```

## Debug Logging

```bash
STRATOS_LOG_LEVEL=debug pnpm start
```

## Manual Enrollment Check

```bash
curl "localhost:3100/xrpc/zone.stratos.enrollment.status?did=did:plc:abc"
```

## Test WebSocket Connectivity

```bash
wscat -c "ws://localhost:3100/xrpc/zone.stratos.sync.subscribeRecords?did=did:plc:abc"
```
