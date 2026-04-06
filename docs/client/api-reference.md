# API Reference

## Endpoints

### Create Record

```
POST /xrpc/com.atproto.repo.createRecord
Authorization: Bearer <access_token>

{
  "repo": "<user-did>",
  "collection": "zone.stratos.feed.post",
  "record": { ... }
}
```

### Get Record

```
GET /xrpc/com.atproto.repo.getRecord?repo=<did>&collection=<collection>&rkey=<rkey>
Authorization: Bearer <access_token>
```

### Hydrate Record

A single record hydration endpoint that applies boundary-aware filtering.

```
GET /xrpc/zone.stratos.repo.hydrateRecord?uri=<at-uri>[&cid=<cid>]
Authorization: Bearer <access_token>
```

Returns the record if the viewer is authorized, otherwise throws `RecordNotFound` (404) or `RecordBlocked` (400).

### Hydrate Records (Batch)

Batch hydration for up to 100 records.

```
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

```
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

```
GET /xrpc/com.atproto.repo.listRecords?repo=<did>&collection=<collection>&limit=50
Authorization: Bearer <access_token>
```

### Delete Record

```
POST /xrpc/com.atproto.repo.deleteRecord
Authorization: Bearer <access_token>

{
  "repo": "<user-did>",
  "collection": "zone.stratos.feed.post",
  "rkey": "<record-key>"
}
```

### Get Record Proof (CAR)

```
GET /xrpc/com.atproto.sync.getRecord?did=<did>&collection=<collection>&rkey=<rkey>
Authorization: Bearer <access_token>
Response: application/vnd.ipld.car
```

Returns a CAR containing the signed commit, MST inclusion proof nodes, and record block.

### Export Repository

```
GET /xrpc/zone.stratos.sync.getRepo?did=<did>[&since=<rev>]
Authorization: Bearer <access_token>
Response: application/vnd.ipld.car
```

Returns a full CAR of the repo: all record blocks, MST nodes, and the signed commit.

### Import Repository

```
POST /xrpc/zone.stratos.repo.importRepo
Authorization: Bearer <access_token>
Content-Type: application/vnd.ipld.car
Response: { "imported": <count> }
```

### Check Enrollment

```
GET /xrpc/zone.stratos.enrollment.status?did=<user-did>
```

Unauthenticated: returns `{ enrolled: true/false }`.  
Authenticated: also returns boundaries, signing key, enrollment rkey, and a fresh attestation.

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

| Error               | Description                                       |
| ------------------- | ------------------------------------------------- |
| `NotEnrolled`       | User hasn't enrolled with this Stratos service    |
| `InvalidCollection` | Collection is not a valid stratos namespace       |
| `InvalidRecord`     | Record failed validation (e.g., missing boundary) |
| `RecordNotFound`    | Record doesn't exist or user doesn't have access  |
| `RecordBlocked`     | Viewer blocked by boundary (for `hydrateRecord`)  |
| `AuthRequired`      | Endpoint requires authentication                  |
| `InvalidCar`        | CAR file is malformed or fails CID integrity      |
| `RepoAlreadyExists` | Target repo already has a commit (import blocked) |
| `TooManyUris`       | Too many URIs in batch request (max 100)          |
