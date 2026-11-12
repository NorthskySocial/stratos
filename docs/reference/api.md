---
audience: App developers and service developers
type: Reference
status: current
---

# API methods

This page lists the XRPC methods that the Stratos service serves, the
authentication each accepts, and the errors each returns.

## Authentication

| Name             | Headers                                                                                    | Who uses it                                                          |
| ---------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| DPoP             | `Authorization: DPoP <access_token>` and `DPoP: <proof>`                                   | A user's AT Protocol OAuth session                                   |
| Optional DPoP    | The same, or no `Authorization` header                                                     | Anonymous callers are allowed, and see no private data               |
| Service JWT      | `Authorization: Bearer <service-jwt>`                                                      | Another service, such as the feed generator                          |
| Space credential | `Authorization: Atproto-Space <credential>` with HTTP signature, or the legacy `DPoP` form | A syncing service or app with a credential from `getSpaceCredential` |
| Admin            | A server-side session cookie                                                               | Operators                                                            |

Stratos does not accept `Authorization: Bearer <access_token>` from a user.
A user request without a DPoP proof answers `401 AuthenticationRequired`.

When Stratos needs a fresh DPoP nonce, it answers 401 with a `DPoP-Nonce`
header. Repeat the request with that nonce. OAuth client libraries do this
for you.

## Error format

Every XRPC error has this body:

```json
{ "error": "RecordNotFound", "message": "Record not found" }
```

Match on `error`. Most errors answer HTTP 400, including `RecordNotFound`.
[Error codes](/reference/errors) lists every error and its status.

## Method index

### Repo methods

These serve `stratos` custody. Stratos hosts the repo.

| Method                             | Type      | Auth                               |
| ---------------------------------- | --------- | ---------------------------------- |
| `com.atproto.repo.createRecord`    | procedure | DPoP                               |
| `com.atproto.repo.deleteRecord`    | procedure | DPoP                               |
| `com.atproto.repo.applyWrites`     | procedure | DPoP                               |
| `com.atproto.repo.uploadBlob`      | procedure | DPoP                               |
| `zone.stratos.repo.uploadBlob`     | procedure | DPoP                               |
| `com.atproto.repo.getRecord`       | query     | Optional DPoP                      |
| `com.atproto.repo.listRecords`     | query     | Optional DPoP                      |
| `com.atproto.repo.describeRepo`    | query     | None                               |
| `zone.stratos.repo.hydrateRecord`  | query     | Optional DPoP, or space credential |
| `zone.stratos.repo.hydrateRecords` | procedure | Optional DPoP, or space credential |

### Sync methods

| Method                               | Type         | Auth                                 |
| ------------------------------------ | ------------ | ------------------------------------ |
| `zone.stratos.sync.getRepo`          | query        | DPoP, repo owner only                |
| `com.atproto.sync.getBlob`           | query        | Optional DPoP                        |
| `zone.stratos.sync.getBlob`          | query        | Optional DPoP                        |
| `zone.stratos.sync.listRepoOps`      | query        | Service JWT, or space credential     |
| `zone.stratos.sync.listRecordPaths`  | query        | Service JWT, or space credential     |
| `zone.stratos.sync.listBoundaries`   | query        | Service JWT from an enrolled service |
| `zone.stratos.sync.subscribeRecords` | subscription | Service JWT                          |

### Space methods

| Method                                  | Type      | Auth                                                    |
| --------------------------------------- | --------- | ------------------------------------------------------- |
| `zone.stratos.space.getSpaceCredential` | procedure | DPoP, or a delegation token                             |
| `zone.stratos.space.getRecord`          | query     | DPoP (space member), or space credential                |
| `zone.stratos.space.listBlobs`          | query     | DPoP (space member), or space credential                |
| `zone.stratos.space.listRepos`          | query     | Service JWT, or space credential. Never a user session. |

### Enrollment, identity, and server methods

| Method                                     | Type      | Auth          |
| ------------------------------------------ | --------- | ------------- |
| `zone.stratos.enrollment.status`           | query     | Optional DPoP |
| `zone.stratos.enrollment.unenroll`         | procedure | DPoP          |
| `zone.stratos.identity.resolveEnrollments` | query     | None          |
| `zone.stratos.identity.getKeyHistory`      | query     | None          |
| `zone.stratos.server.listDomains`          | query     | None          |
| `zone.stratos.server.listRooms`            | query     | None          |

