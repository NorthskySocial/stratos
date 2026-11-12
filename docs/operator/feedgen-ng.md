# Feed Generator

Stratos runs the rooms. The feed generator keeps a scrapbook for each room.
It copies every new post into the right scrapbook as the post arrives. When
someone asks to read a scrapbook, it checks the guest list first. No name on
the list, no page.

In Stratos terms, the room is a boundary, the scrapbook is a local
projection, and the guest list is enrollment. The feed generator is a
separate service. It follows one Stratos service, keeps a bounded copy of
recent posts, and serves that copy as feeds.

The current implementation is the Rust `stratos-feedgen-ng` package. The
older TypeScript `stratos-feedgen` package stays in the repository for
rollback only. Its settings and its storage layout do not apply here.

This page is for operators. For the design, read
[Feed Generator architecture](/architecture/feed-generator). For attachment
downloads from a client, read
[Private feed attachments](/client/feedgen-blobs).

## What it serves

| Route                                         | Auth             | Purpose                            |
| --------------------------------------------- | ---------------- | ---------------------------------- |
| `GET /xrpc/zone.stratos.feedgen.getFeed`      | Service-auth JWT | Posts from one feed, newest first  |
| `GET /xrpc/zone.stratos.feedgen.getBlob`      | Service-auth JWT | One attachment of one indexed post |
| `GET /xrpc/zone.stratos.feedgen.describeFeed` | None             | The service DID and the feed list  |
| `GET /.well-known/did.json`                   | None             | The feed generator's DID document  |
| `GET /health`                                 | None             | Readiness and sync status          |

`describeFeed` is public. It returns every feed ID with its boundary
identifier, display name, and description. Do not put anything secret in a
feed definition.

The service listens on `0.0.0.0` at `FEEDGEN_PORT`. There is no `/ready`
route and no `/metrics` route.

## How posts get in

Posts arrive on two paths. The path depends on custody: who holds the
author's records.

```text
Stratos custody ── subscribeRecords streams ──┐
                                              ├──> local projection ──> feeds
PDS custody ───── membership list, then poll ─┘
```

### Stratos-custody authors

The feed generator opens one service-level `zone.stratos.sync.subscribeRecords`
stream. That stream reports who enrolls, who leaves, and whose boundaries
change. The feed generator stores that list.

A pool of connections then reads each enrolled author's own stream. The pool
holds 8 connections by default. Authors take turns on a connection, so the
pool can cover more authors than it has connections.

The feed generator keeps only `zone.stratos.feed.post` records. It keeps a
boundary on a post only when the post names that boundary and the author is
currently enrolled in it. A post left with no boundary is deleted.

### PDS-custody authors

Some members keep their records on their own PDS. Every 30 seconds the feed
generator does this for each boundary in the feed list:

1. Get a space credential from Stratos.
2. Ask Stratos for the members of the space with
   `zone.stratos.space.listRepos`.
3. For each member with `pds` custody, read
   `com.atproto.space.listRepoOps` from the host that Stratos names.

Up to four members sync at once. Fetched pages wait in a staging area. They
become readable only after the final signed commit verifies against the
author's key. A rejected commit discards that member's staged pages.

A post from a PDS gets the boundary of the space it was read from. A
boundary written inside the post is ignored.

## Who can read

A client does not hold a token for the feed generator. It asks its own PDS
and sets the `atproto-proxy` header to `<feed generator DID>#stratos_feedgen`.
The PDS forwards the request with a service-auth JWT.

The feed generator accepts the token when all of these hold:

- The header is `Authorization: Bearer <jwt>`.
- The algorithm is `ES256` or `ES256K`.
- `iss` is the viewer's DID.
- `aud` equals `FEEDGEN_SERVICE_DID` exactly, with no fragment.
- `exp` is in the future.
- `lxm` names the method the client calls.
- The signature verifies against the `#atproto` key in the viewer's DID
  document.

