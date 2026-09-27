# Feed Generator

The feed generator serves authenticated, boundary-scoped feeds from a bounded,
encrypted local projection. The current implementation is the Rust
`stratos-feedgen-ng` package. The older TypeScript `stratos-feedgen` package is
retained only for rollback; its settings and storage layout do not apply here.

## Data flow

```text
Stratos enrollment stream ──> actor subscriptions ──┐
                                                   ├──> verified projection ──> getFeed/getBlob
authority space membership ──> member PDS polling ─┘            ↑
                                                        viewer enrollment
```

The service stream and per-actor subscriptions ingest Stratos-custody records.
For PDS custody, a membership pass asks the Stratos space authority which repos
belong to each configured boundary. The feed generator polls only those
members. It constructs seven-segment space record URIs from the trusted space
and author; it never accepts a record-supplied boundary as permission. PDS
pages are staged and remain invisible until the terminal commit verifies.
Membership removal, revocation, deletion, and reconciliation invalidate
derived reads.

The HTTP router, feed/blob handlers, viewer authorization, identity endpoints,
and response policy are separate `server/` modules. Storage methods are grouped
by connection, actor, space, read, and retention concern in `store/`. Authority,
identity, and space-host clients are network adapters; `feed_service.rs`,
`space_sync.rs`, and `lifecycle.rs` hold the corresponding rules and admission
transitions. Rust traits sit beside the code that consumes them.

## Authorization and readiness

Inbound feed and blob requests carry a user service-auth JWT addressed to the
feedgen DID. The service verifies the request method and signature, resolves
the viewer's current enrollment from Stratos, and applies that authority-derived
boundary set to the local projection. Outbound Stratos requests use a
feedgen-minted service-auth JWT. A cached viewer grant expires and is revoked
on enrollment changes. Feed and blob requests fail closed while the authority
stream or reconciliation is unavailable; `/health` reports readiness but does
not replace an authenticated feed probe.

## Local data and resource limits

The encrypted-volume profile requires a SQLCipher database, an operator-owned
storage key file, a writer lock, and explicit maximum retention age and bytes.
The projection contains posts, boundaries, enrollment/membership snapshots,
and replay cursors. It is a rebuildable cache, not an authorization source.
Storage keys and signing keys must be private, non-symlink files; use an
operator-provisioned encrypted volume and exclude the projection from backups
unless separately approved. The alternative in-memory profile is for tests and
disposable use. Blob bytes are CID-verified and held in a bounded in-memory
cache, not a disk blob cache.

The rehearsal container is constrained to 1 vCPU and 512 MiB with a read-only
root filesystem and no Linux capabilities. The admission and retention limits
protect this budget; verify actual cgroup limits and an authenticated feed
request before routing traffic.

## Configuration and rollout

Configure one explicit feed registry source: `FEEDGEN_FEEDS_FILE`,
`FEEDGEN_FEEDS_JSON`, or `FEEDGEN_FEEDS_YAML`. Each feed has an ID and a
canonical Stratos boundary; the viewer's enrollment decides access. The feed
generator does not implement the deprecated TypeScript upstream
boundary-catalog refresh settings. For example, a read-only file can contain:

```yaml
feeds:
  - id: general
    boundary: did:web:stratos.example.com/general
    displayName: General
```

Keep feed IDs stable across the browser, feedgen, and operator-approved room
catalogue. Changing a feed registry requires a process restart and a fresh
readiness check. A feed entry does not grant membership; Stratos enrollment
and the authority's space member list remain authoritative.

Set `PLC_DIRECTORY` for a non-default PLC. Private PLC or PDS DNS access is
opt-in: supply the exact HTTPS origin and approved CIDRs through
`PLC_DIRECTORY_PRIVATE_CIDRS` or
`FEEDGEN_SPACE_SYNC_PRIVATE_HOST_ORIGIN` and
`FEEDGEN_SPACE_SYNC_PRIVATE_HOST_CIDRS`. Mixed public/private answers,
unapproved private addresses, redirects, and proxy bypasses are rejected.

Use `stratos-feedgen-ng/README.md` for process variables and
`stratos-feedgen-ng/CUTOVER.md` for independent-state rehearsal, comparison,
switch, and rollback. Do not reuse a TypeScript projection or writer lock for
the feed generator.
