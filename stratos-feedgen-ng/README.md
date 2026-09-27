# Stratos Feedgen NG

Feedgen NG is the Rust implementation of Stratos Feedgen. It maintains an
encrypted, bounded local projection, serves authenticated boundary-scoped
feeds, and stays closed until the authority stream has reconciled.

It also refreshes authority-derived PDS-space membership and synchronizes only
those targets. Pages are staged locally and become visible only after their
terminal commit verifies. Requests use `STRATOS_SERVICE_URL` for network
reachability; `STRATOS_PUBLIC_URL`, when set, is used solely as the public DPoP
proof target.

Run the current contract tests with:

```sh
cargo test --manifest-path stratos-feedgen-ng/Cargo.toml
```

For a process, set `FEEDGEN_SERVICE_DID`, `FEEDGEN_PUBLIC_URL`,
`FEEDGEN_PUBLIC_KEY_MULTIBASE`, `FEEDGEN_SIGNING_KEY`,
`STRATOS_SERVICE_URL`, and `STRATOS_SERVICE_DID`. Set `STRATOS_PUBLIC_URL`
when the authority's public endpoint differs from its private service URL.

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
