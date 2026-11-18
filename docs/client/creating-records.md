# Creating Records

Where the post goes depends on custody. Read
[Custody and Routing](/client/custody) first. Most of this page describes
`stratos` custody, where the Stratos service stores the record.

[Boundary procedures](#boundary-procedures) is the current way to write. It
takes the boundary as a parameter. The helpers work for both custody classes:
they send a `stratos` member to the `zone.stratos.repo` procedures and a `pds`
member to their own PDS. The `zone.stratos.repo` procedures themselves refuse a
member who hosts their own repo with `PdsCustodyWriteForbidden`. The sections
before it use the older `com.atproto.repo` methods, which take the boundary
from the record body and serve `stratos` custody only.

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
| The collection is `zone.stratos.*` on `com.atproto.repo`.    | `InvalidCollection`            |
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
The [boundary procedures](#boundary-procedures) include
`zone.stratos.repo.putRecord`. To update a record with the older methods, send
an `update` action through `applyWrites`:

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

## Boundary procedures

`zone.stratos.repo.createRecord`, `putRecord`, `deleteRecord` and `applyWrites`
take `boundary` as a parameter. The write helpers in `stratos-client` send them
for `stratos` custody. For `pds` custody they send the matching
`com.atproto.space` method to the member's PDS, with the space URI of the
boundary.

```typescript
import {
  createBoundaryRecord,
  resolveRepositoryTarget,
} from '@northskysocial/stratos-client'

const client = {
  handler: authenticatedHandler,
  resolveTarget: () => resolveRepositoryTarget(enrollment, hosts),
}

const result = await createBoundaryRecord(client, {
  boundary: 'did:web:stratos.example.com/general',
  repo: session.sub,
  collection: 'zone.stratos.feed.post',
  record: {
    $type: 'zone.stratos.feed.post',
    text,
    createdAt: new Date().toISOString(),
  },
})
if (!result.ok) {
  // The target did not resolve. Nothing was sent.
  throw new Error(result.reason)
}
console.log(result.value.uri, result.value.cid)
```

The record has no `boundary` field. The `boundary` parameter names it. If the
record does have a `boundary` field, it must name that same boundary, or the
write fails with `BoundaryMismatch`. The record's `$type` must equal the
collection.

- `resolveRepositoryTarget` accepts only https origins. For a service on a
  local `http` address, such as `http://127.0.0.1:3100`, pass a `resolveTarget`
  of your own that returns `{ kind: 'stratos', url }`.
- When several writes in one `applyBoundaryWrites` call fail validation, the
  error returned is that of the first failing write, in order. The collection, duplicate-key and grant checks run for the whole batch first, then the checks on each record's `boundary` claim and `$type`, and only then the lexicon and subject checks.
- `ok: false` means the helper sent nothing. `reason` is a
  `resolveRepositoryTarget` reason, or `invalid-boundary` for a `pds` write
  whose boundary has no space URI.
- A service error is thrown as `BoundaryWriteError`, with `status`, `errorName`
  and `message`.
- `ScopeUpgradeRequiredError` is a `BoundaryWriteError`. Catch it and send the
  member through OAuth authorization again. Do not retry the write first.
  [Errors](/guide/errors#writing-into-a-boundary) says when it is returned.

`putBoundaryRecord`, `deleteBoundaryRecord` and `applyBoundaryWrites` take the
same `boundary` and `repo`. The
[API reference](/client/api-reference#boundary-records) lists the inputs, the
outputs, and the differences from the upstream procedures. Deploy the Rust
feed generator before any client uses them.

## Likes and reposts

A like is an `app.bsky.feed.like` record. A repost is an
`app.bsky.feed.repost` record. A `stratos`-custody member writes them through
the boundary procedures, into the boundary of the post.

```typescript
const like = await createBoundaryRecord(client, {
  boundary,
  repo: session.sub,
  collection: 'app.bsky.feed.like',
  record: {
    $type: 'app.bsky.feed.like',
    subject: { uri: post.uri, cid: post.cid },
    createdAt: new Date().toISOString(),
  },
})

// Later, to unlike. `viewer.like` is the URI of the viewer's like.
const rkey = post.viewer?.like?.split('/').pop()
if (rkey) {
  await deleteBoundaryRecord(client, {
    boundary,
    repo: session.sub,
    collection: 'app.bsky.feed.like',
    rkey,
  })
}
```

The rules:

- The `subject` must be a post (`zone.stratos.feed.post`) in the same boundary.
- `subject.uri` is the post's `uri` exactly as the feed returns it. The URI
  must be canonical. For a post that Stratos holds, `subject.cid` is the post's
  current CID.
- For a post by a member who hosts their own repo, Stratos does not hold the
  record. It checks neither that the record exists nor its CID. It checks that
  the author is an active member of the boundary who hosts their own repo, and
  that the URI is well formed for that boundary.
- A member has one like or repost per post. A second one fails with
  `RecordAlreadyExists`.
- To remove a like or repost, call `deleteBoundaryRecord` (the `deleteRecord` procedure).
- Every wrong subject returns the same error: `InvalidRecord` with the message
  `The subject must be a post in this boundary`. A post that Stratos holds but
  cannot find is a wrong subject.

The feed shows the result. Each post has `likeCount` and `repostCount`. Its
`viewer` object has `like` and `repost`, the URIs of the viewer's own records.
A key is absent when the viewer has no such record.

A member who hosts their own repo (`pds` custody) cannot like or repost yet.
The `zone.stratos.space.feed` declaration must be published with the like and
repost collections, and the client's PDS space scope must list them. See
[Space scope](/client/custody#space-scope).

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
