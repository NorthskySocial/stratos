# User Enrollment

Before users can create Stratos records they must enroll with the Stratos service via OAuth.

## Enrollment Record Schema

A user's Stratos enrollments are published as `zone.stratos.actor.enrollment` records on their PDS,
created during the enrollment process. Each enrollment record represents a connection to a different
Stratos service — _a user can be enrolled in multiple Stratos services simultaneously_, with each
enrollment stored as a separate record using the service's DID as the record key.

Each enrollment record is stored at `at://<did>/zone.stratos.actor.enrollment/<service-did>`:

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

A user enrolled in two Stratos services would have two records:

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

The enrollment process initializes the user's Stratos repository with an empty signed commit, so the
repo is immediately valid for reads and writes. A P-256 signing key is generated and stored by the
Stratos service — this key signs record commits, making them verifiable against the `signingKey`
published in the enrollment record. If the per-user key is unavailable, the service falls back to
its own Secp256k1 key.

## Checking Enrollment Status

### Discovery functions

`getEnrollmentByServiceDid` uses `com.atproto.repo.getRecord` with the service DID as the rkey
for a direct O(1) lookup. This is more efficient than listing all records when targeting a
specific service.

```typescript
import { getEnrollmentByServiceDid } from '@northskysocial/stratos-client'
import type { StratosEnrollment } from '@northskysocial/stratos-client'

// Direct lookup by service DID (recommended)
const enrollment: StratosEnrollment | null = await getEnrollmentByServiceDid(
  did,
  pdsUrl,
  'did:web:stratos.example.com',
)

if (enrollment) {
  console.log(`Service: ${enrollment.service}, rkey: ${enrollment.rkey}`)
}

// With an existing FetchHandler (e.g. from an authenticated agent)
import type { FetchHandler } from '@atcute/client'

const target = await getEnrollmentByServiceDid(did, agent.handle, serviceDid)
```

### Direct lookup by service DID

When you already know which Stratos service you're looking for, use `getEnrollmentByServiceDid` for
a direct O(1) lookup instead of listing all records:

```typescript
import {
  getEnrollmentByServiceDid,
  serviceDIDToRkey,
} from '@northskysocial/stratos-client'

const enrollment = await getEnrollmentByServiceDid(
  'did:plc:test123',
  'https://pds.example.com',
  'did:web:stratos.example.com',
)
if (enrollment) {
  console.log(`Enrolled in ${enrollment.service}`)
}
```

This calls `com.atproto.repo.getRecord` with the service DID as the rkey, which is more efficient
than `listRecords` when targeting a specific service.

### Service DID to rkey conversion

AT Protocol rkeys cannot contain `%` characters, but `did:web` DIDs with ports use `%3A` encoding (
e.g., `did:web:localhost%3A3100`). The `serviceDIDToRkey` helper handles this:

```typescript
import { serviceDIDToRkey } from '@northskysocial/stratos-client'

serviceDIDToRkey('did:web:stratos.example.com') // => 'did:web:stratos.example.com'
serviceDIDToRkey('did:web:localhost%3A3100') // => 'did:web:localhost:3100'
```

### Enrollment selection

When a user has multiple enrollments, you can find the right one by iterating or using direct lookups if you have the service DIDs. `getEnrollmentByServiceDid` is the preferred way to retrieve a specific enrollment.

### Using raw XRPC

Check enrollment status via the Stratos service endpoint:

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

Boundaries are service-DID-qualified: each boundary `value` is stored in `{serviceDid}/{domainName}`
format (e.g., `did:web:stratos.example.com/animal-lovers`). This makes every boundary globally
addressable — the same domain name on two different Stratos services produces two distinct boundary
values, so cross-enrollment conflicts are impossible by design.

Discovery should happen at session establishment (login/resume) and the result cached for the
session lifetime. Reset enrollment state on account switch or logout.

## Verifying the Attestation

The enrollment record's `attestation` field is signed by the Stratos service's private key. To
verify the enrollment is authentic, resolve the service's public key from its DID document and check
the signature over the DAG-CBOR encoded payload:

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

This confirms the Stratos service vouches for the user's DID, boundaries, and signing key binding.
The service's `did:web` DID document is the root of trust — cache the resolved key to avoid repeated
lookups.

See [Attestation Verification](/client/attestation) for the full trust model and chained
verification.

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

## OAuth Scopes

Stratos records use AT Protocol auth scopes. Clients should declare the scopes they need in their
OAuth metadata and scope selector UI.

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

## Troubleshooting

_"NotEnrolled" after completing OAuth_ — The service may have an allowlist. Contact the operator to
request access.

_OAuth redirect fails_ — Verify your app's callback URL matches the Stratos configuration and check
for CORS issues in the browser console.
