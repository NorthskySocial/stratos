# Stratos Feed Generator

The Rust feed generator maintains an encrypted, bounded local projection,
serves authenticated boundary-scoped feeds, and stays closed until the
authority stream has reconciled.

It also refreshes authority-derived PDS-space membership and synchronizes only
those targets. Pages are staged locally and become visible only after their
terminal commit verifies. Requests use `STRATOS_SERVICE_URL` for network
reachability; `STRATOS_PUBLIC_URL`, when set, is used solely as the public DPoP
proof target.

## Architecture

`main.rs` composes the runtime from authority and identity clients, custody
sync workers, the lifecycle, and an encrypted projection. The HTTP router in
`server.rs` delegates feed, blob, identity, viewer authorization, and private
response handling to focused `server/` modules. `feed_service.rs` and
`space_sync.rs` enforce read and space-target rules; `service.rs` coordinates
projection admission and invalidation. `store.rs` defines the SQLCipher store
and shared types; `store/` groups connection, actor, space, read, and retention
operations. Rust traits live near the consumers that need them.

Stratos-custody actors arrive through authenticated subscriptions. PDS-custody
repos are selected from current authority membership, not record claims or
writer discovery. Foreign pages stay unqueryable until their terminal commit
verifies. A current viewer enrollment is required before local posts or blobs
can be returned. The projection is bounded and rebuildable; its encrypted disk
contents are not an independent authorization source. Blob content uses a
bounded in-memory cache and never enters the projection.

Authority membership selects PDS repositories and current viewer enrollment
gates feed responses. Removing a member does not stop writes at that member's
PDS. In-flight foreign synchronization also needs a durable generation fence
so a page fetched before removal cannot be promoted afterward; deploy the
Feedgen version with that fence before relying on this guarantee. An
outstanding credential accepted by a foreign host can remain usable until its
expiry. See [the current spaces contract](../docs/architecture/spaces-alignment.md).

Run the current contract tests with:

```sh
cargo test --manifest-path stratos-feedgen-ng/Cargo.toml
```

For a process, set `FEEDGEN_SERVICE_DID`, `FEEDGEN_PUBLIC_URL`,
`FEEDGEN_PUBLIC_KEY_MULTIBASE`, `FEEDGEN_SIGNING_KEY`,
`STRATOS_SERVICE_URL`, and `STRATOS_SERVICE_DID`. Set `STRATOS_PUBLIC_URL`
when the authority's public endpoint differs from its private service URL.

Before startup, assign `FEEDGEN_SERVICE_DID` a `did:web` under the domain
controlled by the Stratos space authority. For example, with
`STRATOS_SERVICE_DID=did:web:stratos.example.com`, use
`FEEDGEN_SERVICE_DID=did:web:feeds.stratos.example.com` and
`FEEDGEN_PUBLIC_URL=https://feeds.stratos.example.com`. Configure DNS, HTTPS,
and routing for that host, and grant the feed DID service membership in every
boundary it serves through Stratos Enrollments. The feed registry is not a
membership grant. After startup, verify the DID document and an authenticated
feed request.

Set `PLC_DIRECTORY` to the HTTPS origin of a non-default PLC directory. For a
private PLC, also set `PLC_DIRECTORY_PRIVATE_CIDRS` to a comma-separated list
of canonical RFC 1918 or IPv6 ULA ranges, such as `10.42.0.0/16`. A PLC DNS
answer set must be entirely public or entirely inside those private ranges;
mixed answers are rejected. Other identity hosts still require public
addresses. The validated address is pinned for the request, and redirects are
not followed.

To poll a PDS on a private network, set both
`FEEDGEN_SPACE_SYNC_PRIVATE_HOST_ORIGIN` (its exact HTTPS origin) and
`FEEDGEN_SPACE_SYNC_PRIVATE_HOST_CIDRS` (the same CIDR format). This grant is
separate from PLC trust and applies to that PDS origin only.

## Private metrics export

Feed-read timing is aggregate-only and disabled by default. Set
`FEEDGEN_OTLP_METRICS_ENDPOINT` to a private Collector OTLP/HTTP endpoint
ending in `/v1/metrics`, for example `http://collector:4318/v1/metrics`.
The endpoint accepts a literal private IP address or the exact internal
service name `collector`; public hosts, arbitrary DNS names, credentials,
query strings, and other paths are rejected.
The exporter runs on its own bounded background schedule (60-second interval,
3-second export timeout), so Collector availability never blocks a feed
request. No public `/metrics` endpoint is served.