Next the feed generator asks Stratos for the viewer's boundaries with
`zone.stratos.identity.resolveEnrollments`. It keeps the answer in memory for
300 seconds. This value is fixed. An enrollment event for the viewer drops the
stored answer at once.

The viewer reads a feed only when they hold that feed's boundary. Each
returned post lists only the boundaries the viewer also holds.

## Storage profiles

::: danger The default profile keeps nothing
`FEEDGEN_STORAGE_PROFILE` defaults to `ephemeral`. That profile is an
in-memory database. A restart loses every post and every cursor. Set
`encrypted-volume` for any deployment that must survive a restart.
:::

| Profile            | Where data lives         | Limits                                  |
| ------------------ | ------------------------ | --------------------------------------- |
| `ephemeral`        | Memory only              | Fixed: 16 MiB and 1 hour                |
| `encrypted-volume` | SQLCipher file on a disk | You set them. Both limits are required. |

The `ephemeral` profile uses a fixed all-zero database key. Use it for tests.

The `encrypted-volume` profile needs all of these:

- `FEEDGEN_SQLITE_PATH`: an absolute path for the SQLCipher database.
- `FEEDGEN_STORAGE_KEY_PATH`: an absolute path to the storage key file. The
  key file must not be in the same directory as the database.
- `FEEDGEN_PROJECTION_MAX_AGE_MS`: how long a post stays. Use whole seconds.
- `FEEDGEN_PROJECTION_MAX_BYTES`: how much the projection can hold.

The feed generator takes a writer lock before it opens the database. The lock
stops a second process from writing to the same file. A clean exit releases
the lock. A killed process leaves the lock behind. Confirm that no process
uses the database, then remove the lock by hand.

A compactor runs at startup and then every 60 seconds. It removes posts past
the age limit. It removes the oldest posts when the projection passes the
byte limit.

The projection holds posts, their boundaries, the enrollment list, the member
list, and sync cursors. It is a copy. You can delete it and let it rebuild.
It never grants access by itself. Put it on an encrypted volume and keep it
out of backups unless you have approved that.

### Key files

The storage key file holds 64 hexadecimal characters. A trailing newline is
allowed. The feed generator refuses a secret file unless all of these hold:

- The path is absolute.
- No part of the path is a symlink.
- The file is a regular file owned by the user that runs the process.
- Group and other have no permissions on it. Use mode `0600` or `0400`.

The same rules apply to `FEEDGEN_SIGNING_KEY_FILE`.

## Feeds

Give the feed list with exactly one of `FEEDGEN_FEEDS_FILE`,
`FEEDGEN_FEEDS_JSON`, or `FEEDGEN_FEEDS_YAML`. Zero sources stops startup. Two
sources stop startup. A file must end in `.json`, `.yaml`, or `.yml`.

```yaml
feeds:
  - id: general
    boundary: did:web:stratos.example.com/general
    displayName: General
    description: Everyone in the service
```

`id` and `boundary` are required. Feed IDs must be unique.

Write the boundary in full: `{Stratos service DID}/{name}`. The feed
generator does not check this at startup. A bare name such as `general`
loads without error. It then matches no viewer, and every request for that
feed fails with `BoundaryMismatch`.

The feed list is read once at startup. Restart the feed generator after you
change it. Keep feed IDs stable, because clients send them.

A feed in the list grants nothing. Stratos enrollment decides who reads.

## Identity

Three settings describe who the feed generator is.

| Variable                       | Role                                       |
| ------------------------------ | ------------------------------------------ |
| `FEEDGEN_SERVICE_DID`          | The feed generator's DID                   |
| `FEEDGEN_PUBLIC_URL`           | The public base URL clients and PDSs reach |
| `FEEDGEN_PUBLIC_KEY_MULTIBASE` | The public half of the signing key         |

