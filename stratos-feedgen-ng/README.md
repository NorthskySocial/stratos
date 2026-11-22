# Stratos Feed Generator

The Rust feed generator maintains an encrypted, bounded local projection,
serves authenticated boundary-scoped feeds, and stays closed until the
authority stream has reconciled.

It also refreshes authority-derived PDS-space membership and synchronizes only
those targets. A member's records become visible only after the set hash of
the member's repo equals the `data` of a MAC-authenticated commit. Requests use `STRATOS_SERVICE_URL` for network
reachability. `STRATOS_PUBLIC_URL` remains validated configuration for the
authority public endpoint; space signatures do not bind a URL.

## Space credential transport

The Rust client gets each space credential from the authority's
`zone.stratos.space.getSpaceCredential`, which accepts the HTTP-signature
exchange, and reads a member's repo from the member's PDS under the November
space contract. It sends its service-signed delegation as
`Authorization: Bearer`, signs that header with a fresh P-256 `did:key`, and
sends only `space` in JSON. Authority service-member and app admission still
apply. Ordinary service JWTs and caller authentication are unchanged; the
exchange uses no DPoP proof.

Read requests use `Authorization: Atproto-Space-Credential`,
`Atproto-Space-Audience`, `Signature-Input`, and `Signature`. The signature
carries `tag="atproto-space-credential"`. Repo operations name the actual repo owner
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
The receiver also serves OAuth/DPoP clients; the Rust client has no other
transport to fall back to. No pinned PDS accepts the new space URI spelling yet,
so the client has not read from a real host. Trace a deployed image to its
source revision and an immutable image digest; a source checkout alone does not
prove what is running.

## Architecture

`main.rs` composes the runtime from authority and identity clients, custody
sync workers, the lifecycle, and an encrypted projection. The HTTP router in
`server.rs` delegates feed, blob, identity, viewer authorization, and private
response handling to focused `server/` modules. `feed_service.rs` enforces
read rules. `space_sync.rs` holds the predicates that decide what a space
record admits, and the store's target check in `store/space_verification.rs`
enforces the space-target rules. `service.rs` coordinates projection admission
and invalidation. `pds_space_scheduler.rs` runs the
passes over PDS-custody members, and `pds_space_sync.rs` synchronizes one
member's repo in one space. `space_host.rs` makes the authenticated reads,
`space_kem.rs` and `space_mac.rs` derive and check the response MAC, and
`space_archive.rs` reads the `getRepo` archive. `store.rs` defines the
SQLCipher store and shared types; `store/` groups connection, actor, space,
read, and retention operations, and `store/space_verification.rs` keeps the
verified state of each member's repo and promotes changes to it. `label_poller.rs` follows the authority's moderation label log and
applies takedowns and their negations; `moderation_label.rs` validates label
pages; `store/labels.rs` keeps the label cursor and the subjects under
takedown. Rust traits live near the consumers that need them.

Stratos-custody actors arrive through authenticated subscriptions. PDS-custody
repos are selected from current authority membership, not record claims or
writer discovery. Foreign records stay unqueryable until their set hash
matches the commit. A current viewer enrollment is required before local posts or blobs
can be returned. The projection is bounded and rebuildable; its encrypted disk
contents are not an independent authorization source. Blob content uses a
bounded in-memory cache and never enters the projection.

Authority membership selects PDS repositories and current viewer enrollment
gates feed responses. Removing a member does not stop writes at that member's
PDS. A foreign synchronization carries the membership generation it started
under, so a poll read before a removal cannot be promoted afterward. An
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
authorization. It also stops the member's worker. This happens even when the
negation of the takedown is on the same page of the log. A replayed `enroll`
event or a space poll already in flight does not re-admit the member while the
takedown stands. An enrollment answer for the member as a viewer grants no
feed or blob reads while the takedown stands, including an answer that was
already in flight when the takedown was applied.

When an account takedown is lifted, the feed generator asks the authority
whether the member is enrolled again. It asks on up to 6 polls. If another hold
remains, the member returns to feeds only after a new enrollment event. If the
member's worker cannot start because the actor pool is at its limit of 4,096
tracked actors, the reinstatement stays pending. The next poll asks again and
costs no attempt.

A record takedown removes the post and evicts its cached blobs. Later updates
and replays of that post are refused while the takedown stands.

When a record takedown is lifted, the feed generator reads the author again.
For a Stratos-hosted author, it replays the author from the start of the stream.
The replayed author takes the next free connection slot ahead of authors that
are waiting their turn. A running worker is not interrupted. For a self-hosted
author, it clears the verified space state. The next pass then reads the whole
repo as an archive. A sync of that author already in flight is refused, so it
cannot store its old state after the reset.

The post returns within these bounds, with a reachable authority:

- Stratos-hosted author: two polls (20 seconds) to see the negation and act on
  it, plus at most one worker lease (15 seconds) for a slot, plus the replay.
- Self-hosted author: two polls (20 seconds), plus the wait for the next space
  pass (up to 30 seconds), plus that pass, including its archive read.

Each poll can add up to 15 seconds while lifted account takedowns are being
checked. The bounds assume the replay or listing finishes within one worker
lease or one pass. A longer history continues on later turns. The bounds do not
apply when the actor pool is at its limit of 4,096 tracked actors. The replay is
then retried on later polls.

