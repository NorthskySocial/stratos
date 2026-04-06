# Reading Records

## The Source Field Pattern

When a record is created in Stratos, two records are written:

1. Full record in Stratos — actual content, boundaries, all fields.
2. Stub record on the user's PDS — `source` field pointing to Stratos.

```json
{
  "$type": "zone.stratos.feed.post",
  "source": {
    "vary": "authenticated",
    "subject": {
      "uri": "at://did:plc:abc/zone.stratos.feed.post/tid123",
      "cid": "bafyreibeef..."
    },
    "service": "did:web:stratos.example.com#atproto_pns"
  },
  "createdAt": "2024-01-15T12:00:00.000Z"
}
```

AppViews and clients detect the `source` field and hydrate by calling `getRecord` at the service
endpoint.

### Batch Hydration

When rendering a feed, AppViews use batch hydration to fetch multiple records efficiently:

```typescript
async function hydrateBatch(
  stratosEndpoint: string,
  accessToken: string,
  uris: string[],
) {
  const response = await fetch(
    `${stratosEndpoint}/xrpc/zone.stratos.repo.hydrateRecords`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ uris }),
    },
  )

  const result = await response.json()
  // result = { records: [...], blocked: [...], notFound: [...] }
  return result
}
```

## Using `stratos-client` for Verified Reads

The `fetchAndVerifyRecord()` helper fetches a record with its inclusion proof (CAR) from the Stratos
service and verifies it in a single call. Verification is tiered:

| Level               | What it proves                          | Requires              |
| ------------------- | --------------------------------------- | --------------------- |
| `user-signature`    | User authored the record (strongest)    | User's per-actor key  |
| `service-signature` | Service included the record in its repo | Service's signing key |
| `cid-integrity`     | Data integrity and MST path only        | Nothing (default)     |

```typescript
import {
  fetchAndVerifyRecord,
  resolveServiceSigningKey,
  resolveUserSigningKey,
} from '@northskysocial/stratos-client'

// Resolve keys once and cache them
const serviceKey = await resolveServiceSigningKey('did:web:stratos.example.com')
const userKey = await resolveUserSigningKey(
  pdsUrl,
  did,
  'did:web:stratos.example.com',
)

// Fetch and verify with the strongest available level
const verified = await fetchAndVerifyRecord(serviceUrl, did, collection, rkey, {
  userSigningKey: userKey ?? undefined,
  serviceSigningKey: serviceKey,
})

console.log(verified.level) // 'user-signature' | 'service-signature' | 'cid-integrity'
console.log(verified.record) // the verified record content
```

## Get a Single Record

```typescript
async function getRecord(
  stratosEndpoint: string,
  accessToken: string,
  repo: string,
  collection: string,
  rkey: string,
) {
  const params = new URLSearchParams({ repo, collection, rkey })

  const response = await fetch(
    `${stratosEndpoint}/xrpc/com.atproto.repo.getRecord?${params}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  )

  if (!response.ok) {
    if (response.status === 404) return null
    throw new Error('Failed to get record')
  }

  return response.json()
}
```

## List User's Records

```typescript
async function listRecords(
  stratosEndpoint: string,
  accessToken: string,
  repo: string,
  collection: string,
  limit = 50,
  cursor?: string,
) {
  const params = new URLSearchParams({
    repo,
    collection,
    limit: limit.toString(),
  })
  if (cursor) params.set('cursor', cursor)

  const response = await fetch(
    `${stratosEndpoint}/xrpc/com.atproto.repo.listRecords?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )

  return response.json()
}
```

## Reading via AppView (Hydration)

When reading feeds through an AppView, hydration happens automatically:

1. AppView indexes stubs with `source` fields.
2. When rendering a feed, AppView resolves `source.service` to get the Stratos endpoint.
3. AppView calls `getRecord` at Stratos with the viewer identity.
4. Stratos returns full content if the viewer has boundary access.

```typescript
// AppView handles hydration transparently
const authorFeed = await agent.api.app.bsky.feed.getAuthorFeed({
  actor: authorDid,
})

// For direct client access to Stratos
async function hydrateFromSource(
  source: RecordSource,
  viewerToken: string,
): Promise<Record | null> {
  const endpoint = await resolveServiceEndpoint(source.service)
  const { repo, collection, rkey } = parseAtUri(source.subject.uri)

  const response = await fetch(
    `${endpoint}/xrpc/com.atproto.repo.getRecord?` +
      `repo=${repo}&collection=${collection}&rkey=${rkey}`,
    { headers: { Authorization: `Bearer ${viewerToken}` } },
  )

  if (!response.ok) return null
  return response.json()
}
```

::: tip Access denied looks like 404
When a viewer lacks boundary access, Stratos returns 404 — not 403. Handle `null` returns gracefully
without assuming the record is deleted.
:::

## Read Path Integration Patterns

Views that display records, collections, or repo descriptions need to switch between PDS and Stratos
sources based on the active mode.

### Reactive refetch on mode change

When the Stratos active state changes, refetch data. In React, this translates to including the
active state in a query key:

```typescript
const { data } = useQuery({
  queryKey: ['record', uri, stratosActive],
  queryFn: () => fetchRecord(uri, stratosActive, enrollment),
})
```

### Client reset on mode switch

When Stratos mode toggles, any cached RPC client should be discarded since it may point to the wrong
service. Rather than recreating the client on every fetch, cache the PDS and Stratos clients
separately and select the right one based on mode:

```typescript
import { Client } from '@atcute/client'
import { createServiceFetchHandler } from '@northskysocial/stratos-client'

let pdsClient: Client | null = null
let stratosClient: Client | null = null

const getStratosClient = (
  agent: OAuthUserAgent,
  enrollment: StratosEnrollment,
): Client => {
  if (!stratosClient) {
    stratosClient = new Client({
      handler: createServiceFetchHandler(agent.handle, enrollment.service),
    })
  }
  return stratosClient
}

// On logout or account switch, drop both
const resetClients = () => {
  pdsClient = null
  stratosClient = null
}

const fetchRecords = async () => {
  const client = stratosActive && enrollment
    ? getStratosClient(agent, enrollment)
    : getPdsClient(agent)
  return client.get('com.atproto.repo.listRecords', { params: { ... } })
}
```

Mode toggles now just pick the other cached client — no teardown or reconstruction needed. Call
`resetClients()` on logout or account switch to avoid stale sessions.

### Auth requirement in Stratos mode

Stratos endpoints require authentication. If the user is not signed in, display a clear message
rather than attempting an anonymous fetch:

```typescript
if (stratosActive && !agent) {
  throw new Error('Sign in to view Stratos records')
}
```

### Empty repo handling

Stratos initializes every enrolled user's repository with an empty signed commit at enrollment time.
This means `describeRepo` and `getRepo` will always return a valid (possibly empty) repo for any
enrolled user. A `describeRepo` call against an enrolled user will return an empty `collections`
list until the first record is created — this is normal and should be rendered as an empty state,
not an error.

If Stratos returns `RepoNotFound` for an enrolled user, treat it as a genuine error (service
misconfiguration, auth failure, etc.) rather than an empty repo:

```typescript
if (error.name === 'RepoNotFound' && stratosActive) {
  throw new Error('Stratos repo not found for enrolled user')
}
```

### Blob gating

Stratos supports blob listing via `com.atproto.sync.listBlobs`. Blob content retrieval via
`com.atproto.sync.getBlob` is not yet implemented — gate blob download UI behind availability
checks.
