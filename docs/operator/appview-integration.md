# AppView Integration

AppViews index Stratos content by subscribing to the `zone.stratos.sync.subscribeRecords` WebSocket
endpoint — similar to how AppViews subscribe to PDS firehoses, but scoped per-user.

## Step 1: Service Authentication

AppViews authenticate using **service auth** — a signed JWT passed in the `Authorization: Bearer`
header of the WebSocket upgrade request. Server-side WebSocket clients (such as the `ws` library)
can set request headers, so no query-parameter fallback is needed or accepted.

The subscription stream is **boundary-scoped**: the service is only sent records whose boundaries
intersect the boundaries the service itself is enrolled in. A service that is not enrolled in any
boundary is rejected. Mint the JWT with the `zone.stratos.sync.subscribeRecords` lexicon method as
its audience-bound `lxm`.

```typescript
import { createServiceJwt } from '@atproto/xrpc-server'

async function mintServiceJwt(
  appviewDid: string,
  stratosServiceDid: string,
  signingKey: Keypair,
): Promise<string> {
  // Mint a fresh token for every connection — tokens are short-lived.
  return createServiceJwt({
    iss: appviewDid,
    aud: stratosServiceDid,
    lxm: 'zone.stratos.sync.subscribeRecords',
    keypair: signingKey,
  })
}
```

> The service DID and signing key must be registered with the Stratos service as a
> service enrollment before the subscription will be accepted. See
> [Service Enrollment Setup](#service-enrollment-setup) below.

## Service Enrollment Setup

Before a service can subscribe, the Stratos operator must register its DID and grant it
boundaries. Service enrollments are config-driven and reconciled into the store on every
Stratos boot. A service is only streamed records whose boundaries intersect the boundaries
granted here; a service with no boundaries is rejected.

Provide enrollments either inline via `STRATOS_SERVICE_ENROLLMENTS` (a JSON array) or via a
file path with `STRATOS_SERVICE_ENROLLMENTS_FILE`. Each entry is `{ did, boundaries }`, where
`boundaries` are bare boundary names (auto-qualified against the service DID) and must be a
subset of the service's `allowedDomains`.

```json
[
  { "did": "did:web:bsky.example.com", "boundaries": ["engineering", "leadership"] },
  { "did": "did:web:indexer.example.com", "boundaries": ["engineering"] }
]
```

The reconciler upserts these rows as service enrollments (`isService = true`), updates their
boundaries, and prunes any service row no longer present in the config. The service must use
the matching signing key (resolvable from its `did`) to mint the JWT in Step 1.

## Step 2: Subscribe to User Records

```typescript
import WebSocket from 'ws'

async function subscribeToUser(
  appviewDid: string,
  stratosServiceDid: string,
  signingKey: Keypair,
  did: string,
  cursor?: number,
) {
  const serviceJwt = await mintServiceJwt(
    appviewDid,
    stratosServiceDid,
    signingKey,
  )

  const url = new URL(
    'wss://stratos.example.com/xrpc/zone.stratos.sync.subscribeRecords',
  )
  url.searchParams.set('did', did)
  if (cursor !== undefined) url.searchParams.set('cursor', cursor.toString())

  const ws = new WebSocket(url.toString(), {
    headers: { Authorization: `Bearer ${serviceJwt}` },
  })

  ws.on('message', async (data) => {
    const frame = decodeFrame(data)

    if (frame.$type === 'zone.stratos.sync.subscribeRecords#commit') {
      for (const op of frame.ops) {
        if (op.action === 'create' || op.action === 'update') {
          await indexRecord(frame.did, op.path, op.record)
        } else if (op.action === 'delete') {
          await deleteRecord(frame.did, op.path)
        }
      }
      await saveCursor(did, frame.seq)
    }
  })
}
```

## Step 3: Index with Boundary Metadata

Store boundary domains with each record for filtering:

```typescript
async function indexRecord(did: string, path: string, record: unknown) {
  const [collection, rkey] = path.split('/')
  const uri = `at://${did}/${collection}/${rkey}`
  const boundary = record.boundary?.values?.map((d) => d.value) ?? []

  await db
    .insertInto('stratos_posts')
    .values({
      uri,
      did,
      collection,
      rkey,
      text: record.text,
      boundary_domains: JSON.stringify(boundary),
      created_at: record.createdAt,
      indexed_at: new Date().toISOString(),
    })
    .onConflict((oc) =>
      oc.column('uri').doUpdateSet({
        text: record.text,
        boundary_domains: JSON.stringify(boundary),
      }),
    )
    .execute()
}
```

## Step 4: Query with Boundary Filtering

When serving content, filter by the viewer's domain membership. The AppView should only return records where at least one of the record's boundaries matches one of the viewer's enrolled boundaries.

### SQL Implementation (PostgreSQL)

Using the `stratos_posts` table indexed in Step 3, you can perform boundary-aware filtering using PostgreSQL's JSONB operators or a separate join table.

#### Option A: JSONB Overlap

If you stored boundaries as a JSONB array:

```sql
SELECT * FROM stratos_posts
WHERE did = $1 -- author DID
  AND (
    -- Viewer shares at least one boundary
    boundary_domains ?| $2 -- array of viewer's enrolled domains
  )
