# Feedgen compatibility contract

This ledger defines the observable contracts a Feedgen implementation must
preserve. Fixture data and reports use synthetic identifiers only.

## Feed endpoint

`GET /xrpc/zone.stratos.feedgen.getFeed` requires a valid inbound user
service-auth JWT. The token issuer is the viewer DID; its audience is the
Feedgen DID, its `lxm` is exactly `zone.stratos.feedgen.getFeed`, and its
expiry must be current. Invalid, expired, wrong-audience, or wrong-method
tokens are unauthorized and never produce a feed.

The required `feed` parameter selects a configured feed. `limit` defaults to
50 and has a wire maximum of 100. A request with `limit=500` is rejected as
`400 InvalidRequest` before the handler queries the projection. The handler's
defensive clamp is not permission to accept an invalid wire request.

The viewer must currently hold the configured feed boundary. Unknown feeds and
boundary mismatches fail instead of returning an empty feed. If authority
reconciliation is incomplete, the endpoint fails with retryable
`FeedNotReady`; closed reconciliation must not be presented as authorized or
complete.

Posts are ordered by `sortAt DESC, uri ASC`. A cursor is the literal
`{sortAt}::{uri}` pair. A malformed cursor is treated as no cursor. A page
contains an optional next cursor and `feed` entries retaining URI, CID, record,
author DID, optional author handle, and indexed timestamp. The response filters
labels to the viewer's current boundaries. Optional handle lookup failure leaves
the DID usable.

Rust accepts `ES256` with a P-256 DID key and `ES256K` with a secp256k1 DID
key. The algorithm and resolved key curve must match; neither curve is an
authorization fallback for the other.

## Public discovery and private blobs

`GET /xrpc/zone.stratos.feedgen.describeFeed` returns the Feedgen DID and the
configured feed registry. `GET /.well-known/did.json` publishes the service
fragment `#stratos_feedgen`, the configured public endpoint, and the Feedgen
public key. `/health` is readiness-aware: it returns `200` only when the
authority session and reconciliation permit feed reads; otherwise it returns
`503` with `feedReady: false`.

`GET /xrpc/zone.stratos.feedgen.getBlob` uses the same service-auth model with
`lxm` equal to `zone.stratos.feedgen.getBlob`. Blob access is authorized
against the post's current boundary and is rechecked before release. Successful
blob responses include `Cache-Control: private, no-store`, `Vary:
Authorization`, `X-Content-Type-Options: nosniff`, and a restrictive content
security policy.

The feed and blob paths set `Cache-Control: private,
no-store` for private success and error responses. The authenticated PDS proxy
must preserve that response policy rather than supplying a shared-cache
default.

Outbound space requests may use an internal service URL for network reachability
while DPoP `htu` is bound to the authority's configured public URL. Those
origins are distinct configuration values and must not be silently substituted
for one another.

## Projection and custody invariants

The projection is a local, bounded cache rather than authority. A PDS-custody
record's claimed boundary is not authoritative: only authority-derived
membership and boundary state may admit it. Revocation, deletion, membership
loss, readiness loss, or a changed authorization epoch must invalidate a
prepared response before its body is released. Durable feed generators use independent encrypted projections.
Each projection has one writer.

The Rust Feedgen takes a Stratos-custody post's boundary from the operation
`boundary` the authority sets, and uses the record body only for operations
recorded before the authority set it. When an operation carries a boundary the
body boundary is not read. The result is still limited to the boundaries the
actor currently holds.

The Rust Feedgen counts likes and reposts of the posts it serves. Every post
in a feed response carries `likeCount`, `repostCount` and `viewer`. The counts
are 0 when nothing counts, and `viewer` is `{}` when the viewer has neither
liked nor reposted the post. `viewer.like` and `viewer.repost` hold the URIs of
the viewer's own records and nothing else. A like or repost counts only when
its boundary is the feed's boundary and its subject is exactly the post's URI.
One actor counts once per post, however many likes it made. An expired like or
repost does not count. A like or repost can arrive before its post and counts
once the post arrives. A like or repost never makes a post visible to a viewer
who cannot already read it, and the response never names another actor or
another actor's record URI.

## Moderation labels

The Rust Feedgen applies Stratos moderation labels. It polls the authority's
`zone.stratos.moderation.queryLabels` every 10 seconds, using a service-auth
JWT it mints itself.

Feeds stay closed until the label cursor has caught up with the authority.
Caught up means the authority returned the cursor the Feedgen already held. A
Feedgen whose `queryLabels` calls are refused, for example because its DID has
no service enrollment covering its boundaries, never opens its feeds.

The cursor records the served boundaries that the Feedgen's enrollment covers.
When a boundary joins that set, the Feedgen reads the label log again from the
start, and feeds stay closed until that read catches up.

Reads close again once five poll intervals, which is 50 seconds, pass without
the cursor catching up. A separate task enforces this, so it holds while a poll
is still running, when polls keep stopping at their page limit, and when the
polling task has died. A takedown is therefore served for at most 50 seconds
after the authority records it. Reads reopen without a restart once the log is
reachable and the cursor has caught up again. A page that advances the cursor
but does not reach the head does not reopen them.

A taken-down account loses its posts, its sync position and its viewer
authorization, and its sync worker stops. A replayed `enroll` or a staged space
page does not re-admit it while the takedown stands. A taken-down record is
removed and its cached blobs are evicted. A later update, replay or staged page
does not re-admit it.
