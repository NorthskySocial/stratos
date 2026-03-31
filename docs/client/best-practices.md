# Best Practices

## 1. Use `stratos-client` Helpers

The `@northskysocial/stratos-client` package provides tested, composable helpers for discovery,
routing, verification, and OAuth scopes. Prefer these over hand-rolling the same logic:

```typescript
import {
  discoverEnrollment,
  createServiceFetchHandler,
  resolveServiceUrl,
  fetchAndVerifyRecord,
  buildStratosScopes,
} from '@northskysocial/stratos-client'
```

See the [Getting Started](/client/getting-started) guide for how each helper maps to an integration
step.

## 2. Always Check Enrollment First

Before showing Stratos UI, verify the user is enrolled:

```typescript
import { discoverEnrollment } from '@northskysocial/stratos-client'

const enrollment = await discoverEnrollment(did, pdsUrl)
if (!enrollment) {
  showEnrollmentPrompt()
}
```

## 3. Handle Access Errors Gracefully

Stratos returns 404 for both genuinely missing records and records the viewer can't access. Don't
expose the distinction to users:

```typescript
try {
  const post = await getRecord(...)
} catch (err) {
  if (err.status === 404) {
    showMessage("This post isn't available")
  }
}
```

## 4. Default to the User's Primary Domain

Reduce friction in the composer by pre-selecting the first enrolled domain:

```typescript
const defaultDomains = userDomains.length > 0 ? [userDomains[0]] : []
```

## 5. Validate Domains Before Posting

Ensure selected domains are actually available to the user before submitting:

```typescript
const validDomains = selectedDomains.filter((d) => userDomains.includes(d))
if (validDomains.length === 0) {
  throw new Error('Select at least one valid domain')
}
```

## 6. Clear Visual Distinction

Always make it visually clear when content is private:

- Different background color or border
- Lock icon (🔒) on private posts
- Domain badges showing which communities can see the post
- Different composer placeholder text

## 7. Implement Retry with Backoff

Handle 429 rate-limit responses:

```typescript
async function createWithRetry(fn: () => Promise<unknown>, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn()
    } catch (err) {
      if (err.status === 429 && i < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, Math.pow(2, i) * 1000))
        continue
      }
      throw err
    }
  }
}
```

## 8. Use the Stratos Agent Wrapper

Never override `agent.serviceUrl` after constructing an `OAuthSession` agent. Always use the
`fetchHandler` wrapper:

```typescript
// Correct — using stratos-client
import { createServiceFetchHandler } from '@northskysocial/stratos-client'
const handler = createServiceFetchHandler(
  authenticatedHandler,
  STRATOS_ENDPOINT,
)

// Correct — using @atproto/api
const stratosAgent = new Agent((url, init) => {
  return session.fetchHandler(new URL(url, STRATOS_ENDPOINT).href, init)
})

// Wrong — silently sends to PDS
const stratosAgent = new Agent(session)
stratosAgent.serviceUrl = new URL(STRATOS_ENDPOINT)
```

## 9. Cache Signing Keys

Both `resolveServiceSigningKey()` and `resolveUserSigningKey()` make network calls to resolve DID
documents and enrollment records. Cache the results:

```typescript
import {
  resolveServiceSigningKey,
  resolveUserSigningKey,
} from '@northskysocial/stratos-client'

// Cache per service DID — only changes on key rotation
const serviceKey = await resolveServiceSigningKey('did:web:stratos.example.com')

// Cache per (did, serviceDid) pair
const userKey = await resolveUserSigningKey(
  pdsUrl,
  did,
  'did:web:stratos.example.com',
)
```
