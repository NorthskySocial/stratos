# Stratos Technical Design & Operator Guide

This guide provides comprehensive documentation for deploying a Stratos service and integrating it
with an AppView for domain-scoped private content.

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Deployment](#deployment)
4. [Configuration](#configuration)
5. [AppView Integration](#appview-integration)
6. [Operations](#operations)
7. [Security](#security)

---

## Overview

### What is Stratos?

Stratos is a **private namespace service** for ATProtocol that enables users to store content
visible only within specific community domains. Unlike public `app.bsky` records that are
globally visible, Stratos records have **domain boundaries** that restrict visibility.

### Key Concepts

| Concept              | Description                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Domain Boundary**  | A service-qualified boundary identifier in `{serviceDid}/{name}` format. Records with a boundary are visible only to enrolled users who share that boundary. |
| **Enrollment**       | The process of a user registering with a Stratos service via OAuth                                                                                           |
| **Service DID**      | The decentralized identifier for the Stratos service itself                                                                                                  |
| **subscribeRecords** | WebSocket subscription that AppViews use to index Stratos content                                                                                            |

### Use Cases

- **Community-private feeds**: Fandom and community social feeds
- **Gated communities**: Content visible only to verified domain members
- **Multi-community platforms**: Apps with per-community data isolation

---

## Architecture

### System Components

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

> **Note:** See [Blob Storage](#blob-storage) for configuration.

### Data Flow

#### 1. User Enrollment

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

#### 2. Record Creation

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Stratos
    participant P as User's PDS

    C->>S: com.atproto.repo.createRecord
    Note right of C: collection: zone.stratos.feed.post<br/>record: { text: "...", boundary: { values: [{ value: "did:web:stratos.example.com/fanart" }] } } }

    S->>S: Validate User Enrollment, Valid Boundary, No cross-namespace embeds
    S->>S: Store record in actor repo storage
    S->>S: Sequence event to stratos_seq table
    Note right of S: Updates MST (Merkle Search Tree) and signs a new commit:<br/>- Inserts record into MST via NodeWrangler<br/>- Computes block diff (new/removed MST nodes)<br/>- Signs commit with user's P-256 key (falls back to service key)<br/>- Persists commit block and updates repo root

    S->>P: putRecord(Stub with source field)
```

#### 3. AppView Indexing

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

    A->>A: AppView indexes records with boundary metadata
```

### Repository & MST Architecture

Stratos maintains a per-user **Merkle Search Tree (MST)** and **signed commit chain** compatible
with the ATProto repo format. Every record write produces a signed commit that updates the MST root,
enabling cryptographic verification of repository contents.

```mermaid
graph TD
    Commit["Signed Commit (v3)"] --> MST["MST (Merkle Search Tree)"]

    subgraph CommitInfo ["Signed Commit Content"]
        direction TB
        C1["did: 'did:plc:user'"]
        C2["version: 3"]
        C3["data: &lt;MST root CID&gt;"]
        C4["rev: '2024...' (TID)"]
        C5["sig: &lt;P-256 signature (user key)&gt;"]
    end

    subgraph MSTInfo ["MST Content"]
        direction TB
        M1["collection/rkey → record CID"]
        M2["Sorted key-value tree of all records"]
    end

    Commit -.-> CommitInfo
    MST -.-> MSTInfo
```

Key capabilities:

| Endpoint                       | Description                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `com.atproto.sync.getRecord`   | Returns CAR with signed commit + MST inclusion proof + record block              |
| `zone.stratos.sync.getRepo`    | Exports the full repository as a CAR file (all blocks, MST nodes, signed commit) |
| `zone.stratos.repo.importRepo` | Imports a repository from a CAR file with CID integrity verification             |

The MST is implemented using `@atcute/mst` and all blocks are stored in the per-actor
`stratos_repo_block` table alongside record data.

### Storage Architecture

Each enrolled user gets an isolated SQLite database (default) or an isolated PostgreSQL schema
(when using the `postgres` backend). Blobs can be stored either on the local filesystem or in
S3-compatible storage (see [Blob Storage](#blob-storage) configuration).

**With local blob storage:**

```
/data/stratos/
├── service.sqlite          # Service-level (enrollment, OAuth sessions)
├── blobs/                  # Blob storage (when using local provider)
│   ├── {did}/              # Per-user blob storage
│   │   └── {cid}           # Blob content by CID
│   ├── temp/{did}/{key}    # Temporary uploads
│   └── quarantine/{did}/   # Taken-down blobs
└── actors/
    ├── ab/
    │   └── did:plc:abc123/
    │       └── stratos.sqlite   # User's records, repo blocks
    └── cd/
        └── did:plc:cdef456/
            └── stratos.sqlite
```

**With S3 blob storage:**

```
/data/stratos/
├── service.sqlite          # Service-level (enrollment, OAuth sessions)
└── actors/
    ├── ab/
    │   └── did:plc:abc123/
    │       └── stratos.sqlite   # User's records, repo blocks
    └── cd/
        └── did:plc:cdef456/
            └── stratos.sqlite

S3 Bucket (e.g., my-stratos-blobs):
├── stratos/blocks/{did}/{cid}     # Permanent blobs
├── stratos/tmp/{did}/{key}        # Temporary uploads
└── stratos/quarantine/{did}/{cid} # Taken-down blobs
```

### Database Schema

**stratos_record** - Record metadata

```sql
CREATE TABLE stratos_record
(
    uri         TEXT PRIMARY KEY,
    cid         TEXT NOT NULL,
    collection  TEXT NOT NULL,
    rkey        TEXT NOT NULL,
    repoRev     TEXT,
    indexedAt   TEXT NOT NULL,
    takedownRef TEXT
);
```

**stratos_seq** - Event sequencing for subscriptions

```sql
CREATE TABLE stratos_seq
(
    seq   INTEGER PRIMARY KEY AUTOINCREMENT,
    did   TEXT NOT NULL,
    time  TEXT NOT NULL,
    rev   TEXT NOT NULL,
    event TEXT NOT NULL -- JSON-encoded operation
);
```

---

## Deployment

### Prerequisites

- **Node.js 20+**
- **pnpm** (package manager)
- **Domain with HTTPS** (for OAuth callbacks)
- **DID** for the service (did:web or did:plc)

### Step 1: Clone and Build

```bash
git clone https://github.com/your-org/stratos.git
cd stratos
pnpm install
pnpm build
```

### Step 2: Create Service DID

For `did:web`, create a `.well-known/did.json` at your domain:

```json
{
  "@context": ["https://www.w3.org/ns/did/v1"],
  "id": "did:web:stratos.example.com",
  "verificationMethod": [
    {
      "id": "did:web:stratos.example.com#atproto",
      "type": "Multikey",
      "controller": "did:web:stratos.example.com",
      "publicKeyMultibase": "zQ3shXjHeiBuRCKmM36cuYnm7YEMzhGnCmCyW92sRJ9pribSF"
    }
  ],
  "service": [
    {
      "id": "#stratos",
      "type": "StratosService",
      "serviceEndpoint": "https://stratos.example.com"
    }
  ]
}
```

### Step 3: Configure Environment

Create a `.env` file:

```bash
# Service Identity
STRATOS_SERVICE_DID="did:web:stratos.example.com"
STRATOS_SERVICE_FRAGMENT="atproto_pns"  # Fragment for source field (default: atproto_pns)
STRATOS_PORT=3100
STRATOS_PUBLIC_URL="https://stratos.example.com"

# Storage
STRATOS_DATA_DIR="/var/lib/stratos/data"

# Storage backend: 'sqlite' (per-user SQLite files) or 'postgres' (per-user PG schemas)
STORAGE_BACKEND="sqlite"
# For PostgreSQL backend:
# STRATOS_POSTGRES_URL="postgres://user:pass@localhost:5432/stratos"
# Or individual connection params (useful with AWS Secrets Manager):
# STRATOS_PG_HOST="db.example.com"
# STRATOS_PG_PORT="5432"
# STRATOS_PG_USERNAME="stratos"
# STRATOS_PG_PASSWORD="secret"
# STRATOS_PG_DBNAME="stratos"

# Blob Storage Provider: 'local' (filesystem) or 's3' (S3-compatible)
STRATOS_BLOB_STORAGE="local"

# For local/disk storage (default)
# Blobs stored at: STRATOS_DATA_DIR/blobs/{did}/{cid}

# For S3 storage (set STRATOS_BLOB_STORAGE="s3")
STRATOS_S3_BUCKET="my-stratos-blobs"
STRATOS_S3_REGION="us-east-1"
STRATOS_S3_ENDPOINT=""  # Optional: for MinIO or other S3-compatible services
STRATOS_S3_ACCESS_KEY=""  # AWS credentials (or use IAM roles)
STRATOS_S3_SECRET_KEY=""

# Identity Resolution
STRATOS_PLC_URL="https://plc.directory"
STRATOS_RESOLVER_TIMEOUT=5000

# Enrollment (choose mode)
STRATOS_ENROLLMENT_MODE="allowlist"  # or "open"

# For allowlist mode - at least one of these:
STRATOS_ALLOWED_DIDS="did:plc:abc123,did:plc:def456"
STRATOS_ALLOWED_PDS_ENDPOINTS="https://pds.example.com,https://pds2.example.com"

# OAuth (for user enrollment)
STRATOS_OAUTH_CLIENT_ID="https://stratos.example.com/client-metadata.json"
STRATOS_OAUTH_CLIENT_URI="https://stratos.example.com"
STRATOS_OAUTH_REDIRECT_URI="https://stratos.example.com/oauth/callback"

# Allowed boundary domains (records can only have these domains)
STRATOS_ALLOWED_DOMAINS="general,writers"

# Write rate limiter
STRATOS_WRITE_RATE_MAX_WRITES=300
STRATOS_WRITE_RATE_WINDOW_MS=60000
STRATOS_WRITE_RATE_COOLDOWN_MS=10000
STRATOS_WRITE_RATE_COOLDOWN_JITTER_MS=1000

# Service Auth (AppViews that can call getRecord with viewer header)
STRATOS_ALLOWED_APPVIEWS="did:web:appview.example.com"

# Logging
STRATOS_LOG_LEVEL="info"
```

### Step 4: Create OAuth Client Metadata

Host this JSON at `https://stratos.example.com/client-metadata.json`:

```json
{
  "client_id": "https://stratos.example.com/client-metadata.json",
  "client_name": "Stratos Private Namespace Service",
  "client_uri": "https://stratos.example.com",
  "logo_uri": "https://stratos.example.com/logo.png",
  "tos_uri": "https://stratos.example.com/terms",
  "policy_uri": "https://stratos.example.com/privacy",
  "redirect_uris": ["https://stratos.example.com/oauth/callback"],
  "scope": "atproto repo:zone.stratos.actor.enrollment repo:zone.stratos.feed.post",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "application_type": "web",
  "dpop_bound_access_tokens": true
}
```

### Step 5: Run the Service

```bash
# Direct
node dist/bin/stratos.js

# With PM2
pm2 start dist/bin/stratos.js --name stratos

# With systemd
sudo systemctl start stratos
```

### Step 6: Verify Deployment

```bash
# Health check
curl https://stratos.example.com/health
# {"status":"ok","version":"0.1.0"}

# DID document
curl https://stratos.example.com/.well-known/did.json

# Check enrollment status
curl https://stratos.example.com/xrpc/zone.stratos.enrollment.status?did=did:plc:abc123
```

---

## Configuration

### Enrollment Modes

| Mode        | Description                       | Use Case                 |
| ----------- | --------------------------------- | ------------------------ |
| `open`      | Any ATProto user can enroll       | Public services, testing |
| `allowlist` | Only approved users/PDS endpoints | Community deployments    |

### Allowlist Configuration

**By DID** - Explicitly allow specific users:

```bash
STRATOS_ALLOWED_DIDS="did:plc:user1,did:plc:user2,did:plc:user3"
```

**By PDS Endpoint** - Allow all users from specific PDS instances:

```bash
STRATOS_ALLOWED_PDS_ENDPOINTS="https://community-pds.example.com"
```

Both can be combined - a user is allowed if they match **either** list.

### Domain Boundaries

Restrict which domain names can appear in record boundaries:

```bash
STRATOS_ALLOWED_DOMAINS="general,fanart"
```

These are the **bare domain names**. At startup the service qualifies them with its own
DID, so `"fanart"` becomes `"did:web:stratos.example.com/fanart"`. Clients must send the
fully-qualified form when creating records (see the [Client Guide](client-guide.md)).

Records with boundaries outside this list will be rejected.

### Write Rate Limiter

Stratos applies per-DID write throttling to protect MST commit performance under burst traffic.

```bash
# Per-DID writes allowed inside the rolling window
STRATOS_WRITE_RATE_MAX_WRITES=300

# Rolling window size in milliseconds
STRATOS_WRITE_RATE_WINDOW_MS=60000

# Cooldown after limit is exceeded
STRATOS_WRITE_RATE_COOLDOWN_MS=10000

# Random jitter added to cooldown to avoid synchronized retries
STRATOS_WRITE_RATE_COOLDOWN_JITTER_MS=1000
```

For controlled load tests, adjust these values deliberately and record the exact settings used for
each run.

### Repository Import

Configure the maximum CAR file size for `zone.stratos.repo.importRepo`:

```bash
# Default: 256 MiB (268435456 bytes)
STRATOS_IMPORT_MAX_BYTES=268435456
```

Import verifies CID integrity on every block in the CAR, validates the commit DID matches the
authenticated user, and indexes all records from the MST.

### Signing Key

Stratos signs every repo commit with a secp256k1 key. This key is stored at
`{dataDir}/signing_key` and auto-generated on first start, or can be provided via:

```bash
STRATOS_SIGNING_KEY_HEX="<hex-encoded-secp256k1-private-key>"
```

The corresponding public key is published in the service DID document for commit signature
verification.

### User Signing Keys

Each enrolled user receives a P-256 (NIST P-256) signing key generated at enrollment time. This key
enables future per-user record signing and is attested by the service's secp256k1 key.

**Storage**: User signing keys are stored as raw private key bytes at
`{dataDir}/actors/{prefix}/{did}/signing_key`, alongside the actor's SQLite database.

**Enrollment record**: The user's public key (as a `did:key` string) and a service attestation are
published to the user's PDS in the `zone.stratos.actor.enrollment` record. The attestation
is a DAG-CBOR payload (`{boundaries, did, signingKey}`) signed by the service's secp256k1 key.

**Attestation lifecycle**:

- Generated at enrollment time with the user's initial boundaries
- Regenerated when boundaries change (always during an authenticated user action)
- Deleted on unenrollment along with the signing key

**Revocation**: When a user unenrolls, their signing key is deleted from disk and the enrollment
record is removed from the service database. A best-effort attempt is made to delete the PDS
enrollment record. AppViews should check the enrollment status endpoint as the canonical trust anchor
for high-stakes operations.

**Verification**: AppViews can verify a user's attestation offline by checking the DAG-CBOR payload
signature against the service's public key (available in the service DID document).

### Blob Storage

Stratos supports two blob storage backends using a hexagonal (ports & adapters) architecture:

| Provider          | Description                           | Use Case                             |
| ----------------- | ------------------------------------- | ------------------------------------ |
| `local` (default) | Stores blobs on local filesystem      | Single-node deployments, development |
| `s3`              | Stores blobs in S3-compatible storage | Production, multi-node, scalability  |

### Database Storage Backend

Stratos supports multiple database backends for metadata storage:

| Backend            | Description                       | Use Case                                  |
| ------------------ | --------------------------------- | ----------------------------------------- |
| `sqlite` (default) | Per-actor SQLite databases        | Single-node deployments, development      |
| `postgres`         | PostgreSQL with per-actor schemas | Production, multi-node, high availability |

Configuration:

```bash
# Use SQLite (default)
STORAGE_BACKEND="sqlite"

# Use PostgreSQL — either a full connection URL:
STORAGE_BACKEND="postgres"
STRATOS_POSTGRES_URL="postgres://user:pass@localhost:5432/stratos"

# Or individual connection parameters (useful with AWS Secrets Manager / ECS):
STORAGE_BACKEND="postgres"
STRATOS_PG_HOST="db.example.com"
STRATOS_PG_PORT="5432"
STRATOS_PG_USERNAME="stratos"
STRATOS_PG_PASSWORD="secret"
STRATOS_PG_DBNAME="stratos"
```

When both `STRATOS_POSTGRES_URL` and the individual `STRATOS_PG_*` variables are set,
`STRATOS_POSTGRES_URL` takes precedence.

With PostgreSQL, each enrolled actor gets their own schema within the database, providing data
isolation while enabling centralized management.

### DPoP Authentication

Stratos supports DPoP (Demonstration of Proof-of-Possession) token verification. This provides
stronger authentication than simple Bearer tokens by requiring cryptographic proof that the client
possesses the private key associated with the token.

When DPoP is enabled:

1. Clients send `Authorization: DPoP <token>` + `DPoP: <proof>` headers
2. Stratos validates the DPoP proof structure
3. Stratos fetches the PDS's OAuth metadata from `/.well-known/oauth-authorization-server`
4. Stratos fetches and caches the PDS's JWKS from the `jwks_uri`
5. Stratos verifies the token signature using the JWKS
6. Stratos verifies the DPoP proof is bound to the token (cnf.jkt claim)

> **Note:** DPoP authentication requires OAuth to be configured. Token verification uses JWKS-based
> signature validation (not token introspection, which ATProtocol PDSes do not support).

#### Local/Disk Storage

Blobs are stored in the filesystem under the data directory:

```
/var/lib/stratos/data/blobs/
├── {did}/              # Per-user directory
│   └── {cid}           # Blob files by content ID
├── temp/
│   └── {did}/
│       └── {key}       # Temporary uploads
└── quarantine/
    └── {did}/
        └── {cid}       # Taken-down blobs
```

Configuration:

```bash
STRATOS_BLOB_STORAGE="local"
STRATOS_DATA_DIR="/var/lib/stratos/data"
```

#### S3-Compatible Storage

For production deployments, use S3 or an S3-compatible service (MinIO, DigitalOcean Spaces, etc.):

```bash
STRATOS_BLOB_STORAGE="s3"
STRATOS_S3_BUCKET="my-stratos-blobs"
STRATOS_S3_REGION="us-east-1"

# For AWS with IAM roles (recommended)
# No access keys needed - uses instance role

# For explicit credentials
STRATOS_S3_ACCESS_KEY="AKIAIOSFODNN7EXAMPLE"
STRATOS_S3_SECRET_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"

# For S3-compatible services (MinIO, etc.)
STRATOS_S3_ENDPOINT="http://minio.local:9000"
```

S3 key structure:

```
stratos/blocks/{did}/{cid}       # Permanent blobs
stratos/tmp/{did}/{key}          # Temporary uploads
stratos/quarantine/{did}/{cid}   # Taken-down blobs
```

#### Migrating Between Storage Backends

To migrate from disk to S3:

1. Stop the Stratos service
2. Sync blobs to S3:
   ```bash
   aws s3 sync /var/lib/stratos/data/blobs/ s3://my-bucket/stratos/blocks/ \
     --exclude "temp/*" --exclude "quarantine/*"
   ```
3. Update configuration to `STRATOS_BLOB_STORAGE="s3"`
4. Restart the service

---

## AppView Integration

### Overview

AppViews index Stratos content by subscribing to the `zone.stratos.sync.subscribeRecords` WebSocket
endpoint. This is similar to how AppViews subscribe to PDS firehoses, but scoped per-user.

### Step 1: Service Authentication

AppViews authenticate using **service auth** — a signed JWT passed as the `syncToken` query
parameter. The token must be passed as a query param because `Authorization` headers are
stripped by many WebSocket proxies and are not supported in browser WebSocket APIs.

```typescript
import { createServiceJwt } from '@atproto/xrpc-server'

async function mintSyncToken(
  appviewDid: string,
  stratosServiceDid: string,
  signingKey: Keypair,
): Promise<string> {
  // Tokens are short-lived — mint a fresh one for every connection or reconnect.
  return createServiceJwt({
    iss: appviewDid,
    aud: stratosServiceDid,
    lxm: 'zone.stratos.sync.subscribeRecords',
    keypair: signingKey,
  })
}
```

### Step 2: Subscribe to User Records

```typescript
import WebSocket from 'ws'

async function subscribeToUser(
  appviewDid: string,
  stratosServiceDid: string,
  signingKey: Keypair,
  did: string,
  cursor?: number,
) {
  // Mint a fresh token on every call — tokens expire and must not be reused across reconnects.
  const syncToken = await mintSyncToken(
    appviewDid,
    stratosServiceDid,
    signingKey,
  )

  const url = new URL(
    'wss://stratos.example.com/xrpc/zone.stratos.sync.subscribeRecords',
  )
  url.searchParams.set('did', did)
  url.searchParams.set('syncToken', syncToken)
  if (cursor !== undefined) url.searchParams.set('cursor', cursor.toString())

  const ws = new WebSocket(url.toString())

  ws.on('message', async (data) => {
    const frame = decodeFrame(data)

    if (frame.$type === 'zone.stratos.sync.subscribeRecords#commit') {
      for (const op of frame.ops) {
        if (op.action === 'create' || op.action === 'update') {
          await indexRecord(frame.did, op.path, op.record)
        } else if (op.action === 'delete') {
          await deleteRecord(frame.did, op.path)
        }
      }

      // Persist cursor for resume
      await saveCursor(did, frame.seq)
    }
  })
}
```

### Step 3: Index with Domain Metadata

Store the boundary domains with each record for filtering:

```typescript
async function indexRecord(did: string, path: string, record: unknown) {
  const [collection, rkey] = path.split('/')
  const uri = `at://${did}/${collection}/${rkey}`

  // Extract boundary domains
  const boundary = record.boundary?.values?.map((d) => d.value) ?? []

  await db
    .insertInto('stratos_posts')
    .values({
      uri,
      did,
      collection,
      rkey,
      text: record.text,
      boundary_domains: JSON.stringify(boundary),
      created_at: record.createdAt,
      indexed_at: new Date().toISOString(),
    })
    .onConflict((oc) =>
      oc.column('uri').doUpdateSet({
        text: record.text,
        boundary_domains: JSON.stringify(boundary),
      }),
    )
    .execute()
}
```

### Step 4: Query with Domain Filtering

When serving content, filter by the viewer's domain membership:

```typescript
async function getAuthorFeed(authorDid: string, viewerDomains: string[]) {
  // Get posts where viewer has access
  const posts = await db
    .selectFrom('stratos_posts')
    .where('did', '=', authorDid)
    .where((eb) =>
      eb.or([
        // Viewer is the author (sees all their own posts)
        eb('did', '=', viewerDid),
        // Viewer's domain is in the boundary
        ...viewerDomains.map((domain) =>
          eb.raw('boundary_domains LIKE ?', [`%"${domain}"%`]),
        ),
      ]),
    )
    .orderBy('created_at', 'desc')
    .limit(50)
    .execute()

  return posts
}
```

### Step 5: Determine Viewer's Domains

The AppView needs to know what domains a viewer belongs to. Options:

**Option A: Index from Stratos posts**
Users with Stratos posts are assumed to be members of those post boundaries:

```typescript
async function getViewerDomains(viewerDid: string): Promise<string[]> {
  // Get unique domains from viewer's own posts
  const result = await db
    .selectFrom('stratos_posts')
    .select('boundary_domains')
    .where('did', '=', viewerDid)
    .execute()

  const domains = new Set<string>()
  for (const row of result) {
    const boundaries = JSON.parse(row.boundary_domains)
    for (const domain of boundaries) {
      domains.add(domain)
    }
  }

  return [...domains]
}
```

**Option B: Community registry lookup**
Query a community service for verified domain membership.

### Complete Integration Example

```typescript
import { createServiceJwt } from '@atproto/xrpc-server'
import { IdResolver } from '@atproto/identity'
import { Kysely } from 'kysely'

class StratosIndexer {
  private cursors = new Map<string, number>()

  constructor(
    private db: Kysely<AppViewDb>,
    private idResolver: IdResolver,
    private stratosEndpoint: string,
    private appviewDid: string,
    private stratosServiceDid: string,
    private signingKey: Keypair,
  ) {}

  async startIndexing(enrolledDids: string[]) {
    for (const did of enrolledDids) {
      const cursor = await this.loadCursor(did)
      this.subscribeToUser(did, cursor)
    }
  }

  private async connectWithAuth(
    did: string,
    cursor?: number,
  ): Promise<WebSocket> {
    // Mint a fresh JWT on every connection — tokens are short-lived and must
    // not be reused across reconnects.
    const syncToken = await createServiceJwt({
      iss: this.appviewDid,
      aud: this.stratosServiceDid,
      lxm: 'zone.stratos.sync.subscribeRecords',
      keypair: this.signingKey,
    })

    const url = new URL(
      `${this.stratosEndpoint}/xrpc/zone.stratos.sync.subscribeRecords`,
    )
    url.searchParams.set('did', did)
    url.searchParams.set('syncToken', syncToken)
    if (cursor !== undefined) url.searchParams.set('cursor', cursor.toString())

    return new WebSocket(url.toString())
  }

  private async subscribeToUser(did: string, cursor?: number) {
    const ws = await this.connectWithAuth(did, cursor)

    ws.on('message', async (data) => {
      const event = this.decodeEvent(data)

      if (event.$type === 'zone.stratos.sync.subscribeRecords#info') {
        if (event.name === 'OutdatedCursor') {
          // Cursor was too old; indexing continues but some events may be missed.
          this.cursors.delete(did)
        }
        return
      }

      if (event.$type === 'zone.stratos.sync.subscribeRecords#commit') {
        await this.db.transaction().execute(async (tx) => {
          for (const op of event.ops) {
            await this.processOp(tx, event.did, op)
          }
          await this.saveCursor(tx, event.did, event.seq)
        })
        this.cursors.set(did, event.seq)
      }
    })

    ws.on('close', () => {
      // Load cursor from in-memory map (kept in sync with DB commits) and
      // reconnect with a freshly minted token.
      setTimeout(() => this.subscribeToUser(did, this.cursors.get(did)), 5000)
    })
  }

  private async processOp(tx: any, did: string, op: RecordOp) {
    const uri = `at://${did}/${op.path}`

    if (op.action === 'delete') {
      await tx.deleteFrom('stratos_posts').where('uri', '=', uri).execute()
    } else {
      const boundaries = op.record?.boundary?.values?.map((d) => d.value) ?? []

      await tx
        .insertInto('stratos_posts')
        .values({
          uri,
          did,
          collection: op.path.split('/')[0],
          rkey: op.path.split('/')[1],
          record: JSON.stringify(op.record),
          boundary_domains: JSON.stringify(boundaries),
          indexed_at: new Date().toISOString(),
        })
        .onConflict((oc) =>
          oc.column('uri').doUpdateSet({
            record: JSON.stringify(op.record),
            boundary_domains: JSON.stringify(boundaries),
          }),
        )
        .execute()
    }
  }
}
```

---

## Operations

### Monitoring

Key metrics to monitor:

- `stratos_enrolled_users` - Total enrolled users
- `stratos_records_total` - Total records stored
- `stratos_subscription_connections` - Active WebSocket subscriptions
- `stratos_request_duration_seconds` - XRPC request latency

For create → index investigations, additionally track:

- `record created` log `durationMs` and `phases.prepareCommitBuild`
- `record created` log `buildShare` (commit-build contribution to total latency)
- `high create-to-index lag observed` warnings in `stratos-indexer`
- actor sync reconnect pressure (`max reconnect attempts`, websocket close/error events)

### Backup

```bash
# Backup service database
sqlite3 /var/lib/stratos/data/service.sqlite ".backup /backup/service-$(date +%Y%m%d).sqlite"

# Backup all actor databases
tar -czf /backup/actors-$(date +%Y%m%d).tar.gz /var/lib/stratos/data/actors/
```

### Scaling

For high-traffic deployments:

1. **Horizontal scaling**: Run multiple Stratos instances behind a load balancer
2. **Shared storage**: Use network-attached storage for actor databases
3. **Connection pooling**: WebSocket subscriptions should be load-balanced by user DID

---

## Security

### Authentication

| Endpoint                       | Auth Required | Auth Type                   |
| ------------------------------ | ------------- | --------------------------- |
| `/oauth/*`                     | No            | Public enrollment flow      |
| `createRecord`, `deleteRecord` | Yes           | OAuth access token          |
| `getRecord`, `listRecords`     | Optional      | Used for boundary filtering |
| `sync.getRecord`               | Yes           | User or service auth        |
| `sync.getRepo`                 | Yes           | User auth (owner only)      |
| `importRepo`                   | Yes           | User auth (owner only)      |
| `subscribeRecords`             | Yes           | Service auth JWT            |
| `/_health`                     | No            | Public health check         |

### Boundary Enforcement

Records are validated on write:

- Boundary domains must be in `STRATOS_ALLOWED_DOMAINS`
- Cross-namespace embeds are rejected (no `app.bsky` references in stratos records)

### Rate Limiting

Recommended rate limits:

| Endpoint        | Limit               |
| --------------- | ------------------- |
| `createRecord`  | 100/minute per user |
| `getRecord`     | 1000/minute per IP  |
| OAuth authorize | 10/minute per IP    |

### CORS Configuration

**Required exposed headers:** `DPoP-Nonce`, `WWW-Authenticate`

These headers must be included in `Access-Control-Expose-Headers` for DPoP nonce negotiation to
work correctly from browser clients.

**Example nginx configuration:**

```nginx
# Restrict CORS to your webapp origin
location / {
    # Remove the default permissive CORS header from upstream
    proxy_hide_header Access-Control-Allow-Origin;

    # Set restrictive CORS
    add_header Access-Control-Allow-Origin "https://your-webapp.example.com" always;
    add_header Access-Control-Allow-Methods "GET, POST, OPTIONS, DELETE" always;
    add_header Access-Control-Allow-Headers "Authorization, DPoP, Content-Type" always;
    add_header Access-Control-Expose-Headers "DPoP-Nonce, WWW-Authenticate" always;

    if ($request_method = OPTIONS) {
        return 204;
    }

    proxy_pass http://stratos:3100;
}
```

---

## Troubleshooting

### Common Issues

**"NotEnrolled" error when creating records**

- User hasn't completed OAuth enrollment
- Enrollment was rejected (check allowlist configuration)

**Empty subscription stream**

- Verify service auth is configured correctly
- Check cursor isn't ahead of latest sequence

**OAuth callback fails**

- Verify `redirect_uris` in client metadata matches configuration
- Check PDS is reachable for token exchange

### Debug Logging

```bash
STRATOS_LOG_LEVEL=debug pnpm start
```

### Health Checks

```bash
# Basic health
curl localhost:3100/health

# Check specific user enrollment
curl "localhost:3100/xrpc/zone.stratos.enrollment.status?did=did:plc:abc"

# Test WebSocket connectivity
wscat -c "ws://localhost:3100/xrpc/zone.stratos.sync.subscribeRecords?did=did:plc:abc"
```
