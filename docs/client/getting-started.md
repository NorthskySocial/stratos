# Getting Started

This guide explains how to integrate Stratos private namespace functionality into ATProtocol client applications.

## What is Stratos?

Stratos enables private, domain-scoped content within ATProtocol. Users can create posts visible only to members of specific groups or communities.

| Concept             | Description                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stratos Service** | A server that stores private records (separate from PDS)                                                                                      |
| **Enrollment**      | User must enroll with a Stratos service to create private content                                                                             |
| **Domain Boundary** | Specifies which community can view a record. Values are fully qualified as `{serviceDid}/{name}` (e.g. `did:web:stratos.example.com/general`) |
| **Private Post**    | A `zone.stratos.feed.post` record with boundary restrictions                                                                                  |

## Quick Start

### 1. Check for Stratos Support

Determine if the user's AppView knows about their Stratos access:

```typescript
import { Agent } from '@atproto/api'

const agent = new Agent('https://appview.example.com')

const profile = await agent.getProfile({ actor: agent.session.did })
const stratosDomains = profile.data.associated?.stratosDomains ?? []

if (stratosDomains.length > 0) {
  console.log('User has stratos access for:', stratosDomains)
}
```

### 2. Discover the Stratos Endpoint

Get the Stratos service endpoint from the AppView or your app configuration:

```typescript
const STRATOS_ENDPOINT = 'https://stratos.example.com'
```

### 3. Create a Stratos Agent

When using `@atproto/api` with an OAuth session, you **must** wrap the session's `fetchHandler` to route requests to the Stratos service URL.

::: warning Common mistake
`new Agent(session)` followed by `agent.serviceUrl = new URL(stratosUrl)` will silently send requests to the PDS instead of Stratos. The `OAuthSession` always resolves URLs against the OAuth token's audience. Always use the wrapper pattern below.
:::

```typescript
import { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-browser'

function createStratosAgent(session: OAuthSession, serviceUrl: string): Agent {
  return new Agent((url: string, init: RequestInit) => {
    const fullUrl = new URL(url, serviceUrl)
    return session.fetchHandler(fullUrl.href, init)
  })
}
```

### 4. Create a Private Post

```typescript
const stratosAgent = createStratosAgent(session, STRATOS_ENDPOINT)

await stratosAgent.com.atproto.repo.createRecord({
  repo: userDid,
  collection: 'zone.stratos.feed.post',
  record: {
    $type: 'zone.stratos.feed.post',
    text: 'This is a private post for my community!',
    boundary: {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: [
        {
          $type: 'zone.stratos.boundary.defs#Domain',
          value: 'did:web:stratos.example.com/general',
        },
      ],
    },
    createdAt: new Date().toISOString(),
  },
})
```

## Next Steps

- [User Enrollment](/client/enrollment) — check and initiate enrollment
- [Creating Records](/client/creating-records) — posts with images, replies, rich text
- [Reading Records](/client/reading-records) — direct access and AppView hydration
- [Domain Boundaries](/client/boundaries) — understand visibility rules