`zone.stratos.admin.*` methods need an admin session. The
[Operator Guide](/operator/overview) covers them.

### Not served by Stratos

| Method                         | Note                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `com.atproto.repo.putRecord`   | Use an `update` action in `applyWrites`.                                             |
| `com.atproto.sync.getRecord`   | Removed. Stratos serves no single-record proof.                                      |
| `zone.stratos.repo.importRepo` | A lexicon exists. No handler is registered.                                          |
| `zone.stratos.feedgen.*`       | Served by the feed generator. See [Private Feed Attachments](/client/feedgen-blobs). |
| `com.atproto.space.*`          | Served by a spaces-capable PDS, for `pds` custody.                                   |

## Records

### Create Record

```http
POST /xrpc/com.atproto.repo.createRecord
Authorization: DPoP <access_token>
DPoP: <proof>
Content-Type: application/json

{
  "repo": "<user-did>",
  "collection": "zone.stratos.feed.post",
  "record": { ... }
}
```

Returns `{ "uri": "...", "cid": "..." }`. Optional body fields: `rkey` and
`validate`. `repo` must equal the caller's DID. The collection must start
with `zone.stratos.`.

### Delete Record

```http
POST /xrpc/com.atproto.repo.deleteRecord
Authorization: DPoP <access_token>
DPoP: <proof>
Content-Type: application/json

{
  "repo": "<user-did>",
  "collection": "zone.stratos.feed.post",
  "rkey": "<record-key>"
}
```

### Apply Writes

```http
POST /xrpc/com.atproto.repo.applyWrites
Authorization: DPoP <access_token>
DPoP: <proof>
Content-Type: application/json

{
  "repo": "<user-did>",
  "writes": [
    {
      "action": "create",
      "collection": "zone.stratos.feed.post",
      "record": { ... }
    },
    {
      "action": "update",
      "collection": "zone.stratos.feed.post",
      "rkey": "<tid>",
      "record": { ... }
    },
    {
      "action": "delete",
      "collection": "zone.stratos.feed.post",
      "rkey": "<tid>"
    }
  ]
}
```

Each write is `{ action, collection, rkey, record }`. This is not the
upstream `$type` and `value` shape.

### Get Record

```http
GET /xrpc/com.atproto.repo.getRecord?repo=<did>&collection=<collection>&rkey=<rkey>[&cid=<cid>]
Authorization: DPoP <access_token>
DPoP: <proof>
```

Returns `{ "uri": "...", "cid": "...", "value": { ... } }`. A missing record
and a record the viewer may not read both answer `400 RecordNotFound`.

### List Records

```http
GET /xrpc/com.atproto.repo.listRecords?repo=<did>&collection=<collection>[&limit=<n>][&cursor=<c>][&reverse=true]
Authorization: DPoP <access_token>
DPoP: <proof>
```

Returns `{ "records": [...], "cursor": "..." }`. The default `limit` is 50.
Stratos filters by boundary after paging, so a page can be shorter than
`limit`.

### Describe Repo

```http
GET /xrpc/com.atproto.repo.describeRepo?repo=<did>
```

No authentication. Answers `RepoNotFound` when Stratos hosts no repo for the
DID.

### Hydrate Record

```http
GET /xrpc/zone.stratos.repo.hydrateRecord?uri=<at-uri>[&cid=<cid>]
Authorization: DPoP <access_token>
DPoP: <proof>
```

Returns `{ uri, cid, value }`. Answers `400 RecordNotFound` or
`400 RecordBlocked`.

### Hydrate Records (Batch)

```http
POST /xrpc/zone.stratos.repo.hydrateRecords
Authorization: DPoP <access_token>
DPoP: <proof>
Content-Type: application/json

{
  "uris": ["at://did:plc:user1/zone.stratos.feed.post/tid1"]
}
```

Returns:

```json
{
  "records": [{ "uri": "...", "cid": "...", "value": { ... } }],
  "notFound": ["at://..."],
  "blocked": ["at://..."]
}
```

