# Stratos Architecture Diagram

This document contains Mermaid diagrams representing the Stratos system architecture, including
enrollment flows, record management, and hydration.

## High-Level System Architecture

This diagram shows the relationship between the Client, AppView, User's PDS, and the Stratos
Service.

```mermaid
graph TD
    subgraph "External Ecosystem"
        PDS["User's PDS<br/>(Stores Stubs)"]
        AV["AppView<br/>(Indexing & Hydration)"]
        PLC["Identity Resolver<br/>(PLC / DID:WEB)"]
        EAL["External Allow List<br/>(HTTP Endpoint)"]
    end

    subgraph "Stratos Service"
        SS["Stratos API Server<br/>(XRPC / OAuth)"]
        SDB[("Service DB<br/>(Enrollments/Metadata)")]
        AS[("Actor Store<br/>(Full Records / Blobs)")]
        FR["Firehose<br/>(subscribeRecords)"]
        VAL[(Valkey/Redis)]
    end

    Client["User Client"] -- "1. OAuth Enrollment" --> SS
    SS -- "2. Check Eligibility" --> EAL
    SS -- "3. Bootstrap (Optional)" --> VAL
    SS -- "4. Store Enrollment" --> SDB
    SS -- "5. Write Profile Record" --> PDS

    Client -- "6. Write Full Record" --> SS
    SS -- "7. Store Full Record" --> AS
    SS -- "8. Write Stub Record" --> PDS
    SS -- "9. Emit Event" --> FR

    AV -- "10. Index Stubs" --> PDS
    AV -- "11. Resolve Service DID" --> PLC
    AV -- "12. getRecord (Hydration)" --> SS
    SS -- "13. Boundary Filtered Content" --> AV
    AV -- "14. Hydrated Feed" --> Client
```

## Record Hydration Flow (Sequence)

This sequence diagram details the "Source Field Pattern" used for content hydration while
maintaining data boundaries.

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
    Note right of S: Validates requester DID<br/>Checks boundary permissions
    S-->>AV: Full record content
    AV-->>C: Hydrated view (Feed/Thread)
```

## Enrollment & AllowList Mechanism

How the service manages user eligibility using both internal and external sources.

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
    EAL -- "Bootstrap" --> VK[(Valkey / Redis)]

    DAL --> Allowed{Allowed?}
    PAL --> Allowed
    EAL --> Allowed

    Allowed -- "Yes" --> Enrolled[Create Enrollment & Actor Store]
    Allowed -- "No" --> Denied[Return 403 Forbidden]

    Enrolled --> Profile[Write app.stratos.actor.enrollment to PDS]
```
