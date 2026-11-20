---
audience: App developers
type: Guide
status: current
---

# Best Practices

## 1. Use the `stratos-client` helpers

`@northskysocial/stratos-client` has tested helpers for discovery, routing,
verification, and scopes. Prefer them to hand-written versions:

```typescript
import {
  getEnrollmentByServiceDid,
  resolveRepositoryTarget,
  createServiceFetchHandler,
  verifyEnrollmentAttestation,
  verifyRecordCid,
  buildStratosScopes,
} from '@northskysocial/stratos-client'
```

[Getting Started](/client/getting-started) shows where each one fits.

## 2. Check enrollment first

Show Stratos UI only to an enrolled user:

```typescript
import { getEnrollmentByServiceDid } from '@northskysocial/stratos-client'

async function isEnrolled(
  userDid: string,
  pdsUrl: string,
  serviceDid: string,
): Promise<boolean> {
  const enrollment = await getEnrollmentByServiceDid(
    userDid,
    pdsUrl,
    serviceDid,
  )
  return enrollment !== null
}
```

## 3. Route by custody, from trusted hosts

Resolve the repository target before every write path. Take the Stratos URL
from your configuration and the PDS URL from the signed-in session. Do not
send credentials to `enrollment.service` or `enrollment.repoHost`; the
attestation does not cover them.

```typescript
import { resolveRepositoryTarget } from '@northskysocial/stratos-client'
import type { StratosEnrollment } from '@northskysocial/stratos-client'

function canWrite(
  enrollment: StratosEnrollment | null,
  stratosUrl: string,
  sessionPdsUrl: string,
): boolean {
  const target = resolveRepositoryTarget(enrollment, {
    authorityServiceUrl: stratosUrl,
    sessionPdsUrl,
  })
  return target.kind !== 'unresolved'
}
```

See [Custody and Routing](/client/custody).

## 4. Handle access errors gracefully

Stratos answers `400 RecordNotFound` for a missing record and for a record
the viewer may not read. Show one message for both:

```typescript
interface XrpcError {
  error: string
  message?: string
}

function describeReadError(status: number, body: XrpcError): string {
  if (status === 400 && body.error === 'RecordNotFound') {
    return "This post isn't available"
  }
  return 'Something went wrong'
}
```

## 5. One boundary per post

A post belongs to exactly one boundary. Preselect the user's first boundary
and let them change it:

```typescript
function defaultBoundary(userBoundaries: string[]): string | null {
  return userBoundaries[0] ?? null
}
```

Check the selection before you submit. Stratos rejects a boundary the user
does not hold with `ForbiddenBoundary`:

```typescript
function assertUserHolds(boundary: string, userBoundaries: string[]): void {
  if (!userBoundaries.includes(boundary)) {
    throw new Error('Select one of your boundaries')
  }
}
```

## 6. Make private content look private

- A different background color or border
- A lock icon on private posts
- A badge with the boundary name
- A different composer placeholder

## 7. Retry with backoff on 429

Stratos limits writes per DID. The default is 300 writes per 60 seconds. A
limited request answers `429 RateLimitExceeded`:

```typescript
async function withRetry<T>(
  send: () => Promise<Response>,
  parse: (response: Response) => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await send()
    if (response.status !== 429 || attempt >= maxAttempts - 1) {
      return parse(response)
    }
    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000))
  }
}
```

## 8. Pass absolute URLs to the session fetch handler

Never override `agent.serviceUrl` on an agent built from an OAuth session. The
request still goes to the session's PDS. Pass the absolute target URL
instead, so the DPoP proof names the right origin:

```typescript
import { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-browser'

// Correct
function createStratosAgent(session: OAuthSession, stratosUrl: string): Agent {
  return new Agent((url: string, init: RequestInit) =>
    session.fetchHandler(new URL(url, stratosUrl).href, init),
  )
}

// Wrong: requests still go to the PDS
function createBrokenAgent(session: OAuthSession, stratosUrl: string): Agent {
  const agent = new Agent(session)
  agent.serviceUrl = new URL(stratosUrl)
  return agent
}
```

Use this agent for `stratos` custody only.

## 9. Cache signing keys

`resolveServiceSigningKey` fetches a DID document. `resolveUserSigningKey`
fetches an enrollment record. Cache both:

```typescript
import {
  resolveServiceSigningKey,
  resolveUserSigningKey,
} from '@northskysocial/stratos-client'

const serviceKeyCache = new Map()

async function loadKeys(pdsUrl: string, userDid: string, serviceDid: string) {
  // The cache map keeps one key per service DID.
  const serviceKey = await resolveServiceSigningKey(serviceDid, {
    cache: serviceKeyCache,
  })
  // Cache this yourself, per user and service.
  const userKey = await resolveUserSigningKey(pdsUrl, userDid, serviceDid)
  return { serviceKey, userKey }
}
```

## 10. Never trust a boundary on a PDS-hosted record

A PDS accepts any write its owner makes. A record in a Stratos space on a
user's PDS proves nothing about membership. Read private feeds through the
feed generator, which checks membership with Stratos.
