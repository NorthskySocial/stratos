# Stratos Feed Generator

The Rust feed generator maintains an encrypted, bounded local projection,
serves authenticated boundary-scoped feeds, and stays closed until the
authority stream has reconciled.

It also refreshes authority-derived PDS-space membership and synchronizes only
those targets. Pages are staged locally and become visible only after their
terminal commit verifies. Requests use `STRATOS_SERVICE_URL` for network
reachability. `STRATOS_PUBLIC_URL` remains validated configuration for the
authority public endpoint; space signatures do not bind a URL.

## Space credential transport

The Rust client requires the standard HTTP-signature receiver from Plan 014
(PR #218) and an October-compatible spaces PDS. It sends its existing
service-signed delegation as `Authorization: Bearer`, signs that header with a
fresh P-256 `did:key`, and sends only `space` in JSON. Authority service-member
and app admission still apply. Ordinary service JWTs and caller authentication
are unchanged; this is not the independent DPoP ADR in PR #217.

Read requests use `Authorization: Atproto-Space`, `Atproto-Space-Audience`,
`Signature-Input`, and `Signature`. Repo operations name the actual repo owner
DID; authority membership listing names the space authority DID. Neither a host
nor a service fragment is a read audience. Presentations may be reused at the
same audience until the credential expires; no method or URL proof is added.

Each mint flight owns a fresh private key. The cache retains the token and key
together in memory, refreshes near actual expiry, and discards rejected grants.
Keys are not persisted or logged and are separate from the service signing key.
Response decoding checks claims against the authenticated authority transport;
it does not independently verify the credential signature. Grants must match
the authority, space, and generated key, with a positive lifetime of at most
3,600 seconds and issuance no more than five seconds in the future.

Restart the receiver and Rust client together to discard old cached grants.
The receiver can coexist with legacy OAuth/DPoP clients; the Rust client has no
legacy transport fallback. The AiaB primary PDS now uses the pinned October
source. Deployed images must still be traced to that source revision and an
immutable image digest; a source checkout alone does not prove what is running.

## Architecture

`main.rs` composes the runtime from authority and identity clients, custody
sync workers, the lifecycle, and an encrypted projection. The HTTP router in
`server.rs` delegates feed, blob, identity, viewer authorization, and private
response handling to focused `server/` modules. `feed_service.rs` and
`space_sync.rs` enforce read and space-target rules; `service.rs` coordinates
projection admission and invalidation. `store.rs` defines the SQLCipher store
and shared types; `store/` groups connection, actor, space, read, and retention
operations. `label_poller.rs` follows the authority's moderation label log and
applies takedowns and their negations; `moderation_label.rs` validates label
pages; `store/labels.rs` keeps the label cursor and the subjects under
takedown. Rust traits live near the consumers that need them.

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

## Moderation labels

The feed generator reads the authority's moderation label log every 10 seconds.
It applies takedown labels to its local projection.

Feeds open only after the feed generator has read the label log to its head.
Feeds return `FeedNotReady` once 50 seconds, which is five polls, pass without
such a read. A separate task enforces this. It holds while a poll is still
running, when polls stop at their limit of 50 pages, and when the polling task
has died. Feeds reopen without a restart once the log is read to its head
again.

A takedown therefore stays in feeds for at most 50 seconds after the authority
records it. With a reachable log it normally leaves within one poll. While
lifted account takedowns are being checked, a poll first spends up to 10
seconds asking the authority about them, plus one 5-second request already
started. That delays the label pages by up to 15 seconds.

The feed generator DID needs a service enrollment that covers every boundary it
serves. With no service enrollment, the authority refuses its label queries and
its feeds never open. An enrollment that covers only some served boundaries
gives no error. The authority returns only the labels of the covered
boundaries, so takedowns in the other boundaries are never applied.

An account takedown removes the member's posts, sync position and viewer
authorization. It also stops the member's worker. A replayed `enroll` event or a
staged space page does not re-admit the member while the takedown stands.

When an account takedown is lifted, the feed generator asks the authority
whether the member is enrolled again. It asks on up to 6 polls. If another hold
remains, the member returns to feeds only after a new enrollment event.

A record takedown removes the post and evicts its cached blobs. Later updates
and replays of that post are refused while the takedown stands.

When a record takedown is lifted, the feed generator reads the author again.
For a Stratos-hosted author, it replays the author from the start of the stream.
The replayed author takes the next free connection slot ahead of authors that
are waiting their turn. A running worker is not interrupted. For a self-hosted
author, it clears the space cursor and stage. The next pass then lists from the
start. A sync of that author already in flight is refused, so it cannot store
its old position after the reset.

The post returns within these bounds, with a reachable authority:

- Stratos-hosted author: two polls (20 seconds) to see the negation and act on
  it, plus at most one worker lease (15 seconds) for a slot, plus the replay.
- Self-hosted author: two polls (20 seconds), plus the wait for the next space
  pass (up to 30 seconds), plus that pass.

Each poll can add up to 15 seconds while lifted account takedowns are being
checked. The bounds assume the replay or listing finishes within one worker
lease or one pass. A longer history continues on later turns. The bounds do not
apply when the actor pool is at its limit of 4,096 tracked actors. The replay is
then retried on later polls.

A post returns only if the stream or the host still carries it. Other taken-down
posts of the same author stay refused.

With several Stratos processes, another process can report a member as enrolled
for up to 60 seconds after a takedown. It answers from its own cache.

The TypeScript feed generator does not apply labels. Label logs and metrics
carry fixed event names only. They never carry a DID, record URI or CID.

## Staged space limits

The validated `FEEDGEN_PROJECTION_MAX_BYTES` budget includes published posts,
staged private payloads, and stage checkpoints. The memory profile uses its
fixed 16 MiB projection budget; an encrypted volume requires an explicit
positive byte budget and `FEEDGEN_PROJECTION_MAX_AGE_MS` in whole seconds,
with a minimum of one second. `FEEDGEN_STAGE_TARGET_MAX_ROWS` (default 1,024),
`FEEDGEN_STAGE_GLOBAL_MAX_ROWS` (default 8,192),
`FEEDGEN_STAGE_TARGET_MAX_BYTES` (default one quarter of the projection budget,
up to 8 MiB), and `FEEDGEN_STAGE_GLOBAL_MAX_BYTES` (default half the projection
budget) set the staging caps. All four values must be positive; the target caps
must fit within the global caps, the target row cap cannot exceed 1,024, the
target byte cap cannot exceed 8 MiB, and the global byte cap cannot exceed half
the projection budget. The compactor preserves that global byte allowance for
staged data by evicting the oldest published posts as needed. Checkpoints
count as rows, including those for pages without posts. The byte and row caps
persist across sync passes and restarts. A rejected page rolls back, and the
sync worker discards that target's incomplete stage.

Stages expire after the configured projection age from creation or the last
actual progress, whichever occurs first. Replaying the same cursor and data
does not extend that age. The compactor removes expired rows, checkpoints, and
pending verification together in bounded batches at startup and every minute.
Promotion is atomic and has a fixed work ceiling of 1,024 staged rows
(including checkpoints) and 8 MiB of staged bytes. The validated target caps
fit within that ceiling, so accepted stages remain promotable. Cleanup logs
contain aggregate counts only.

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
