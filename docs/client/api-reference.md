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
Authorization: Bearer <access_token> | Bearer <space-credential>
Response: { "uri": "...", "cid": "...", "value": { ... } }
```

Get a single record from a permissioned space (spec-shaped mirror of
`com.atproto.space.getRecord`). Callable with standard user auth - the caller
must be a member of the space - or with a space credential for that space (for
syncing services). The record must belong to the requested space; records
outside it (including records with no space) resolve to `RecordNotFound`.

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

Incremental pull sync of a repo's operation log. Returns record operations after the
`since` revision, boundary-gated to the caller's enrolled boundaries, with current record
values inlined by default. When the response reaches the end of the log and no concurrent
write was detected, `caughtUp` is `true` and the repo's current signed commit is included.
If a write lands during the request, the response instead carries `caughtUp: false` and a
cursor with no commit — poll again. Under continuous writes `caughtUp` may stay false
indefinitely, but each poll still delivers ops; it is never falsely `true`. If `since`
predates retained history, the `OplogTruncated` error is returned - fall back to
full-state recovery below.

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
Content-Type: application/json
Body: { "space": "at://<space-did>/space/<type>/<skey>"[, "delegationToken": "<jwt>"][, "clientAttestation": "<jwt>"] }
Response: { "credential": "<jwt>", "expiresAt": "<datetime>" }
```

Issues a multi-use space credential (JWT) for a space the caller is a member of. Identity
comes from the delegation token when supplied, otherwise from the DPoP session; membership
is checked live against the enrollment store. Spaces configured with an app allow-list
additionally require a valid client attestation whose attested `client_id` is listed. The
credential is then accepted on read/sync endpoints as an alternative to standard auth.

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