The feed generator serves this DID document at `/.well-known/did.json`:

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/multikey/v1"
  ],
  "id": "did:web:feeds.stratos.example.com",
  "verificationMethod": [
    {
      "id": "did:web:feeds.stratos.example.com#atproto",
      "type": "Multikey",
      "controller": "did:web:feeds.stratos.example.com",
      "publicKeyMultibase": "zQ3sh..."
    }
  ],
  "service": [
    {
      "id": "#stratos_feedgen",
      "type": "NorthskyStratosFeedGen",
      "serviceEndpoint": "https://feeds.stratos.example.com"
    }
  ]
}
```

Route the DID's host to the feed generator over HTTPS, so that the document
resolves.

::: warning The published key must match the signing key
The feed generator signs with `FEEDGEN_SIGNING_KEY`. It publishes
`FEEDGEN_PUBLIC_KEY_MULTIBASE`. Nothing checks that the two belong together.
If they differ, the process starts and Stratos rejects every token it signs.
Derive the multibase value from the signing key and set both together.
:::

The signing key is a secp256k1 private key written as 64 hexadecimal
characters. Give it inline with `FEEDGEN_SIGNING_KEY` or from a file with
`FEEDGEN_SIGNING_KEY_FILE`. Setting both stops startup. Prefer the file.

`FEEDGEN_PUBLIC_URL` also forms the attachment URLs in feed responses.

## What Stratos needs

The feed generator makes five kinds of call to Stratos. Each one carries a
token that the feed generator signs with its own key.

| Call                                       | Token                                   |
| ------------------------------------------ | --------------------------------------- |
| `zone.stratos.sync.subscribeRecords`       | Service-auth JWT, 60 seconds            |
| `zone.stratos.identity.resolveEnrollments` | Service-auth JWT, 60 seconds            |
| `com.atproto.sync.getBlob`                 | Service-auth JWT, 60 seconds            |
| `zone.stratos.space.getSpaceCredential`    | Delegation JWT, 60 seconds              |
| `zone.stratos.space.listRepos`             | Space credential with an HTTP signature |

Set up two things on the Stratos service.

**A service enrollment for the feed generator.** Add the feed generator's DID
to the Stratos service enrollments. Grant it every boundary in the feed list.
Stratos rejects the sync streams of a service with no boundaries. It sends
only records from boundaries the service holds. It issues a space credential
only for a boundary the service holds. See
[Service enrollments](/operator/configuration#service-enrollments).

**A Valkey cache.** Set `STRATOS_VALKEY_URL` on the Stratos service. Stratos
uses it as the replay store for space credentials. Without it, a Stratos
service outside dev mode refuses to issue any space credential. PDS-custody
sync then fails on every pass. See
[Valkey and the replay store](/operator/configuration#valkey-and-the-replay-store).

### Space credentials

A space credential is a short-lived pass for one space. The feed generator
needs one to list members and to read a member's PDS.

The feed generator signs a delegation JWT and sends it to
`zone.stratos.space.getSpaceCredential`. It signs the request with a fresh
P-256 key. Stratos returns a credential bound to that key.

The feed generator then presents the credential with three parts: the
`Authorization: Atproto-Space` header, the `Atproto-Space-Audience` header,
and an HTTP signature over both. The audience is the Stratos DID for a
member list. It is the member's DID for a read from that member's PDS.

The feed generator keeps credentials and their keys in memory only. It holds
at most 128. It refreshes one five minutes before expiry. It rejects a
credential that lasts longer than one hour. The Stratos side of this
exchange is described in
[October Spaces rollout](/operator/configuration#october-spaces-rollout).

## Readiness

Feeds start closed. They open only after two things happen in order:

1. The service-level stream to Stratos connects.
2. The feed generator asks Stratos again about every author in its stored
   enrollment list, and every answer applies without error.

A dropped stream closes feeds at once. The feed generator reconnects with a
delay that doubles from 1 second up to 60 seconds. Every reconnect repeats
the check in step 2 before feeds open again. A failed author stream also ends
the session and forces a reconnect.

A feed read that takes longer than 2 seconds also closes feeds. They stay
closed until the service-level stream next reconnects and the check passes.
`/health` then shows `feedReady: false` and `serviceStreamConnected: false`.

While feeds are closed, `getFeed` and `getBlob` return `503 FeedNotReady`.
The feed generator does not serve from a projection it cannot vouch for.

### The health route

`GET /health` returns `200` when feeds are open and `503` when they are
closed.

```json
{
  "ok": true,
  "feedReady": true,
  "version": "0.1.0",
  "serviceStreamConnected": true,
  "actorPoolSize": 0,
  "pdsSpaceSyncHealthy": true,
  "pdsSpaceSyncLastPass": {
    "boundaries": 3,
    "membershipFailures": 0,
    "targets": 12,
    "promoted": 12,
    "deferred": 0,
    "rejected": 0,
    "targetFailures": 0
  }
}
```

| Field                    | Meaning                                                        |
| ------------------------ | -------------------------------------------------------------- |
| `ok`, `feedReady`        | Feeds are open. Both fields carry the same value.              |
| `serviceStreamConnected` | The service-level stream to Stratos is up.                     |
| `actorPoolSize`          | Always `0`. The field is kept for compatibility.               |
| `pdsSpaceSyncHealthy`    | The last PDS pass ended under 90 seconds ago with no failures. |
| `pdsSpaceSyncLastPass`   | Counts from the last PDS pass. Absent before the first pass.   |

The status code follows `feedReady` only. A failing PDS sync does not turn
`/health` to `503`. Watch `pdsSpaceSyncHealthy` separately.

`/health` tells you the gate is open. It does not tell you that a viewer can
read. Make an authenticated feed request before you route users to a new
instance.

## Request limits and errors

The feed generator handles four `getFeed` and `getBlob` requests at a time,
counted together. A fifth request gets `503 FeedNotReady` straight away. Token
checks, boundary lookups, and feed reads each have a 2 second limit.

`getFeed` takes `feed` (required), `limit` (1 to 100, default 50), and
`cursor`. The query string can be up to 8 KiB. `feed` can be up to 256
bytes. `cursor` can be up to 4 KiB.

| Status | Error                   | Cause                                                                  |
| ------ | ----------------------- | ---------------------------------------------------------------------- |
| 401    | `AuthMissing`           | No `Authorization` header                                              |
| 401    | `InvalidToken`          | Not a Bearer token, malformed JWT, or unsupported algorithm            |
| 401    | `BadJwtType`            | An access, DPoP, or refresh token was sent                             |
| 401    | `ExpiredToken`          | `exp` has passed                                                       |
| 401    | `BadJwtAudience`        | `aud` is not `FEEDGEN_SERVICE_DID`                                     |
| 401    | `BadJwtLexiconMethod`   | `lxm` is missing or not a feed generator method                        |
| 401    | `CouldNotResolveIssuer` | The viewer's DID document did not resolve                              |
| 401    | `BadJwtSignature`       | The signature does not match the viewer's key                          |
| 400    | `InvalidRequest`        | A parameter is missing, too long, or out of range                      |
| 400    | `UnknownFeed`           | The feed ID is not in the feed list                                    |
| 400    | `BoundaryMismatch`      | The viewer is enrolled but does not hold this feed's boundary          |
| 503    | `FeedNotReady`          | Feeds are closed, the request limit is reached, or a time limit passed |
| 503    | `FeedNotReady`          | The viewer has no enrollment, or Stratos did not answer the lookup     |

Note the last row. A viewer who is not enrolled at all gets `503
FeedNotReady`, not an authorization error. The response does not reveal
whether the viewer is unknown or Stratos is unreachable.

Every response carries `Cache-Control: private, no-store` and
`Vary: Authorization`. Attachment errors are listed in
[Private feed attachments](/client/feedgen-blobs#errors).

## Private networks

Identity lookups use `https://plc.directory` by default. Set `PLC_DIRECTORY`
to the HTTPS origin of another PLC directory. For a PLC directory on a
private network, also set `PLC_DIRECTORY_PRIVATE_CIDRS`.

