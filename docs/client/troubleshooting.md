# Troubleshooting

## "NotEnrolled" After Completing OAuth

The Stratos service may have an allowlist. Contact the service operator to request access. You can verify the current enrollment status directly:

```bash
curl "https://stratos.example.com/xrpc/zone.stratos.enrollment.status?did=<your-did>"
```

## Posts Not Appearing in Feed

1. Check that the post's boundary domains match at least one of the viewer's enrolled domains.
2. Verify the AppView has indexed the Stratos content — indexing can lag by a few seconds.
3. Confirm the post was created successfully by checking the returned AT-URI.

## OAuth Redirect Fails

1. Verify your app's callback URL is listed in the Stratos `redirect_uris` configuration.
2. Check for CORS errors in the browser console.
3. Ensure the user's PDS supports ATProtocol OAuth.

## Requests Go to PDS Instead of Stratos

You're likely using `new Agent(session)` and then trying to override `serviceUrl`. Use the fetch handler wrapper instead — see [Getting Started](/client/getting-started#_3-create-a-stratos-agent).

## Rate Limiting (429 errors)

Implement exponential backoff. The default rate limit is 300 writes per 60-second window per DID. If you're building a bulk import tool, use `zone.stratos.repo.importRepo` instead of individual `createRecord` calls.

## DPoP Nonce Errors

If you receive `use_dpop_nonce` errors, extract the nonce from the `DPoP-Nonce` response header and include it in the next request's DPoP proof. Ensure `DPoP-Nonce` is listed in your nginx/proxy `Access-Control-Expose-Headers`.

## Record Returns 404 for Enrolled User

The viewer may not share a boundary with the record. Stratos returns 404 (not 403) for boundary access failures to avoid leaking record existence.

## CORS and Header Requirements

Browser clients making cross-origin requests to a Stratos service depend on correct CORS configuration. This is critical because the Stratos service is a different origin from the user's PDS.

### Required CORS headers

Stratos services using `@atcute/xrpc-server` get correct CORS behavior from the built-in middleware. If using another framework, configure these:

**Exposed response headers** (via `Access-Control-Expose-Headers`):

- `dpop-nonce` — required for DPoP nonce rotation
- `www-authenticate` — required for DPoP error recovery (e.g., `use_dpop_nonce`)
- `ratelimit-limit`, `ratelimit-policy`, `ratelimit-remaining`, `ratelimit-reset`

**Allowed request headers** (via `Access-Control-Allow-Headers`):

- `authorization` — carries the DPoP-bound access token
- `dpop` — carries the DPoP proof JWT
- `content-type`
- `atproto-accept-labelers`, `atproto-proxy`

### CORS flow

When a browser client sends a DPoP-authenticated request to a Stratos service at a different origin:

1. The browser performs a CORS preflight (`OPTIONS`) request
2. The Stratos service must respond with `Access-Control-Allow-Headers` including `authorization` and `dpop`
3. On the actual response, `Access-Control-Expose-Headers` must include `dpop-nonce` so the client can read the server's nonce for subsequent requests
4. If `www-authenticate` is not exposed, the client cannot parse DPoP error details (like `use_dpop_nonce`) from 401 responses

### Custom CORS configuration

If not using `@atcute/xrpc-server`:

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

### CORS failure symptoms

| Missing header                         | Symptom                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `dpop` not in allowed headers          | Preflight fails; all authenticated requests return CORS errors              |
| `dpop-nonce` not exposed               | Client cannot read nonce; subsequent DPoP proofs use stale nonce → 401 loop |
| `www-authenticate` not exposed         | Client cannot parse `use_dpop_nonce` error; falls into generic auth failure |
| `authorization` not in allowed headers | Access token never sent; all requests return 401                            |

## Known Pitfalls

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

Stratos may fall back from full MST verification to CID-only verification. This should be clearly communicated to users — "CID verified" means data integrity is confirmed but the commit chain and signature are not verified. Don't label CID-only verification as "verified" without qualification.

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
