# Stratos Client Integration Guide

This guide explains how to integrate Stratos private namespace functionality into ATProtocol client
applications.

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [User Enrollment](#user-enrollment)
4. [Creating Records](#creating-records)
5. [Reading Records](#reading-records)
6. [Domain Boundaries](#domain-boundaries)
7. [UI Patterns](#ui-patterns)
8. [API Reference](#api-reference)

---

## Overview

### What is Stratos?

Stratos enables **private, domain-scoped content** within ATProtocol. Users can create posts visible
only to members of specific groups or communities.

### Key Concepts

| Concept             | Description                                                       |
| ------------------- | ----------------------------------------------------------------- |
| **Stratos Service** | A server that stores private records (separate from PDS)          |
| **Enrollment**      | User must enroll with a Stratos service to create private content |
| **Domain Boundary** | Specifies which community boundaries can view a record            |
| **Private Post**    | An `app.stratos.feed.post` record with boundary restrictions      |

## Quick Start

### 1. Check for Stratos Support

First, determine if the user's AppView knows about their Stratos access:

```typescript
import { Agent } from '@atproto/api'

const agent = new Agent('https://appview.example.com')

// After user login, check if they have stratos domains
const profile = await agent.getProfile({ actor: agent.session.did })
const stratosDomains = profile.data.associated?.stratosDomains ?? []

if (stratosDomains.length > 0) {
  console.log('User has stratos access for:', stratosDomains)
}
```

### 2. Discover Stratos Endpoint

Get the Stratos service endpoint from the AppView or configuration:

```typescript
const STRATOS_ENDPOINT = 'https://stratos.example.com'
```

### 3. Create a Private Post

```typescript
const response = await fetch(
  `${STRATOS_ENDPOINT}/xrpc/com.atproto.repo.createRecord`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      repo: userDid,
      collection: 'app.stratos.feed.post',
      record: {
        $type: 'app.stratos.feed.post',
        text: 'This is a private post for my community!',
        boundary: {
          $type: 'app.stratos.boundary.defs#Domains',
          values: [
            { $type: 'app.stratos.boundary.defs#Domain', value: 'general' },
          ],
        },
        createdAt: new Date().toISOString(),
      },
    }),
  },
)

const result = await response.json()
console.log('Created:', result.uri)
```

---

## User Enrollment

Before users can create Stratos records, they must **enroll** with the Stratos service.

### Checking Enrollment Status

```typescript
async function isUserEnrolled(
  stratosEndpoint: string,
  did: string,
): Promise<boolean> {
  const response = await fetch(
    `${stratosEndpoint}/xrpc/app.stratos.enrollment.status?did=${encodeURIComponent(did)}`,
  )
  const data = await response.json()
  return data.enrolled === true
}
```

### Initiating Enrollment

Enrollment uses OAuth. Redirect the user to start the flow:

```typescript
function startEnrollment(stratosEndpoint: string, handle: string) {
  const url = `${stratosEndpoint}/oauth/authorize?handle=${encodeURIComponent(handle)}`
  window.location.href = url
}
```

### Complete Flow

```typescript
async function ensureEnrolled(
  stratosEndpoint: string,
  userHandle: string,
  userDid: string,
) {
  // Check if already enrolled
  const enrolled = await isUserEnrolled(stratosEndpoint, userDid)

  if (enrolled) {
    return true
  }

  // Start enrollment flow (redirects to OAuth)
  startEnrollment(stratosEndpoint, userHandle)
  return false
}
```

### Handling the OAuth Callback

After enrollment completes, the user is redirected back to your app. Handle the callback:

```typescript
// On your callback page (e.g., /stratos-callback)
async function handleEnrollmentCallback() {
  const urlParams = new URLSearchParams(window.location.search)

  if (urlParams.get('error')) {
    console.error('Enrollment failed:', urlParams.get('error_description'))
    return { success: false, error: urlParams.get('error') }
  }

  // Enrollment successful
  return { success: true }
}
```

---

## Creating Records

### Basic Post

```typescript
interface StratosPost {
  $type: 'app.stratos.feed.post'
  text: string
  boundary: {
    $type: 'app.stratos.boundary.defs#Domains'
    values: Array<{ $type: 'app.stratos.boundary.defs#Domain'; value: string }>
  }
  createdAt: string
  facets?: RichTextFacet[]
  embed?: Embed
  reply?: ReplyRef
  langs?: string[]
  tags?: string[]
}
```

### Post with Rich Text

```typescript
import { RichText } from '@atproto/api'

async function createPrivatePost(
  stratosEndpoint: string,
  accessToken: string,
  userDid: string,
  text: string,
  domains: string[],
) {
  // Process rich text (mentions, links, etc.)
  const rt = new RichText({ text })
  await rt.detectFacets(agent) // Your atproto agent

  const record: StratosPost = {
    $type: 'app.stratos.feed.post',
    text: rt.text,
    facets: rt.facets,
    boundary: {
      $type: 'app.stratos.boundary.defs#Domains',
      values: domains.map((domain) => ({
        $type: 'app.stratos.boundary.defs#Domain',
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
        collection: 'app.stratos.feed.post',
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

### Post with Images

```typescript
async function createPostWithImages(
  stratosEndpoint: string,
  accessToken: string,
  userDid: string,
  text: string,
  images: Array<{ blob: Blob; alt: string }>,
  domains: string[],
) {
  // Upload images first
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
    $type: 'app.stratos.feed.post',
    text,
    embed: {
      $type: 'app.bsky.embed.images',
      images: uploadedImages,
    },
    boundary: {
      $type: 'app.stratos.boundary.defs#Domains',
      values: domains.map((domain) => ({
        $type: 'app.stratos.boundary.defs#Domain',
        value: domain,
      })),
    },
    createdAt: new Date().toISOString(),
  }

  // Create post with embed
  return fetch(`${stratosEndpoint}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      repo: userDid,
      collection: 'app.stratos.feed.post',
      record,
    }),
  }).then((r) => r.json())
}
```

### Reply to a Post

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
    $type: 'app.stratos.feed.post',
    text,
    reply: {
      root: { uri: rootPost.uri, cid: rootPost.cid },
      parent: { uri: replyTo.uri, cid: replyTo.cid },
    },
    boundary: {
      $type: 'app.stratos.boundary.defs#Domains',
      values: domains.map((domain) => ({
        $type: 'app.stratos.boundary.defs#Domain',
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
      collection: 'app.stratos.feed.post',
      record,
    }),
  }).then((r) => r.json())
}
```

---

## Reading Records

### Understanding the Source Field Pattern

When a record is created in Stratos, two records are created:

1. **Full record** in Stratos (with actual content, boundaries, etc.)
2. **Stub record** on user's PDS (with `source` field pointing to Stratos)

The stub record looks like this:

```json
{
  "$type": "app.stratos.feed.post",
  "source": {
    "vary": "authenticated",
    "subject": {
      "uri": "at://did:plc:abc/app.stratos.feed.post/tid123",
      "cid": "bafyreibeef..."
    },
    "service": "did:web:stratos.example.com#atproto_pns"
  },
  "createdAt": "2024-01-15T12:00:00.000Z"
}
```

AppViews and clients detect the `source` field and hydrate by calling `getRecord` at the service
endpoint.

### Get a Single Record

```typescript
async function getRecord(
  stratosEndpoint: string,
  accessToken: string,
  repo: string,
  collection: string,
  rkey: string,
) {
  const params = new URLSearchParams({
    repo,
    collection,
    rkey,
  })

  const response = await fetch(
    `${stratosEndpoint}/xrpc/com.atproto.repo.getRecord?${params}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  )

  if (!response.ok) {
    if (response.status === 404) {
      return null
    }
    throw new Error('Failed to get record')
  }

  return response.json()
}
```

### List User's Records

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
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  )

  return response.json()
}
```

### Reading via AppView (Hydration)

When reading feeds through an AppView, the hydration happens automatically:

1. AppView indexes stubs with `source` fields
2. When rendering feed, AppView resolves `source.service` to get Stratos endpoint
3. AppView calls `getRecord` at Stratos with viewer identity
4. Stratos returns full content if viewer has boundary access

```typescript
// AppView handles hydration transparently
const authorFeed = await agent.api.app.bsky.feed.getAuthorFeed({
  actor: authorDid,
  // Stratos content is hydrated based on viewer's boundaries
})

// For direct client access to Stratos
async function hydrateFromSource(
  source: RecordSource,
  viewer: string,
): Promise<Record | null> {
  // 1. Resolve service DID to endpoint
  const endpoint = await resolveServiceEndpoint(source.service)

  // 2. Parse URI from subject
  const { repo, collection, rkey } = parseAtUri(source.subject.uri)

  // 3. Call getRecord at Stratos
  const response = await fetch(
    `${endpoint}/xrpc/com.atproto.repo.getRecord?` +
      `repo=${repo}&collection=${collection}&rkey=${rkey}`,
    {
      headers: {
        Authorization: `Bearer ${viewerToken}`,
      },
    },
  )

  if (!response.ok) return null
  return response.json()
}
```

---

## Domain Boundaries

### Understanding Boundaries

Every Stratos record must include a `boundary` specifying which boundaries can access it:

```typescript
{
  boundary: {
    $type: 'app.stratos.boundary.defs#Domains',
      values
  :
    [
      {$type: 'app.stratos.boundary.defs#Domain', value: 'general'},
      {$type: 'app.stratos.boundary.defs#Domain', value: 'writers'}
    ]
  }
}
```

### Domain Visibility Rules

| Viewer                       | Can See Record? |
| ---------------------------- | --------------- |
| Record owner                 | ✅ Always       |
| User with matching domain    | ✅ Yes          |
| User without matching domain | ❌ No           |
| Unauthenticated              | ❌ No           |

### Multi-Domain Posts

Posts can be visible to multiple domains:

```typescript
const crossDomainPost = {
  $type: 'app.stratos.feed.post',
  text: 'Announcement for both groups',
  boundary: {
    values: [{ value: 'fanart' }, { value: 'cosplay' }],
  },
  createdAt: new Date().toISOString(),
}
```

### Getting User's Available Domains

```typescript
async function getUserDomains(agent: Agent): Promise<string[]> {
  const profile = await agent.getProfile({ actor: agent.session.did })

  // AppView returns domains the user has access to
  return profile.data.associated?.stratosDomains ?? []
}
```

---

## Repository Export & Import

### Verifying a Record (Sync)

Clients can request a verifiable CAR containing the signed commit, MST inclusion proof, and record
block:

```typescript
async function getRecordProof(
  stratosEndpoint: string,
  accessToken: string,
  did: string,
  collection: string,
  rkey: string,
): Promise<Uint8Array> {
  const params = new URLSearchParams({ did, collection, rkey })
  const response = await fetch(
    `${stratosEndpoint}/xrpc/com.atproto.sync.getRecord?${params}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  )
  if (!response.ok) throw new Error('Failed to get record proof')
  return new Uint8Array(await response.arrayBuffer())
}
```

The returned CAR contains:
1. **Signed commit** — the repo root with the service's secp256k1 signature
2. **MST inclusion proof** — the tree nodes proving the record exists in the repo
3. **Record block** — the actual record data

### Exporting a Repository

Export the full repository as a CAR file containing all records, MST nodes, and the signed commit:

```typescript
async function exportRepo(
  stratosEndpoint: string,
  accessToken: string,
  did: string,
  since?: string,
): Promise<Uint8Array> {
  const params = new URLSearchParams({ did })
  if (since) params.set('since', since)

  const response = await fetch(
    `${stratosEndpoint}/xrpc/app.stratos.sync.getRepo?${params}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  )
  if (!response.ok) throw new Error('Failed to export repo')
  return new Uint8Array(await response.arrayBuffer())
}
```

### Importing a Repository

Import a previously exported CAR file into a Stratos service. The caller must be enrolled and the
CAR's commit DID must match the authenticated user:

```typescript
async function importRepo(
  stratosEndpoint: string,
  accessToken: string,
  carBytes: Uint8Array,
): Promise<{ imported: number }> {
  const response = await fetch(
    `${stratosEndpoint}/xrpc/app.stratos.repo.importRepo`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/vnd.ipld.car',
      },
      body: carBytes,
    },
  )
  if (!response.ok) {
    const err = await response.json()
    throw new Error(err.message ?? 'Import failed')
  }
  return response.json()
}
```

Import constraints:
- Maximum CAR size: 256 MiB (configurable by operator)
- CID integrity is verified for every block
- The target repo must not already have an existing commit
- Records are indexed but no PDS stubs are created

---

## UI Patterns

### Enrollment Prompt

```tsx
function StratosEnrollmentPrompt({ handle, onEnroll }) {
  return (
    <div className="enrollment-prompt">
      <h3>Enable Private Posts</h3>
      <p>Connect to Stratos to create posts visible only to your community.</p>
      <button onClick={() => onEnroll(handle)}>Enable Private Posts</button>
    </div>
  )
}
```

### Domain Selector

```tsx
function DomainSelector({ availableDomains, selected, onChange }) {
  return (
    <div className="domain-selector">
      <label>Visible to:</label>
      <select
        multiple
        value={selected}
        onChange={(e) =>
          onChange(Array.from(e.target.selectedOptions, (o) => o.value))
        }
      >
        {availableDomains.map((domain) => (
          <option key={domain} value={domain}>
            {domain}
          </option>
        ))}
      </select>
    </div>
  )
}
```

### Post Composer with Privacy Toggle

```tsx
function StratosComposer({ agent, stratosDomains }) {
  const [text, setText] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [selectedDomains, setSelectedDomains] = useState([])

  const handleSubmit = async () => {
    if (isPrivate) {
      await createPrivatePost(
        STRATOS_ENDPOINT,
        accessToken,
        agent.session.did,
        text,
        selectedDomains,
      )
    } else {
      await agent.post({ text })
    }
  }

  return (
    <div className="composer">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          isPrivate ? 'Write a private post...' : "What's happening?"
        }
      />

      <div className="privacy-toggle">
        <label>
          <input
            type="checkbox"
            checked={isPrivate}
            onChange={(e) => setIsPrivate(e.target.checked)}
          />
          Private post
        </label>
      </div>

      {isPrivate && stratosDomains.length > 0 && (
        <DomainSelector
          availableDomains={stratosDomains}
          selected={selectedDomains}
          onChange={setSelectedDomains}
        />
      )}

      <button
        onClick={handleSubmit}
        disabled={isPrivate && selectedDomains.length === 0}
      >
        {isPrivate ? '🔒 Post' : 'Post'}
      </button>
    </div>
  )
}
```

### Private Post Indicator

```tsx
function PostCard({ post }) {
  const isStratos = post.uri.includes('app.stratos.')
  const domains = post.record?.boundary?.values?.map((d) => d.value) ?? []

  return (
    <div className={`post ${isStratos ? 'private' : ''}`}>
      {isStratos && (
        <div className="privacy-badge">🔒 {domains.join(', ')}</div>
      )}

      <div className="content">{post.record.text}</div>
    </div>
  )
}
```

---

## API Reference

### Endpoints

#### Create Record

```
POST /xrpc/com.atproto.repo.createRecord
Authorization: Bearer <access_token>

{
  "repo": "<user-did>",
  "collection": "app.stratos.feed.post",
  "record": { ... }
}
```

#### Get Record

```
GET /xrpc/com.atproto.repo.getRecord?repo=<did>&collection=<collection>&rkey=<rkey>
Authorization: Bearer <access_token>
```

#### List Records

```
GET /xrpc/com.atproto.repo.listRecords?repo=<did>&collection=<collection>&limit=50
Authorization: Bearer <access_token>
```

#### Delete Record

```
POST /xrpc/com.atproto.repo.deleteRecord
Authorization: Bearer <access_token>

{
  "repo": "<user-did>",
  "collection": "app.stratos.feed.post",
  "rkey": "<record-key>"
}
```

#### Sync Get Record (CAR proof)

```
GET /xrpc/com.atproto.sync.getRecord?did=<did>&collection=<collection>&rkey=<rkey>
Authorization: Bearer <access_token>
Response: application/vnd.ipld.car
```

Returns a CAR containing the signed commit, MST inclusion proof nodes, and record block.

#### Export Repository

```
GET /xrpc/app.stratos.sync.getRepo?did=<did>[&since=<rev>]
Authorization: Bearer <access_token>
Response: application/vnd.ipld.car
```

Returns a full CAR of the repo: all record blocks, MST nodes, and the signed commit.

#### Import Repository

```
POST /xrpc/app.stratos.repo.importRepo
Authorization: Bearer <access_token>
Content-Type: application/vnd.ipld.car
Response: { "imported": <count> }
```

#### Check Enrollment

```
GET /xrpc/app.stratos.enrollment.status?did=<user-did>
```

### Record Types

#### app.stratos.feed.post

```typescript
interface AppStratosFeedPost {
  $type: 'app.stratos.feed.post'
  text: string // Required, max 3000 chars
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
  $type: 'app.stratos.boundary.defs#Domains'
  values: Domain[] // Max 10 domains
}

interface Domain {
  $type: 'app.stratos.boundary.defs#Domain'
  value: string // Domain name, max 253 chars
}
```

### Error Codes

| Error               | Description                                       |
| ------------------- | ------------------------------------------------- |
| `NotEnrolled`       | User hasn't enrolled with this Stratos service    |
| `InvalidCollection` | Collection is not a valid stratos namespace       |
| `InvalidRecord`     | Record failed validation (e.g., missing boundary) |
| `RecordNotFound`    | Record doesn't exist or user doesn't have access  |
| `AuthRequired`      | Endpoint requires authentication                  |
| `InvalidCar`        | CAR file is malformed or fails CID integrity      |
| `RepoAlreadyExists` | Target repo already has a commit (import blocked) |

---

## Best Practices

### 1. Always Check Enrollment First

```typescript
// Before showing stratos UI
const enrolled = await isUserEnrolled(STRATOS_ENDPOINT, userDid)
if (!enrolled) {
  showEnrollmentPrompt()
}
```

### 2. Handle Access Errors Gracefully

```typescript
try {
  const post = await getRecord(...)
} catch (err) {
  if (err.status === 404) {
    // Could be genuinely missing OR access denied
    showMessage("This post isn't available")
  }
}
```

### 3. Default to User's Primary Domain

```typescript
const defaultDomains = userDomains.length > 0 ? [userDomains[0]] : []
```

### 4. Validate Domains Before Posting

```typescript
// Ensure selected domains are actually available to user
const validDomains = selectedDomains.filter((d) => userDomains.includes(d))
if (validDomains.length === 0) {
  throw new Error('Select at least one valid domain')
}
```

### 5. Clear Visual Distinction

Always make it visually clear when content is private:

- Different background color
- Lock icon
- Domain badges
- Different composer style

---

## Troubleshooting

### "NotEnrolled" After Completing OAuth

The Stratos service may have an allowlist. Contact the service operator to request access.

### Posts Not Appearing in Feed

1. Check domain boundaries match your viewer's domains
2. Verify the AppView has indexed the Stratos content
3. Confirm the post was created successfully (check the returned URI)

### OAuth Redirect Fails

1. Verify your app's callback URL matches Stratos configuration
2. Check for CORS issues in browser console
3. Ensure the user's PDS supports OAuth

### Rate Limiting

If you receive 429 errors, implement exponential backoff:

```typescript
async function createWithRetry(fn: () => Promise<any>, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn()
    } catch (err) {
      if (err.status === 429 && i < maxRetries - 1) {
        await sleep(Math.pow(2, i) * 1000)
        continue
      }
      throw err
    }
  }
}
```
