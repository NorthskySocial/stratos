# Configuration

## Enrollment Modes

| Mode        | Description | Use Case |
|-------------|-------------|----------|
| `open`      | Any ATProto user can enroll | Public services, testing |
| `allowlist` | Only approved users/PDS endpoints | Community deployments |

### Allowlist Configuration

**By DID** — allow specific users:

```bash
STRATOS_ALLOWED_DIDS="did:plc:user1,did:plc:user2"
```

**By PDS endpoint** — allow all users from specific PDS instances:

```bash
STRATOS_ALLOWED_PDS_ENDPOINTS="https://community-pds.example.com"
```

Both can be combined — a user is allowed if they match **either** list.

## Domain Boundaries

Restrict which domain names can appear in record boundaries:

```bash
STRATOS_ALLOWED_DOMAINS="general,fanart"
```

These are bare domain names. At startup the service qualifies them with its own DID, so `"fanart"` becomes `"did:web:stratos.example.com/fanart"`. Clients must send the fully-qualified form.

## Write Rate Limiter

Per-DID write throttling to protect MST commit performance under burst traffic:

```bash
STRATOS_WRITE_RATE_MAX_WRITES=300      # writes allowed in window
STRATOS_WRITE_RATE_WINDOW_MS=60000     # rolling window (ms)
STRATOS_WRITE_RATE_COOLDOWN_MS=10000   # cooldown after limit exceeded
STRATOS_WRITE_RATE_COOLDOWN_JITTER_MS=1000  # jitter to avoid synchronized retries
```

## Repository Import

```bash
# Default: 256 MiB
STRATOS_IMPORT_MAX_BYTES=268435456
```

## Signing Keys

**Service key** — signs every repo commit. Auto-generated on first start, or supply via:

```bash
STRATOS_SIGNING_KEY_HEX="<hex-encoded-secp256k1-private-key>"
```

**User keys** — each enrolled user receives a P-256 keypair generated at enrollment time. Private keys are stored at `{dataDir}/actors/{prefix}/{did}/signing_key`. The public key and a service attestation are published in the enrollment record on the user's PDS.

Attestation lifecycle:
- Generated at enrollment with the user's initial boundaries.
- Regenerated when boundaries change.
- Deleted on unenrollment.

## Database Storage Backend

| Backend            | Description | Use Case |
|--------------------|-------------|----------|
| `sqlite` (default) | Per-actor SQLite databases | Single-node, development |
| `postgres`         | PostgreSQL with per-actor schemas | Production, high availability |

```bash
# SQLite (default)
STORAGE_BACKEND="sqlite"
STRATOS_DATA_DIR="/var/lib/stratos/data"

# PostgreSQL — connection URL
STORAGE_BACKEND="postgres"
STRATOS_POSTGRES_URL="postgres://user:pass@localhost:5432/stratos"

# PostgreSQL — individual params (useful with AWS Secrets Manager)
STORAGE_BACKEND="postgres"
STRATOS_PG_HOST="db.example.com"
STRATOS_PG_PORT="5432"
STRATOS_PG_USERNAME="stratos"
STRATOS_PG_PASSWORD="secret"
STRATOS_PG_DBNAME="stratos"
```

When both `STRATOS_POSTGRES_URL` and `STRATOS_PG_*` variables are set, the URL takes precedence.

## Blob Storage

| Provider          | Description | Use Case |
|-------------------|-------------|----------|
| `local` (default) | Local filesystem | Single-node, development |
| `s3`              | S3-compatible storage | Production, multi-node |

### Local Storage

```bash
STRATOS_BLOB_STORAGE="local"
STRATOS_DATA_DIR="/var/lib/stratos/data"
```

Blobs are stored under `{STRATOS_DATA_DIR}/blobs/{did}/{cid}`.

### S3-Compatible Storage