To poll a PDS on a private network, set both
`FEEDGEN_SPACE_SYNC_PRIVATE_HOST_ORIGIN` and
`FEEDGEN_SPACE_SYNC_PRIVATE_HOST_CIDRS`. The first is the exact HTTPS origin
of that PDS. The second lists the private ranges it can resolve to. This
grant covers that one origin. It is separate from the PLC grant.

The feed generator rejects mixed public and private DNS answers, private
addresses outside the listed ranges, and redirects.

## Metrics and logs

Metrics are off by default. Set `FEEDGEN_OTLP_METRICS_ENDPOINT` to push them
to an OpenTelemetry Collector over OTLP/HTTP. The feed generator does not
expose a metrics route to scrape.

The endpoint must be a private IP address or the host name `collector`. Its
path must be `/v1/metrics`. A public host, credentials, or a query string
stops startup. Metric names and their meaning are listed in
`stratos-feedgen-ng/README.md`.

Logs go to standard error as `event=<name> key=value` lines. There is no log
level setting. Useful events:

| Event                              | Meaning                                       |
| ---------------------------------- | --------------------------------------------- |
| `service_reconciliation_completed` | The readiness check ran. Check `errors`.      |
| `service_stream_connect_failed`    | The stream to Stratos did not connect.        |
| `service_stream_session_ended`     | The stream dropped. `kind` gives the reason.  |
| `pds_space_sync_pass`              | One PDS pass ended. Check `healthy`.          |
| `pds_space_membership_failed`      | A member list failed. `kind` gives the stage. |
| `pds_space_target_failed`          | One member's sync failed.                     |

