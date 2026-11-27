---
audience: Operators
type: How-to and reference
prerequisites: A running Stratos service and a service DID for the feed generator
status: current
---

<script setup>
import FeedgenIndexingFlow from '../.vitepress/theme/components/FeedgenIndexingFlow.vue'

const readinessStates = [
  { id: 'closed', title: 'Closed', sub: '503 FeedNotReady', tone: 'deny' },
  { id: 'checking', title: 'Re-checking', sub: 'every stored author' },
  { id: 'open', title: 'Open', sub: '/health 200', tone: 'ok' },
]
const readinessMoves = [
  { from: 'closed', to: 'checking', label: 'Stream connects' },
  { from: 'checking', to: 'open', label: 'Every answer applies' },
  { from: 'open', to: 'closed', label: 'Stream drops, or a feed read over 2 s' },
  { from: 'checking', to: 'closed', label: 'An answer fails; reconnect' },
]
</script>

# Run the feed generator

The feed generator turns boundaries into feeds. It copies each new post into
a local projection as the post arrives. When a viewer asks for a feed, it
checks the viewer's enrollment first.

The feed generator is a separate service. It follows one Stratos service, keeps a bounded copy of
recent posts, and serves that copy as feeds.

The feed generator is the Rust `stratos-feedgen-ng` package.

This page is for operators. For the design, read
[Feed generator design](/architecture/feed-generator). For attachment
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

<Figure step="1" caption="How posts get in">
  <FeedgenIndexingFlow />
</Figure>

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

Stratos sends each commit as one frame of up to 200 writes. The feed generator
stores all of a frame's posts and moves the author's cursor in one step, or
does neither. A frame is at most 2,359,296 bytes, the most Stratos sends. Each
connection holds one frame at a time: up to 18 MiB of frames at the default 8
connections, and 144 MiB at 64.

A larger frame ends the connection. The cursor does not move, so the next
connection meets the same frame and that author's posts stop arriving. The feed
generator logs `actor_frame_too_large` and counts
`stratos.feedgen.subscription.oversized_frames` each time. Stratos refuses to
write a commit that large, so the event means that Stratos and the feed
generator disagree on the limit. Run versions that agree.

### PDS-custody authors

Some members keep their records on their own PDS. Every 30 seconds the feed
generator does this for each boundary in the feed list:

1. Get a space credential from Stratos.
2. Ask Stratos for the members of the space with
   `zone.stratos.space.listRepos`.
3. For each member with `pds` custody, read
   `com.atproto.space.listRepoOps` from the host that Stratos names, or read
   the whole repo with `com.atproto.space.getRepo` when that is not possible.

