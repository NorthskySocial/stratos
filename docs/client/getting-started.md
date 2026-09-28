# Getting Started

This guide explains how to integrate Stratos private namespace functionality into ATprotocol client
applications. It is based on how Stratos was integrated with [pdsls](https://pdsls.dev)
and maps patterns to the Bluesky [social-app](https://github.com/bluesky-social/social-app) codebase
as a reference architecture.

## What is Stratos?

Stratos enables private, domain-scoped content within ATprotocol. Users can create posts visible
only to members of specific groups or communities.

| Concept         | Description                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Stratos Service | A server that stores private records (separate from PDS)                                                                                      |
| Enrollment      | User must enroll with a Stratos service to create private content                                                                             |
| Domain Boundary | Specifies which community can view a record. Values are fully qualified as `{serviceDid}/{name}` (e.g. `did:web:stratos.example.com/general`) |
| Private Post    | A `zone.stratos.feed.post` record with boundary restrictions                                                                                  |

## The `stratos-client` Helper Library

The `@northskysocial/stratos-client` package provides the building blocks for enrollment discovery,
service routing, record verification, and OAuth scope management:

| Module       | What it provides                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| discovery    | `getEnrollmentByServiceDid()` — find enrollment for a specific service                                                                     |
| routing      | `createServiceFetchHandler()`, `resolveServiceUrl()`, `findEnrollmentByService()` — route XRPC calls to the correct Stratos service        |
| verification | `fetchAndVerifyRecord()`, `verifyCidIntegrity()`, `resolveServiceSigningKey()`, `resolveUserSigningKey()` — three-tier record verification |
| scopes       | `buildStratosScopes()`, `STRATOS_SCOPES` — build OAuth scope strings for Stratos collections                                               |

Install it alongside your AT Protocol client library:

```bash
npm install @northskysocial/stratos-client
```

::: tip When to use stratos-client vs. raw XRPC
The code examples in this guide show both approaches. Use `stratos-client` when you want concise,
tested helpers — use raw XRPC when you need full control or are using a framework that doesn't fit
the helper signatures.
:::

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

### 2. Discover Enrollment

Discover enrollment records from the user's PDS:

```typescript
import {
  getEnrollmentByServiceDid,
  resolveServiceUrl,
  resolveRepositoryTarget,
} from '@northskysocial/stratos-client'

const enrollment = await getEnrollmentByServiceDid(did, pdsUrl, serviceDid)
const serviceUrl = resolveServiceUrl(enrollment, pdsUrl)
```

`serviceUrl` identifies the Stratos authority. For repository writes, call
`resolveRepositoryTarget(enrollment, { authorityServiceUrl, authoritativeRepoHost,
sessionPdsUrl })`. Supply live authority answers or the PDS endpoint bound to the
authenticated session. The published `repoHost` is a hint and is not attested.
Stop when the result is `unresolved`.

Or discover the Stratos service endpoint from your app configuration:

```typescript
const STRATOS_ENDPOINT = 'https://stratos.example.com'
```

See [User Enrollment](/client/enrollment) for the full enrollment record schema and all discovery
variants.

### 3. Create a Stratos Agent

When using `@atproto/api` with an OAuth session, you **must** wrap the session's `fetchHandler` to
route requests to the Stratos service URL.

::: warning Common mistake
`new Agent(session)` followed by `agent.serviceUrl = new URL(stratosUrl)` will silently send
requests to the PDS instead of Stratos. The `OAuthSession` always resolves URLs against the OAuth
token's audience. Always use the wrapper pattern below.
:::

Using `stratos-client` (with `@atcute/client`):

```typescript
import { createServiceFetchHandler } from '@northskysocial/stratos-client'

const handler = createServiceFetchHandler(authenticatedHandler, serviceUrl)
const rpc = new Client({ handler })
```

Using `@atproto/api` directly:

```typescript
import { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-browser'

function createRepositoryAgent(
  session: OAuthSession,
  serviceUrl: string,
): Agent {
  return new Agent((url: string, init: RequestInit) => {
    const fullUrl = new URL(url, serviceUrl)
    return session.fetchHandler(fullUrl.href, init)
  })
}
```

### 4. Create a Private Post

```typescript
const target = resolveRepositoryTarget(enrollment, {
  authorityServiceUrl: STRATOS_ENDPOINT,
  sessionPdsUrl: pdsUrl,
})
if (target.kind === 'unresolved') throw new Error(target.reason)
const repositoryAgent = createRepositoryAgent(session, target.url)

if (target.kind === 'stratos')
  await repositoryAgent.com.atproto.repo.createRecord({
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

For PDS custody, use `com.atproto.space.createRecord` on the trusted PDS endpoint.
Pass `space: at://{authorityDid}/space/zone.stratos.space.feed/{spaceKey}`
alongside `repo`, `collection`, and `record`. The returned record URI has seven
segments and starts with the authority DID. A legacy repo write to the PDS
origin does not create a space record.

## Service Routing

Repository routing depends on custody. Stratos custody uses authority repo methods.
PDS custody uses space methods on the user's PDS.

When a user has multiple enrollments, select the target enrollment first (see
`findEnrollmentByService` in [User Enrollment](/client/enrollment)), then route using that
enrollment's service URL.

### Routing logic

```typescript
import { resolveServiceUrl } from '@northskysocial/stratos-client'

const url = resolveServiceUrl(enrollment, pdsUrl)
```

`resolveServiceUrl` returns the enrollment's service URL if enrolled, otherwise the fallback PDS
URL.

### Which operations route to Stratos

| Operation                            | Routes to Stratos?                |
| ------------------------------------ | --------------------------------- |
| `com.atproto.repo.getRecord`         | Yes (reads private records)       |
| `com.atproto.repo.listRecords`       | Yes (lists private collections)   |
| `com.atproto.repo.describeRepo`      | Yes (describes private repo)      |
| `com.atproto.repo.createRecord`      | Stratos custody only              |
| `com.atproto.repo.deleteRecord`      | Stratos custody only              |
| `com.atproto.repo.applyWrites`       | Stratos custody only              |
| `com.atproto.sync.getRecord`         | Yes (CAR export for verification) |
| `zone.stratos.space.listBlobs`       | Yes (lists blob CIDs in a space)  |
| `zone.stratos.sync.getRepo`          | Yes (full repo export as CAR)     |
| `zone.stratos.repo.importRepo`       | Yes (import repo from CAR)        |
| `zone.stratos.sync.subscribeRecords` | Yes (WebSocket firehose)          |
| `com.atproto.sync.getBlob`           | No (not yet implemented)          |

## DPoP-Aware Transport

Stratos endpoints require authenticated requests using the same DPoP credentials as the user's PDS
session. The key insight: _pass an absolute URL to the OAuth agent's fetch handler to redirect
requests to a different origin while keeping DPoP proof generation valid._

The underlying DPoP implementation derives `htu` (the HTTP URI claim in the DPoP proof JWT) from the
actual request URL. By passing an absolute URL with the Stratos origin, the proof is generated for
that origin rather than the PDS.

### Transport wrapper

This authority transport applies to `stratos` custody only. For `pds` custody, route to the
authenticated PDS host with space methods; see [Create a Private Post](#4-create-a-private-post).

```typescript
import { createServiceFetchHandler } from '@northskysocial/stratos-client'

// agent.handle is the FetchHandler from your OAuth session
if (enrollment.custody !== 'stratos')
  throw new Error('Expected Stratos custody')
const handler = createServiceFetchHandler(agent.handle, authorityServiceUrl)
```

`createServiceFetchHandler` accepts any `FetchHandler` from `@atcute/client` (a function
`(pathname, init) => Promise<Response>`) and returns a `FetchHandlerObject` that resolves relative
pathnames against the target service URL.

### Client construction

Construct the RPC client from the resolved target in [Create a Private Post](#4-create-a-private-post).
The enrollment's authority `service` URL is not the PDS repository host.

## Minimum Viable Adoption Path

For apps that want to add basic Stratos support incrementally:

### Step 1: Read-only hydration

1. Add enrollment discovery to session establishment
2. Store enrollment state
3. Add a Stratos mode toggle (settings or UI chrome)
4. For Stratos-custody records, route `getRecord` / `listRecords` through the authority client;
   for PDS-custody space records, use the trusted PDS target
5. Handle empty Stratos-custody collections gracefully (the enrolled repo may have no records yet)

### Step 2: Write routing

1. For `stratos` custody, route repo `createRecord` / `deleteRecord` / `applyWrites` through the
   authority client; for `pds` custody, use the corresponding space methods on the authenticated
   PDS target shown in [Create a Private Post](#4-create-a-private-post)
2. Add scope declarations to OAuth metadata
3. Add scope selector UI with dependency gating

### Step 3: Verification

1. Implement two-tier verification for Stratos records
2. Surface verification level in UI

### Step 4: Rich features

1. Boundary-aware UI (show boundary chips, filter by boundary)
2. AppView-side hydration for feed integration
3. Blob support when available

## social-app Integration Mapping

For a React Native/Expo app like Bluesky's social-app:

### State layer

| Concept            | social-app location           | Pattern                                                             |
| ------------------ | ----------------------------- | ------------------------------------------------------------------- |
| Enrollment state   | `src/state/stratos.tsx` (new) | React Context with `StratosEnrollment \| null \| undefined`         |
| Active mode toggle | `src/state/stratos.tsx` (new) | Boolean state with setter                                           |
| Discovery trigger  | `src/state/session/index.tsx` | Call `getEnrollmentByServiceDid` in `resumeSession` / `login` flows |
| Cleanup on logout  | `src/state/session/index.tsx` | Reset enrollment and active state in logout handler                 |

### Query hooks

| Hook                     | Location                             | Implementation                                  |
| ------------------------ | ------------------------------------ | ----------------------------------------------- |
| `useStratosEnrollment()` | `src/state/stratos.tsx`              | Context consumer returning enrollment state     |
| `useStratosActive()`     | `src/state/stratos.tsx`              | Context consumer returning active boolean       |
| `useStratosClient()`     | `src/state/queries/stratos.ts` (new) | Returns correctly-routed `Client` based on mode |

### Agent/transport

In `src/state/session/agent.ts`, the `BskyAppAgent` wraps transport. In a query hook, resolve the
repository target before constructing a client. Use authority repo methods for `stratos` custody;
use authenticated PDS space methods for `pds` custody. See
[Create a Private Post](#4-create-a-private-post) for the write route.

### View integration

| View            | Integration point                  | What changes                                            |
| --------------- | ---------------------------------- | ------------------------------------------------------- |
| Post thread     | `src/screens/PostThread/index.tsx` | Hydrate from Stratos when viewing boundary-scoped posts |
| Feed            | `src/state/queries/post-feed.ts`   | Include Stratos records in feed via hydration           |
| Settings        | `src/screens/Settings/`            | Stratos enrollment status, mode toggle                  |
| Record creation | Post composer                      | Select repo or space `createRecord` by custody          |

### Key differences from pdsls

| Aspect              | pdsls (SolidJS)        | social-app (React)                   |
| ------------------- | ---------------------- | ------------------------------------ |
| State               | `createSignal()`       | React Context / `useState`           |
| Reactivity          | Signal auto-tracking   | Query key invalidation / `useEffect` |
| Refetch trigger     | Resource source signal | Query key includes `stratosActive`   |
| Client construction | Per-call               | `useMemo` with deps or query hook    |

## Next Steps

- [User Enrollment](/client/enrollment) — enrollment record schema, discovery functions, attestation
  verification, OAuth scopes
- [Creating Records](/client/creating-records) — posts with images, replies, rich text
- [Reading Records](/client/reading-records) — direct access, read path integration, and verified
  reads
- [Domain Boundaries](/client/boundaries) — understand visibility rules
- [Attestation Verification](/client/attestation) — trust model, chained verification, signing keys
