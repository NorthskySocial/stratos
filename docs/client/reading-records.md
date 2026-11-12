---
audience: App developers
type: How-to
status: current
---

# Reading Records

A member of a boundary can read the records in it. Anyone else gets the same
answer as for a record that does not exist. Stratos applies that rule on
every read.

There are three ways to read. Pick by what you need:

| Need                                | Use                                                | Custody covered     |
| ----------------------------------- | -------------------------------------------------- | ------------------- |
| A feed of posts the viewer may read | The feed generator, `zone.stratos.feedgen.getFeed` | `stratos` and `pds` |
| One record you know the URI of      | `com.atproto.repo.getRecord` on Stratos            | `stratos`           |
| Many records by URI                 | `zone.stratos.repo.hydrateRecords` on Stratos      | `stratos`           |

The Stratos read methods serve only records that Stratos hosts. A
`pds`-custody user's posts live on their own PDS. Read those through the feed
generator.

## Who can read a record

| Viewer                                 | Result         |
| -------------------------------------- | -------------- |
| The record owner                       | Always sees it |
| A user who holds the record's boundary | Sees it        |
| A user without the boundary            | Denied         |
| An anonymous caller                    | Denied         |

Read methods accept an anonymous call. They then answer as if no private
record exists. Send the user's DPoP session to read private records.

## Reading a feed

The feed generator collects posts from Stratos and from member PDS spaces. It
checks the viewer's current membership on every request. Your app calls
`zone.stratos.feedgen.getFeed` through the user's PDS. The PDS forwards the
call with a service auth JWT it mints.

- [Private Feed Attachments](/client/feedgen-blobs) shows the feed response
  and how to download images.
- [Run the feed generator](/operator/feedgen-ng) describes the service.

## Read by custody

Choose the tab for the author's custody. A Stratos-hosted post can be read
from Stratos directly. A PDS-hosted post reaches your app through the feed.

::: code-group

```typescript [Stratos custody]
// One record, read from Stratos with the viewer's DPoP session.
// stratosGet is defined in the next section.
const response = await stratosGet(
  session,
  target.url,
  'com.atproto.repo.getRecord',
  { repo: authorDid, collection: 'zone.stratos.feed.post', rkey },
)
```

```typescript [PDS custody]
// The viewer's PDS forwards the call to the feed generator.
// One page of the general feed. Pass the returned cursor for the next page.
const params = new URLSearchParams({ feed: 'general', limit: '50' })
const response = await session.fetchHandler(
  `/xrpc/zone.stratos.feedgen.getFeed?${params}`,
  {
    method: 'GET',
    headers: { 'atproto-proxy': `${feedgenDid}#stratos_feedgen` },
  },
)
```

:::

The feed generator serves both custody classes in one feed. Use the feed for
timelines, whatever the custody.

## A DPoP request helper

The samples below send GET requests through the user's OAuth session. The
session's fetch handler adds `Authorization: DPoP <token>` and the `DPoP`
proof.

```typescript
import type { OAuthSession } from '@atproto/oauth-client-browser'

interface XrpcError {
  error: string
  message?: string
}

async function stratosGet(
  session: OAuthSession,
  stratosUrl: string,
  method: string,
  params: Record<string, string>,
): Promise<Response> {
  const url = new URL(`/xrpc/${method}`, stratosUrl)
  url.search = new URLSearchParams(params).toString()
  return session.fetchHandler(url.href, { method: 'GET' })
}
```

## Get a single record

```typescript
interface RecordView {
  uri: string
  cid: string
  value: unknown
}

async function getRecord(
  session: OAuthSession,
  stratosUrl: string,
  repo: string,
  collection: string,
  rkey: string,
): Promise<RecordView | null> {
  const response = await stratosGet(
    session,
    stratosUrl,
    'com.atproto.repo.getRecord',
    { repo, collection, rkey },
  )
  if (response.ok) return (await response.json()) as RecordView

  const body = (await response.json()) as XrpcError
  if (response.status === 400 && body.error === 'RecordNotFound') return null
  throw new Error(`${body.error}: ${body.message ?? ''}`)
}
```

::: tip Access denied looks like a missing record
Stratos answers HTTP 400 with `{ "error": "RecordNotFound" }` in both cases:
the record does not exist, or the viewer may not read it. The status is 400,
not 404 and not 403. Check the `error` name. Do not tell the user that the
record was deleted.
:::

## List records

```typescript
async function listRecords(
  session: OAuthSession,
  stratosUrl: string,
  repo: string,
  collection: string,
  cursor?: string,
): Promise<{ records: RecordView[]; cursor?: string }> {
  const params: Record<string, string> = { repo, collection, limit: '50' }
  if (cursor) params.cursor = cursor
  const response = await stratosGet(
    session,
    stratosUrl,
    'com.atproto.repo.listRecords',
    params,
  )
  if (!response.ok) throw new Error(`listRecords failed (${response.status})`)
  return (await response.json()) as { records: RecordView[]; cursor?: string }
}
```

Stratos filters each page by the viewer's boundaries after it reads the page.
A page can hold fewer records than `limit`, or none, and still carry a
`cursor`. Continue while a `cursor` is present.

An unknown repo returns an empty list, not an error.

## Batch reads

`zone.stratos.repo.hydrateRecords` fetches up to 100 records by URI:

```typescript
interface HydrateResult {
  records: RecordView[]
  notFound: string[]
  blocked: string[]
}

