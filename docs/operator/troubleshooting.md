# Troubleshooting

Most Stratos problems come from one of three places: the caller is not who the
service expects, the caller is not in the boundary, or a setting names
something that no longer exists. Find your symptom below.

## The service does not start

- **`Configuration error: Invalid environment variables`.** The lines that
  follow name each bad variable. Boolean settings accept only `true` or
  `false`.
- **`The reserved boundary must be active in the boundary catalog`.** The
  boundary named by `STRATOS_RESERVED_DOMAIN` is missing or inactive in the
  database. Restore the previous name.
- **The signing identity lock fails.** Another Stratos process holds the same
  data directory, or `flock` is not installed. Run one process for each data
  directory.
- **PostgreSQL refuses the connection over TLS.** A URL built from
  `STRATOS_PG_*` uses `sslmode=require`. Set `STRATOS_PG_SSLMODE="disable"`
  for a local database without TLS.

## `NotEnrolled` when creating records

- The person has not completed OAuth enrollment.
- Enrollment was denied. Check `STRATOS_ENROLLMENT_MODE`,
  `STRATOS_ALLOWED_DIDS`, and `STRATOS_ALLOWED_PDS_ENDPOINTS`.

Check directly:

```bash
curl "https://stratos.example.com/xrpc/zone.stratos.enrollment.status?did=<did>"
```

A DID that is not enrolled gets `enrolled: false`, with `eligible` when Stratos
could decide whether it may enroll.

## A write is rejected

| Error                   | Cause                                                            |
| ----------------------- | ---------------------------------------------------------------- |
| `InvalidDomainCount`    | The record has zero boundaries or more than one                  |
| `ForbiddenBoundary`     | The author is not a member of the record's boundary              |
| `ServiceMismatch`       | The boundary belongs to another Stratos service                  |
| `ServiceWriteForbidden` | A service identity tried to write                                |
| `RateLimitExceeded`     | The author passed the write rate limit. Retry after the cooldown |

## The sync stream closes or stays empty

`zone.stratos.sync.subscribeRecords` needs a service-auth token from a service
enrollment.

| Message                                   | Cause                                                    |
| ----------------------------------------- | -------------------------------------------------------- |
| `Service auth required`                   | The token is missing or is not a service-auth token      |
| `Enrollment is missing or deactivated`    | The caller has no active service enrollment              |
| `Service is not enrolled in any boundary` | Grant the service identity a boundary in **Enrollments** |
| `Subscription authorization changed`      | The caller's membership changed. Reconnect               |

When the stream is open but silent:

- Confirm the member has records in a boundary the service identity holds.
- A cursor ahead of the newest event resumes from the newest event. Stratos
  logs `subscribeRecords: cursor ahead of latest`.
- A member with `pds` custody has no records in Stratos. Their posts come from
  their own PDS. See [Mixed-mode custody](/operator/architecture#mixed-mode-custody).

## OAuth callback fails

- Check `STRATOS_PUBLIC_URL`. Stratos builds its redirect URIs from it:
  `{publicUrl}/oauth/callback` and `{publicUrl}/admin/oauth/callback`.
- Check that `https://<host>/client-metadata.json` is reachable from the
  member's PDS.
- Check that the member's PDS is reachable from the Stratos server for the
  token exchange.
- Check that the proxy routes `/oauth/*` and `/admin/*` to the service.

### `invalid_scope` from a spaces PDS

The PDS could not resolve the `zone.stratos.space.feed` space type. Nothing in
the Stratos logs shows this. Check that the lexicon record is still published.
See [Keep the space type published](/operator/architecture#keep-the-space-type-published).

## Admin login fails

| Message                               | Cause                                                        |
| ------------------------------------- | ------------------------------------------------------------ |
| `Not an authorized admin`             | The DID is not in `STRATOS_ADMIN_DIDS` and was never granted |
| `Admin session invalid or expired`    | Sessions last 12 hours. Sign in again                        |
| `Cross-origin admin request rejected` | The request came from an origin other than the service's own |

Open the admin interface on the same host as `STRATOS_PUBLIC_URL`.

## Space credential requests fail

When `STRATOS_VALKEY_URL` is not set, delegation requests fail with
`InvalidToken` and attested clients fail with `AttestationRequired`. The log
says `no replay store (cache) configured`. Set `STRATOS_VALKEY_URL`.

## DPoP nonce errors

Stratos answers the first request with `use_dpop_nonce` and a `DPoP-Nonce`
response header. The client must repeat the request with that nonce in its
proof.

A browser can read the header only when it is exposed. Stratos exposes it
already. Check that your proxy does not replace the CORS headers. See
[CORS](/operator/security#cors).

## A member's PDS record is out of date

Stratos applies a boundary change locally first and publishes the enrollment
record through a queue. See
[PDS sync queue](/operator/operations#pds-sync-queue) to inspect and requeue
jobs.

## High latency under load

1. **Connection pool exhaustion.** Latency is high while CPU and database load
   are low. Raise `STRATOS_PG_ACTOR_POOL_SIZE`, and keep it below the
   database's `max_connections`.
2. **Database storage saturation.** Check write latency and queue depth on the
   database volume.
3. **CPU pinned on one core.** Node.js runs requests on one thread. Give the
   process a faster core.

The `record created` log line reports `durationMs` for each write. Watch its
trend during a load test.

## Debug logging

```bash
LOG_LEVEL=debug node dist/bin/stratos.js
```
