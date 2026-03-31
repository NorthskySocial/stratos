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

```typescript
async function createPostWithImages(
  stratosEndpoint: string,
  accessToken: string,
  userDid: string,
  text: string,
  images: Array<{ blob: Blob; alt: string }>,
  domains: string[],
) {
  const uploadedImages = await Promise.all(
    images.map(async ({ blob, alt }) => {
      const uploadRes = await fetch(
        `${stratosEndpoint}/xrpc/com.atproto.repo.uploadBlob`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': blob.type,
          },
          body: blob,
        },
      )
      const { blob: blobRef } = await uploadRes.json()
      return { image: blobRef, alt }
    }),
  )

  const record: StratosPost = {
    $type: 'zone.stratos.feed.post',
    text,
    embed: {
      $type: 'app.bsky.embed.images',
      images: uploadedImages,
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
