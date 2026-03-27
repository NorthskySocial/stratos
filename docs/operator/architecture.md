# Architecture

## System Components

```mermaid
graph TD
    subgraph ATProtocol ["ATProtocol Network"]
        direction TB
        subgraph Services [" "]
            direction LR
            PDS["User's PDS"]
            Stratos["Stratos Service"]
            AppView["AppView"]
            PDS <--> Stratos
            Stratos <--> AppView
        end

        subgraph Infrastructure [" "]
            direction LR
            DID["DID PLC"]
            Blob["Blob Storage<br/>(Disk or S3)"]
            Postgres["PostgreSQL"]
        end

        PDS -- "OAuth<br/>Authentication" --> DID
        Stratos -- "Per-user<br/>SQLite / PG" --> Blob
        AppView -- "Indexed<br/>Content" --> Postgres
    end

    style Services fill:none,stroke:none
    style Infrastructure fill:none,stroke:none
```

## Data Flow

### User Enrollment

```mermaid
sequenceDiagram
    participant U as User
    participant S as Stratos
    participant P as User's PDS

    U->>S: /oauth/authorize?handle=user.bsky.social
    S->>P: Request OAuth endpoint
    P->>U: Prompt for authorization
    U->>P: Authorize Stratos
    P->>S: /oauth/callback (with auth code)
    S->>S: Validate enrollment (DID/PDS allowlist)
    S->>S: Create enrollment record + initialize actor storage
```

### Record Creation

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Stratos
    participant P as User's PDS

    C->>S: com.atproto.repo.createRecord
    Note right of C: collection: zone.stratos.feed.post

    S->>S: Validate enrollment, boundary, no cross-namespace embeds
    S->>S: Store record in actor repo storage
    S->>S: Sequence event to stratos_seq table
    Note right of S: Updates MST and signs new commit with user P-256 key

    S->>P: putRecord (stub with source field)
```

### AppView Indexing

```mermaid
sequenceDiagram
    participant A as AppView
    participant S as Stratos

    A->>S: zone.stratos.sync.subscribeRecords (WebSocket)
    Note right of A: { did: "<user-did>", cursor: 0 }

    loop Commit events
        S->>A: zone.stratos.sync.subscribeRecords#commit
        Note right of S: { seq: 1, did: "did:plc:abc", ops: [...] }
    end

    A->>A: Index records with boundary metadata
```

## Repository & MST Architecture

Stratos maintains a per-user **Merkle Search Tree (MST)** and **signed commit chain** compatible with the ATProto repo format. Every record write produces a signed commit that updates the MST root, enabling cryptographic verification of repository contents.

```mermaid
graph TD
    Commit["Signed Commit (v3)"] --> MST["MST (Merkle Search Tree)"]

    subgraph CommitInfo ["Commit Content"]
        direction TB
        C1["did: 'did:plc:user'"]
        C2["version: 3"]
        C3["data: MST root CID"]
        C4["rev: TID"]
        C5["sig: P-256 signature (user key)"]
    end

    subgraph MSTInfo ["MST Content"]
        direction TB
        M1["collection/rkey → record CID"]
        M2["Sorted key-value tree of all records"]
    end

    Commit -.-> CommitInfo
    MST -.-> MSTInfo
```

| Endpoint | Description |
|----------|-------------|
| `com.atproto.sync.getRecord` | CAR with signed commit + MST inclusion proof + record block |
| `zone.stratos.sync.getRepo` | Full repo as a CAR file |
| `zone.stratos.repo.importRepo` | Import repo from CAR with CID integrity verification |

## Storage Architecture

Each enrolled user gets either an isolated SQLite database (default) or an isolated PostgreSQL schema.

**SQLite layout:**

```
/data/stratos/
├── service.sqlite              # Enrollment, OAuth sessions
├── blobs/                      # Blob storage (local provider)
│   ├── {did}/{cid}
│   ├── temp/{did}/{key}
│   └── quarantine/{did}/{cid}
└── actors/
    ├── ab/
    │   └── did:plc:abc123/
    │       └── stratos.sqlite  # Records, repo blocks
    └── cd/
        └── did:plc:cdef456/
            └── stratos.sqlite
```

## Database Schema

**stratos_record** — record metadata

```sql
CREATE TABLE stratos_record (
    uri         TEXT PRIMARY KEY,
    cid         TEXT NOT NULL,
    collection  TEXT NOT NULL,
    rkey        TEXT NOT NULL,
    repoRev     TEXT,
    indexedAt   TEXT NOT NULL,
    takedownRef TEXT
);
```

**stratos_seq** — event sequencing for subscriptions

```sql
CREATE TABLE stratos_seq (
    seq   INTEGER PRIMARY KEY AUTOINCREMENT,
    did   TEXT NOT NULL,
    time  TEXT NOT NULL,
    rev   TEXT NOT NULL,
    event TEXT NOT NULL  -- JSON-encoded operation
);
```
