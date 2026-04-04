# Operations

## Monitoring

Key metrics to track:

| Metric                             | Description                    |
| ---------------------------------- | ------------------------------ |
| `stratos_enrolled_users`           | Total enrolled users           |
| `stratos_records_total`            | Total records stored           |
| `stratos_subscription_connections` | Active WebSocket subscriptions |
| `stratos_request_duration_seconds` | XRPC request latency           |

For create → index latency investigations also track:

- `record created` log `durationMs` and `phases.prepareCommitBuild`
- `record created` log `buildShare` (commit-build contribution to total)
- `high create-to-index lag observed` warnings in `stratos-indexer`
- Actor sync reconnect pressure (`max reconnect attempts`, WebSocket close/error events)

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
