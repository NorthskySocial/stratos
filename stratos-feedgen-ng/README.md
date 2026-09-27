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
The endpoint accepts a private IP address or a single-label private service
name; public hosts, credentials, query strings, and other paths are rejected.
The exporter runs on its own bounded background schedule (60-second interval,
3-second export timeout), so Collector availability never blocks a feed
request. No public `/metrics` endpoint is served.

The scope is `stratos.feedgen.ng`; the metric namespace is
`stratos.feedgen.*` for comparison with the existing Feedgen runtime. This
initial instrumentation records only `stratos.feedgen.read.stage.duration`
with the fixed labels `stage` (`verify_authorization`, `viewer_authorization`,
or `projection_serialization`) and `outcome` (`success`, `failure`, or
`timeout`). It never includes DIDs, feed IDs, boundaries, record URIs, tokens,
queries, or response bodies.

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
