# AppView Integration

AppViews index Stratos content by subscribing to the `zone.stratos.sync.subscribeRecords` WebSocket endpoint — similar to how AppViews subscribe to PDS firehoses, but scoped per-user.

## Step 1: Service Authentication

AppViews authenticate using **service auth** — a signed JWT passed as the `syncToken` query parameter. The token must be a query param because `Authorization` headers are stripped by many WebSocket proxies and aren't supported in browser WebSocket APIs.

```typescript
import { createServiceJwt } from '@atproto/xrpc-server'

async function mintSyncToken(
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
  const syncToken = await mintSyncToken(
    appviewDid,
    stratosServiceDid,
    signingKey,
  )

  const url = new URL(
    'wss://stratos.example.com/xrpc/zone.stratos.sync.subscribeRecords',
  )
  url.searchParams.set('did', did)
  url.searchParams.set('syncToken', syncToken)
  if (cursor !== undefined) url.searchParams.set('cursor', cursor.toString())

  const ws = new WebSocket(url.toString())

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

When serving content, filter by the viewer's domain membership:

```typescript
async function getAuthorFeed(authorDid: string, viewerDomains: string[]) {
  return db
    .selectFrom('stratos_posts')
    .where('did', '=', authorDid)
    .where((eb) =>
      eb.or([
        eb('did', '=', viewerDid),
        ...viewerDomains.map((domain) =>
          eb.raw('boundary_domains LIKE ?', [`%"${domain}"%`]),
        ),
      ]),
    )
    .orderBy('created_at', 'desc')
    .limit(50)
    .execute()
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
    const syncToken = await createServiceJwt({
      iss: this.appviewDid,
      aud: this.stratosServiceDid,
      lxm: 'zone.stratos.sync.subscribeRecords',
      keypair: this.signingKey,
    })

    const url = new URL(
      `${this.stratosEndpoint}/xrpc/zone.stratos.sync.subscribeRecords`,
    )
    url.searchParams.set('did', did)
    url.searchParams.set('syncToken', syncToken)
    if (cursor !== undefined) url.searchParams.set('cursor', cursor.toString())

    const ws = new WebSocket(url.toString())

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
