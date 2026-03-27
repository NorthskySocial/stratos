# Best Practices

## 1. Always Check Enrollment First

Before showing Stratos UI, verify the user is enrolled:

```typescript
const enrolled = await isUserEnrolled(STRATOS_ENDPOINT, userDid)
if (!enrolled) {
  showEnrollmentPrompt()
}
```

## 2. Handle Access Errors Gracefully

Stratos returns 404 for both genuinely missing records and records the viewer can't access. Don't expose the distinction to users:

```typescript
try {
  const post = await getRecord(...)
} catch (err) {
  if (err.status === 404) {
    showMessage("This post isn't available")
  }
}
```

## 3. Default to the User's Primary Domain

Reduce friction in the composer by pre-selecting the first enrolled domain:

```typescript
const defaultDomains = userDomains.length > 0 ? [userDomains[0]] : []
```

## 4. Validate Domains Before Posting

Ensure selected domains are actually available to the user before submitting:

```typescript
const validDomains = selectedDomains.filter((d) => userDomains.includes(d))
if (validDomains.length === 0) {
  throw new Error('Select at least one valid domain')
}
```

## 5. Clear Visual Distinction

Always make it visually clear when content is private:

- Different background color or border
- Lock icon (🔒) on private posts
- Domain badges showing which communities can see the post
- Different composer placeholder text

## 6. Implement Retry with Backoff

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

## 7. Use the Stratos Agent Wrapper

Never override `agent.serviceUrl` after constructing an `OAuthSession` agent. Always use the `fetchHandler` wrapper:

```typescript
// ✅ Correct
const stratosAgent = new Agent((url, init) => {
  return session.fetchHandler(new URL(url, STRATOS_ENDPOINT).href, init)
})

// ❌ Wrong — silently sends to PDS
const stratosAgent = new Agent(session)
stratosAgent.serviceUrl = new URL(STRATOS_ENDPOINT)
```
