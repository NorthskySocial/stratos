# API Reference

## Endpoints

### Create Record

```http
POST /xrpc/com.atproto.repo.createRecord
Authorization: Bearer <access_token>

{
  "repo": "<user-did>",
  "collection": "zone.stratos.feed.post",
  "record": { ... }
}
```

### Get Record

```http
GET /xrpc/com.atproto.repo.getRecord?repo=<did>&collection=<collection>&rkey=<rkey>
Authorization: Bearer <access_token>
```

### Hydrate Record

A single record hydration endpoint that applies boundary-aware filtering.

```http
GET /xrpc/zone.stratos.repo.hydrateRecord?uri=<at-uri>[&cid=<cid>]
Authorization: Bearer <access_token>
```

Returns the record if the viewer is authorized, otherwise throws `RecordNotFound` (404) or `RecordBlocked` (400).

### Hydrate Records (Batch)

Batch hydration for up to 100 records.

```http
POST /xrpc/zone.stratos.repo.hydrateRecords
Authorization: Bearer <access_token>

{
  "uris": ["at://did:plc:user1/collection/tid1", "at://did:plc:user1/collection/tid2"]
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

### Apply Writes (Batch)

Batch create/update/delete operations.

```http
POST /xrpc/com.atproto.repo.applyWrites
Authorization: Bearer <access_token>

