# Enrollment Signing and Verification

This document describes the enrollment attestation model implemented in the current Stratos codebase.

## Summary

During enrollment, Stratos creates and persists two pieces of signing state:

- a service signing key, used to sign repo commits and enrollment attestations
- a per-user signing key, stored as a `did:key` and included in the enrollment record

The enrollment record published to the user's PDS contains:

- the Stratos service URL
- the user's boundary memberships for that service
- the user's signing key DID
- a service attestation over the user's DID, sorted boundaries, and signing key

## Enrollment Record Shape

The current `zone.stratos.actor.enrollment` record shape is:

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

Each Stratos service writes its own record using the service DID as the rkey.

## What the Service Signs

The attestation payload is DAG-CBOR over this object:

```ts
{
  boundaries: ['engineering', 'leadership'],
  did: 'did:plc:alice',
  signingKey: 'did:key:zDna...'
}
```

Important details:

- boundary strings are sorted before signing
- the payload is binary DAG-CBOR, not JSON text
- the signature is produced by the Stratos service signing key

## Enrollment Flow

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {
  'actorBkg': '#e0f2fe',
  'actorBorder': '#7dd3fc',
  'actorTextColor': '#0c4a6e',
  'actorLineColor': '#bae6fd',
  'noteBkgColor': '#fef9c3',
  'noteBorderColor': '#fde047',
  'noteTextColor': '#713f12',
  'activationBkgColor': '#ede9fe',
  'activationBorderColor': '#c4b5fd',
  'signalColor': '#64748b',
  'signalTextColor': '#1e293b',
  'sequenceNumberColor': '#ffffff'
}}}%%
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
    note over S: signingKey = userKeypair.did() (did:key multibase)
    S->>S: Build attestation payload (DAG-CBOR)
    note over S: encode({<br/>  boundaries: [...sorted],<br/>  did: userDid,<br/>  signingKey: "did:key:zDna..."<br/>})
    S->>S: Sign payload with service Secp256k1 key
    S->>DB: INSERT enrollment<br/>(did, boundaries, signingKey,<br/> rkey = serviceDid)
    S->>PDS: putRecord zone.stratos.actor.enrollment#serviceDid
    note over PDS: {<br/>  service: serviceUrl,<br/>  boundaries: [{value: "..."}],<br/>  signingKey: "did:key:zDna...",<br/>  attestation: {<br/>    sig: {$bytes: "..."},<br/>    signingKey: "did:key:zQ3s..."<br/>  },<br/>  createdAt: "..."<br/>}
    S->>U: 200 { success: true, did }
```

## Verification Flow

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {
  'actorBkg': '#dcfce7',
  'actorBorder': '#86efac',
  'actorTextColor': '#14532d',
  'actorLineColor': '#bbf7d0',
  'noteBkgColor': '#fef9c3',
  'noteBorderColor': '#fde047',
  'noteTextColor': '#713f12',
  'activationBkgColor': '#ede9fe',
  'activationBorderColor': '#c4b5fd',
  'labelBoxBkgColor': '#fce7f3',
  'labelBoxBorderColor': '#f9a8d4',
  'labelTextColor': '#831843',
  'signalColor': '#64748b',
  'signalTextColor': '#1e293b',
  'sequenceNumberColor': '#ffffff'
}}}%%
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

        AV->>AV: Build attestation payload (DAG-CBOR)<br/>from record fields (did, sorted boundaries, signingKey)
        AV->>DR: Resolve attestation.signingKey or service DID
        DR->>AV: Public key

        AV->>AV: Verify attestation.sig<br/>over DAG-CBOR payload
        AV->>AV: Assert enrollment is for expected user
        AV->>AV: Assert enrollment is for expected service

        AV->>C: Cache verified enrollment
        C->>AV: Return enrollment + boundaries
    end

    AV->>AV: Filter hydrated records<br/>by viewer ∩ record boundaries
```

A verifier should:

1. Read the user's `zone.stratos.actor.enrollment` record from the PDS.
2. Build the attestation payload from the record fields.
3. Resolve the service public key from `attestation.signingKey` or the service DID document.
4. Verify the signature bytes in `attestation.sig`.
5. Confirm the record is for the expected user and service.