At most 100 URIs. `value` is the stored record. Stratos adds no `source`
field.

## Blobs

### Upload Blob

```http
POST /xrpc/com.atproto.repo.uploadBlob
Authorization: DPoP <access_token>
DPoP: <proof>
Content-Type: <mime-type>

<blob-data>
```

Returns `{ "blob": BlobRef }`. `zone.stratos.repo.uploadBlob` is the same
handler under a Stratos name.

### Get Blob

```http
GET /xrpc/com.atproto.sync.getBlob?did=<did>&cid=<cid>
Authorization: DPoP <access_token>
DPoP: <proof>
```

Returns the blob bytes. `zone.stratos.sync.getBlob` is the same handler.
Errors: `BlobBlocked`, `RepoNotFound`, `BlobNotFound`.

## Spaces

### Get Space Record

```http
GET /xrpc/zone.stratos.space.getRecord?space=<at-uri>&repo=<did>&collection=<nsid>&rkey=<rkey>
Authorization: DPoP <access_token> | Atproto-Space <space-credential> | DPoP <space-credential>
DPoP: <proof>   (user sessions and legacy cnf.jkt credentials)
Response: { "uri": "...", "cid": "...", "value": { ... } }
```

Get a single record from a permissioned space (spec-shaped mirror of
`com.atproto.space.getRecord`). Callable with standard user auth - the caller
must be a member of the space - or with a space credential for that space (for
syncing services). Standard `cnf.kid` credentials use `Atproto-Space` with HTTP
signatures as described under Get Space Credential. A legacy credential is
DPoP-key-bound (`cnf.jkt`): present it
under the `DPoP` scheme with a per-request proof signed by the bound key and
hash-bound to the credential (`ath`). The record must belong to the requested
space; records outside it (including records with no space) resolve to
`RecordNotFound`.

This method reads records that Stratos hosts. It does not read a
`pds`-custody user's PDS.

### List Space Blobs

```http
GET /xrpc/zone.stratos.space.listBlobs?space=<at-uri>&repo=<did>[&since=<rev>][&limit=<n>][&cursor=<cursor>]
Authorization: DPoP <access_token> | Atproto-Space <space-credential> | DPoP <space-credential>
DPoP: <proof>   (user sessions and legacy cnf.jkt credentials)
Response: { "cids": ["..."], "cursor": "..." }
```

List the CIDs of blobs referenced by an account's records within a permissioned
space (spec-shaped mirror of `com.atproto.space.listBlobs`). The same access
rules as Get Space Record apply: standard user auth requires space membership, or
a space credential for that space. `limit` is 1-1000 (default 500); a `cursor`
is returned when a page is full.

### List Space Repos

```http
GET /xrpc/zone.stratos.space.listRepos?space=<at-uri>[&limit=<n>][&cursor=<cursor>]
Authorization: Bearer <service-jwt> | Atproto-Space <space-credential>
Response: { "repos": [{ "did": "...", "custody": "...", "rev": "...", "host": "...", "hostSource": "..." }], "cursor": "..." }
```

Lists the members of a space. `limit` is 1-1000 (default 100). `custody` is
`stratos` or `pds`. `host` is the resolved repo host and `hostSource` is
`authority-override` or `did-document`; both are absent when resolution
fails. `rev` is present for `stratos` custody. A user session is never
accepted.

### Get Space Credential

```http
POST /xrpc/zone.stratos.space.getSpaceCredential
Authorization: DPoP <access_token>
DPoP: <proof>
Content-Type: application/json
Body: { "space": "at://<space-did>/space/<type>/<skey>"[, "delegationToken": "<jwt>"][, "clientAttestation": "<jwt>"] }
Response: { "credential": "<jwt>", "expiresAt": "<datetime>" }
```