async function hydrateBatch(
  session: OAuthSession,
  stratosUrl: string,
  uris: string[],
): Promise<HydrateResult> {
  const url = new URL('/xrpc/zone.stratos.repo.hydrateRecords', stratosUrl)
  const response = await session.fetchHandler(url.href, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uris }),
  })
  if (!response.ok)
    throw new Error(`hydrateRecords failed (${response.status})`)
  return (await response.json()) as HydrateResult
}
```

Each record comes back as `{ uri, cid, value }`. `value` is the stored record,
unchanged. Stratos adds no `source` field.

Unlike `getRecord`, the batch call separates the two failures. `notFound`
lists URIs with no record. `blocked` lists records the viewer may not read.
More than 100 URIs fail with `TooManyUris`.

`zone.stratos.repo.hydrateRecord` does the same for one URI. It answers HTTP
400 with `RecordNotFound` or `RecordBlocked`.

## Verifying what you read

Stratos does not serve a signed proof for a single record. A record read with
`getRecord` can be checked for integrity only:

```typescript
import { verifyRecordCid } from '@northskysocial/stratos-client'

async function getVerifiedRecord(
  session: OAuthSession,
  stratosUrl: string,
  repo: string,
  collection: string,
  rkey: string,
) {
  const record = await getRecord(session, stratosUrl, repo, collection, rkey)
  if (!record) return null
  // Throws when the value does not hash to the claimed CID.
  return verifyRecordCid(record.value, record.cid)
}
```

The result has `level: 'cid-integrity'`. It proves the value matches its CID.
It does not prove who wrote it.

For a signature check, the repo owner can export their repo and verify
records inside the CAR. See
[Repo Export](/client/repo-export-import#verifying-records-in-an-export).

::: warning fetchAndVerifyRecord does not work
`fetchAndVerifyRecord` calls `com.atproto.sync.getRecord`. The Stratos service
no longer serves that method, so the call fails. Use `verifyRecordCid`.
:::

## Reading a record in a space

`zone.stratos.space.getRecord` reads one Stratos-hosted record through its
space. It takes `space`, `repo`, `collection`, and `rkey`. A member calls it
with their DPoP session. A syncing service calls it with a space credential.

The record must belong to the requested space. Any other record answers
`RecordNotFound`. See the [API methods](/reference/api#get-space-record).

## Blobs

`com.atproto.sync.getBlob` and `zone.stratos.sync.getBlob` return blob bytes.
Both take `did` and `cid`. The viewer must be able to read a record that
references the blob.

| Error          | Meaning                             |
| -------------- | ----------------------------------- |
| `BlobBlocked`  | The viewer may not read the blob.   |
| `RepoNotFound` | Stratos hosts no repo for this DID. |
| `BlobNotFound` | The repo has no such blob.          |

`zone.stratos.space.listBlobs` lists the blob CIDs that an account's records
reference within one space.

## Integration patterns

### Cache one client per target

A client is bound to one origin. Build it once per session and drop it on
logout or account switch:

```typescript
import { Client } from '@atcute/client'
import { createServiceFetchHandler } from '@northskysocial/stratos-client'
import type { FetchHandler } from '@northskysocial/stratos-client'

let stratosClient: Client | null = null

function getStratosClient(
  authenticatedHandler: FetchHandler,
  stratosUrl: string,
): Client {
  stratosClient ??= new Client({
    handler: createServiceFetchHandler(authenticatedHandler, stratosUrl),
  })
  return stratosClient
}

function resetClients(): void {
  stratosClient = null
}
```

`stratosUrl` is the `url` of a `stratos` repository target. Never pass
`enrollment.service` here; it is an unverified hint.

### Refetch when the session changes

Key each query by the signed-in DID, so an account switch refetches:

```typescript
import { useQuery } from '@tanstack/react-query'

function useStratosRecord(
  session: OAuthSession,
  stratosUrl: string,
  repo: string,
  rkey: string,
) {
  return useQuery({
    queryKey: ['stratos-record', session.sub, repo, rkey],
    queryFn: () =>
      getRecord(session, stratosUrl, repo, 'zone.stratos.feed.post', rkey),
  })
}
```

### Empty repo handling

For `stratos` custody, enrollment creates the repo with an empty signed
commit. `com.atproto.repo.describeRepo` returns an empty `collections` list
until the first post. Render that as an empty state.

`describeRepo` answers `RepoNotFound` when Stratos hosts no repo for the DID.
That is the normal answer for a `pds`-custody user. For a `stratos`-custody
user it is a real error.