## Configuration reference

Every variable the feed generator reads is in this table.

| Variable                                 | Required                  | Default                       | Notes                                                  |
| ---------------------------------------- | ------------------------- | ----------------------------- | ------------------------------------------------------ |
| `FEEDGEN_SERVICE_DID`                    | Yes                       |                               | The feed generator's DID                               |
| `FEEDGEN_PUBLIC_URL`                     | Yes                       |                               | Public base URL                                        |
| `FEEDGEN_PUBLIC_KEY_MULTIBASE`           | Yes                       |                               | Must match the signing key                             |
| `FEEDGEN_SIGNING_KEY`                    | One of the two            |                               | 64 hexadecimal characters, secp256k1                   |
| `FEEDGEN_SIGNING_KEY_FILE`               | One of the two            |                               | Path to a file with the same value                     |
| `STRATOS_SERVICE_URL`                    | Yes                       |                               | URL the feed generator uses to reach Stratos           |
| `STRATOS_SERVICE_DID`                    | Yes                       |                               | DID of the Stratos service                             |
| `STRATOS_PUBLIC_URL`                     | No                        | `STRATOS_SERVICE_URL`         | Public URL of Stratos, when it differs                 |
| `FEEDGEN_FEEDS_FILE`                     | One of the three          |                               | Path to a `.json`, `.yaml`, or `.yml` feed list        |
| `FEEDGEN_FEEDS_JSON`                     | One of the three          |                               | Inline JSON feed list                                  |
| `FEEDGEN_FEEDS_YAML`                     | One of the three          |                               | Inline YAML feed list                                  |
| `FEEDGEN_PORT`                           | No                        | `3000`                        | Listening port                                         |
| `FEEDGEN_STORAGE_BACKEND`                | No                        | `sqlite`                      | `sqlite` is the only accepted value                    |
| `FEEDGEN_STORAGE_PROFILE`                | No                        | `ephemeral`                   | `ephemeral` or `encrypted-volume`                      |
| `FEEDGEN_SQLITE_PATH`                    | With `encrypted-volume`   |                               | Absolute database path                                 |
| `FEEDGEN_STORAGE_KEY_PATH`               | With `encrypted-volume`   |                               | Absolute key path, outside the database directory      |
| `FEEDGEN_WRITER_LOCK_PATH`               | No                        | `<database path>.writer-lock` | Absolute lock path                                     |
| `FEEDGEN_PROJECTION_MAX_AGE_MS`          | With `encrypted-volume`   |                               | Whole seconds, at least `1000`                         |
| `FEEDGEN_PROJECTION_MAX_BYTES`           | With `encrypted-volume`   |                               | Positive number of bytes                               |
| `FEEDGEN_STAGE_TARGET_MAX_ROWS`          | No                        | `1024`                        | Staged rows per member. Maximum `1024`.                |
| `FEEDGEN_STAGE_GLOBAL_MAX_ROWS`          | No                        | `8192`                        | Staged rows in total                                   |
| `FEEDGEN_STAGE_TARGET_MAX_BYTES`         | No                        | A quarter of the byte limit   | Staged bytes per member. Maximum 8 MiB.                |
| `FEEDGEN_STAGE_GLOBAL_MAX_BYTES`         | No                        | Half of the byte limit        | Staged bytes in total. Maximum half of the byte limit. |
| `FEEDGEN_ACTOR_SYNC_MAX_CONNECTIONS`     | No                        | `8`                           | Author stream connections, `1` to `64`                 |
| `FEEDGEN_OTLP_METRICS_ENDPOINT`          | No                        | Off                           | Private OTLP/HTTP endpoint ending in `/v1/metrics`     |
| `PLC_DIRECTORY`                          | No                        | `https://plc.directory`       | PLC directory origin                                   |
| `PLC_DIRECTORY_PRIVATE_CIDRS`            | No                        |                               | Private ranges allowed for the PLC directory           |
| `FEEDGEN_SPACE_SYNC_PRIVATE_HOST_ORIGIN` | No, set with the next one |                               | Exact HTTPS origin of one private PDS                  |
| `FEEDGEN_SPACE_SYNC_PRIVATE_HOST_CIDRS`  | No, set with the previous |                               | Private ranges allowed for that PDS                    |

