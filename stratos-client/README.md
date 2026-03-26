# Stratos Client Integration Guide

This guide takes you through how to integrate Stratos into an ATProto client. It is based on how it was integrated with [pdsls](https://github.com/pdsls/pdsls) to test things out and maps patterns to the Bluesky [social-app](https://github.com/bluesky-social/social-app) codebase as a reference architecture so this should cover most use cases. If you see something missing open an issue (or PR) to cover it. The goal of the guide is to make it as easy and as straightforward as possible to integrate it, therefore we're just going to assume you are using the `atcute` package as it's fairly lightweight when compared `atproto` plus it is used in `stratos-client`.

The `@northskysocial/stratos-client` package provides the building blocks for enrollment discovery, service routing, record verification, and OAuth scope management. This guide shows how to wire it into your app.

1. [Enrollment discovery](#1-enrollment-discovery)
2. [Service routing](#2-service-routing)
3. [DPoP-aware transport](#3-dpop-aware-transport)
4. [Read path integration](#4-read-path-integration)
5. [Write path integration](#5-write-path-integration)
6. [Record verification](#6-record-verification)
7. [OAuth scope declarations](#7-oauth-scope-declarations)
8. [CORS and header requirements](#8-cors-and-header-requirements)
9. [Known pitfalls](#9-known-pitfalls)
10. [social-app mapping](#10-social-app-mapping)
11. [Minimum viable adoption path](#11-minimum-viable-adoption-path)

---

## 1. Enrollment Discovery

A user's Stratos enrollments are published as `zone.stratos.actor.enrollment` records on their PDS collection, created during the enrollment process via OAuth. Each enrollment record represents a connection to a different Stratos service — **a user can be enrolled in multiple Stratos services simultaneously**, with each enrollment stored as a separate record using the **service's DID** as the record key. This makes enrollment records deterministically addressable: knowing the service DID is sufficient to look up a specific enrollment. So as to prevent a confused deputy scenario, domains are also fully addressable using the service DID and stored this way.

The enrollment process initializes the user's Stratos repository with an empty signed commit, so the repo is immediately valid for reads and writes. A P-256 signing key is generated for the user and stored by the Stratos service — this key is used for signing record commits, making them verifiable against the `signingKey` published in the enrollment record. If the per-user key is unavailable, the service falls back to its own Secp256k1 key.

To discover a user's enrollments, list the enrollment collection via `com.atproto.repo.listRecords` on the user's PDS and verify each record using the service's public key.

### Enrollment record schema

Each enrollment record is stored at `at://<did>/zone.stratos.actor.enrollment/<service-did>` where `<service-did>` is the Stratos service's DID (e.g., `did:web:stratos.example.com`):

```json
{
  "service": "https://stratos.example.com",
  "boundaries": [
    { "value": "did:web:stratos.example.com/WestCoastBestCoast" },
    { "value": "did:web:stratos.example.com/TeaDrinkers" }
  ],
  "signingKey": "did:key:zDnae...",
  "attestation": {
    "sig": { "$bytes": "base64..." },
    "signingKey": "did:key:zDnae..."
  },
  "createdAt": "2025-01-15T00:00:00.000Z"
}
```

A user enrolled in two Stratos services would have two records in their collection:

```
at://did:plc:abc123/zone.stratos.actor.enrollment/did:web:service-a.example.com  → Service A
at://did:plc:abc123/zone.stratos.actor.enrollment/did:web:service-b.example.com  → Service B
```

| Field                    | Type                       | Description                                                                                          |
| ------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `service`                | `string` (URI)             | Stratos service endpoint where user's private data lives                                             |
| `boundaries`             | `Array<{ value: string }>` | Service-DID-qualified boundaries the user can access, each in `{serviceDid}/{domainName}` format     |
| `signingKey`             | `string` (did:key)         | User's P-256 public key, generated at enrollment and used to sign record commits                     |
| `attestation`            | `ServiceAttestation`       | Service attestation vouching for enrollment, boundaries, and signing key                             |
| `attestation.sig`        | `bytes`                    | Signature over DAG-CBOR encoded `{boundaries, did, signingKey}` (sorted keys), signed by service key |
| `attestation.signingKey` | `string` (did:key)         | The Stratos service's public key used to verify the attestation                                      |
| `createdAt`              | `string` (datetime)        | When the enrollment was created                                                                      |

### Discovery functions

```typescript
import {
  discoverEnrollments,
  discoverEnrollment,
} from '@northskysocial/stratos-client'
import type { StratosEnrollment } from '@northskysocial/stratos-client'

// Discover all enrollments (recommended for multi-service support)
const enrollments: StratosEnrollment[] = await discoverEnrollments(did, pdsUrl)

// Each enrollment includes its rkey for identification
enrollments.forEach((e) => {
  console.log(`Service: ${e.service}, rkey: ${e.rkey}`)
})

// Convenience: discover the first/only enrollment (backward-compatible)
const enrollment: StratosEnrollment | null = await discoverEnrollment(
  did,
  pdsUrl,
)

// With an existing FetchHandler (e.g. from an authenticated agent)
import type { FetchHandler } from '@atcute/client'
const all = await discoverEnrollments(did, agent.handle)
```

`discoverEnrollments` uses `com.atproto.repo.listRecords` to fetch all enrollment records from the collection, validates each record's shape, and includes the rkey from the record URI. `discoverEnrollment` is a convenience wrapper that returns the first enrollment or null.

### Direct lookup by service DID

When you already know which Stratos service you're looking for, use `getEnrollmentByServiceDid` for a direct O(1) lookup instead of listing all records:

```typescript
import {
  getEnrollmentByServiceDid,
  serviceDIDToRkey,
} from '@northskysocial/stratos-client'

// Direct lookup — no need to list and filter
const enrollment = await getEnrollmentByServiceDid(
  'did:plc:test123',
  'https://pds.example.com',
  'did:web:stratos.example.com',
)
if (enrollment) {
  console.log(`Enrolled in ${enrollment.service}`)
}
```

This calls `com.atproto.repo.getRecord` with the service DID as the rkey, which is more efficient than `listRecords` when targeting a specific service.

### Service DID to rkey conversion

AT Protocol rkeys cannot contain `%` characters, but `did:web` DIDs with ports use `%3A` encoding (e.g., `did:web:localhost%3A3100`). The `serviceDIDToRkey` helper handles this:

```typescript
import { serviceDIDToRkey } from '@northskysocial/stratos-client'

serviceDIDToRkey('did:web:stratos.example.com') // => 'did:web:stratos.example.com'
serviceDIDToRkey('did:web:localhost%3A3100') // => 'did:web:localhost:3100'
```

### Enrollment selection

When a user has multiple enrollments, select the right one by service URL:

```typescript
import { findEnrollmentByService } from '@northskysocial/stratos-client'

const enrollments = await discoverEnrollments(did, pdsUrl)
const target = findEnrollmentByService(
  enrollments,
  'https://stratos.example.com',
)
if (target) {
  // Route requests to this enrollment's service
}
```

### Boundary addressability

Boundaries are service-DID-qualified: each boundary `value` is stored in `{serviceDid}/{domainName}` format (e.g., `did:web:stratos.example.com/animal-lovers`). This makes every boundary globally addressable — the same domain name on two different Stratos services produces two distinct boundary values, so cross-enrollment conflicts are impossible by design.

```typescript
const enrollments = await discoverEnrollments(did, pdsUrl)

// Boundaries from different services are distinct by construction
enrollments.forEach((e) => {
  e.boundaries.forEach((b) => {
    // e.g. 'did:web:service-a.example.com/animal-lovers'
    //      'did:web:service-b.example.com/animal-lovers'
    console.log(b.value)
  })
})
```

Discovery should happen at session establishment (login/resume) and the result cached for the session lifetime. Reset enrollment state on account switch or logout.

### Verifying the attestation

The enrollment record's `attestation` field is signed by the Stratos service's private key. To verify the enrollment is authentic, resolve the service's public key from its DID document and check the signature over the DAG-CBOR encoded payload:

```typescript
import { encode as cborEncode } from '@atcute/cbor'
import { getPublicKeyFromDidController } from '@atcute/crypto'
import { getAtprotoVerificationMaterial } from '@atcute/identity'
import { WebDidDocumentResolver } from '@atcute/identity-resolver'
import type { StratosEnrollment } from '@northskysocial/stratos-client'

async function verifyEnrollmentAttestation(
  enrollment: StratosEnrollment,
  did: string,
): Promise<boolean> {
  const serviceDid = new URL(enrollment.service).hostname
    .replaceAll('.', ':')
    .replace(/^/, 'did:web:')

  const resolver = new WebDidDocumentResolver()
  const doc = await resolver.resolve(serviceDid as `did:web:${string}`)

  const material = getAtprotoVerificationMaterial(doc)
  if (!material) return false

  const { publicKeyBytes } = getPublicKeyFromDidController(material)

  // attestation payload is DAG-CBOR with sorted keys: {boundaries, did, signingKey}
  const boundaries = enrollment.boundaries.map((b) => b.value).sort()
  const payload = cborEncode({
    boundaries,
    did,
    signingKey: enrollment.signingKey,
  })

  const key = await crypto.subtle.importKey(
    'raw',
    publicKeyBytes,
    { name: 'ECDSA', namedCurve: 'K-256' },
    false,
    ['verify'],
  )

  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    enrollment.attestation.sig,
    payload,
  )
}
```

This confirms the Stratos service vouches for the user's DID, boundaries, and signing key binding. The service's `did:web` DID document is the root of trust — cache the resolved key to avoid repeated lookups.

---

## 2. Service Routing

The core routing decision is: _when reading/writing Stratos data and enrollment exists, route XRPC calls to the Stratos service URL instead of the user's PDS._

When a user has multiple enrollments, select the target enrollment first (see `findEnrollmentByService` in Section 1), then route using that enrollment's service URL.

### Routing logic

```typescript
import { resolveServiceUrl } from '@northskysocial/stratos-client'

const url = resolveServiceUrl(enrollment, pdsUrl)
```

`resolveServiceUrl` returns the enrollment's service URL if enrolled, otherwise the fallback PDS URL. Record creation/deletion always has the corresponding action to the PDS record referencing it.

### Routing applies to

| Operation                            | Routes to Stratos?                |
| ------------------------------------ | --------------------------------- |
| `com.atproto.repo.getRecord`         | Yes (reads private records)       |
| `com.atproto.repo.listRecords`       | Yes (lists private collections)   |
| `com.atproto.repo.describeRepo`      | Yes (describes private repo)      |
| `com.atproto.repo.createRecord`      | Yes (writes to Stratos)           |
| `com.atproto.repo.deleteRecord`      | Yes (deletes from Stratos)        |
| `com.atproto.repo.applyWrites`       | Yes (batch writes)                |
| `com.atproto.sync.getRecord`         | Yes (CAR export for verification) |
| `com.atproto.sync.listBlobs`         | Yes (lists blob CIDs)             |
| `zone.stratos.sync.getRepo`          | Yes (full repo export as CAR)     |
| `zone.stratos.repo.importRepo`       | Yes (import repo from CAR)        |
| `zone.stratos.sync.subscribeRecords` | Yes (WebSocket firehose)          |
| `com.atproto.sync.getBlob`           | No (not yet implemented)          |

---

## 3. DPoP-Aware Transport

Stratos endpoints require authenticated requests using the same DPoP credentials as the user's PDS session. The key insight: _pass an absolute URL to the OAuth agent's fetch handler to redirect requests to a different origin while keeping DPoP proof generation valid._

The underlying DPoP implementation derives `htu` (the HTTP URI claim in the DPoP proof JWT) from the actual request URL. By passing an absolute URL with the Stratos origin, the proof is generated for that origin rather than the PDS. The agent's session audience (PDS) is ignored per the URL specification when an absolute URL is provided.

### Transport wrapper

```typescript
import { createServiceFetchHandler } from '@northskysocial/stratos-client'

// agent.handle is the FetchHandler from your OAuth session
const handler = createServiceFetchHandler(agent.handle, enrollment.service)
```

`createServiceFetchHandler` accepts any `FetchHandler` from `@atcute/client` (a function `(pathname, init) => Promise<Response>`) and returns a `FetchHandlerObject` that resolves relative pathnames against the target service URL.

### Client construction

```typescript
import { Client } from '@atcute/client'
import { createServiceFetchHandler } from '@northskysocial/stratos-client'

const createServiceClient = (
  agent: OAuthUserAgent,
  enrollment: StratosEnrollment | null,
): Client => {
  if (enrollment) {
    return new Client({
      handler: createServiceFetchHandler(agent.handle, enrollment.service),
    })
  }
  return new Client({ handler: agent })
}
```

---

## 4. Read Path Integration

Views that display records, collections, or repo descriptions need to switch between PDS and Stratos sources based on the active mode.

### Pattern: reactive refetch on mode change

When the Stratos active state changes, refetch data. In React, this translates to including the active state in a query key:

```typescript
const { data } = useQuery({
  queryKey: ['record', uri, stratosActive],
  queryFn: () => fetchRecord(uri, stratosActive, enrollment),
})
```

### Pattern: client reset on mode switch

When Stratos mode toggles, any cached RPC client should be discarded since it may point to the wrong service. Rather than recreating the client on every fetch, cache the PDS and Stratos clients separately and select the right one based on mode:

```typescript
import { Client } from '@atcute/client'
import { createServiceFetchHandler } from '@northskysocial/stratos-client'

let pdsClient: Client | null = null
let stratosClient: Client | null = null

//pdsClient magic happens elsewhere

const getStratosClient = (
  agent: OAuthUserAgent,
  enrollment: StratosEnrollment,
): Client => {
  if (!stratosClient) {
    stratosClient = new Client({
      handler: createServiceFetchHandler(agent.handle, enrollment.service),
    })
  }
  return stratosClient
}

// On logout or account switch, drop both
const resetClients = () => {
  pdsClient = null
  stratosClient = null
}

const fetchRecords = async () => {
  const client = stratosActive && enrollment
    ? getStratosClient(agent, enrollment)
    : getPdsClient(agent)
  return client.get('com.atproto.repo.listRecords', { params: { ... } })
}
```

Mode toggles now just pick the other cached client — no teardown or reconstruction needed. Call `resetClients()` on logout or account switch to avoid stale sessions.

### Pattern: auth requirement in Stratos mode

Stratos endpoints require authentication. If the user is not signed in, display a clear message rather than attempting an anonymous fetch as the user will get access denied or simply not found error response:

```typescript
if (stratosActive && !agent) {
  throw new Error('Sign in to view Stratos records')
}
```

### Pattern: empty repo handling

Stratos initializes every enrolled user's repository with an empty signed commit at enrollment time. This means `describeRepo` and `getRepo` will always return a valid (possibly empty) repo for any enrolled user. A `describeRepo` call against an enrolled user will return an empty `collections` list until the first record is created — this is normal and should be rendered as an empty state, not an error.

If Stratos returns `RepoNotFound` for an enrolled user, treat it as a genuine error (service misconfiguration, auth failure, etc.) rather than an empty repo:

```typescript
if (error.name === 'RepoNotFound' && stratosActive) {
  // This should not happen for enrolled users — the repo is created at enrollment
  throw new Error('Stratos repo not found for enrolled user')
}
```

### Boundary gating: blobs

Stratos supports blob listing via `com.atproto.sync.listBlobs`. Blob content retrieval via `com.atproto.sync.getBlob` is not yet implemented — gate blob download UI behind availability checks.

---

## 5. Write Path Integration

Record creates, updates, and deletes should route through the service client when Stratos is active:

```typescript
const sessionAgent = new OAuthUserAgent(await getSession(repoDid))
const rpc = createServiceClient(sessionAgent, stratosActive, enrollment)

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

Batch operations (`com.atproto.repo.applyWrites`) work identically — route through the service client.

---

## 6. Record Verification

Stratos supports `com.atproto.sync.getRecord` which returns a CAR file containing an inclusion proof for a single record. Stratos maintains independent repositories per user. Record commits are signed with the user's per-enrollment P-256 key when available, falling back to the service's Secp256k1 key. This means standard ATproto verification against the user's PDS DID document will fail — clients must verify against either the user's enrollment `signingKey` or the Stratos service's signing key.

### Resolving the service signing key

Stratos services publish their signing public key in the `did:web` DID document as a Multikey `verificationMethod` with the standard `#atproto` fragment. Resolve it once and cache:

```typescript
import { resolveServiceSigningKey } from '@northskysocial/stratos-client'

// serviceDid is the service's did:web, e.g. 'did:web:stratos.example.com'
const signingKey = await resolveServiceSigningKey(serviceDid)

// With a custom fetch function
const signingKey2 = await resolveServiceSigningKey(serviceDid, {
  fetchFn: customFetch,
})
```

### Fetch + verify in one step

```typescript
import {
  fetchAndVerifyRecord,
  resolveUserSigningKey,
  resolveServiceSigningKey,
} from '@northskysocial/stratos-client'

// User-signature verification (strongest — proves authorship)
const userKey = await resolveUserSigningKey(pdsUrl, did, serviceDid)
const verified = await fetchAndVerifyRecord(serviceUrl, did, collection, rkey, {
  userSigningKey: userKey ?? undefined,
})

// Service-signature verification (proves service inclusion)
const serviceKey = await resolveServiceSigningKey(serviceDid)
const verified2 = await fetchAndVerifyRecord(
  serviceUrl,
  did,
  collection,
  rkey,
  {
    serviceSigningKey: serviceKey,
  },
)

// CID integrity only (no signature check)
const verified3 = await fetchAndVerifyRecord(serviceUrl, did, collection, rkey)
```

### Trust model

Record commits are signed with the user's per-enrollment P-256 key. Clients can verify a record was authored by a specific user by checking the commit signature against the `signingKey` published in the user's enrollment record. The enrollment attestation (signed by the service's Secp256k1 key) binds the user's DID, boundaries, and signing key — establishing the service as the root of trust for that binding.

Verification levels:

| Level               | What it proves                                                            |
| ------------------- | ------------------------------------------------------------------------- |
| `user-signature`    | Record was signed by the user's P-256 key (strongest — proves authorship) |
| `service-signature` | Record was signed by the Stratos service key (proves service inclusion)   |
| `cid-integrity`     | Record CID matches the commit tree (no signature check)                   |

`fetchAndVerifyRecord` prefers the user signing key when provided and falls back to the service key.

---

## 7. OAuth Scope Declarations

Stratos records use AT Protocol auth scopes. Clients should declare the scopes they need in their OAuth metadata and scope selector UI.

### Required scopes

| Scope                                | Description                   | Dependency                                    |
| ------------------------------------ | ----------------------------- | --------------------------------------------- |
| `repo:zone.stratos.actor.enrollment` | Read/write enrollment records | None                                          |
| `repo:zone.stratos.feed.post`        | Read/write Stratos posts      | Requires `repo:zone.stratos.actor.enrollment` |

### Scope utilities

```typescript
import {
  STRATOS_SCOPES,
  buildCollectionScope,
  buildStratosScopes,
} from '@northskysocial/stratos-client'

// Individual scope construction
const enrollmentScope = buildCollectionScope(STRATOS_SCOPES.enrollment)
// => 'repo:zone.stratos.actor.enrollment'

// Full scope set for OAuth metadata
const scopes = buildStratosScopes()
// => ['atproto',
//     'repo:zone.stratos.actor.enrollment',
//     'repo:zone.stratos.feed.post']
```

### OAuth client metadata

Add scopes to your `oauth-client-metadata.json`:

```json
{
  "scope": "atproto repo:zone.stratos.actor.enrollment repo:zone.stratos.feed.post"
}
```

---

## 8. CORS and Header Requirements

Browser clients making cross-origin requests to a Stratos service depend on correct CORS configuration. This is especially critical because the Stratos service is a different origin from the user's PDS.

### Required CORS headers

Stratos services using `@atcute/xrpc-server` get correct CORS behavior from the built-in middleware, which configures:

**Exposed response headers** (via `Access-Control-Expose-Headers`):

- `dpop-nonce` — required for DPoP nonce rotation
- `www-authenticate` — required for DPoP error recovery (e.g., `use_dpop_nonce`)
- `ratelimit-limit`, `ratelimit-policy`, `ratelimit-remaining`, `ratelimit-reset`

**Allowed request headers** (via `Access-Control-Allow-Headers`):

- `authorization` — carries the DPoP-bound access token
- `dpop` — carries the DPoP proof JWT
- `content-type`
- `atproto-accept-labelers`, `atproto-proxy`

### Why this matters

When a browser client sends a DPoP-authenticated request to a Stratos service at a different origin:

1. The browser performs a CORS preflight (`OPTIONS`) request
2. The Stratos service must respond with `Access-Control-Allow-Headers` including `authorization` and `dpop`
3. On the actual response, `Access-Control-Expose-Headers` must include `dpop-nonce` so the client can read the server's nonce for subsequent requests
4. If `www-authenticate` is not exposed, the client cannot parse DPoP error details (like `use_dpop_nonce`) from 401 responses

### If you run your own Stratos service

If using `@atproto/xrpc-server`, the defaults are correct. If using another framework directly, configure:

```typescript
app.use((req, res, next) => {
  const origin = req.headers.origin || '*'
  res.header('Access-Control-Allow-Origin', origin)
  res.header(
    'Access-Control-Allow-Headers',
    'authorization, dpop, content-type, atproto-accept-labelers, atproto-proxy',
  )
  res.header('Access-Control-Expose-Headers', 'dpop-nonce, www-authenticate')
  if (req.method === 'OPTIONS') {
    res.header('Access-Control-Max-Age', '86400')
    return res.sendStatus(204)
  }
  next()
})
```

### Failure symptoms

| Missing header                         | Symptom                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `dpop` not in allowed headers          | Preflight fails; all authenticated requests return CORS errors              |
| `dpop-nonce` not exposed               | Client cannot read nonce; subsequent DPoP proofs use stale nonce → 401 loop |
| `www-authenticate` not exposed         | Client cannot parse `use_dpop_nonce` error; falls into generic auth failure |
| `authorization` not in allowed headers | Access token never sent; all requests return 401                            |

---

## 9. Known Pitfalls

### Async discovery race condition

If enrollment discovery is fire-and-forget, account switches can cause stale enrollment data:

```typescript
// Problem: if user switches accounts before discovery completes,
// setEnrollment updates state for the wrong account
discoverEnrollment(did, pds)
  .then(setEnrollment)
  .catch(() => setEnrollment(null))
```

Key discovery to the active session and cancel on account change:

```typescript
// React pattern
useEffect(() => {
  let cancelled = false
  discoverEnrollment(did, pds).then((enrollment) => {
    if (!cancelled) setEnrollment(enrollment)
  })
  return () => {
    cancelled = true
  }
}, [did])
```

### Global mode state leakage

If Stratos active/inactive is stored as app-global state, unrelated views can inadvertently route to the wrong service. Prefer scoping the mode to a specific context or view rather than making it global — or guard every routing decision with an explicit mode check.

### Verification level ambiguity

Stratos mode may fall back from full MST verification to CID-only verification. This should be clearly communicated to users — "CID verified" means data integrity is confirmed but the commit chain and signature are not verified. Don't label CID-only verification as "verified" without qualification.

### Empty repo vs. error masking

Stratos initializes a signed empty commit at enrollment time, so every enrolled user has a valid repository from the start. `RepoNotFound` for an enrolled user is always an error — it no longer indicates "no records yet." Possible causes:

- The Stratos service is unreachable or misconfigured
- Authentication failed silently
- The actor store was not properly initialized during enrollment

An empty `collections` list from `describeRepo` is the normal state for a user who hasn't created records yet. Differentiate by checking HTTP status codes explicitly rather than catching all errors as "empty."

### DPoP `htu` claim accuracy

The DPoP proof's `htu` claim must match the actual request URL. When routing through a service fetch handler, ensure the absolute URL is passed to the agent's `handle()` method — not a relative path — so the DPoP proof targets the correct origin. The `@atcute/oauth-browser-client` agent derives `htu` from the URL it receives.

### Blob operations

`com.atproto.sync.getBlob` is not yet implemented by Stratos. Blob listing via `com.atproto.sync.listBlobs` is available. Gate blob download/display UI behind availability checks until `getBlob` is supported.

---

## 10. social-app Mapping

For a React Native/Expo app like Bluesky's social-app:

### State layer

| Concept            | social-app location           | Pattern                                                                                            |
| ------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| Enrollment state   | `src/state/stratos.tsx` (new) | React Context with `StratosEnrollment \| null \| undefined`                                        |
| Active mode toggle | `src/state/stratos.tsx` (new) | Boolean state with setter                                                                          |
| Discovery trigger  | `src/state/session/index.tsx` | Call `discoverEnrollment` from `@northskysocial/stratos-client` in `resumeSession` / `login` flows |
| Cleanup on logout  | `src/state/session/index.tsx` | Reset enrollment and active state in logout handler                                                |

### Query hooks

| Hook                     | Location                             | Implementation                                  |
| ------------------------ | ------------------------------------ | ----------------------------------------------- |
| `useStratosEnrollment()` | `src/state/stratos.tsx`              | Context consumer returning enrollment state     |
| `useStratosActive()`     | `src/state/stratos.tsx`              | Context consumer returning active boolean       |
| `useStratosClient()`     | `src/state/queries/stratos.ts` (new) | Returns correctly-routed `Client` based on mode |

### Agent/transport

In `src/state/session/agent.ts`, the `BskyAppAgent` wraps transport. For Stratos routing, create a parallel agent or intercept at the fetch handler level:

```typescript
import { createServiceFetchHandler } from '@northskysocial/stratos-client'
import { Client } from '@atcute/client'

// In a query hook or utility
const agent = useAgent()
const { active, enrollment } = useStratos()
const client = enrollment
  ? new Client({
      handler: createServiceFetchHandler(agent.handle, enrollment.service),
    })
  : new Client({ handler: agent })
```

### View integration

| View            | Integration point                  | What changes                                            |
| --------------- | ---------------------------------- | ------------------------------------------------------- |
| Post thread     | `src/screens/PostThread/index.tsx` | Hydrate from Stratos when viewing boundary-scoped posts |
| Feed            | `src/state/queries/post-feed.ts`   | Include Stratos records in feed via hydration           |
| Settings        | `src/screens/Settings/`            | Stratos enrollment status, mode toggle                  |
| Record creation | Post composer                      | Route `createRecord` through service client             |

### Key differences from pdsls

| Aspect              | pdsls (SolidJS)        | social-app (React)                   |
| ------------------- | ---------------------- | ------------------------------------ |
| State               | `createSignal()`       | React Context / `useState`           |
| Reactivity          | Signal auto-tracking   | Query key invalidation / `useEffect` |
| Refetch trigger     | Resource source signal | Query key includes `stratosActive`   |
| Client construction | Per-call               | `useMemo` with deps or query hook    |

---

## 11. Minimum Viable Adoption Path

For apps that want to add basic Stratos support incrementally:

### Step 1: Read-only hydration

1. Add enrollment discovery to session establishment
2. Store enrollment state
3. Add a Stratos mode toggle (settings or UI chrome)
4. In record/thread views, when Stratos is active, route `getRecord` / `listRecords` through the service client
5. Handle empty collections gracefully (enrolled users always have a valid repo, but it may have no records yet)

### Step 2: Write routing

1. Route `createRecord` / `deleteRecord` / `applyWrites` through service client when active
2. Add scope declarations to OAuth metadata
3. Add scope selector UI with dependency gating

### Step 3: Verification

1. Implement two-tier verification for Stratos records
2. Surface verification level in UI

### Step 4: Rich features

1. Boundary-aware UI (show boundary chips, filter by boundary)
2. AppView-side hydration for feed integration
3. Blob support when available
