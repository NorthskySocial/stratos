# Creating Records

Where the post goes depends on custody. Read
[Custody and Routing](/client/custody) first. Most of this page describes
`stratos` custody, where the Stratos service stores the record. The last
section covers `pds` custody.

## Record shape

```typescript
interface StratosPost {
  $type: 'zone.stratos.feed.post'
  text: string
  boundary: {
    $type: 'zone.stratos.boundary.defs#Domains'
    // Exactly one entry.
    values: [{ $type: 'zone.stratos.boundary.defs#Domain'; value: string }]
  }
  createdAt: string
  facets?: unknown[]
  embed?: unknown
  reply?: {
    root: { uri: string; cid: string }
    parent: { uri: string; cid: string }
  }
  langs?: string[]
  tags?: string[]
}
```

## Write rules

Stratos checks every write. A failed check answers HTTP 400 with
`{ "error": "<name>", "message": "..." }`.

| Rule                                                         | Error                          |
| ------------------------------------------------------------ | ------------------------------ |
| The caller writes only to their own repo.                    | `AuthenticationRequired` (401) |
| The collection starts with `zone.stratos.`.                  | `InvalidCollection`            |
| The caller has an active enrollment.                         | `NotEnrolled`                  |
| The caller has `stratos` custody.                            | `PdsCustodyWriteForbidden`     |
| The caller is a user, not a service identity.                | `ServiceWriteForbidden`        |
| The record names exactly one boundary.                       | `InvalidDomainCount`           |
| The boundary name is a valid space key.                      | `InvalidDomain`                |
| The boundary belongs to this Stratos service.                | `ServiceMismatch`              |
| The caller holds the boundary.                               | `ForbiddenBoundary`            |
| A reply points at a Stratos record.                          | `InvalidRecord`                |
| A reply's boundary is one of the parent's boundaries.        | `InvalidRecord`                |
| A record embed points at a Stratos record, not a public one. | `InvalidRecord`                |
| The caller is under the write rate limit.                    | `RateLimitExceeded` (429)      |

The default rate limit is 300 writes per 60 seconds per DID.

The record and boundary checks run when `validate` is `true`, the default for
`createRecord`. Leave it at the default.

## A DPoP request helper

Every sample below sends requests through the user's OAuth session. The
session's fetch handler adds `Authorization: DPoP <token>` and the `DPoP`
proof. Stratos rejects `Authorization: Bearer` from a user.

```typescript
import type { OAuthSession } from '@atproto/oauth-client-browser'

async function stratosPost(
  session: OAuthSession,
  stratosUrl: string,
  method: string,
  body: unknown,
): Promise<unknown> {
  const url = new URL(`/xrpc/${method}`, stratosUrl)
  const response = await session.fetchHandler(url.href, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data: unknown = await response.json()
  if (!response.ok) {
    const { error, message } = data as { error?: string; message?: string }
    throw new Error(`${error ?? response.status}: ${message ?? ''}`)
  }
  return data
}
```

`stratosUrl` is the `url` of a `stratos` repository target.

## Basic post

```typescript
function buildBoundary(boundary: string): StratosPost['boundary'] {
  return {
    $type: 'zone.stratos.boundary.defs#Domains',
    values: [{ $type: 'zone.stratos.boundary.defs#Domain', value: boundary }],
  }
}

async function createPrivatePost(
  session: OAuthSession,
  stratosUrl: string,
  text: string,
  boundary: string,
) {
  const record: StratosPost = {
    $type: 'zone.stratos.feed.post',
    text,
    boundary: buildBoundary(boundary),
    createdAt: new Date().toISOString(),
  }
  return stratosPost(session, stratosUrl, 'com.atproto.repo.createRecord', {
    repo: session.sub,
    collection: 'zone.stratos.feed.post',
    record,
  })
}
```

`boundary` is the full value, such as `did:web:stratos.example.com/general`.
The response is `{ uri, cid }`. The URI has three segments:
`at://{userDid}/zone.stratos.feed.post/{rkey}`.

## Post with rich text

```typescript
import { Agent, RichText } from '@atproto/api'

async function createRichPost(
  publicAgent: Agent,
  session: OAuthSession,
  stratosUrl: string,
  text: string,
  boundary: string,
) {
  const rt = new RichText({ text })
  await rt.detectFacets(publicAgent)

  const record: StratosPost = {
    $type: 'zone.stratos.feed.post',
    text: rt.text,
    facets: rt.facets,
    boundary: buildBoundary(boundary),
    createdAt: new Date().toISOString(),
  }
  return stratosPost(session, stratosUrl, 'com.atproto.repo.createRecord', {
    repo: session.sub,
    collection: 'zone.stratos.feed.post',
    record,
  })
}
```