ORDER BY created_at DESC;
```

#### Option B: Join Table (Recommended for Performance)

For better performance at scale, use a separate `stratos_post_boundaries` table:

```sql
-- Schema
CREATE TABLE stratos_post_boundaries (
  uri TEXT NOT NULL,
  boundary TEXT NOT NULL,
  PRIMARY KEY (uri, boundary)
);

-- Query
SELECT p.* FROM stratos_posts p
JOIN stratos_post_boundaries b ON p.uri = b.uri
WHERE p.did = $1
  AND b.boundary = ANY($2) -- array of viewer's enrolled domains
ORDER BY p.created_at DESC;
```

### Feed Integration

When building a unified feed (e.g., `app.bsky.feed.getTimeline`), you can mix public PDS records with private Stratos records:

```typescript
async function getUnifiedFeed(viewerDid: string, viewerDomains: string[]) {
  const posts = await db
    .selectFrom('posts')
    .leftJoin('stratos_posts', 'posts.uri', 'stratos_posts.uri')
    .where((eb) =>
      eb.or([
        // Public posts (not in Stratos)
        eb('stratos_posts.uri', 'is', null),
        // Private posts with boundary overlap
        eb('stratos_posts.boundary_domains', '?|', viewerDomains),
      ]),
    )
    .orderBy('posts.createdAt', 'desc')
    .limit(50)
    .execute()

  return posts
}
```

## Step 5: Hydration

AppViews should verify the integrity of Stratos records during hydration.

```typescript
async function hydrateRecord(stub: RecordStub, viewerDomains: string[]) {
  // 1. Fetch from Stratos
  const record = await stratosClient.com.atproto.repo.getRecord({
    repo: stub.did,
    collection: stub.collection,
    rkey: stub.rkey,
  })

  // 2. Verify CID integrity
  if (record.cid !== stub.source.subject.cid) {
    throw new Error('Record integrity verification failed.')
  }

  // 3. (Optional) Verify service attestation
  // See architecture/attestation.md
}
```

## Step 5: Determine Viewer's Domains

The AppView needs to know what domains a viewer belongs to.

**Option A — Index from Stratos posts:**

```typescript
async function getViewerDomains(viewerDid: string): Promise<string[]> {
  const result = await db
    .selectFrom('stratos_posts')
    .select('boundary_domains')
    .where('did', '=', viewerDid)
    .execute()

  const domains = new Set<string>()
  for (const row of result) {
    for (const domain of JSON.parse(row.boundary_domains)) {
      domains.add(domain)
    }
  }
  return [...domains]
}
```

**Option B — Community registry lookup:** Query a community service for verified domain membership.

## Complete Indexer Example

```typescript
class StratosIndexer {
  private cursors = new Map<string, number>()

  constructor(
    private db: Kysely<AppViewDb>,
    private stratosEndpoint: string,
    private appviewDid: string,
    private stratosServiceDid: string,
    private signingKey: Keypair,
  ) {}

  async startIndexing(enrolledDids: string[]) {
    for (const did of enrolledDids) {
      const cursor = await this.loadCursor(did)
      this.subscribeToUser(did, cursor)
    }
  }

  private async subscribeToUser(did: string, cursor?: number) {
    // Mint a fresh JWT on every connection.
    const serviceJwt = await createServiceJwt({
      iss: this.appviewDid,
      aud: this.stratosServiceDid,
      lxm: 'zone.stratos.sync.subscribeRecords',
      keypair: this.signingKey,
    })

    const url = new URL(
      `${this.stratosEndpoint}/xrpc/zone.stratos.sync.subscribeRecords`,
    )
    url.searchParams.set('did', did)
    if (cursor !== undefined) url.searchParams.set('cursor', cursor.toString())

    const ws = new WebSocket(url.toString(), {
      headers: { Authorization: `Bearer ${serviceJwt}` },
    })

    ws.on('message', async (data) => {
      const event = this.decodeEvent(data)

      if (event.$type === 'zone.stratos.sync.subscribeRecords#info') {
        if (event.name === 'OutdatedCursor') {
          this.cursors.delete(did)
        }
        return
      }

      if (event.$type === 'zone.stratos.sync.subscribeRecords#commit') {
        await this.db.transaction().execute(async (tx) => {
          for (const op of event.ops) {
            await this.processOp(tx, event.did, op)
          }
          await this.saveCursor(tx, event.did, event.seq)
        })
        this.cursors.set(did, event.seq)
      }
    })

    ws.on('close', () => {
      // Reconnect with a fresh token after a short delay.
      setTimeout(() => this.subscribeToUser(did, this.cursors.get(did)), 5000)
    })
  }
}
```