```bash
STRATOS_BLOB_STORAGE="s3"
STRATOS_S3_BUCKET="my-stratos-blobs"
STRATOS_S3_REGION="us-east-1"

# Explicit credentials (or use IAM roles — no keys needed)
STRATOS_S3_ACCESS_KEY="AKIAIOSFODNN7EXAMPLE"
STRATOS_S3_SECRET_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"

# For MinIO or other S3-compatible services
STRATOS_S3_ENDPOINT="http://minio.local:9000"
```

S3 key structure:
```
stratos/blocks/{did}/{cid}       # Permanent blobs
stratos/tmp/{did}/{key}          # Temporary uploads
stratos/quarantine/{did}/{cid}   # Taken-down blobs
```

### Migrating from Disk to S3

1. Stop the Stratos service.
2. Sync blobs to S3:
   ```bash
   aws s3 sync /var/lib/stratos/data/blobs/ s3://my-bucket/stratos/blocks/ \
     --exclude "temp/*" --exclude "quarantine/*"
   ```
3. Update config to `STRATOS_BLOB_STORAGE="s3"`.
4. Restart the service.

## DPoP Authentication

Stratos validates DPoP tokens using JWKS-based signature verification (not token introspection):

1. Client sends `Authorization: DPoP <token>` + `DPoP: <proof>` headers.
2. Stratos fetches and caches the PDS's JWKS from `/.well-known/oauth-authorization-server`.
3. Stratos verifies the token signature using the JWKS.
4. Stratos verifies the DPoP proof is bound to the token (`cnf.jkt` claim).

## Complete Environment Variable Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STRATOS_SERVICE_DID` | ✅ | — | Service DID (`did:web:<host>`) |
| `STRATOS_PUBLIC_URL` | ✅ | — | Public base URL |
| `STRATOS_ALLOWED_DOMAINS` | ✅ | — | Comma-separated allowed boundary names |
| `STRATOS_PORT` | | `3100` | HTTP listen port |
| `STRATOS_SERVICE_FRAGMENT` | | `atproto_pns` | Fragment for source field in stubs |
| `STRATOS_DATA_DIR` | | `./data` | Base data directory (sqlite) |
| `STORAGE_BACKEND` | | `sqlite` | `sqlite` or `postgres` |
| `STRATOS_POSTGRES_URL` | | — | Full Postgres DSN |
| `STRATOS_PG_ACTOR_POOL_SIZE` | | — | Actor transaction pool size |
| `STRATOS_PG_ADMIN_POOL_SIZE` | | — | Admin/schema pool size |
| `STRATOS_BLOB_STORAGE` | | `local` | `local` or `s3` |
| `STRATOS_S3_BUCKET` | | — | S3 bucket name |
| `STRATOS_S3_REGION` | | — | S3 region |
| `STRATOS_S3_ENDPOINT` | | — | S3-compatible endpoint override |
| `STRATOS_ENROLLMENT_MODE` | | `allowlist` | `open` or `allowlist` |
| `STRATOS_ALLOWED_DIDS` | | — | Comma-separated allowed DIDs |
| `STRATOS_ALLOWED_PDS_ENDPOINTS` | | — | Comma-separated allowed PDS URLs |
| `STRATOS_AUTO_ENROLL_DOMAINS` | | all allowed | Domains assigned to new users |
| `STRATOS_PLC_URL` | | `https://plc.directory` | DID PLC resolver URL |
| `STRATOS_OAUTH_CLIENT_ID` | | — | OAuth client metadata URL |
| `STRATOS_OAUTH_REDIRECT_URI` | | — | OAuth callback URI |
| `STRATOS_ALLOWED_APPVIEWS` | | — | Comma-separated AppView DIDs |
| `STRATOS_SIGNING_KEY_HEX` | | auto-generated | Service secp256k1 key |
| `STRATOS_IMPORT_MAX_BYTES` | | `268435456` | Max CAR import size |
| `STRATOS_WRITE_RATE_MAX_WRITES` | | `300` | Per-DID write limit |
| `STRATOS_WRITE_RATE_WINDOW_MS` | | `60000` | Rate limit window |
| `STRATOS_LOG_LEVEL` | | `info` | `debug`, `info`, `warn`, `error` |