## Post with images

A post with an image takes two steps: upload the blob, then reference it.

### 1. Upload the blob

Stratos serves `com.atproto.repo.uploadBlob` and
`zone.stratos.repo.uploadBlob`. Both run the same code.

```typescript
async function uploadImage(
  session: OAuthSession,
  stratosUrl: string,
  imageData: Uint8Array,
  mimeType: string,
): Promise<unknown> {
  const url = new URL('/xrpc/com.atproto.repo.uploadBlob', stratosUrl)
  const response = await session.fetchHandler(url.href, {
    method: 'POST',
    headers: { 'content-type': mimeType },
    body: imageData,
  })
  if (!response.ok) throw new Error(`Upload failed (${response.status})`)
  const { blob } = (await response.json()) as { blob: unknown }
  return blob
}
```

### 2. Create the post with the embed

```typescript
async function createPostWithImage(
  session: OAuthSession,
  stratosUrl: string,
  text: string,
  boundary: string,
  blob: unknown,
  altText: string,
) {
  const record: StratosPost = {
    $type: 'zone.stratos.feed.post',
    text,
    boundary: buildBoundary(boundary),
    embed: {
      $type: 'zone.stratos.embed.images',
      images: [{ image: blob, alt: altText }],
    },
    createdAt: new Date().toISOString(),
  }
  return stratosPost(session, stratosUrl, 'com.atproto.repo.createRecord', {
    repo: session.sub,
    collection: 'zone.stratos.feed.post',
    record,
  })
}
```

`zone.stratos.embed.images` holds up to four images. Each needs `image` and
`alt`, and may carry `aspectRatio` (`width`, `height`). The post lexicon also
accepts `app.bsky.embed.images`, which the demo webapp uses.

## Reply to a post

```typescript
async function createReply(
  session: OAuthSession,
  stratosUrl: string,
  text: string,
  parent: { uri: string; cid: string },
  root: { uri: string; cid: string },
  boundary: string,
) {
  const record: StratosPost = {
    $type: 'zone.stratos.feed.post',
    text,
    reply: { root, parent },
    boundary: buildBoundary(boundary),
    createdAt: new Date().toISOString(),
  }
  return stratosPost(session, stratosUrl, 'com.atproto.repo.createRecord', {
    repo: session.sub,
    collection: 'zone.stratos.feed.post',
    record,
  })
}
```

A reply stays in the parent's boundary. Use the same boundary value. A reply to a
public `app.bsky.feed.post` is rejected.

## Deletes, updates, and batches

Stratos serves `com.atproto.repo.deleteRecord` and
`com.atproto.repo.applyWrites`. It does not serve `com.atproto.repo.putRecord`.
To update a record, send an `update` action through `applyWrites`:

```typescript
async function updatePost(
  session: OAuthSession,
  stratosUrl: string,
  rkey: string,
  record: StratosPost,
) {
  return stratosPost(session, stratosUrl, 'com.atproto.repo.applyWrites', {
    repo: session.sub,
    writes: [
      {
        action: 'update',
        collection: 'zone.stratos.feed.post',
        rkey,
        record,
      },
    ],
  })
}
```

`applyWrites` accepts `create`, `update`, and `delete` actions in one call.
Each write is `{ action, collection, rkey, record }`. This differs from the
upstream `com.atproto.repo.applyWrites` shape, which uses `$type` and `value`.
A `create` may omit `rkey`.
Stratos retries a conflicting write itself. If the conflict persists, it
answers `ConcurrentModification`; send the request again.

## Using an RPC client

With `@atcute/client`, route the session through `createServiceFetchHandler`:

```typescript
import { Client } from '@atcute/client'
import { createServiceFetchHandler } from '@northskysocial/stratos-client'
import type { FetchHandler } from '@northskysocial/stratos-client'

function createStratosClient(
  authenticatedHandler: FetchHandler,
  stratosUrl: string,
): Client {
  return new Client({
    handler: createServiceFetchHandler(authenticatedHandler, stratosUrl),
  })
}
```

## PDS custody

A `pds`-custody user does not write to Stratos. Their app calls
`com.atproto.space.createRecord` on their own PDS, with a `space` URI in place
of the `boundary` field. The record URI that comes back has seven segments.

[Writing by custody](/client/custody#writing-by-custody) has the request and
the scope it needs.