The resource `service.name` is fixed to `stratos-feedgen-ng`, and the scope is
`stratos.feedgen.ng`; the metric namespace is
`stratos.feedgen.*` for comparison with the previous TypeScript Feed Generator. The
Collector adds `otel_scope_name=stratos.feedgen.ng`, allowing Rust and
TypeScript series to be selected separately without changing metric names.
The exporter has no listener of its own: route the private Collector to its
existing private Prometheus exporter/scrape path, never through this service.

| Metric                                                                                                                  | Rust Feed Generator behavior                                                                                 | TypeScript comparison                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `stratos.telemetry.heartbeat`, `stratos.feedgen.ready`                                                                  | 60-second callback gauges, including idle processes                                                          | Same name and intent                                                                                           |
| `stratos.feedgen.subscription.connected`, `stratos.feedgen.subscription.reconnects`                                     | Service-stream WebSocket state plus service and failed actor-worker reconnects                               | Same name; intentional actor idle/lease rotation is not counted                                                |
| `stratos.feedgen.actor_pool`                                                                                            | Active, waiting, and configured-capacity gauges after authoritative pool changes                             | Same name and labels                                                                                           |
| `http.server.request.duration`, `http.server.active_requests`                                                           | Static method, route, and status dimensions for public routes                                                | Same name and bounded dimensions                                                                               |
| `stratos.feedgen.feed.requests`, `stratos.feedgen.feed.posts_returned`                                                  | Completed projection reads; post count is carried from the bounded response before serialization             | Same name and intent                                                                                           |
| `stratos.feedgen.cache.requests`                                                                                        | Viewer-authorization cache hits and authority-resolution misses                                              | Same name and intent                                                                                           |
| `stratos.feedgen.index.operations`                                                                                      | Actor projection upserts and deletes after commit validation                                                 | Same name and intent                                                                                           |
| `stratos.feedgen.reconciliation.duration`, `stratos.feedgen.reconciliation.outcomes`                                    | Authority-session reconciliation                                                                             | Same name and intent                                                                                           |
| `stratos.feedgen.space_sync.duration`, `stratos.feedgen.space_sync.outcomes`, `stratos.feedgen.space_sync.last_success` | Authority-listed PDS target passes and outcomes                                                              | Same name; Rust distinguishes deferred and rejected member results                                             |
| `process.resident_memory`, `process.cpu.time`                                                                           | Linux-only current RSS bytes from `/proc/self/statm` and process CPU seconds from `CLOCK_PROCESS_CPUTIME_ID` | Matches the standard OTel runtime metric names; Collector Prometheus naming follows its configured translation |

`stratos.feedgen.shadow_feed.reads` is TypeScript-only: the Rust service is
the production implementation and has no shadow comparison path. Process RSS
and CPU metrics are emitted only on Linux. Other platforms emit no process
resource series because a portable Rust source would not provide a current,
semantically comparable value (`getrusage` RSS is only a high-water mark).
Obtain portable container resource telemetry from the Collector or orchestrator.

All attributes are fixed by code: no metric includes DIDs, feed IDs,
boundaries, record URIs, tokens, queries, response bodies, or hostnames.

## Constrained rehearsal container

Build the production-shaped rehearsal image from the workspace root:

```sh
docker build -f stratos-feedgen-ng/Dockerfile -t stratos-feedgen-ng:rehearsal .
```

`compose.rehearsal.yml` runs the image as uid/gid `65532`, with a read-only
root filesystem, no Linux capabilities, a 16 MiB no-exec `/tmp`, no core dumps,
and a 1 vCPU / 512 MiB container limit. It has no in-image healthcheck shell;
the orchestrator must probe `GET /health` from outside the container.

Prepare a local `stratos-feedgen-ng/rehearsal.env` outside version control with
the public configuration values and paths for four protected host files or
directories: `FEEDGEN_STATE_DIR`, `FEEDGEN_SIGNING_KEY_FILE`,
`FEEDGEN_STORAGE_KEY_FILE`, and `FEEDGEN_FEEDS_FILE`. The state directory must
be mode `0700`, owned by `65532:65532`; both secret files must be readable only
by that identity. The compose profile bind-mounts those files and uses
`FEEDGEN_SIGNING_KEY_FILE`, so a signing secret is neither copied into the
image nor included in the compose environment.

```sh
docker compose --env-file stratos-feedgen-ng/rehearsal.env \
  -f stratos-feedgen-ng/compose.rehearsal.yml up
```

Use an operator-provisioned encrypted volume for `FEEDGEN_STATE_DIR`. The
container does not create encryption, copy the projection, or perform an
automatic traffic switch. A failed process intentionally leaves its writer
lock in place for operator recovery.
