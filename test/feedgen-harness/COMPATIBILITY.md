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
complete. This readiness rule is separate from the legacy mutation race
described below.

Posts are ordered by `sortAt DESC, uri ASC`. A cursor is the literal
`{sortAt}::{uri}` pair. A malformed cursor is treated as no cursor. A page
contains an optional next cursor and `feed` entries retaining URI, CID, record,
author DID, optional author handle, and indexed timestamp. The legacy handler
returns every stored boundary label for a selected post, including labels the
viewer does not hold. That metadata disclosure is a known deviation; the Rust
response filters labels to the viewer's current boundaries. Optional handle
lookup failure leaves the DID usable.

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

The legacy Feed XRPC path does not set an explicit private cache directive on
success or error. The Rust feed and blob paths set `Cache-Control: private,
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
prepared response before its body is released. The legacy feed path only
rechecks readiness and feed-catalogue identity before returning; it lacks that
final authorization-epoch fence. The Rust admission path is required to close
this deviation. The TypeScript durable profile requires
a protected volume, private filesystem modes, and bounded retention, but does
not provide SQLCipher at-rest encryption. A Rust projection must use independent
encrypted state and must never share a writer or database with the TypeScript
projection.

## Known legacy deviations

The legacy implementation normalizes a malformed cursor to the first page and
performs optional author-handle work on the response path. Compatibility tests
preserve the wire outcome while the Rust implementation keeps optional display
metadata outside the authorization-critical path. Neither behavior permits a
partial feed presented as complete because a cursor is malformed or display
metadata is unavailable. Legacy TypeScript can race a later authorization
mutation; Rust closes that race before release. The Rust durable projection
adds encrypted-at-rest storage before it is eligible to replace the legacy
durable path.
