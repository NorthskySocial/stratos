# Enrollment Signing & Verification

## Key Generation on Enrollment

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

    S->>S: Generate P-256 keypair (userKeypair)
    note over S: userPublicKey = userKeypair.did() (multibase)<br/>userPrivateKey = userKeypair.export() (raw bytes)

    S->>S: Sign service certificate JWT
    note over S: cert = {<br/>  iss: serviceDid,<br/>  sub: userDid,<br/>  pub: userPublicKey,<br/>  boundaries: [...],<br/>  svc: serviceEndpoint,<br/>  iat: now<br/>}<br/>signed with service Secp256k1 key (ES256K)

    S->>DB: INSERT enrollment<br/>(did, enrolledAt, userPublicKey,<br/> userPrivateKey, serviceCert)

    S->>PDS: putRecord app.northsky.stratos.actor.enrollment
    note over PDS: {<br/>  service: serviceEndpoint,<br/>  boundaries: [...],<br/>  createdAt: now,<br/>  userPublicKey: "zDn...",<br/>  serviceCert: "eyJ..."<br/>}

    S->>U: 200 { success: true, did }
```

## Verification Flow (AppView — no Stratos call)

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
    participant AV as AppView
    participant PDS as User's PDS
    participant DR as DID Resolver
    participant C as Cache

    AV->>C: Lookup enrollment for userDid
    alt Cache hit (not stale)
        C->>AV: Return cached enrollment + boundaries
    else Cache miss or stale
        AV->>PDS: getRecord app.northsky.stratos.actor.enrollment#self
        PDS->>AV: { userPublicKey, serviceCert, boundaries, service }

        AV->>AV: Decode serviceCert JWT<br/>(extract iss = serviceDid without verifying)
        AV->>DR: Resolve serviceDid → DID document
        DR->>AV: DID document (verificationMethod[#atproto])

        AV->>AV: Verify serviceCert signature<br/>using service public key (ES256K)

        AV->>AV: Assert cert.sub === userDid
        AV->>AV: Assert cert.pub === record.userPublicKey
        AV->>AV: Assert cert.svc === record.service

        AV->>C: Cache verified enrollment
        C->>AV: Return enrollment + cert.boundaries
    end

    AV->>AV: Filter hydrated records<br/>by viewer ∩ record boundaries
```

## Trust Chain

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'edgeLabelBackground': '#f8fafc', 'tertiaryColor': '#f1f5f9'}}}%%
flowchart TD
    SK[Service Secp256k1 Key
persisted at dataDir/signing_key]
    SD[Service DID Document
#atproto verificationMethod]
    CERT[Service Certificate JWT
iss=serviceDid, sub=userDid
pub=userPublicKey, boundaries]
    UK[User P-256 Keypair
generated at enrollment]
    ER[Enrollment Record on PDS
app.northsky.stratos.actor.enrollment]
    RC[Record Commits
future — signed with user private key]

    SK -->|signs| CERT
    SD -->|resolves to| SK
    UK -->|public key embedded in| CERT
    CERT -->|written to| ER
    UK -->|public key in| ER
    UK -->|private key signs| RC
    CERT -->|cert.pub verifies| RC

    style SK fill:#ede9fe,stroke:#c4b5fd,color:#3b0764
    style SD fill:#e0f2fe,stroke:#7dd3fc,color:#0c4a6e
    style CERT fill:#fef9c3,stroke:#fde047,color:#713f12
    style UK fill:#dcfce7,stroke:#86efac,color:#14532d
    style ER fill:#fce7f3,stroke:#f9a8d4,color:#831843
    style RC fill:#ffedd5,stroke:#fdba74,color:#7c2d12
```

## Boundary Update Flow

When a user's boundaries change, the service re-signs a new certificate and rewrites the PDS record. AppViews learn of the change via the firehose subscription and invalidate their cache.

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
    S->>S: Re-sign serviceCert with new boundaries
    S->>DB: UPDATE enrollment SET serviceCert
    S->>PDS: putRecord enrollment#self<br/>(new boundaries + new serviceCert)
    PDS-->>AV: Firehose: #repo.commit<br/>collection=app.northsky.stratos.actor.enrollment
    AV->>AV: Invalidate cached enrollment for did
    note over AV: Next hydration request triggers<br/>fresh fetch + verify from PDS
```
