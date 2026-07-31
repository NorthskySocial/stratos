# Feed Generator

<script setup>
import FeedgenRequestFlow from '../.vitepress/theme/components/FeedgenRequestFlow.vue'
import FeedgenIndexingFlow from '../.vitepress/theme/components/FeedgenIndexingFlow.vue'
</script>

`stratos-feedgen` is a standalone service that turns a Stratos instance into
browsable timelines. It subscribes to a single upstream Stratos service,
maintains a local post index, and serves fully hydrated, boundary-scoped
feeds to clients over two XRPC methods:

| Lexicon                              | Type                    | Purpose                                        |
| ------------------------------------ | ----------------------- | ---------------------------------------------- |
| `zone.stratos.feedgen.getFeed`       | query (authenticated)   | Hydrated posts the viewer is entitled to see   |
| `zone.stratos.feedgen.describeFeed`  | query (unauthenticated) | The configured feed list, for introspection    |

The spec-shaped `zone.stratos.space.getRecord` endpoint answers one record
for one caller; it cannot build a timeline. The feed generator exists to
close that gap: it is the component that assembles many boundary-gated
records into a feed without ever showing a viewer a post from a boundary
they are not enrolled in. See [Permissioned Spaces](./permissioned-spaces.md)
for the access model it enforces.

In that model the feed generator is a syncer and verifier, never a signer:
it holds sync credentials and the verification logic, while signing keys
stay in the Stratos service's isolated signer. That keeps the feed
generator's compromise blast radius to read access, which is still worth
guarding closely, but it cannot forge records.

## Request path

A client never calls the feed generator directly. It asks its own PDS with
an `atproto-proxy` header naming the feed generator
(`did:web:feedgen.example.com#stratos_feedgen`), and the PDS forwards the
request with a short-lived service-auth JWT that identifies the user.

<FeedgenRequestFlow />

The viewer's DID comes from the JWT `iss` claim, so the feed generator never
handles user credentials. Boundary membership is resolved from the upstream
Stratos and cached in process (300 s TTL by default), which bounds how long
a revoked member can keep reading through a warm cache.

## Indexing path

Feed queries are served from a local index, not by fanning out to Stratos at
request time. Two kinds of background subscription keep that index current:

<FeedgenIndexingFlow />

The service-level stream tells the feed generator *who* to follow; the
per-actor streams deliver *what* they wrote, already scoped to the
boundaries the feed generator is entitled to observe. Posts land in a SQLite
(WAL) index keyed by uri, author, boundary, and `sortAt`, with cursors
persisted so restarts resume rather than re-index.

## Auth flows

Every hop is authenticated, and each direction uses a different mechanism:

| Direction                     | Mechanism                                                                             | Verified by                                             |
| ----------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Client → PDS                  | OAuth + DPoP                                                                          | The PDS                                                  |
| PDS → Feed generator          | Service-auth JWT: `iss` = user DID, `aud` = feedgen DID, `lxm` = endpoint, `exp` < 60s | Feed generator, via the user's DID document              |
| Feed generator → Stratos      | Service-auth JWT: `iss` = feedgen DID, `aud` = Stratos DID, `lxm` = endpoint           | Stratos `service` verifier                               |
| Feed generator → Stratos (WS) | Same JWT shape as a Bearer header, `lxm` = `zone.stratos.sync.subscribeRecords`        | Stratos `subscribeAuth` verifier                         |

The feed generator has its own identity: a `did:web` whose DID document
publishes an `#atproto` verification method (its signing key) and a service
entry with id `#stratos_feedgen` and type `NorthskyStratosFeedGen`. One key
signs outgoing JWTs to Stratos and proves the feed generator's identity to
callers.

## Moderation labels

The feed generator can subscribe to labeler DIDs (`FEEDGEN_LABELERS`),
caches their labels locally, and attaches them to `postView.labels` at
serialization time. Self-labels from the record are merged with external
labels filtered by the caller's `atproto-accept-labelers` header, and the
response reports the labelers consulted in `atproto-content-labelers`.

Labels annotate; they never filter. Deciding to blur, warn, or hide is the
client's job, the same division of responsibility the public network uses.

## Storage

| Concern                        | Choice                               |
| ------------------------------ | ------------------------------------ |
| Post / boundary / cursor index | SQLite (WAL) via Drizzle             |
| Blob cache                     | S3 or filestore                      |
| Viewer boundary cache          | In-process TTL + LRU (300 s default) |
| Feed configuration             | Static file or environment variable  |

## Deployment notes

The feed generator binds to exactly one upstream Stratos service. Required
configuration:

| Env var               | Description                                            |
| --------------------- | ------------------------------------------------------ |
| `FEEDGEN_SERVICE_DID` | The feed generator's own DID (`did:web:<host>`)        |
| `FEEDGEN_SIGNING_KEY` | Its signing key (hex secp256k1)                        |
| `STRATOS_SERVICE_URL` | Base URL of the upstream Stratos                       |
| `STRATOS_SERVICE_DID` | DID of the upstream Stratos                            |

Because all reads go through the local index and blob cache, the feed
generator absorbs feed traffic that would otherwise hit the Stratos service,
and it can be scaled or restarted independently of it. A ready-made compose
overlay (`docker-compose.feedgen.yml`) is described in the
[deployment examples](/operator/examples/#feed-generator-overlay-docker-compose-feedgen-yml).
Source lives in `stratos/stratos-feedgen/`; the package README covers build,
test, and the full module layout.