{
  "repo": "<user-did>",
  "writes": [
    {
      "action": "create",
      "collection": "zone.stratos.feed.post",
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

### List Records

```http
GET /xrpc/com.atproto.repo.listRecords?repo=<did>&collection=<collection>&limit=50
Authorization: Bearer <access_token>
```

### Upload Blob

Upload a blob to the repository.

```http
POST /xrpc/com.atproto.repo.uploadBlob
Authorization: Bearer <access_token>
Content-Type: * /* (binary)

<blob-data>
```

Returns: `{ blob: BlobRef }`

Stratos-specific alias (preferred for boundary filtering on some implementations):

```http
POST /xrpc/zone.stratos.repo.uploadBlob
Authorization: Bearer <access_token>
Content-Type: * /* (binary)

<blob-data>
```

### Get Blob

Fetch a blob from an actor's repository. Requires the viewer to have access to at least one record referencing this blob.

```http
GET /xrpc/com.atproto.sync.getBlob?did=<did>&cid=<cid>
Authorization: Bearer <access_token>
```

Returns: `* /*` (binary content)

Stratos-specific alias (guarantees boundary-aware access control):

```http
GET /xrpc/zone.stratos.sync.getBlob?did=<did>&cid=<cid>
Authorization: Bearer <access_token>
```

### Delete Record

```http
POST /xrpc/com.atproto.repo.deleteRecord
Authorization: Bearer <access_token>

{
  "repo": "<user-did>",
  "collection": "zone.stratos.feed.post",
  "rkey": "<record-key>"
}
```

### Get Space Record

```http
GET /xrpc/zone.stratos.space.getRecord?space=<at-uri>&repo=<did>&collection=<nsid>&rkey=<rkey>
Authorization: Bearer <access_token> | DPoP <space-credential>
DPoP: <proof>   (required when presenting a space credential)
Response: { "uri": "...", "cid": "...", "value": { ... } }
```

Get a single record from a permissioned space (spec-shaped mirror of
`com.atproto.space.getRecord`). Callable with standard user auth - the caller
must be a member of the space - or with a space credential for that space (for
syncing services). A space credential is DPoP-key-bound (`cnf.jkt`): present it
under the `DPoP` scheme with a per-request proof signed by the bound key and
hash-bound to the credential (`ath`). The record must belong to the requested
space; records outside it (including records with no space) resolve to
`RecordNotFound`.

### List Space Blobs

```http
GET /xrpc/zone.stratos.space.listBlobs?space=<at-uri>&repo=<did>[&since=<rev>][&limit=<n>][&cursor=<cursor>]
Authorization: Bearer <access_token> | DPoP <space-credential>
DPoP: <proof>   (required when presenting a space credential)
Response: { "cids": ["..."], "cursor": "..." }
```

List the CIDs of blobs referenced by an account's records within a permissioned
space (spec-shaped mirror of `com.atproto.space.listBlobs`). Same admission
contract as Get Space Record: standard user auth requires space membership, or
a space credential for that space. `limit` is 1-1000 (default 500); a `cursor`
is returned when a page is full.

### Export Repository

```http
GET /xrpc/zone.stratos.sync.getRepo?did=<did>[&since=<rev>]
Authorization: Bearer <access_token>
Response: application/vnd.ipld.car
```

Returns a full CAR of the repo: all record blocks, MST nodes, and the signed commit.

### Import Repository

```http
POST /xrpc/zone.stratos.repo.importRepo
Authorization: Bearer <access_token>
Content-Type: application/vnd.ipld.car
Response: { "imported": <count> }
```

### Check Enrollment

```http
GET /xrpc/zone.stratos.enrollment.status?did=<user-did>
```

Unauthenticated: returns `{ enrolled: true/false }`.  
Authenticated: also returns boundaries, signing key, enrollment rkey, and a fresh attestation.

### Pull Sync: List Repo Operations

```http
GET /xrpc/zone.stratos.sync.listRepoOps?did=<did>[&since=<rev>][&limit=<n>][&cursor=<c>][&excludeValues=true]
Authorization: Bearer <service-jwt>
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
Authorization: Bearer <service-jwt>
```

Enumerates a repo's record paths with their current CIDs (values inlined by default),
boundary-gated. Use this as the fallback when `listRepoOps` returns `OplogTruncated`:
enumerate paths, diff locally, and fetch misses.

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

## Record Types

### zone.stratos.feed.post

```typescript
interface AppStratosFeedPost {
  $type: 'zone.stratos.feed.post'
  text: string // Required, max 300 chars
  boundary: Boundary // Required
  createdAt: string // Required, ISO datetime
  facets?: Facet[] // Rich text annotations
  reply?: ReplyRef // If this is a reply
  embed?: Embed // Images, video, external links
  langs?: string[] // Language tags, max 3
  labels?: SelfLabels // Content warnings
  tags?: string[] // Additional hashtags, max 8
}

interface Boundary {
  $type: 'zone.stratos.boundary.defs#Domains'
  values: Domain[] // Max 10 domains
}

interface Domain {
  $type: 'zone.stratos.boundary.defs#Domain'
  value: string // Qualified boundary: '{serviceDid}/{name}', max 253 chars
}
```

## Error Codes

| Error                 | Description                                                       |
| --------------------- | ----------------------------------------------------------------- |
| `NotEnrolled`         | User hasn't enrolled with this Stratos service                    |
| `InvalidCollection`   | Collection is not a valid stratos namespace                       |
| `InvalidRecord`       | Record failed validation (e.g., missing boundary)                 |
| `RecordNotFound`      | Record doesn't exist or user doesn't have access                  |
| `RecordBlocked`       | Viewer blocked by boundary (for `hydrateRecord`)                  |
| `AuthRequired`        | Endpoint requires authentication                                  |
| `InvalidCar`          | CAR file is malformed or fails CID integrity                      |
| `RepoAlreadyExists`   | Target repo already has a commit (import blocked)                 |
| `TooManyUris`         | Too many URIs in batch request (max 100)                          |
| `OplogTruncated`      | `since` predates retained oplog history (use full-state recovery) |
| `RepoNotFound`        | Requested repo does not exist (sync endpoints)                    |
| `InvalidToken`        | Delegation token failed verification or space mismatch            |
| `UnknownSpace`        | Space URI malformed or space DID not this service                 |
| `AttestationRequired` | Space gates on app identity; no valid client attestation supplied |
| `ClientNotAllowed`    | Attested `client_id` not in the space's allow-list                |