Up to four members sync at once. Each member's state is checked before it
becomes readable. See [Verified sync of PDS members](#verified-sync-of-pds-members).

A post from a PDS gets the boundary of the space it was read from. A
boundary written inside the post is ignored.

## Verified sync of PDS members

The feed generator keeps a verified state for each member and space. The state
is the last verified revision, a set-hash state, and the CID at every record
path. A member's posts are readable only from a state that was verified.

### What one cycle does

Each member's cycle runs in this order. The whole cycle, including the wait for
the member's lock, has a deadline of 60 seconds.

1. Get a space credential for the boundary, or reuse the one held.
2. Read the verified state. If the member has none, or the stored host or
   membership generation is not the current one, go to step 6.
3. Read `listRepoOps` pages with `since` set to the verified revision. Each page
   is its own request with its own one-time key. Every response is
   authenticated by a MAC. The MAC key comes from HPKE (export only), a one-time
   key and the member's `#atproto_kem` key. A MAC mismatch makes the feed
   generator read the member's `#atproto_kem` key again and send the request
   once more. If the key is unchanged, or the second request also fails the
   check, the member fails. The poll ends at the first page that carries no
   cursor.
4. Apply the ops of all pages in memory to the verified state, and compute the
   set hash.
5. Promote only when the set hash equals the `data` of the last page's commit.
   The write is one transaction. A poll that changes nothing and ends at the
   stored revision writes nothing. Nothing is staged: a failed check leaves the
   stored state as it was.
6. Read the whole repo as an archive (`getRepo`, authenticated the same way)
   and replace the member's state, again only when the set hash equals the
   commit's `data`.

The feed generator reads the whole repo when:

- the member has no verified state yet;
- the stored host or membership generation is not the current one;
- the last commit's revision is below the verified revision;
- the ops do not follow the stored records, or the set hash does not equal the
  commit's `data`;
- the host answers `InvalidCursor` with status 400 to a page request;
- a poll passes a limit in the table below;
- a post, like or repost changed with no value in the op.

Only one whole-repo read runs at a time across all members. After a failed
whole-repo read, that member has no whole-repo read for 10 minutes
(`SPACE_REPLACEMENT_COOLDOWN`). The cooldown is in memory. Incremental polls
continue during it.

A `RepoNotFound` answer with status 400 from the member's host clears that
member's records in that space, and nothing else. The answer carries no MAC.
The pinned TLS connection to the host that Stratos named is its only
protection, so one answer is not enough. The host must give the same answer for
one hour (`SPACE_REPO_NOT_FOUND_CONFIRMATION`). Until then the member fails as
`repo_not_found` and nothing is changed. When the answer came to a whole-repo
read, the passes in the cooldown after it fail as `replacement_cooldown`
instead. The first pass that gets the answer an hour or more after the first
one clears the member and counts it as `cleared`. Any other end of that
member's cycle, a good poll or another failure, starts the hour again. A pass
that the cooldown turns away before it asks the host does not. The hour also
starts again when the answer comes from another host than the one before, when
the member left the space and joined again, or when the answer comes more than
20 minutes (`SPACE_REPO_NOT_FOUND_MAX_GAP`) after the one before it, for
example after passes that could not list the members. With the cooldown,
answers to whole-repo reads come about 10 minutes and a pass apart, inside that
wait. The hour is kept in memory, so a restart starts it again. Any other failure leaves the
stored rows as they were.

A host answer of `RepoTakendown`, `RepoSuspended` or `RepoDeactivated` fails
the member and deletes nothing. The cached posts of that member stay served.

### Limits

| Limit                                                  | Value                            | Constant                                                      |
| ------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------- |
| Ops in one poll, and ops in one page request           | 1,000                            | `MAX_POLL_OPS`, `MAX_SPACE_PAGE_OPS`                          |
| Pages in one poll                                      | 1,000                            | `MAX_POLL_PAGES`                                              |
| Page bodies in one poll, and one page response         | 16 MiB                           | `MAX_SPACE_POLL_BODY_BYTES`                                   |
| Records of one member in one space                     | 20,000                           | `MAX_SPACE_REPO_RECORDS`                                      |
| Record paths in the store, all members and spaces      | 500,000                          | `MAX_SPACE_VERIFICATION_ROWS`                                 |
| Whole archive                                          | 16 MiB                           | `MAX_SPACE_ARCHIVE_BYTES`                                     |
| One record in an archive                               | 1 MiB                            | `MAX_SPACE_ARCHIVE_VALUE_BYTES`                               |
| Archive metadata, and one archive key                  | 64 KiB, 4 KiB                    | `MAX_SPACE_ARCHIVE_META_BYTES`, `MAX_SPACE_ARCHIVE_KEY_BYTES` |
| Decoded JSON values one member's cycle may hold        | 2,000,000                        | `MAX_SPACE_CYCLE_VALUES`                                      |
| One serialized projected record                        | 64 KiB. A larger one is removed. | `MAX_SPACE_RECORD_BYTES`                                      |
| One member's whole cycle                               | 60 seconds                       | `SPACE_TARGET_DEADLINE`                                       |
| One page request, and one archive request              | 10 seconds, 60 seconds           | `REQUEST_TIMEOUT`, `ARCHIVE_REQUEST_TIMEOUT`                  |
| No whole-repo read after a failed one                  | 10 minutes                       | `SPACE_REPLACEMENT_COOLDOWN`                                  |
| Members held in the lock list and in the cooldown list | 4,096 each                       | `MAX_TARGET_LOCKS`                                            |
| Members syncing at once                                | 4                                | `MAX_TARGET_CONCURRENCY`                                      |
| Time between passes                                    | 30 seconds                       | `DEFAULT_INTERVAL`                                            |

A poll that passes the ops, pages or body limit recovers from the whole repo.
A member that passes any other limit is a failed target. The store is never
left truncated. The path rows do not count against the projection budget, and
retention never deletes them.

### The size budget and the write reserve

`FEEDGEN_PROJECTION_MAX_BYTES` is the budget for published posts and
interactions. Each compaction pass brings published bytes to that maximum less
`FEEDGEN_SPACE_WRITE_RESERVE_BYTES`, or under. That leaves the reserve free for
verified space writes. A space write that would push the projection over the
whole maximum is refused with the reason `repo_over_budget`. It changes nothing
and evicts nothing.

`FEEDGEN_SPACE_WRITE_RESERVE_BYTES` is optional. It defaults to half of
`FEEDGEN_PROJECTION_MAX_BYTES`. It must be a whole number above zero and below
the maximum, or the feed generator does not start. The `ephemeral` profile has
a fixed 16 MiB maximum, so its default reserve is 8 MiB.

The four settings `FEEDGEN_STAGE_TARGET_MAX_ROWS`,
`FEEDGEN_STAGE_GLOBAL_MAX_ROWS`, `FEEDGEN_STAGE_TARGET_MAX_BYTES` and
`FEEDGEN_STAGE_GLOBAL_MAX_BYTES` are not read. A set one is ignored.

### The database file

The store is at schema version 12. Migration 10 deletes every post and
suppression marker whose URI is not a Stratos-custody URI, every interaction
whose URI or subject is not one, and the record takedown subjects of those
URIs. It empties the four staged-page tables and the space cursor table. It
resets the label cursor, so the feed generator reads the label log again from
the start, and it creates the tables of verified state. Migration 11 drops the
four staged-page tables, the space cursor table and the triggers on the
staged-page tables. Migration 12 records with the label cursor the boundaries it
was read under, and keeps a row for every lifted takedown. An existing cursor
has no record, so the first poll after the upgrade reads the label log again
from the start, once. An older binary refuses a migrated file, so the only way back is the copy made before the upgrade. The
effects and the steps are in
[November upgrade and rollback](./november-upgrade.md).

### Pass output and reasons

`GET /health` reports `pdsSpaceSyncLastPass` with the counts of the last pass.
The same counts are logged as `event=pds_space_sync_pass`. The members are
`boundaries`, `membershipFailures`, `targets`, `promoted`, `unchanged`,
`replaced`, `cleared`, `deferred` and `targetFailures`.

| Member               | Counts                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `boundaries`         | Boundaries the pass handled                                                                                          |
| `membershipFailures` | Boundaries whose member list failed                                                                                  |
| `targets`            | Members the pass started a cycle for                                                                                 |
| `promoted`           | Members whose ops were proven and written                                                                            |
| `unchanged`          | Members already at the revision the host reports                                                                     |
| `replaced`           | Members whose state a whole-repo read replaced                                                                       |
| `cleared`            | Members whose records were cleared because their host answered `RepoNotFound` for an hour                            |
| `deferred`           | Members whose DID document lookup did not complete, or answered an error other than not found; no failure is counted |
| `targetFailures`     | Members that failed                                                                                                  |

A member whose cycle a membership change or a moved base interrupted starts
again in the next pass. It counts only in `targets`. It is not a failure.

A failed member logs `event=pds_space_target_failed kind=<reason>`. A failure
with the reason `member_generation` logs no line of its own, and it is not
counted in `targets`. A pass with failed members logs one
`event=pds_space_target_failures` line with `<reason>=<count>` pairs, which
counts every reason. The reason is one of 27 fixed words. No host text reaches
a log line.

| Reason                                                                               | Meaning                                                                                                     |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `invalid_space_mac`, `invalid_space_uri`, `invalid_credential`, `bad_space_audience` | The host answered with that error name                                                                      |
| `repo_not_found`                                                                     | The host answered `RepoNotFound` with a status other than 400, or with status 400 not yet for an hour       |
| `repo_takendown`, `repo_suspended`, `repo_deactivated`                               | The host answered that account status. Nothing is deleted                                                   |
| `invalid_cursor`                                                                     | The host answered `InvalidCursor` other than as a status 400 to a page                                      |
| `mac`                                                                                | A response failed the MAC check, after the one retry                                                        |
| `kem_key`                                                                            | The member's DID document has no usable `#atproto_kem` key, or is not found. No request is sent to the host |
| `record_refused`                                                                     | A record value could not be admitted or held to its CID                                                     |
| `archive`                                                                            | The archive was malformed, out of order, or had the wrong metadata                                          |
| `repo_over_budget`                                                                   | A record, row, archive, value or projection budget would be passed                                          |
| `digest`                                                                             | The set hash of a whole-repo read did not equal the commit's `data`                                         |
| `deadline`                                                                           | The 60-second deadline passed                                                                               |
| `replacement_cooldown`                                                               | A whole-repo read was refused because one failed in the last 10 minutes                                     |
| `credential`                                                                         | No space credential could be obtained                                                                       |
| `transport`                                                                          | The request did not complete                                                                                |
| `page`                                                                               | A page could not be read, or an op's revision was out of range                                              |
| `cursor_stalled`                                                                     | The host repeated a page cursor                                                                             |
| `store`                                                                              | The store refused the write for another reason                                                              |
| `target_capacity`, `cooldown_capacity`                                               | The lock list or the cooldown list is full (4,096)                                                          |
| `member_generation`                                                                  | The membership pass gave no generation for the member                                                       |
| `task`                                                                               | The member's task did not finish                                                                            |
| `other`                                                                              | The host answered an error name that is not one of the nine it tells apart                                  |

The words `host`, `target`, `stage`, `page_limit` and `operation_limit` are not
reasons of a failed member, and the `outcome` label of the space sync metric
has no `member_rejected` value. An alert keyed on one of the five as a
member's reason, or on `member_rejected`, never fires. `page_limit`
remains a `kind` of `pds_space_membership_failed`, for a membership listing
that ran out of pages.

## Who can read

A client does not hold a token for the feed generator. It asks its own PDS
and sets the `atproto-proxy` header to `<feed generator DID>#stratos_feedgen`.
The PDS forwards the request with a service-auth JWT.

The feed generator accepts the token only when every row holds:

| Claim or part | Requirement                                                      |
| ------------- | ---------------------------------------------------------------- |
| Header        | `Authorization: Bearer <jwt>`                                    |
| `alg`         | `ES256` or `ES256K`                                              |
| `iss`         | The viewer's DID                                                 |
| `aud`         | Exactly `FEEDGEN_SERVICE_DID`, with no fragment                  |
| `exp`         | In the future                                                    |
| `lxm`         | The method the client calls                                      |
| Signature     | Verifies against the `#atproto` key in the viewer's DID document |

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

| Profile               | Where data lives         | Kept on restart      | Limits                                  | Use for                                    |
| --------------------- | ------------------------ | -------------------- | --------------------------------------- | ------------------------------------------ |
| `ephemeral` (default) | Memory only              | Nothing              | Fixed: 16 MiB and 1 hour                | Tests                                      |
| `encrypted-volume`    | SQLCipher file on a disk | The whole projection | You set them. Both limits are required. | Any deployment that must survive a restart |

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
`Authorization: Atproto-Space-Credential` header, the `Atproto-Space-Audience`
header, and an HTTP signature over both. The signature carries
`tag="atproto-space-credential"` and covers `("authorization"
"atproto-space-audience")`. The audience is the Stratos DID for a member list.
It is the member's DID for a read from that member's PDS. The delegation names
the audience `<Stratos DID>#atproto_pds`.

The feed generator keeps credentials and their keys in memory only. It holds
at most 128. It refreshes a credential five minutes before expiry, or a tenth
of its remaining lifetime before expiry when that is shorter. With the default
600-second lifetime that is 60 seconds. It rejects a credential that lasts
longer than one hour. The Stratos side of this exchange is described in
[Permissioned spaces](/architecture/permissioned-spaces#credential).

## Readiness

<StateDiagram
  title="Feed readiness"
  :states="readinessStates"
  :transitions="readinessMoves"
/>

Feeds start closed. They open only after two things happen in order:

1. The service-level stream to Stratos connects.
2. The feed generator asks Stratos again about every author in its stored
   enrollment list, and every answer applies without error.

A dropped stream closes feeds at once. The feed generator reconnects with a
delay that doubles from 1 second up to 60 seconds. Every reconnect repeats
the check in step 2 before feeds open again. A failed check or a failed
author stream also ends the session and forces a reconnect.

A feed read that takes longer than 2 seconds also closes feeds. They stay
closed until the service-level stream next reconnects and the check passes.
`/health` then shows `feedReady: false` and `serviceStreamConnected: false`.

Feeds also close while the label log is read again from the start. That
happens when a boundary joins the label scope: a new feed, or a wider service
enrollment of the feed generator DID. It also happens once after the upgrade
to store version 12. Feeds reopen when the read reaches the head. The
moderation labels section of `stratos-feedgen-ng/README.md` has the details.

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
    "promoted": 2,
    "unchanged": 10,
    "replaced": 0,
    "cleared": 0,
    "deferred": 0,
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
| `actor_frame_too_large`            | An author's frame was over the frame limit.   |
| `pds_space_sync_pass`              | One PDS pass ended. Check `healthy`.          |
| `pds_space_membership_failed`      | A member list failed. `kind` gives the stage. |
| `pds_space_target_failed`          | One member's sync failed. `kind` is a reason. |
| `pds_space_target_failures`        | The failed members of a pass, by reason.      |

## Configuration reference

Every variable the feed generator reads is in this table.

| Variable                                 | Required                  | Default                       | Notes                                                       |
| ---------------------------------------- | ------------------------- | ----------------------------- | ----------------------------------------------------------- |
| `FEEDGEN_SERVICE_DID`                    | Yes                       |                               | The feed generator's DID                                    |
| `FEEDGEN_PUBLIC_URL`                     | Yes                       |                               | Public base URL                                             |
| `FEEDGEN_PUBLIC_KEY_MULTIBASE`           | Yes                       |                               | Must match the signing key                                  |
| `FEEDGEN_SIGNING_KEY`                    | One of the two            |                               | 64 hexadecimal characters, secp256k1                        |
| `FEEDGEN_SIGNING_KEY_FILE`               | One of the two            |                               | Path to a file with the same value                          |
| `STRATOS_SERVICE_URL`                    | Yes                       |                               | URL the feed generator uses to reach Stratos                |
| `STRATOS_SERVICE_DID`                    | Yes                       |                               | DID of the Stratos service                                  |
| `STRATOS_PUBLIC_URL`                     | No                        | `STRATOS_SERVICE_URL`         | Public URL of Stratos, when it differs                      |
| `FEEDGEN_FEEDS_FILE`                     | One of the three          |                               | Path to a `.json`, `.yaml`, or `.yml` feed list             |
| `FEEDGEN_FEEDS_JSON`                     | One of the three          |                               | Inline JSON feed list                                       |
| `FEEDGEN_FEEDS_YAML`                     | One of the three          |                               | Inline YAML feed list                                       |
| `FEEDGEN_PORT`                           | No                        | `3000`                        | Listening port                                              |
| `FEEDGEN_STORAGE_BACKEND`                | No                        | `sqlite`                      | `sqlite` is the only accepted value                         |
| `FEEDGEN_STORAGE_PROFILE`                | No                        | `ephemeral`                   | `ephemeral` or `encrypted-volume`                           |
| `FEEDGEN_SQLITE_PATH`                    | With `encrypted-volume`   |                               | Absolute database path                                      |
| `FEEDGEN_STORAGE_KEY_PATH`               | With `encrypted-volume`   |                               | Absolute key path, outside the database directory           |
| `FEEDGEN_WRITER_LOCK_PATH`               | No                        | `<database path>.writer-lock` | Absolute lock path                                          |
| `FEEDGEN_PROJECTION_MAX_AGE_MS`          | With `encrypted-volume`   |                               | Whole seconds, at least `1000`                              |
| `FEEDGEN_PROJECTION_MAX_BYTES`           | With `encrypted-volume`   |                               | Positive number of bytes                                    |
| `FEEDGEN_SPACE_WRITE_RESERVE_BYTES`      | No                        | Half of the byte limit        | Bytes kept free for space writes. Above 0, below the limit. |
| `FEEDGEN_ACTOR_SYNC_MAX_CONNECTIONS`     | No                        | `8`                           | Author stream connections, `1` to `64`                      |
| `FEEDGEN_OTLP_METRICS_ENDPOINT`          | No                        | Off                           | Private OTLP/HTTP endpoint ending in `/v1/metrics`          |
| `PLC_DIRECTORY`                          | No                        | `https://plc.directory`       | PLC directory origin                                        |
| `PLC_DIRECTORY_PRIVATE_CIDRS`            | No                        |                               | Private ranges allowed for the PLC directory                |
| `FEEDGEN_SPACE_SYNC_PRIVATE_HOST_ORIGIN` | No, set with the next one |                               | Exact HTTPS origin of one private PDS                       |
| `FEEDGEN_SPACE_SYNC_PRIVATE_HOST_CIDRS`  | No, set with the previous |                               | Private ranges allowed for that PDS                         |

The `ephemeral` profile ignores the age and byte variables and uses its fixed
limits. `FEEDGEN_STAGE_TARGET_MAX_ROWS`, `FEEDGEN_STAGE_GLOBAL_MAX_ROWS`,
`FEEDGEN_STAGE_TARGET_MAX_BYTES` and `FEEDGEN_STAGE_GLOBAL_MAX_BYTES` are not
read. A set one is ignored.

The rehearsal compose file also reads `FEEDGEN_STATE_DIR` and
`FEEDGEN_STORAGE_KEY_FILE`. Those are host paths for bind mounts. The feed
generator binary does not read them.

## Run it

The rehearsal compose file is `stratos-feedgen-ng/compose.rehearsal.yml`. It
runs the container with 1 vCPU, 512 MiB, a read-only root filesystem, and no
Linux capabilities. It uses the `encrypted-volume` profile. See
[Deployment examples](/operator/examples/) for the commands.

Before you route users to an instance:

1. Fetch `/.well-known/did.json` through the public URL.
2. Check that `/health` returns `200` and `pdsSpaceSyncHealthy` is `true`.
   With members who have `pds` custody it is `false` until their hosts accept
   the `at:space/` spelling. See
   [What cannot work yet](./november-upgrade.md#what-cannot-work-yet).
3. Make an authenticated `getFeed` request as an enrolled test viewer.

See `stratos-feedgen-ng/README.md` for the space credential transport, the
space sync limits, and the metric list. See `stratos-feedgen-ng/CUTOVER.md`
for a test switch and rollback. See the
[November upgrade and rollback](./november-upgrade.md) procedure for in-place upgrades.
