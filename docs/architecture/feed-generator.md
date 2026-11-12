---
audience: Protocol implementers and maintainers
type: Explanation
status: current
---

# Feed generator design

<script setup>
import FeedgenRequestFlow from '../.vitepress/theme/components/FeedgenRequestFlow.vue'
import FeedgenIndexingFlow from '../.vitepress/theme/components/FeedgenIndexingFlow.vue'
</script>

A member asks a simple question: "What is new in the cooking boundary?"

The posts that answer it are spread out. Stratos keeps some of them. The
rest sit on the PDS of each member who keeps their own. Something has to
collect them, put them in order, and check the asker's membership first,
every time. That is the feed generator.

`stratos-feedgen-ng` is a standalone Rust service. It follows one Stratos
service, keeps a local, encrypted copy of recent posts, and serves that copy
back as boundary-scoped timelines. It never shows a viewer a post from a
boundary the viewer is not enrolled in.

| Lexicon                             | Type                    | Purpose                                      |
| ----------------------------------- | ----------------------- | -------------------------------------------- |
| `zone.stratos.feedgen.getFeed`      | query (authenticated)   | Hydrated posts the viewer is entitled to see |
| `zone.stratos.feedgen.getBlob`      | query (authenticated)   | An attachment of a post the viewer may read  |
| `zone.stratos.feedgen.describeFeed` | query (unauthenticated) | The configured feed list                     |

The spec-shaped `zone.stratos.space.getRecord` answers one record for one
caller. It cannot build a timeline. The feed generator closes that gap. See
[Permissioned Spaces](./permissioned-spaces.md) for the access model it
enforces.

In that model the feed generator reads and verifies. It never signs records.
A compromised feed generator leaks what it can read, which is worth guarding
closely, but it cannot forge a post.

::: info The TypeScript feed generator
`stratos-feedgen` is the earlier TypeScript implementation. It stays in the
repository as a rollback reference. New work belongs in `stratos-feedgen-ng`,
and this page describes only that service.
:::

## A feed is a boundary

The operator configures a short list of feeds. Each feed has an id and names
exactly one boundary by its full identifier, such as
`did:web:stratos.example.com/cooking`. A viewer may read a feed when they hold
that boundary. There is no ranking and no algorithm: a feed is the posts of
one boundary, newest first.

