# Feed Generator

The feed generator serves private feeds from a local encrypted database. It
only returns posts from boundaries the viewer can access. The current
implementation is the Rust `stratos-feedgen-ng` package. The older TypeScript
`stratos-feedgen` package is retained only for rollback; its settings and
storage layout do not apply here.

## Data flow

```text
Stratos-hosted records ───────┐
                              ├──> encrypted local database ──> feeds and attachments
Records from member PDSs ─────┘               ↑
                                viewer's current membership
```

The feed generator subscribes to updates for records hosted by Stratos. For
records hosted on users' PDSs, it asks Stratos which users belong to each
boundary and reads only those users' protected spaces. It gets the boundary
from Stratos, not from a claim inside a post.

Records fetched from a PDS are held aside until the final signed update passes
verification. Only then can they appear in a feed. When a post is deleted or
access is removed, the feed generator stops serving affected posts.

## Authorization and readiness

Feed and attachment requests need a signed service-auth token (JWT) for the
feed generator. It checks the token and the viewer's current Stratos
membership before reading the local database. It uses its own service-auth
token when contacting Stratos.

If it cannot confirm current membership after startup or a disconnect, it
returns an unavailable response instead of serving possibly outdated data.
`/health` shows whether the service is ready, but also test with an
authenticated feed request before sending users to it.

## Local data and resource limits

The disk profile uses SQLCipher (encrypted SQLite). It needs a private storage
key file, a lock that prevents two processes from writing to the same database,
and limits on how long and how much data it keeps. The database stores posts,
their boundaries, membership information, and the positions needed to resume
updates. It can be rebuilt and never grants access on its own.

Keep storage and signing keys in private files, not symlinks. Put the database
on an operator-provided encrypted volume and leave it out of backups unless
backups have been separately approved. An in-memory mode is available for
tests. Attachments are checked against their content IDs and kept only in a
size-limited memory cache, not on disk.

The rehearsal container has a 1 vCPU and 512 MiB limit, a read-only root
filesystem, and no Linux capabilities. Check the limits inside the running
container and make an authenticated feed request before routing users to it.

## Set up the feed generator

Provide one feed list using `FEEDGEN_FEEDS_FILE`, `FEEDGEN_FEEDS_JSON`, or
`FEEDGEN_FEEDS_YAML`. Each feed needs an ID and a full Stratos boundary
identifier. A viewer still needs membership in that boundary. For example, a
read-only file can contain:

```yaml
feeds:
  - id: general
    boundary: did:web:stratos.example.com/general
    displayName: General
```

Keep feed IDs stable across clients and the feed generator. Restart the feed
generator after changing the list, then check that it is ready. Adding a feed
does not grant anyone access; Stratos membership still decides who can read it.

Set `PLC_DIRECTORY` if you use a non-default PLC directory. To reach a PLC or
PDS on a private network, configure its exact HTTPS address and allowed
private IP ranges with `PLC_DIRECTORY_PRIVATE_CIDRS` or the
`FEEDGEN_SPACE_SYNC_PRIVATE_HOST_ORIGIN` and
`FEEDGEN_SPACE_SYNC_PRIVATE_HOST_CIDRS` settings. The feed generator rejects
mixed public/private DNS answers, unapproved private addresses, redirects,
and proxy bypasses.

See `stratos-feedgen-ng/README.md` for setup variables and
`stratos-feedgen-ng/CUTOVER.md` for a test switch and rollback. Do not reuse
the older TypeScript service's database or writer lock.
