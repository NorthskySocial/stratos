# Creating Records

## Record Shape

```typescript
interface StratosPost {
  $type: 'zone.stratos.feed.post'
  text: string
  boundary: {
    $type: 'zone.stratos.boundary.defs#Domains'
    values: Array<{
      $type: 'zone.stratos.boundary.defs#Domain'
      value: string
    }>
  }
  createdAt: string
  facets?: RichTextFacet[]
  embed?: Embed
  reply?: ReplyRef
  langs?: string[]
  tags?: string[]
}
```

## Basic Post

```typescript
async function createPrivatePost(
  stratosEndpoint: string,
  accessToken: string,
  userDid: string,
  text: string,
  domains: string[],
) {
  const record: StratosPost = {
    $type: 'zone.stratos.feed.post',
    text,
    boundary: {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: domains.map((domain) => ({
        $type: 'zone.stratos.boundary.defs#Domain',
        value: domain,
      })),
    },
    createdAt: new Date().toISOString(),
  }

  const response = await fetch(
    `${stratosEndpoint}/xrpc/com.atproto.repo.createRecord`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        repo: userDid,
        collection: 'zone.stratos.feed.post',
        record,
      }),
    },
  )

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.message || 'Failed to create post')
  }

  return response.json()
}
```

## Post with Rich Text

```typescript
import { RichText } from '@atproto/api'

async function createRichPost(
  agent: Agent,
  stratosEndpoint: string,
  accessToken: string,
  userDid: string,
  text: string,
  domains: string[],
) {
  const rt = new RichText({ text })
  await rt.detectFacets(agent)

  const record: StratosPost = {
    $type: 'zone.stratos.feed.post',
    text: rt.text,
    facets: rt.facets,
    boundary: {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: domains.map((domain) => ({
        $type: 'zone.stratos.boundary.defs#Domain',
        value: domain,
      })),
    },
    createdAt: new Date().toISOString(),
  }

  return fetch(`${stratosEndpoint}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      repo: userDid,
      collection: 'zone.stratos.feed.post',
      record,
    }),
  }).then((r) => r.json())
}
```

## Post with Images

Creating a post with images involves two steps: uploading the blob and then referencing it in the record.

### 1. Upload the Blob

You can use either the standard `com.atproto.repo.uploadBlob` or the Stratos-specific `zone.stratos.repo.uploadBlob`.

```typescript
async function uploadImage(
  stratosEndpoint: string,
  accessToken: string,
  imageData: Uint8Array,
  mimeType: string,
) {
  const response = await fetch(
    `${stratosEndpoint}/xrpc/com.atproto.repo.uploadBlob`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': mimeType,
      },
      body: imageData,
    },
  )

  if (!response.ok) {
    throw new Error('Failed to upload image')
  }

  const { blob } = await response.json()
  return blob // This is a BlobRef
}
```

### 2. Create the Post with Embed

```typescript
async function createPostWithImage(
  stratosEndpoint: string,
  accessToken: string,
  userDid: string,
  text: string,
  domains: string[],
  blob: any, // BlobRef from uploadImage
  altText: string = '',
) {
  const record: StratosPost = {
    $type: 'zone.stratos.feed.post',
    text,
    boundary: {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: domains.map((domain) => ({
        $type: 'zone.stratos.boundary.defs#Domain',
        value: domain,
      })),
    },
    embed: {
      $type: 'app.bsky.embed.images',
      images: [
        {
          image: blob,
          alt: altText,
        },
      ],
    },
    createdAt: new Date().toISOString(),
  }

  return fetch(`${stratosEndpoint}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      repo: userDid,
      collection: 'zone.stratos.feed.post',
      record,
    }),
  }).then((r) => r.json())
}
```

## Reply to a Post

```typescript
async function createReply(
  stratosEndpoint: string,
  accessToken: string,
  userDid: string,
  text: string,
  replyTo: { uri: string; cid: string },
  rootPost: { uri: string; cid: string },
  domains: string[],
) {
  const record: StratosPost = {
    $type: 'zone.stratos.feed.post',
    text,
    reply: {
      root: { uri: rootPost.uri, cid: rootPost.cid },
      parent: { uri: replyTo.uri, cid: replyTo.cid },
    },
    boundary: {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: domains.map((domain) => ({
        $type: 'zone.stratos.boundary.defs#Domain',
        value: domain,
      })),
    },
    createdAt: new Date().toISOString(),
  }

  return fetch(`${stratosEndpoint}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      repo: userDid,
      collection: 'zone.stratos.feed.post',
      record,
    }),
  }).then((r) => r.json())
}
```

## Write Path Integration

Record creates, updates, and deletes should route through the service client when Stratos is active:

```typescript
import { createServiceFetchHandler } from '@northskysocial/stratos-client'

const sessionAgent = new OAuthUserAgent(await getSession(repoDid))
const rpc = enrollment
  ? new Client({
      handler: createServiceFetchHandler(
        sessionAgent.handle,
        enrollment.service,
      ),
    })
  : new Client({ handler: sessionAgent })

await rpc.post('com.atproto.repo.createRecord', {
  input: {
    repo: did,
    collection: 'zone.stratos.feed.post',
    record: {
      text: 'hello',
      createdAt: new Date().toISOString(),
      boundary: {
        values: [{ value: 'did:web:stratos.example.com/WestCoastBestCoast' }],
      },
    },
  },
})
```

Batch operations (`com.atproto.repo.applyWrites`) work identically — route through the service
client.
