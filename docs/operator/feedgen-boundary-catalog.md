# Feed generator boundary catalogue

The feed generator reads its boundary catalogue from Stratos by default.
Administrators manage boundary definitions in Stratos and separately grant the feed generator membership through Enrollments.
Changing a boundary's metadata, membership, or lifecycle no longer requires editing feed configuration files or restarting the feed generator.

The upstream service must implement the authenticated lexicon XRPC query `zone.stratos.sync.listBoundaries`.
The feed generator signs a service-auth JWT for that method.
Stratos returns only active boundaries held by the authenticated, enrolled service.
The feed generator never enrolls itself or adds itself to a boundary.
An unavailable or unsupported catalogue endpoint keeps feeds unavailable; there is no automatic fallback to an old configuration file.

## Discovery and access

Each catalogue entry contains a qualified boundary, stable `roomId`, display name, description, `listed`, `joinable`, and increasing revision.
The `roomId` becomes the feed ID used by `zone.stratos.feedgen.getFeed`.

- `listed: false` removes a feed from public `describeFeed` discovery. Current members can still request its known ID.
- `joinable: false` closes new joins. It does not revoke existing reader access.
- Inactive boundaries and boundaries the feed generator no longer holds disappear from its catalogue and served scope.
- Viewer membership is still required. Catalogue metadata never grants a viewer access.

A catalogue response containing a foreign authority, invalid boundary, duplicate mapping, or invalid metadata is rejected as a whole.
A running process remembers prior room-ID mappings and revision values even after an entry disappears, and rejects reassignment or rollback.
Stratos's durable boundary definitions preserve those identities across process restarts.

## Refresh and recovery

The feed generator polls every 30 seconds by default.
A request has a 10-second timeout, and an accepted snapshot remains fresh for at most 60 seconds.
Responses are limited to 1 MiB and 1,000 boundaries.
Refreshes are serialized, so slow requests cannot accumulate overlapping catalogue work.
Membership discovery and enrollment reconciliation share a separate two-minute application budget; expiry cancels the pass and leaves reads closed for retry.
A failed request immediately closes feed and blob reads and suspends indexing.
The next scheduled refresh retries; an expired snapshot can never keep reads available indefinitely.
`/health` and feed/blob XRPC requests report unavailability until both catalogue validation and enrollment reconciliation succeed.

A changed catalogue closes reads while the feed generator:

1. Stops and drains the actor and space sync workers.
2. Clears viewer membership caches, held space credentials, and cached blob bytes. Late work cannot repopulate cleared caches.
3. Revokes changed space leases and purges affected posts, staged records, space cursors, and membership snapshots, including indexed boundaries removed while the process was offline.
4. Discovers members using the existing credential-authenticated `zone.stratos.space.listRepos` API, then resolves their current enrollment and reconciles the stored snapshots.
5. Resets affected actor cursors and seeds the actor pool, allowing records from newly added boundaries to be replayed and indexed.
6. Fetches the catalogue again before reopening reads, so a long reconciliation cannot publish a snapshot that changed while it ran.

A refresh builds new space membership and verification workers, so removed memberships cannot return through an old poll target or verification cache.
The first catalogue load in a process also rebuilds active projections and replays their records.
Large boundaries can therefore take time to become available after startup or configuration changes.
Enrollment snapshots remain durable; feed posts and their cursors are derived state.

Shutdown cancels catalogue requests, stops future refreshes, and drains catalogue work before closing the store.
The enrollment subscription remains required in upstream catalogue mode.
Disabling scheduled PDS space sync still permits membership discovery for Stratos-hosted repositories.

## Configuration and migration

| Variable                                      | Default    | Meaning                                     |
| --------------------------------------------- | ---------- | ------------------------------------------- |
| `FEEDGEN_BOUNDARY_CATALOG_MODE`               | `upstream` | `upstream` or explicit legacy `static` mode |
| `FEEDGEN_BOUNDARY_CATALOG_REFRESH_MS`         | `30000`    | Delay before the next refresh               |
| `FEEDGEN_BOUNDARY_CATALOG_MAX_AGE_MS`         | `60000`    | Maximum accepted snapshot age               |
| `FEEDGEN_BOUNDARY_CATALOG_REQUEST_TIMEOUT_MS` | `10000`    | Per-request timeout                         |
| `FEEDGEN_BOUNDARY_CATALOG_APPLY_TIMEOUT_MS`   | `120000`   | Membership and reconciliation time budget   |

Duration settings accept integers from 1,000 through 300,000 milliseconds.
The refresh interval must be shorter than the maximum snapshot age.

To migrate an existing installation:

1. Make the upstream catalogue API available and import the existing Stratos boundary definitions with their original room IDs.
2. In Stratos Enrollments, grant the feed generator only the boundaries it should serve.
3. Use `FEEDGEN_BOUNDARY_CATALOG_MODE=upstream` or omit that variable. Static `FEEDGEN_FEEDS_*` inputs are ignored in this mode.
4. Check `/health` and the catalogue refresh logs. Boundary changes thereafter propagate without restarting the feed generator.

For development or an upstream service that has not acquired the new API, set `FEEDGEN_BOUNDARY_CATALOG_MODE=static` explicitly.
In static mode, keep exactly one existing `FEEDGEN_FEEDS_FILE`, `FEEDGEN_FEEDS_JSON`, or `FEEDGEN_FEEDS_YAML` input.
That mode retains the existing file-based catalogue and requires configuration reload through process restart.
It does not acquire automatic boundary discovery or catalogue freshness checks.
