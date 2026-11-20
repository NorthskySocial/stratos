---
audience: App developers and maintainers
type: Explanation
status: current
---

# Enrollment Signing

<script setup>
import EnrollmentFlow from '../.vitepress/theme/components/EnrollmentFlow.vue'
import VerificationFlowAnimation from '../.vitepress/theme/components/VerificationFlowAnimation.vue'
import TrustChainAnimation from '../.vitepress/theme/components/TrustChainAnimation.vue'
import BoundaryChangeAnimation from '../.vitepress/theme/components/BoundaryChangeAnimation.vue'
</script>

A membership card is useful because someone other than the member signed it.
Anyone can read the card and check the signature without phoning the club.

The enrollment record is that card. Stratos signs a statement about a member
and publishes it to the member's own PDS. An app reads the record and verifies
that this Stratos service enrolled this member, with these boundaries and this
signing key.

The card is not the lock. Stratos checks the caller's current boundary
membership on every request, whatever a published record says.

## What gets signed

At enrollment Stratos settles two things:

- **The member's signing key.** For a member whose records Stratos hosts,
  Stratos creates a P-256 key and keeps the private half. For a member whose
  own PDS hosts their records, the key is the member's existing AT Protocol
  signing key. See
  [custody](/architecture/permissioned-spaces#who-keeps-the-records-custody).
- **A service attestation.** Stratos signs a payload that binds the member's
  DID, boundaries, and signing key, with the time of signing.

The attestation payload is:

```typescript
{
  boundaries: [
    'did:web:stratos.example.com/fanart',
    'did:web:stratos.example.com/general',
  ],                                  // sorted
  did: 'did:plc:alice',               // the member
  signingKey: 'did:key:zDna...',      // the member's signing key
  issuedAt: '2026-03-12T00:00:00.000Z',
}
```

Stratos encodes the payload as DAG-CBOR and signs it with the service's
secp256k1 key. Boundaries are full identifiers, not bare names.

## Enrollment record shape

```json
{
  "service": "https://stratos.example.com",
  "boundaries": [
    { "value": "did:web:stratos.example.com/fanart" },
    { "value": "did:web:stratos.example.com/general" }
  ],
  "signingKey": "did:key:zDna...",
  "attestation": {
    "sig": { "$bytes": "..." },
    "signingKey": "did:key:zQ3s...",
    "issuedAt": "2026-03-12T00:00:00.000Z"
  },
  "custody": "stratos",
  "createdAt": "2026-03-12T00:00:00.000Z"
}
```

| Field                    | Meaning                                             |
| ------------------------ | --------------------------------------------------- |
| `service`                | URL of the Stratos service                          |
| `boundaries`             | The member's boundaries when the record was written |
| `signingKey`             | The member's signing key                            |
| `attestation.sig`        | Service signature over the payload                  |
| `attestation.signingKey` | The service key that signed                         |
| `attestation.issuedAt`   | Signed time of issue                                |
| `custody`                | `stratos` or `pds`: who hosts the member's records  |
| `repoHost`               | The member's PDS. Present only with `pds` custody   |
| `createdAt`              | Unsigned record timestamp                           |

A member has one enrollment record for each Stratos service.

Records written before `issuedAt` existed omit it from both the record and the
signed payload. They verify only while the signing service key is still the
current key.

## Enrollment flow

<EnrollmentFlow />

## Verification flow

<VerificationFlowAnimation />

Use the client library. It handles key history and both payload forms:

```typescript
import { verifyEnrollmentAttestation } from '@northskysocial/stratos-client'

const result = await verifyEnrollmentAttestation(enrollment, userDid, {
  serviceDid: 'did:web:stratos.example.com',
})
if (!result.valid)
  throw new Error(result.error ?? 'Invalid enrollment attestation')
```

The steps behind that call:

1. Read the `zone.stratos.actor.enrollment` record from the member's PDS.
2. Take the expected service DID from your own configuration.
3. Resolve that service's DID document and its current key.
4. When `attestation.signingKey` is an older key, verify it against the
   service's signed key history.
5. Rebuild the payload and verify `attestation.sig` over its DAG-CBOR bytes.

Do not trust `attestation.signingKey` because the record contains it. Anyone
can write a record that names their own key. Trust starts from the service DID
you expect. See [Service signing key history](/architecture/service-key-history).

The payload is rebuilt like this:

```typescript
import { encode as cborEncode } from '@atcute/cbor'

function buildAttestationPayload(options: {
  did: string
  boundaries: Array<{ value: string }>
  signingKey: string
  issuedAt?: string
}) {
  const payload: Record<string, unknown> = {
    boundaries: options.boundaries.map((entry) => entry.value).sort(),
    did: options.did,
    signingKey: options.signingKey,
  }
  if (options.issuedAt !== undefined) payload.issuedAt = options.issuedAt
  return cborEncode(payload)
}
```

## Trust model

<TrustChainAnimation />

A verifier chains trust in this order: expected service DID, service key,
attestation, member signing key. With the member's key in hand, a verifier can
check a signed repository commit.

## What the attestation does not prove

- That the member is still enrolled.
- That the member's boundaries are unchanged since the record was written.
- That a published boundary grants access. Stratos decides access from its own
  enrollment state.

For a current answer, ask the service:

```bash
GET /xrpc/zone.stratos.enrollment.status?did=<did>
```

| Caller        | Response                                                               |
| ------------- | ---------------------------------------------------------------------- |
| Anonymous     | `enrolled`, `enrolledAt`, `active`, `signingKey`, `enrollmentRkey`     |
| Authenticated | The same, plus current `boundaries` and a freshly signed `attestation` |

For a DID that is not enrolled, the response is `enrolled: false`, with
`eligible` when Stratos could decide whether the DID may enroll.

## Boundary changes

<BoundaryChangeAnimation />

When a member's boundaries change, Stratos stores the change, signs a new
attestation, and queues an update of the PDS record. The local change applies
at once. The PDS record follows through the
[PDS sync queue](/operator/operations#pds-sync-queue).

Stratos also announces the change on the sync stream as an enrollment event
that carries the member's boundaries after the change. A consumer such as the
feed generator drops what it held for any boundary the member left.

Every stored membership change is also written to a signed history. See
[Boundary membership history](/operator/boundary-history).
