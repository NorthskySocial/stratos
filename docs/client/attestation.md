# Attestation Verification

<script setup>
import TrustChainAnimation from '../.vitepress/theme/components/TrustChainAnimation.vue'
</script>

The note on a guest's door says "I am a guest at this house." Anyone could
write such a note. So the host signs it. The signature is the attestation: a
passer-by can check it against the host's known signature without knocking.

The enrollment record on a user's PDS is that note. The attestation inside it
is the Stratos service's signature. It lets any app confirm an enrollment
without a call to Stratos.

## What the attestation covers

The service signs the DAG-CBOR encoding of four values:

| Value        | Source                                          |
| ------------ | ----------------------------------------------- |
| `boundaries` | The user's boundary values, sorted              |
| `did`        | The user's DID                                  |
| `signingKey` | The `signingKey` field of the enrollment record |
| `issuedAt`   | The `attestation.issuedAt` field                |

Older attestations have no `issuedAt`, in the record or in the payload.

The attestation does not cover `service`, `custody`, `repoHost`, or
`createdAt`. Treat those fields as hints. See
[Custody and Routing](/client/custody#reading-custody-from-the-enrollment).

The `attestation` object in the record:

| Field        | Type              | Description                                      |
| ------------ | ----------------- | ------------------------------------------------ |
| `sig`        | bytes             | The signature over the payload                   |
| `signingKey` | string (did:key)  | The service key that made the signature          |
| `issuedAt`   | string (datetime) | Signed issue time. Absent on older attestations. |

## Verifying an attestation

```typescript
import { verifyEnrollmentAttestation } from '@northskysocial/stratos-client'
import type {
  AttestationResult,
  StratosEnrollment,
} from '@northskysocial/stratos-client'

async function checkEnrollment(
  enrollment: StratosEnrollment,
  userDid: string,
): Promise<AttestationResult> {
  return verifyEnrollmentAttestation(enrollment, userDid, {
    serviceDid: 'did:web:stratos.example.com',
  })
}
```

`serviceDid` is required. Take it from your configuration, never from the
record. The key embedded in the attestation proves only that some key signed
the payload. The verifier ties that key to the service identity in two ways:

- It matches the key in the service's current DID document.
- Or the key is retired. The verifier then fetches
  `zone.stratos.identity.getKeyHistory`, checks the signed history, and
  confirms that `issuedAt` falls inside that key's validity window.

An attestation without `issuedAt` passes only against the current key.

The function never throws. The result has `valid`, `serviceKey`,
`userSigningKey`, `boundaries`, and an `error` string when `valid` is `false`.

The options also accept `fetchFn` and `cache`.
[Service Key History](/architecture/service-key-history) describes rotation
and its trust limits.

## Resolving keys

### The service signing key

A Stratos service publishes its public key in its `did:web` document, as a
Multikey verification method with the `#atproto` fragment.

```typescript
import { resolveServiceSigningKey } from '@northskysocial/stratos-client'

const keyCache = new Map()

async function getServiceKey(serviceDid: string) {
  return resolveServiceSigningKey(serviceDid, { cache: keyCache })
}
```

With a `cache` map, the function reads the map before it fetches and writes
to it after a successful fetch. It accepts only `did:web` DIDs.

### The user signing key

```typescript
import { resolveUserSigningKey } from '@northskysocial/stratos-client'

async function getUserKey(pdsUrl: string, userDid: string) {
  return resolveUserSigningKey(pdsUrl, userDid, 'did:web:stratos.example.com')
}
```

The function reads the enrollment record and decodes its `signingKey`. It
returns `null` when the user has no enrollment for that service. Cache the
result per user and service.

What that key is depends on custody:

| Custody   | `signingKey`                                                  |
| --------- | ------------------------------------------------------------- |
| `stratos` | A P-256 key. Stratos generates it at enrollment and holds it. |
| `pds`     | The user's own `#atproto` key from their DID document.        |

## Record verification

Stratos-hosted commits are signed with the user's P-256 key, not with the
service key. Standard AT Protocol verification against the user's DID
document fails for these repos. The key to check is the enrollment
`signingKey`.

What a client can check today:

| Source of the record                        | Check                                            | Level           |
| ------------------------------------------- | ------------------------------------------------ | --------------- |
| `com.atproto.repo.getRecord` on Stratos     | `verifyRecordCid(value, cid)`                    | `cid-integrity` |
| The owner's `zone.stratos.sync.getRepo` CAR | `verifyCidIntegrity(car, collection, rkey, did)` | `cid-integrity` |

`cid-integrity` proves the content matches its CID. It does not prove
authorship. Say so in your UI. Do not label it "verified" without a
qualifier.

The library defines two more levels, `user-signature` and
`service-signature`. `fetchAndVerifyRecord` returns them, but it depends on
`com.atproto.sync.getRecord`, which the Stratos service no longer serves. The
call fails against a current service. See
[Reading Records](/client/reading-records#verifying-what-you-read).

## Trust model

The attestation proves that the service vouched for the enrollment and the
boundaries at signing time. It does not prove:

- that the user is still enrolled now
- that the boundaries are unchanged

It is a statement of enrollment, not a permission to read. Stratos and the
feed generator check current membership on every request.

For a decision that matters, ask the service:

```http
GET /xrpc/zone.stratos.enrollment.status?did=<did>
```

An authenticated call returns the current boundaries. It also returns a fresh
attestation when the DID holds at least one boundary.

## Chained verification

For `stratos` custody the checks chain together. The service DID document
names the service key. The service key signs the attestation. The attestation
binds the user's DID to their signing key. That key signs the user's commits.

<TrustChainAnimation />