The per-member staging limits must fit inside the total staging limits. The
`ephemeral` profile ignores the age and byte variables and uses its fixed
limits.

The rehearsal compose file also reads `FEEDGEN_STATE_DIR` and
`FEEDGEN_STORAGE_KEY_FILE`. Those are host paths for bind mounts. The feed
generator binary does not read them.

Settings from the TypeScript package have no effect here. That includes
`FEEDGEN_BOUNDARY_CACHE_*`, `FEEDGEN_BOUNDARY_CATALOG_*`,
`FEEDGEN_BLOB_CACHE_*`, `FEEDGEN_POSTGRES_*`, `FEEDGEN_SUBSCRIBE_ENROLLMENTS`,
and `FEEDGEN_MEMBERSHIP_SQLITE_PATH`.

## Run it

The rehearsal compose file is `stratos-feedgen-ng/compose.rehearsal.yml`. It
runs the container with 1 vCPU, 512 MiB, a read-only root filesystem, and no
Linux capabilities. It uses the `encrypted-volume` profile. See
[Deployment examples](/operator/examples/) for the commands.

Before you route users to an instance:

1. Fetch `/.well-known/did.json` through the public URL.
2. Check that `/health` returns `200` and `pdsSpaceSyncHealthy` is `true`.
3. Make an authenticated `getFeed` request as an enrolled test viewer.

See `stratos-feedgen-ng/README.md` for the space credential transport, the
staging limits, and the metric list. See `stratos-feedgen-ng/CUTOVER.md` for
a test switch and rollback. Do not reuse the TypeScript service's database or
writer lock.
