# Tutorial: Your First Private Post

This tutorial walks you through the process of setting up the Stratos client, discovering an enrollment, and creating your first private post with a domain boundary.

## Prerequisites

- An AT Protocol account (e.g., on `bsky.social`).
- A Stratos service you want to use (e.g., `https://stratos.actor`).
- Basic knowledge of TypeScript/JavaScript.

## 1. Install the Client

First, install the Stratos client library along with the standard AT Protocol API:

```bash
pnpm add @northskysocial/stratos-client @atproto/api
```

## 2. Discover an Enrollment

Before you can post to Stratos, you need to find the user's enrollment record on their PDS. This record tells the client which Stratos service the user is registered with.

```typescript
import {
  getEnrollmentByServiceDid,
  resolveServiceUrl,
} from '@northskysocial/stratos-client'

const userDid = 'did:plc:your-user-did'
const pdsUrl = 'https://bsky.social' // Or your custom PDS
const serviceDid = 'did:web:stratos.example.com'

// Discover the enrollment record
const enrollment = await getEnrollmentByServiceDid(userDid, pdsUrl, serviceDid)

if (!enrollment) {
  throw new Error('User is not enrolled with any Stratos service.')
}

// Resolve the service URL
const serviceUrl = resolveServiceUrl(enrollment, pdsUrl)
console.log(`Stratos service found at: ${serviceUrl}`)
```

## 3. Create a Private Post

Now that you have the service URL, you can create a private post. You'll need an authenticated session from your OAuth flow or a temporary session for testing.

```typescript
import { Agent } from '@atproto/api'
import { createServiceFetchHandler } from '@northskysocial/stratos-client'

// Assume 'session' is your existing AT Protocol session
const stratosAgent = new Agent((url, init) => {
  const fullUrl = new URL(url, serviceUrl)
  return session.fetchHandler(fullUrl.href, init)
})

// Create a post restricted to the 'engineering' boundary
await stratosAgent.com.atproto.repo.createRecord({
  repo: userDid,
  collection: 'zone.stratos.feed.post',
  record: {
    $type: 'zone.stratos.feed.post',
    text: 'Hello from the private engineering channel!',
    boundary: {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: [
        {
          $type: 'zone.stratos.boundary.defs#Domain',
          value: 'did:web:stratos.actor/engineering',
        },
      ],
    },
    createdAt: new Date().toISOString(),
  },
})

console.log('Private post created successfully!')
```

## Summary

You've successfully:

1. Located a Stratos enrollment via the PDS.
2. Routed an XRPC request to the correct Stratos instance.
3. Created a record with a domain-scoped boundary.

## Next Steps

- Explore [Boundary Visibility](../client/boundaries.md) to learn how access is restricted.
- Learn about [Hydration](../architecture/hydration.md) to understand how these posts appear in feeds.