A post returns only if the stream or the host still carries it. Other taken-down
posts of the same author stay refused.

With several Stratos processes, another process can report a member as enrolled
for up to 60 seconds after a takedown. It answers from its own cache. The feed
generator refuses that answer while the takedown stands.

A label subject URI is read with the `@atproto/syntax` rules. A collection such
as `com.123.post` is valid, because only the first segment and the last
segment of an NSID must start with a letter.

The TypeScript feed generator does not apply labels. Label logs and metrics
carry fixed event names only. They never carry a DID, record URI or CID.

## Space sync and limits

For each PDS-custody member and space, the store keeps the last verified
revision, a set-hash state, and the CID at every record path. Each cycle reads
`listRepoOps` pages with `since` set to the verified revision. Every response
is authenticated by a MAC keyed with a secret that HPKE (export only) derives
from a one-time key and the member's `#atproto_kem` key. The cycle applies the
ops of all pages together and promotes them in one transaction only when the
set hash it computes equals the `data` of the last page's commit. Nothing is
staged: the ops of a poll stay in memory until that write.

When incremental sync cannot work, the cycle reads the whole repo as an
archive (`getRepo`, STAR format, authenticated the same way) and replaces the
member's state. That happens when there is no verified state yet, when the
host or the membership generation changed, when the ops do not follow the
stored records, when the digest does not match, when the host went back to an
older revision, when the host refuses the cursor, when a poll passes its
limits, and when a post, like or repost changed without its value. Only one
archive is read at a time across members. After a failed archive read, that
member gets no archive read for `SPACE_REPLACEMENT_COOLDOWN` (10 minutes).

A `RepoNotFound` answer with status 400 from the member's host clears that
member's records in that space only after the host has given the same answer
for `SPACE_REPO_NOT_FOUND_CONFIRMATION` (1 hour). Until then the member fails
as `repo_not_found` and nothing is changed. Any other end of that member's
cycle, a good poll or another failure, starts the hour again. So does an
answer from another host, to a new membership generation, or more than
`SPACE_REPO_NOT_FOUND_MAX_GAP` (20 minutes) after the answer before it. The
hour is kept in memory, so a restart starts it again. Every other failure leaves the stored
rows as they were. Values of records in collections the feed does not project
(anything but posts, likes and reposts) are checked against their CID and
dropped.

These limits apply:

- A poll reads at most `MAX_POLL_OPS` (1,000) ops, `MAX_POLL_PAGES` (1,000)
  pages, and `MAX_SPACE_POLL_BODY_BYTES` (16 MiB) of page bodies. A poll that
  passes one recovers from the archive.
- `MAX_SPACE_REPO_RECORDS` allows 20,000 records per member per space.
- `MAX_SPACE_VERIFICATION_ROWS` allows 500,000 record paths in the store. Path
  rows do not count against the projection budget and retention never deletes
  them.
- An archive is at most `MAX_SPACE_ARCHIVE_BYTES` (16 MiB), with records of at
  most `MAX_SPACE_ARCHIVE_VALUE_BYTES` (1 MiB).
- A member's cycle holds at most `MAX_SPACE_CYCLE_VALUES` (2,000,000) decoded
  JSON values, and runs under the `SPACE_TARGET_DEADLINE` of 60 seconds.

A member that passes a limit other than the poll limits is a failed target.
The store is never left truncated.

The validated `FEEDGEN_PROJECTION_MAX_BYTES` budget covers published posts and
interactions. Each compaction pass brings published bytes to that maximum less
`FEEDGEN_SPACE_WRITE_RESERVE_BYTES` or under, which leaves the reserve free for
space writes. The reserve defaults to half the maximum and must be positive
and below it. A space write that would push the projection over the whole
maximum is refused and changes nothing. The memory profile uses its fixed
16 MiB projection budget; an encrypted volume requires an explicit
positive byte budget and `FEEDGEN_PROJECTION_MAX_AGE_MS` in whole seconds,
with a minimum of one second. `FEEDGEN_STAGE_TARGET_MAX_ROWS`,
`FEEDGEN_STAGE_GLOBAL_MAX_ROWS`, `FEEDGEN_STAGE_TARGET_MAX_BYTES` and
`FEEDGEN_STAGE_GLOBAL_MAX_BYTES` are no longer read, and a set one is ignored.

The store is at schema version 11. An older binary refuses a migrated
database.

Each pass logs `event=pds_space_sync_pass` with the counts `promoted`,
`unchanged`, `replaced`, `cleared`, `deferred` and `target_failures`, and the
scheduler status reports the same counts. Each cycle with failed targets also logs one line,
`event=pds_space_target_failures <reason>=<count> ...`, with reasons from a
fixed list. Logs carry no DID, URI or host text.

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
| `stratos.feedgen.space_sync.duration`, `stratos.feedgen.space_sync.outcomes`, `stratos.feedgen.space_sync.last_success` | Authority-listed PDS target passes and outcomes                                                              | Same name; Rust distinguishes promoted, unchanged, replaced, cleared, deferred and failed member results       |
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
