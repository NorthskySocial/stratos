# System Diagrams

High-level architecture and flow diagrams for Stratos.

## System Architecture

```mermaid
graph TD
    subgraph "External Ecosystem"
        PDS["User's PDS\n(Stores Stubs)"]
        AV["AppView\n(Indexing & Hydration)"]
        PLC["Identity Resolver\n(PLC / DID:WEB)"]
        EAL["External Allow List\n(HTTP Endpoint)"]
    end

    subgraph "Stratos Service"
        SS["Stratos API Server\n(XRPC / OAuth)"]
        SDB[("Service DB\n(Enrollments/Metadata)")]
        AS[("Actor Store\n(Full Records / Blobs)")]
        FR["Firehose\n(subscribeRecords)"]
    end

    Client["User Client"] -- "1. OAuth Enrollment" --> SS
    SS -- "2. Check Eligibility" --> EAL
    SS -- "3. Store Enrollment" --> SDB
    SS -- "4. Write Profile Record" --> PDS

    Client -- "5. Write Full Record" --> SS
    SS -- "6. Store Full Record" --> AS
    SS -- "7. Write Stub Record" --> PDS
    SS -- "8. Emit Event" --> FR

    AV -- "9. Index Stubs" --> PDS
    AV -- "10. Resolve Service DID" --> PLC
    AV -- "11. getRecord (Hydration)" --> SS
    SS -- "12. Boundary Filtered Content" --> AV
    AV -- "13. Hydrated Feed" --> Client
```

## Record Hydration Sequence

```mermaid
sequenceDiagram
    participant C as Client
    participant P as User's PDS
    participant AV as AppView
    participant S as Stratos Service

    Note over C, S: Record Creation
    C->>S: postRecord(full_content, boundary)
    S->>S: Store full record in ActorStore
    S->>P: putRecord(stub_with_source_field)
    S->>S: Emit subscribeRecords event

    Note over C, S: Hydration Flow
    AV->>P: subscribeRepos / getRecord (Stub)
    AV->>AV: Detect 'source' field in stub
    AV->>S: com.atproto.repo.getRecord(at://did/coll/rkey)
    Note right of S: Validates requester DID\nChecks boundary permissions
    S-->>AV: Full record content
    AV-->>C: Hydrated view (Feed/Thread)
```

## Enrollment & Allowlist Mechanism

```mermaid
flowchart LR
    Start([Enrollment Request]) --> OAuth[OAuth Authentication]
    OAuth --> Check{Eligible?}

    subgraph "Eligibility Checks"
        Check -- "DID Allow List" --> DAL[Internal Config]
        Check -- "PDS Allow List" --> PAL[Internal Config]
        Check -- "External" --> EAL[ExternalAllowListProvider]
    end

    EAL -- "Fetch & Cache" --> URL["External URL (.txt)"]

    DAL --> Allowed{Allowed?}
    PAL --> Allowed
    EAL --> Allowed

    Allowed -- "Yes" --> Enrolled[Create Enrollment & Actor Store]
    Allowed -- "No" --> Denied[Return 403 Forbidden]

    Enrolled --> Profile[Write zone.stratos.actor.enrollment to PDS]
```

## Indexer Sync Architecture

```mermaid
graph TD
    PDS["User PDS Firehose\n(com.atproto.sync.subscribeRepos)"] --> Indexer["stratos-indexer"]
    Stratos["Stratos Service\n(zone.stratos.sync.subscribeRecords)"] --> Indexer

    Indexer --> DB["PostgreSQL\n(stratos_post, stratos_post_boundary,\nstratos_enrollment, stratos_sync_cursor)"]
    DB --> AppView["AppView\n(zone.stratos.feed.*)"]
```
