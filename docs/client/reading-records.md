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

AppViews and clients detect the `source` field and hydrate by calling `getRecord` at the service endpoint.

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
When a viewer lacks boundary access, Stratos returns 404 — not 403. Handle `null` returns gracefully without assuming the record is deleted.
:::