Issues a multi-use space credential (JWT) for a space the caller is a member of. Identity
comes from the delegation token when supplied, otherwise from the DPoP session; membership
is checked live against the enrollment store. Spaces configured with an app allow-list
additionally require a valid client attestation whose attested `client_id` is listed. The
credential is bound to the caller's DPoP key (`cnf.jkt`, RFC 9449): on the delegation path
the key comes from a standalone DPoP proof in the `DPoP` header, otherwise from the session
proof key. When no key is available the request fails with `ProofRequired` (unbound
credentials are minted only in development mode). The credential is then accepted on
read/sync endpoints as an alternative to standard auth, presented under the `DPoP` scheme
with a fresh proof per request.

The additive standard profile uses the same custom procedure:

```http
POST /xrpc/zone.stratos.space.getSpaceCredential
Authorization: Bearer <delegation JWT>
Signature-Input: atproto-space=("authorization");keyid="<P-256 did:key>"
Signature: atproto-space=:<base64 compact signature>:
Content-Type: application/json
Body: { "space": "at://<authority-did>/space/<type>/<skey>" }
```

Do not combine HTTP signatures with a DPoP proof. Standard credentials bind
`cnf.kid` and use a separate default-600/max-3600-second TTL. Legacy session,
body-delegation, and Bearer-delegation-plus-DPoP minting remain supported with
their existing TTL configuration, default 7200 seconds.

For standard reads, send `Authorization: Atproto-Space <credential JWT>` and
sign exactly `authorization` then `atproto-space-audience`. Set
`Atproto-Space-Audience` to the actual repo owner's DID, not its host, for repo
operations. Use the bare authority DID for `zone.stratos.space.listRepos`.
The same signature is reusable for the same credential and audience until
expiry. Failed standard verification never falls back to legacy verification.
Keep each cached credential paired with its original key and transport profile;
renew both together. Ordinary OAuth DPoP remains unchanged.

This does not add an upstream `com.atproto.space.*` authority endpoint.
Member removal prevents renewal but does not automatically revoke credentials
already accepted by a foreign PDS. See the
[compatibility and rollout limits](/operator/upgrades/october-spaces).

## Export

### Export Repository

```http
GET /xrpc/zone.stratos.sync.getRepo?did=<did>[&since=<rev>]
Authorization: DPoP <access_token>
DPoP: <proof>
Response: application/vnd.ipld.car
```

Returns a full CAR of the repo: all record blocks, MST nodes, and the signed
commit. `did` must equal the caller's DID. Any other DID answers
`400 RepoNotFound`.

## Enrollment and discovery

### Check Enrollment

```http
GET /xrpc/zone.stratos.enrollment.status?did=<user-did>
```

Unauthenticated, enrolled DID: returns `{ did, enrolled: true, active, enrolledAt, signingKey, enrollmentRkey }`.  
Unauthenticated, not-enrolled DID: returns `{ did, enrolled: false, eligible }` — `eligible: true`
means the DID may enroll but has not yet done so (no enrollment row, record writes are denied).
`eligible` is omitted when the eligibility check cannot complete (for example, DID resolution
fails); do not treat an absent `eligible` as a denial.  
Authenticated: also returns boundaries for enrolled DIDs, plus a fresh attestation when the DID
has at least one boundary.

### Unenroll

```http
POST /xrpc/zone.stratos.enrollment.unenroll
Authorization: DPoP <access_token>
DPoP: <proof>
Content-Type: application/json

{}
```

Returns `{ "success": true }`. Deletes the enrollment, the Stratos-hosted
records, the signing key, and the enrollment record on the user's PDS.

### Resolve Enrollments

```http
GET /xrpc/zone.stratos.identity.resolveEnrollments?did=<did>
Response: { "did": "...", "enrolled": true, "boundaries": ["did:web:stratos.example.com/general"] }
```

No authentication. `boundaries` is empty when the DID is not enrolled.

### List Domains

```http
GET /xrpc/zone.stratos.server.listDomains
Response: { "domains": ["did:web:stratos.example.com/general"] }
```

No authentication. Returns every boundary on the service.

### List Rooms

```http
GET /xrpc/zone.stratos.server.listRooms
Response: { "rooms": [{ "id": "...", "boundary": "...", "displayName": "...", "description": "...", "available": true }] }
```

No authentication. Returns the boundaries that the operator lists publicly.

### Get Key History

```http
GET /xrpc/zone.stratos.identity.getKeyHistory
```

