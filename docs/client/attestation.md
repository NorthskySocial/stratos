# Attestation Verification

## Overview

Each enrolled user's enrollment record includes a _service attestation_ — a DAG-CBOR payload signed by the Stratos service's secp256k1 key. This enables AppViews to verify a user's enrollment and boundaries offline without querying the enrollment status endpoint on every request.

## Enrollment Record Fields

The `zone.stratos.actor.enrollment` record on the user's PDS includes:

| Field         | Type             | Description                       |
| ------------- | ---------------- | --------------------------------- |
| `service`     | string           | Stratos service endpoint URL      |
| `boundaries`  | `Domain[]`       | User's boundary assignments       |
| `signingKey`  | string (did:key) | User's P-256 public key           |
| `attestation` | object           | Service attestation of enrollment |
| `createdAt`   | string           | ISO 8601 enrollment timestamp     |

The `attestation` object:

| Field        | Type             | Description                                   |
| ------------ | ---------------- | --------------------------------------------- |
| `sig`        | bytes            | secp256k1 signature over the CBOR payload     |
| `signingKey` | string (did:key) | Service public key that created the signature |

## Using `stratos-client` for Key Resolution

The `stratos-client` package provides helpers to resolve the signing keys needed for verification. Results should be cached — keys don't change unless the service rotates them.

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

### Resolving user signing keys

```typescript
import { resolveUserSigningKey } from '@northskysocial/stratos-client'

// Resolve a user's per-actor signing key from their enrollment record
const userKey = await resolveUserSigningKey(
  pdsUrl,
  did,
  'did:web:stratos.example.com',
)
```

## Verifying an Attestation

Reconstruct the CBOR payload and check the signature:

```typescript
import { encode as cborEncode } from '@atcute/cbor'
import { verifySignature } from '@atproto/crypto'

async function verifyAttestation(
  enrollmentRecord: {
    signingKey: string
    attestation: { sig: Uint8Array; signingKey: string }
    boundaries: Array<{ value: string }>
  },
  userDid: string,
): Promise<boolean> {
  const sortedBoundaries = enrollmentRecord.boundaries
    .map((b) => b.value)
    .sort()

  const payload = cborEncode({
    boundaries: sortedBoundaries,
    did: userDid,
    signingKey: enrollmentRecord.signingKey,
  })

  return verifySignature(
    enrollmentRecord.attestation.signingKey,
    payload,
    enrollmentRecord.attestation.sig,
  )
}
```

::: warning Boundary sort order matters
The attestation payload encodes boundaries as a _sorted_ array. Reconstruct with `.sort()` or verification will fail.
:::

## Record-Level Verification

Stratos supports `com.atproto.sync.getRecord` which returns a CAR file containing an inclusion proof for a single record. Stratos maintains independent repositories per user. Record commits are signed with the user's per-enrollment P-256 key when available, falling back to the service's Secp256k1 key. This means standard ATproto verification against the user's PDS DID document will fail — clients must verify against either the user's enrollment `signingKey` or the Stratos service's signing key.

### Fetch and verify in one step

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

### Verification levels

Record commits are signed with the user's per-enrollment P-256 key. Clients can verify a record was authored by a specific user by checking the commit signature against the `signingKey` published in the user's enrollment record. The enrollment attestation (signed by the service's Secp256k1 key) binds the user's DID, boundaries, and signing key — establishing the service as the root of trust for that binding.

| Level               | What it proves                                                            |
| ------------------- | ------------------------------------------------------------------------- |
| `user-signature`    | Record was signed by the user's P-256 key (strongest — proves authorship) |
| `service-signature` | Record was signed by the Stratos service key (proves service inclusion)   |
| `cid-integrity`     | Record CID matches the commit tree (no signature check)                   |

`fetchAndVerifyRecord` prefers the user signing key when provided and falls back to the service key.

## Trust Model

The attestation proves the Stratos service vouched for the user's enrollment and boundaries _at signing time_. It does not prove:

- The user is still enrolled right now.
- The boundaries haven't changed since signing.

For high-stakes operations, also call the live status endpoint:

```
GET /xrpc/zone.stratos.enrollment.status?did=<did>
```

Authenticated callers receive boundaries, signing key, enrollment rkey, and a fresh attestation.

## Chained Verification

Because record commits are signed with the user's P-256 key, a verifier can chain trust:

<script setup>
import TrustChainAnimation from '../.vitepress/theme/components/TrustChainAnimation.vue'
</script>

<TrustChainAnimation />

This proves both service endorsement of the enrollment and user authorship of each record.
