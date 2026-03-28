# Troubleshooting

## "NotEnrolled" Error When Creating Records

- User hasn't completed OAuth enrollment.
- Enrollment was rejected — check your allowlist configuration (`STRATOS_ALLOWED_DIDS`, `STRATOS_ALLOWED_PDS_ENDPOINTS`).

Verify directly:

```bash
curl "https://stratos.example.com/xrpc/zone.stratos.enrollment.status?did=<did>"
```

## Empty Subscription Stream

- Verify service auth is configured correctly and the AppView DID is in `STRATOS_ALLOWED_APPVIEWS`.
- Check cursor isn't ahead of the latest sequence number.
- Confirm the user has records in their Stratos repo.

## OAuth Callback Fails

- Verify `redirect_uris` in `client-metadata.json` exactly matches `STRATOS_OAUTH_REDIRECT_URI`.
- Check the user's PDS is reachable from the Stratos server for the token exchange.
- Check nginx/proxy isn't stripping required headers.

## DPoP Nonce Errors

Extract the nonce from the `DPoP-Nonce` response header and include it in the next request's DPoP proof. Ensure your reverse proxy exposes `DPoP-Nonce` in `Access-Control-Expose-Headers` — see [Security](/operator/security#cors-configuration).

## High Latency Under Load

See the Performance Investigation Playbook. Key checkpoints:

1. **DB connection pool exhaustion** — increase `STRATOS_PG_ACTOR_POOL_SIZE`.
2. **RDS IOPS saturation** — check `WriteIOPS` vs baseline (gp2: `allocatedStorageGiB × 3` IOPS).
3. **CPU pinned at 100%** — Node.js is single-threaded; if 1 vCPU is maxed, scale up the task.

## Indexer Reconnection Pressure

Common during RDS restarts or resizes: `ECONNREFUSED` and `database system is shutting down`. The indexer retries with exponential backoff. These errors self-resolve once the database is back.

Check indexer logs:

```bash
# CloudWatch Log Insights
filter @message like /error|Error|ECONNREFUSED|timeout|worker pool/
```

## Debug Logging

```bash
STRATOS_LOG_LEVEL=debug pnpm start
```