## Verification Example

```ts
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

After building the payload, verify `attestation.sig` using the service public key.

## Trust Model

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'edgeLabelBackground': '#f8fafc', 'tertiaryColor': '#f1f5f9'}}}%%
flowchart TD
    SK[Service Secp256k1 Key
persisted at dataDir/signing_key]
    SD[Service DID Document
verificationMethod]
    ATT[Attestation
DAG-CBOR payload signed by service
boundaries + did + signingKey]
    UK[User P-256 Keypair
generated at enrollment]
    ER[Enrollment Record on PDS
zone.stratos.actor.enrollment]
    RC[Record Commits
signed with user private key]

    SK -->|signs| ATT
    SD -->|resolves to| SK
    UK -->|public key embedded in| ATT
    ATT -->|written to| ER
    UK -->|signingKey in| ER
    UK -->|private key signs| RC
    ATT -->|signingKey verifies| RC

    style SK fill:#ede9fe,stroke:#c4b5fd,color:#3b0764
    style SD fill:#e0f2fe,stroke:#7dd3fc,color:#0c4a6e
    style ATT fill:#fef9c3,stroke:#fde047,color:#713f12
    style UK fill:#dcfce7,stroke:#86efac,color:#14532d
    style ER fill:#fce7f3,stroke:#f9a8d4,color:#831843
    style RC fill:#ffedd5,stroke:#fdba74,color:#7c2d12
```

This attestation lets a client or AppView verify that:

- the enrollment record was vouched for by the Stratos service
- the boundary set has not been modified after signing
- the user signing key in the record matches what the service enrolled

What it does not prove by itself:

- that the user is still enrolled right now
- that the boundaries have not changed since the record was last written

For that, query the live status endpoint.

## Live Freshness Check

`GET /xrpc/zone.stratos.enrollment.status?did=<did>` is the live service check.

Behavior today:

- unauthenticated callers receive `enrolled: true` or `false`
- authenticated callers also receive boundaries, signing key, enrollment rkey, and a fresh attestation

Use this when you need stronger freshness guarantees than the cached PDS record provides.

## Boundary Changes

When a user's boundaries change, the Stratos service re-signs a new attestation and rewrites the PDS record. AppViews learn of the change via the sync stream and invalidate their cache.

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {
  'actorBkg': '#ffedd5',
  'actorBorder': '#fdba74',
  'actorTextColor': '#7c2d12',
  'actorLineColor': '#fed7aa',
  'noteBkgColor': '#fef9c3',
  'noteBorderColor': '#fde047',
  'noteTextColor': '#713f12',
  'activationBkgColor': '#ede9fe',
  'activationBorderColor': '#c4b5fd',
  'signalColor': '#64748b',
  'signalTextColor': '#1e293b',
  'sequenceNumberColor': '#ffffff'
}}}%%
sequenceDiagram
    participant OP as Operator
    participant S as Stratos Service
    participant DB as Service DB
    participant PDS as User's PDS
    participant AV as AppView

    OP->>S: PATCH /boundaries { did, boundaries }
    S->>DB: UPDATE enrollment SET boundaries
    S->>S: Re-sign attestation (DAG-CBOR)<br/>with new boundaries
    S->>DB: UPDATE enrollment attestation
    S->>PDS: putRecord zone.stratos.actor.enrollment#serviceDid<br/>(new boundaries + new attestation)
    PDS-->>AV: Sync stream: record update<br/>collection=zone.stratos.actor.enrollment
    AV->>AV: Invalidate cached enrollment for did
    note over AV: Next hydration request triggers<br/>fresh fetch + verify from PDS
```

## Legacy Notes

Older docs described a JWT-shaped service certificate and `app.northsky.stratos.actor.enrollment` records keyed at `self`. That is not the current model in this repository.

The current model uses:

- `zone.stratos.actor.enrollment`
- one record per Stratos service
- service-DID rkeys for new enrollments
- DAG-CBOR payload signing for the attestation
