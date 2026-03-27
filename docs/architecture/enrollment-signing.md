# Enrollment Signing

During enrollment, Stratos establishes a cryptographic trust chain that lets AppViews verify user identity and boundary membership without querying the live service.

## What Gets Signed

At enrollment time Stratos generates:

- A **per-user P-256 keypair** — private key stored on the service, public key embedded in the enrollment record.
- A **service attestation** — a DAG-CBOR signature binding the user's DID, boundaries, and signing key together.

The attestation payload is:

```typescript
{
  boundaries: ['engineering', 'leadership'],  // sorted
  did: 'did:plc:alice',
  signingKey: 'did:key:zDna...'              // user's P-256 public key
}
```

Payload is serialised as DAG-CBOR (not JSON) and signed with the service's Secp256k1 key.

## Enrollment Record Shape

```json
{
  "service": "https://stratos.example.com",
  "boundaries": [{ "value": "engineering" }, { "value": "leadership" }],
  "signingKey": "did:key:zDna...",
  "attestation": {
    "sig": { "$bytes": "..." },
    "signingKey": "did:key:zQ3s..."
  },
  "createdAt": "2026-03-12T00:00:00.000Z"
}
```

One record is written per Stratos service, keyed at the service DID as the rkey.

## Enrollment Flow

```mermaid
sequenceDiagram
    participant U as User Browser
    participant PDS as User's PDS
    participant S as Stratos Service
    participant DB as Service DB

    U->>S: GET /oauth/authorize?handle=user.bsky.social
    S->>U: Redirect → PDS authorization page
    U->>PDS: Approve OAuth request
    PDS->>S: GET /oauth/callback?code=...

    note over S: Validate enrollment eligibility

    S->>S: Initialize user repo (empty signed commit)
    S->>S: Generate P-256 keypair (userKeypair)
    S->>S: Build attestation payload (DAG-CBOR)
    note over S: encode({<br/>  boundaries: [...sorted],<br/>  did: userDid,<br/>  signingKey: "did:key:zDna..."<br/>})
    S->>S: Sign payload with service Secp256k1 key
    S->>DB: INSERT enrollment
    S->>PDS: putRecord zone.stratos.actor.enrollment#serviceDid
    S->>U: 200 { success: true, did }
```

## Verification Flow

```mermaid
sequenceDiagram
    participant AV as AppView / Verifier
    participant PDS as User's PDS
    participant DR as DID Resolver
    participant C as Cache

    AV->>C: Lookup enrollment for userDid
    alt Cache hit (not stale)
        C->>AV: Return cached enrollment + boundaries
    else Cache miss or stale
        AV->>PDS: getRecord zone.stratos.actor.enrollment#serviceDid
        PDS->>AV: { signingKey, attestation, boundaries, service }
        AV->>AV: Build attestation payload (DAG-CBOR)
        AV->>DR: Resolve attestation.signingKey
        DR->>AV: Public key
        AV->>AV: Verify attestation.sig over payload
        AV->>C: Cache verified enrollment
        C->>AV: Return enrollment + boundaries
    end

    AV->>AV: Filter records by viewer ∩ record boundaries
```

**Verification steps:**

1. Read `zone.stratos.actor.enrollment` record from user's PDS.
2. Build the attestation payload from `{ did, sorted(boundaries), signingKey }`.
3. Resolve the service public key from `attestation.signingKey` or service DID document.
4. Verify `attestation.sig` bytes over the DAG-CBOR payload.
5. Confirm the record is for the expected user and service.

```typescript
import { encode as cborEncode } from '@atcute/cbor'

function buildAttestationPayload(options: {
  did: string
  boundaries: Array<{ value: string }>
  signingKey: string
}) {
  return cborEncode({
    boundaries: options.boundaries.map((entry) => entry.value).sort(),
    did: options.did,
    signingKey: options.signingKey,
  })
}
```

## Trust Model

```mermaid
flowchart TD
    SK["Service Secp256k1 Key\n(persisted at dataDir/signing_key)"]
    SD["Service DID Document\n(verificationMethod)"]
    ATT["Attestation\n(DAG-CBOR payload signed by service)"]
    UK["User P-256 Keypair\n(generated at enrollment)"]
    ER["Enrollment Record on PDS\n(zone.stratos.actor.enrollment)"]
    RC["Record Commits\n(signed with user private key)"]

    SK -->|signs| ATT
    SD -->|resolves to| SK
    UK -->|public key embedded in| ATT
    ATT -->|written to| ER
    UK -->|signingKey in| ER
    UK -->|private key signs| RC
    ATT -->|signingKey verifies| RC
```

A verifier can chain trust: enrollment record → verify service attestation → extract user `signingKey` → verify commit signature. This proves both service endorsement and user authorship.

## What the Attestation Does Not Prove

- That the user is **currently enrolled** (boundaries may have changed since the record was written).
- That the **boundaries haven't changed** after the record was written.

For freshness guarantees, query the live status endpoint:

```bash
GET /xrpc/zone.stratos.enrollment.status?did=<did>
```

Authenticated callers receive current boundaries, signing key, and a fresh attestation.

## Boundary Changes

When a user's boundaries change, the service re-signs a new attestation and rewrites the PDS record. AppViews learn of the change via the sync stream and must invalidate their cache.

```mermaid
sequenceDiagram
    participant OP as Operator
    participant S as Stratos Service
    participant DB as Service DB
    participant PDS as User's PDS
    participant AV as AppView

    OP->>S: PATCH /boundaries { did, boundaries }
    S->>DB: UPDATE enrollment SET boundaries
    S->>S: Re-sign attestation with new boundaries
    S->>DB: UPDATE enrollment attestation
    S->>PDS: putRecord zone.stratos.actor.enrollment#serviceDid
    PDS-->>AV: Sync stream: record update
    AV->>AV: Invalidate cached enrollment for did
    note over AV: Next hydration triggers fresh fetch + verify
```
