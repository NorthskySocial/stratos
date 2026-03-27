# User Enrollment

Before users can create Stratos records they must enroll with the Stratos service via OAuth.

## Checking Enrollment Status

```typescript
async function isUserEnrolled(
  stratosEndpoint: string,
  did: string,
): Promise<boolean> {
  const response = await fetch(
    `${stratosEndpoint}/xrpc/zone.stratos.enrollment.status?did=${encodeURIComponent(did)}`,
  )
  const data = await response.json()
  return data.enrolled === true
}
```

## Initiating Enrollment

Enrollment uses OAuth. Redirect the user to start the flow:

```typescript
function startEnrollment(stratosEndpoint: string, handle: string) {
  const url = `${stratosEndpoint}/oauth/authorize?handle=${encodeURIComponent(handle)}`
  window.location.href = url
}
```

## Complete Flow

```typescript
async function ensureEnrolled(
  stratosEndpoint: string,
  userHandle: string,
  userDid: string,
) {
  const enrolled = await isUserEnrolled(stratosEndpoint, userDid)
  if (enrolled) return true

  startEnrollment(stratosEndpoint, userHandle)
  return false
}
```

## Handling the OAuth Callback

After enrollment completes the user is redirected back to your app. Handle the callback:

```typescript
async function handleEnrollmentCallback() {
  const urlParams = new URLSearchParams(window.location.search)

  if (urlParams.get('error')) {
    console.error('Enrollment failed:', urlParams.get('error_description'))
    return { success: false, error: urlParams.get('error') }
  }

  return { success: true }
}
```

## Troubleshooting

**"NotEnrolled" after completing OAuth** — The service may have an allowlist. Contact the operator to request access.

**OAuth redirect fails** — Verify your app's callback URL matches the Stratos configuration and check for CORS issues in the browser console.