`describeFeed` returns the list without authentication. It includes each
feed's boundary identifier. Boundary names are public metadata already; see
[where the data lives](./permissioned-spaces.md#where-the-data-lives).

## Request path

A client never calls the feed generator directly. It asks its own PDS, with
an `atproto-proxy` header that names the feed generator
(`did:web:feedgen.example.com#stratos_feedgen`). The PDS forwards the request
with a short-lived service-auth JWT that identifies the user.

<FeedgenRequestFlow />

The feed generator never handles user credentials. It takes four steps.

1. **Who is asking?** The viewer's DID is the `iss` claim of the JWT. The
   feed generator resolves that DID and checks the signature against the
   `#atproto` key in the DID document. The `aud` claim must be the feed
   generator's own DID, and `lxm` must name the method.
2. **Which boundaries do they hold?** The feed generator asks Stratos for the
   viewer's current boundaries. It keeps the answer for five minutes, and
   drops it at once when Stratos reports an enrollment change for that
   viewer.
3. **Is this feed one of them?** The feed's boundary must be in the viewer's
   set. If not, the request fails with `BoundaryMismatch`.
4. **Read the page.** The posts come from the local projection, newest
   first. Each post lists only the boundaries the viewer holds.

The five-minute cache is the upper bound on how long a removed member keeps
reading feeds.

A viewer with no enrollment gets `FeedNotReady`, the same answer as a feed
generator that is still catching up. The response does not reveal which of
the two it is.

## Indexing path

Feed requests are served from the local projection. The feed generator does
not fan out to Stratos or to any PDS at request time. Three background jobs
keep the projection current, and they map onto the two
[custody classes](./permissioned-spaces.md#who-keeps-the-records-custody).

<FeedgenIndexingFlow />

### The service stream: who is a member

One WebSocket to Stratos carries enrollment events. It tells the feed
generator who joined, who left, and whose boundaries changed. This stream
decides _who_ to follow.

### Actor streams: Stratos-custody members

For members whose records Stratos hosts, the feed generator subscribes to
`zone.stratos.sync.subscribeRecords` per actor. It does not hold one socket
per member. A bounded pool of connections (8 by default) rotates through the
members, and each one resumes from its saved cursor.

Stratos already filters these streams to the boundaries the feed generator
may observe. The feed generator still intersects each post's boundary with
the author's current enrollment before it stores the post.

### Space polling: PDS-custody members

For members whose records live on their own PDS, nobody pushes. The feed
generator goes and asks. Every 30 seconds, for each configured boundary, it:

1. obtains a space credential from Stratos for that boundary's space;
2. asks Stratos who the members are (`zone.stratos.space.listRepos`) and
   where each PDS-custody member's repository is hosted;
3. pages `com.atproto.space.listRepoOps` on each member's PDS with that
   credential;
4. holds the changes in a staging area until the final commit signature
   verifies against the author's own key;
5. promotes the staged changes into the projection in one step.

Two rules make this safe.

**The boundary comes from Stratos, never from the post.** Any account can
write a record into a Stratos-owned space on its own PDS and claim any
boundary. The feed generator ignores the claim. A post found while polling
the cooking space is a cooking post because Stratos listed its author as a
cooking member.

**The member list decides whose repository is read.** The feed generator
never discovers writers by itself. A removed member can keep writing on
their PDS; the feed generator stops asking for it.

### Ready or not

The feed generator refuses to serve from a projection it cannot vouch for.
Reads are closed at startup and on every reconnect of the service stream.
They open again only after every stored enrollment has been checked against
Stratos without error. Until then, feed requests answer `FeedNotReady` with
HTTP 503.

Only `zone.stratos.feed.post` records are indexed. A post that no longer has
a valid boundary is deleted from the projection.

## Auth flows

Every hop is authenticated, and each direction uses a different mechanism.

| Direction                             | Mechanism                                                                  | Verified by                                 |
| ------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------- |
| Client → PDS                          | OAuth + DPoP                                                               | The PDS                                     |
| PDS → feed generator                  | Service-auth JWT: `iss` = user DID, `aud` = feedgen DID, `lxm` = method    | Feed generator, via the user's DID document |
| Feed generator → Stratos (HTTP)       | Service-auth JWT: `iss` = feedgen DID, `aud` = Stratos DID, `lxm` = method | Stratos                                     |
| Feed generator → Stratos (WebSocket)  | The same JWT shape, `lxm` = `zone.stratos.sync.subscribeRecords`           | Stratos, against a service enrollment       |
| Feed generator → Stratos (credential) | A single-use delegation token and an HTTP signature                        | Stratos `getSpaceCredential`                |
| Feed generator → member's PDS         | Space credential as `Authorization: Atproto-Space`, with an HTTP signature | The member's PDS                            |

The last two rows are the
[HTTP-signature credential profile](./permissioned-spaces.md#two-ways-to-bind-a-credential).
Stratos needs a replay store (Valkey or Redis) to issue those credentials.

The feed generator has its own identity: a `did:web` whose DID document
publishes an `#atproto` verification method and a service entry with id
`#stratos_feedgen` and type `NorthskyStratosFeedGen`. Stratos must know that
DID as a service enrollment before it accepts the sync stream.

## Storage

The feed generator's copy is a projection, not a system of record. It can be
thrown away and rebuilt from Stratos and the members' PDSs.

| Concern                         | Choice                                          |
| ------------------------------- | ----------------------------------------------- |
| Posts, boundaries, sync cursors | SQLCipher (encrypted SQLite)                    |
| Staged PDS changes              | The same database, with its own reserved budget |
| Attachments                     | In-memory cache only; never written to disk     |
| Viewer boundaries               | In-memory, five-minute lifetime                 |
| Feed list                       | A static file or an environment variable        |

The projection is bounded by age and by size. A compactor evicts the oldest
posts first. A feed therefore shows recent history, not an archive.

There are two storage profiles. The default, `ephemeral`, keeps everything
in memory and forgets it on restart. The `encrypted-volume` profile persists
the database, with the encryption key in a separate, private key file.
Production deployments use `encrypted-volume`.

## Attachments

`zone.stratos.feedgen.getBlob` serves the images of a post. The feed
generator repeats the viewer check, confirms that the post references the
requested CID, fetches the blob from Stratos, verifies its hash, and returns
it with private cache headers.

It serves attachments of Stratos-hosted posts only. A post hosted on a
member's PDS appears in the feed without its attachments. See
[Private Feed Attachments](/client/feedgen-blobs) for the client side.

## What it does not do

- It does not rank, recommend, or mix boundaries into one feed.
- It does not attach moderation labels.
- It does not resolve handles. A post's author carries a DID only.
- It does not serve public posts. Clients merge public and private timelines
  themselves.

## Running one

The feed generator binds to exactly one Stratos service. It runs and
restarts independently of it, and it absorbs feed traffic that would
otherwise reach Stratos.

Configuration, storage profiles, health checks, and limits are in the
[operator guide](/operator/feedgen-ng). Source lives in
`stratos-feedgen-ng/`; its README covers build and test, and `CUTOVER.md`
covers rehearsal and rollback from the TypeScript service.