No authentication. Returns the signed history of the service's signing keys.
`verifyEnrollmentAttestation` reads it to check an attestation from a retired
key.

## Sync for services

### Subscribe Records

```http
GET /xrpc/zone.stratos.sync.subscribeRecords[?did=<did>][&cursor=<seq>][&domain=<boundary>]
Authorization: Bearer <service-jwt>
```

A WebSocket stream of Stratos-hosted record changes. Messages are `#commit`,
`#enrollment`, and `#info`. A cursor ahead of the newest event resumes from
the newest event. A cursor older than the kept events receives an
`OutdatedCursor` info message. A user session is not accepted.

### Pull Sync: List Repo Operations

```http
GET /xrpc/zone.stratos.sync.listRepoOps?did=<did>[&since=<rev>][&limit=<n>][&cursor=<c>][&excludeValues=true]
Authorization: Bearer <service-jwt> | Atproto-Space <space-credential>
```

Incremental pull sync of a repo's operation log, mirroring `com.atproto.space.listRepoOps`
semantics. Returns record operations after the `since` revision, boundary-gated to the
caller's enrolled boundaries, with current record values inlined by default. Each op carries
required-nullable `cid` and `prev` fields: `cid` null means delete, `prev` null means create
(or that the superseded value predates the returned window). The response reaches the head
of the oplog when `cursor` is absent; the repo's current signed commit is then included
(unless the repo has no commits yet), consistent with the ops returned. If a concurrent
write is detected, the response instead carries a cursor with no commit. Such a response can
carry no ops and repeat the cursor you sent, so poll again while a cursor is present, and do
not read an unchanged cursor as a stall. Under continuous writes the head may never be
reached. A write that commits after the head probe is not detected; it falls outside this
snapshot and arrives on a later poll. `cursor` takes precedence over `since` when both are
supplied. The `OplogTruncated` error (stricter than upstream, which silently restarts) means
the oplog cannot serve your position truthfully - fall back to full-state recovery below. It
is returned when the cursor is malformed, predates retained history (compaction passed it),
or names a seq beyond retained history (e.g. after a log reset); when `since` falls outside
the retained `[oldest, newest]` rev window or that window cannot be verified; and when a
retained op cannot be emitted truthfully (a non-delete op without a cid, or a record key
that fails the record-key format).

### Pull Sync: List Record Paths (Full-State Recovery)

```http
GET /xrpc/zone.stratos.sync.listRecordPaths?did=<did>[&collection=<nsid>][&limit=<n>][&cursor=<c>][&excludeValues=true]
Authorization: Bearer <service-jwt> | Atproto-Space <space-credential>
```

Enumerates a repo's record paths with their current CIDs (values inlined by default),
boundary-gated. Use this as the fallback when `listRepoOps` returns `OplogTruncated`:
enumerate paths, diff locally, and fetch misses.

## Record Types

### zone.stratos.feed.post

```typescript
interface StratosFeedPost {
  $type: 'zone.stratos.feed.post'
  text: string // Max 300 graphemes
  boundary: Boundary // Required for Stratos-hosted records
  createdAt: string // Required, ISO datetime
  facets?: Facet[] // Rich text annotations
  reply?: ReplyRef // Root and parent must be Stratos posts
  embed?: Embed // zone.stratos.embed.images, or an app.bsky.embed type
  langs?: string[] // Language tags, max 3
  labels?: SelfLabels // Content warnings
  tags?: string[] // Additional hashtags, max 8
}

interface Boundary {
  $type: 'zone.stratos.boundary.defs#Domains'
  values: [Domain] // Exactly one
}

interface Domain {
  $type: 'zone.stratos.boundary.defs#Domain'
  value: string // '{serviceDid}/{name}', max 253 chars
}
```

A record in a space on a user's PDS carries no `boundary`. The space names it.

### zone.stratos.embed.images

```typescript
interface StratosEmbedImages {
  $type: 'zone.stratos.embed.images'
  images: Image[] // Max 4
}

interface Image {
  image: BlobRef
  alt: string
  aspectRatio?: { width: number; height: number }
}
```

## Error codes

Every error name, with its status and meaning, is in
[Error codes](/reference/errors).
