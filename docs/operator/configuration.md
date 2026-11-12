---
audience: Operators
type: How-to
status: current
---

# Configuration

The environment fixes the service identity, storage, and who the first admins
are. It does not define boundaries. You manage those in the admin interface
after the service starts.

Stratos reads its configuration from environment variables at startup. An
invalid value stops the service and prints the variable name. Only
`STRATOS_SERVICE_DID` has no default.

This page explains each group of settings. Every variable, with its default,
is in [Environment variables](/reference/env).

## Service identity

```bash
STRATOS_SERVICE_DID="did:web:stratos.example.com"
STRATOS_PUBLIC_URL="https://stratos.example.com"
STRATOS_PORT=3100
STRATOS_SERVICE_FRAGMENT="atproto_pns"
```

`STRATOS_PUBLIC_URL` defaults to `http://localhost:3100`. Set it in every real
deployment. Stratos derives its OAuth client ID and both OAuth redirect URIs
from it.

Keep the service DID stable. Every boundary identifier starts with it.

## Enrollment modes

| Mode        | Description                      | Use case                 |
| ----------- | -------------------------------- | ------------------------ |
| `open`      | Any AT Protocol user can enroll  | Public services, testing |
| `allowlist` | Only approved users or PDS hosts | Community deployments    |

`allowlist` is the default.

### Allowlist configuration

Allow specific users by DID:

```bash
STRATOS_ALLOWED_DIDS="did:plc:user1,did:plc:user2"
```

Allow every user of specific PDS hosts:

```bash
STRATOS_ALLOWED_PDS_ENDPOINTS="https://community-pds.example.com"
```

A user is allowed when they match either list.

### External allow list

Stratos can also read an allow list from a URL. Set `STRATOS_ALLOW_LIST_URI`
to enable it. `STRATOS_ALLOW_LIST_BOOTSTRAP_NAME` names the bootstrap entry,
and the provider uses `STRATOS_VALKEY_URL` when it is set.

## Boundaries

Boundaries live in the service database. You create, edit, and deactivate them
in the admin interface. See [Manage boundaries](/operator/boundaries).

These older settings seed that database on the first start only:

```bash
STRATOS_ALLOWED_DOMAINS="general,fanart"
STRATOS_AUTO_ENROLL_DOMAINS="general"
STRATOS_ROOM_CATALOG_FILE="/etc/stratos/rooms.yaml"
STRATOS_SPACE_APP_ACCESS_FILE="/etc/stratos/space-app-access.json"
```

Names are bare. Stratos qualifies each one with the service DID, so `fanart`
becomes `did:web:stratos.example.com/fanart`. Clients send the qualified form.

When `STRATOS_AUTO_ENROLL_DOMAINS` is empty at the first start, the seed marks
every allowed boundary for automatic enrollment. Later restarts ignore these
settings. Remove them after you check the imported boundaries.

### Reserved boundary

`STRATOS_RESERVED_DOMAIN` names the all-members boundary. It defaults to
`general`. Every enrollment includes it, and it is always allowed. You do not
need to list it in `STRATOS_ALLOWED_DOMAINS`.

The name must be a valid space key. Keep it stable. Startup fails when the
reserved boundary is missing or inactive in the database.

### One boundary per record

A record carries exactly one boundary. Stratos rejects a write with zero
boundaries or more than one with `InvalidDomainCount`.

## Service enrollments

A service enrollment gives a downstream service, such as the feed generator,
read access to a set of boundaries without an OAuth flow.

```bash
# Inline JSON
STRATOS_SERVICE_ENROLLMENTS='[{"did":"did:web:feeds.stratos.example.com","boundaries":["general"]}]'

# A JSON file with the same shape
STRATOS_SERVICE_ENROLLMENTS_FILE="/etc/stratos/service-enrollments.json"
```

Stratos merges both sources. A DID that appears twice stops startup.

```json
[
  {
    "did": "did:web:feeds.stratos.example.com",
    "boundaries": ["general", "fanart"]
  }
]
```

Each entry needs a unique `did` and at least one boundary. A boundary can be a
bare name or a qualified identifier.

Configuration decides which service identities exist. On every start Stratos
creates the declared identities, marks them `isService = true`, and removes
service identities you no longer declare. User enrollments are never affected.

Configuration does not keep deciding their boundaries. The `boundaries` list
applies when Stratos first creates the identity. After that, admins manage its
membership in the admin interface, and a restart does not restore the original
list.

Service identities are read-only. They cannot create records.

## Admin authorization

Admin access uses OAuth only. There is no admin password.

```bash
STRATOS_ADMIN_DIDS="did:plc:operator1,did:plc:operator2"
```

An operator opens `https://stratos.example.com/admin/` and signs in with their
AT Protocol account. The login requests the identity-only `atproto` scope. It
grants Stratos no write access to the operator's repository.

A DID is an admin when it is on `STRATOS_ADMIN_DIDS` or an existing admin
granted it in the **Admins** tab. DIDs on the configuration list cannot be
revoked from the interface. They are your recovery path.

Set at least one DID before the first start. Only an admin can grant another
admin, so an empty list with an empty database locks everyone out.

| Route                        | Purpose                                     |
| ---------------------------- | ------------------------------------------- |
| `GET /admin/`                | Admin interface                             |
| `GET /admin/oauth/authorize` | Starts the admin login                      |
| `GET /admin/oauth/callback`  | Completes the login and creates the session |
| `GET /admin/whoami`          | Returns `{ did, isAdmin }` for the session  |
| `POST /admin/oauth/logout`   | Deletes the session and clears the cookie   |

The session lives in the service database. The browser holds only a random key
in the HttpOnly `stratos_admin_session` cookie. A session expires after 12
hours. Stratos checks on every request that the DID is still an admin.

Stratos rejects an admin request whose `Origin` or `Referer` is not the
service's own origin.

The interface has four tabs: **Health**, **Boundaries**, **Enrollments**, and
**Admins**. It is built with the service (`pnpm build`) and served from the
same process.

## Write rate limiter

Stratos throttles writes per DID to protect commit performance under bursts:

```bash
STRATOS_WRITE_RATE_MAX_WRITES=300          # writes allowed in the window
STRATOS_WRITE_RATE_WINDOW_MS=60000         # rolling window
STRATOS_WRITE_RATE_COOLDOWN_MS=10000       # cooldown after the limit
STRATOS_WRITE_RATE_COOLDOWN_JITTER_MS=1000 # spreads client retries
```

A throttled write returns HTTP 429 `RateLimitExceeded`. The limiter keeps its
counters in process memory.

## Signing keys

Stratos uses two kinds of key.

**Service key.** One secp256k1 key signs enrollment attestations, space
credentials, and boundary history. Stratos creates it on
the first start and keeps it in `{STRATOS_DATA_DIR}/service-signing-identity.json`
with file mode `0600`. The service publishes the public key in its DID
document. No environment variable sets this key.

Rotate the service key with the offline `stratos-rotate-service-key` command.
See [Service signing key history](/architecture/service-key-history).

**Member keys.** Stratos creates one P-256 key for each member whose records it
hosts. That key signs the member's repository commits. Where it lives depends
on the storage backend:

| Backend    | Member key location                                    |
| ---------- | ------------------------------------------------------ |
| `sqlite`   | `{STRATOS_DATA_DIR}/actors/{prefix}/{did}/signing_key` |
| `postgres` | The Stratos database                                   |

A member whose own PDS hosts their records signs with their own key. See
[Mixed-mode custody](/operator/architecture#mixed-mode-custody).

Attestation lifecycle:

- Stratos signs an attestation at enrollment.
- Stratos signs a new one when the member's boundaries change.
- Unenrollment is a hard delete. Stratos removes the enrollment, the member's
  records and blobs, and the member key.

## Database storage backend

| Backend            | Description                       | Use case                 |
| ------------------ | --------------------------------- | ------------------------ |
| `sqlite` (default) | Per-member SQLite databases       | Single node, development |
| `postgres`         | PostgreSQL with per-member schema | Production               |

```bash
# SQLite (default)
STORAGE_BACKEND="sqlite"
STRATOS_DATA_DIR="/var/lib/stratos/data"

# PostgreSQL, connection URL
STORAGE_BACKEND="postgres"
STRATOS_POSTGRES_URL="postgres://user:pass@db.example.com:5432/stratos"

# PostgreSQL, individual parameters
STORAGE_BACKEND="postgres"
STRATOS_PG_HOST="db.example.com"
STRATOS_PG_PORT="5432"
STRATOS_PG_USERNAME="stratos"
STRATOS_PG_PASSWORD="secret"
STRATOS_PG_DBNAME="stratos"
STRATOS_PG_SSLMODE="require"
```

`STRATOS_POSTGRES_URL` wins when both forms are set.

When Stratos builds the URL from `STRATOS_PG_*`, it adds `sslmode=require`
unless you set `STRATOS_PG_SSLMODE`. Set `STRATOS_PG_SSLMODE="disable"` for a
local database without TLS.

`STRATOS_DATA_DIR` is still required with `postgres`. It holds the service
signing identity, local blobs, and static assets.

Pool sizes default to 200 connections for member transactions
(`STRATOS_PG_ACTOR_POOL_SIZE`) and 3 for schema work
(`STRATOS_PG_ADMIN_POOL_SIZE`). Keep the total below the database's
`max_connections`.

## Blob storage

| Provider          | Description           | Use case                 |
| ----------------- | --------------------- | ------------------------ |
| `local` (default) | Local filesystem      | Single node, development |
| `s3`              | S3-compatible storage | Production               |

### Local storage

```bash
STRATOS_BLOB_STORAGE="local"
STRATOS_DATA_DIR="/var/lib/stratos/data"
```

```text
{STRATOS_DATA_DIR}/blobs/{did}/{cid}              # stored blobs
{STRATOS_DATA_DIR}/blobs/temp/{did}/{key}         # uploads in progress
{STRATOS_DATA_DIR}/blobs/quarantine/{did}/{cid}   # taken-down blobs
```

### S3-compatible storage

```bash
STRATOS_BLOB_STORAGE="s3"
STRATOS_S3_BUCKET="my-stratos-blobs"
STRATOS_S3_REGION="us-east-1"

# Static credentials. Omit both to use the instance or task role.
STRATOS_S3_ACCESS_KEY="AKIAIOSFODNN7EXAMPLE"
STRATOS_S3_SECRET_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"

# MinIO or another S3-compatible service
STRATOS_S3_ENDPOINT="http://minio.local:9000"
```

`STRATOS_S3_BUCKET` is required when the provider is `s3`.

```text
stratos/blocks/{did}/{cid}       # stored blobs
stratos/tmp/{did}/{key}          # uploads in progress
stratos/quarantine/{did}/{cid}   # taken-down blobs
```

### Migrating from disk to S3

1. Stop the Stratos service.
2. Sync the stored blobs:

   ```bash
   aws s3 sync /var/lib/stratos/data/blobs/ s3://my-bucket/stratos/blocks/ \
     --exclude "temp/*" --exclude "quarantine/*"
   ```

3. Set `STRATOS_BLOB_STORAGE="s3"` and the bucket settings.
4. Start the service.

## Valkey and the replay store

```bash
STRATOS_VALKEY_URL="redis://valkey:6379"
```

Stratos uses Valkey, or any Redis-compatible server, for two jobs:

- **Replay store.** Space-credential delegation and client attestation use
  single-use tokens. Stratos records each token ID in Valkey. Without a replay
  store, those two paths refuse every request.
- **Cache.** Boundary lookups during hydration and the external allow list
  use it as a shared cache.

Ordinary OAuth record reads and writes work without Valkey. Set it for any
deployment that serves a feed generator or space credentials.

## OAuth client

Stratos is an OAuth client of each member's PDS. It generates and serves its
own client metadata at `/client-metadata.json` and
`/.well-known/oauth-client-metadata.json`. You do not host that file.

Set the consent screen with
[`STRATOS_OAUTH_CLIENT_NAME`](/reference/env#stratos_oauth_client_name),
[`STRATOS_OAUTH_LOGO_URI`](/reference/env#stratos_oauth_logo_uri),
[`STRATOS_OAUTH_TOS_URI`](/reference/env#stratos_oauth_tos_uri), and
[`STRATOS_OAUTH_POLICY_URI`](/reference/env#stratos_oauth_policy_uri).
[`STRATOS_OAUTH_CLIENT_ID`](/reference/env#stratos_oauth_client_id)
overrides the client ID, which defaults to `{publicUrl}/client-metadata.json`.

The redirect URIs are fixed: `{publicUrl}/oauth/callback` for enrollment and
`{publicUrl}/admin/oauth/callback` for admin login.

[`STRATOS_OAUTH_CLIENT_SECRET`](/reference/env#stratos_oauth_client_secret)
holds a PEM private key. Without it, the client authenticates with `none`.
With it, Stratos is a confidential client and uses `private_key_jwt` with
ES256.

Stratos serves `{STRATOS_DATA_DIR}/assets` at `/assets`. Put a logo there and
point `STRATOS_OAUTH_LOGO_URI` at `{publicUrl}/assets/<file>`.

`STRATOS_ALLOWED_REDIRECT_ORIGINS` lists origins the enrollment flow may
redirect back to. A client that publishes its own client metadata document
proves its redirect target and needs no entry. Each entry must be a valid URL,
or startup fails.

## DPoP authentication

Members call Stratos with the DPoP-bound access token their PDS issued.

1. The client sends `Authorization: DPoP <token>` and a `DPoP` proof header.
2. Stratos validates the proof: signature, method, URL, and a single-use ID.
3. Stratos decodes the token and checks its expiry.
4. Stratos checks that the token is bound to the proof key (`cnf.jkt`).
5. Stratos checks that the token's subject is enrolled.

Stratos does not verify the access token's own signature. A PDS does not
publish the key that signs its access tokens. The DPoP proof and the key
binding carry the trust.

Stratos answers a request without a valid nonce with `use_dpop_nonce` and a
`DPoP-Nonce` header. The client retries with that nonce.

## PDS sync queue

Stratos publishes each member's enrollment record to the member's PDS. A PDS
can be offline, so Stratos queues that write and retries it.

The worker's interval, batch size, timeout, backoff, and attempt limit are
the `STRATOS_PDS_SYNC_*` variables. See the **PDS sync queue** category in
[Environment variables](/reference/env).

A boundary change succeeds locally before the PDS record catches up. Admins
read the queue with `zone.stratos.admin.listPdsSyncStatus`. After a fault that
failed many jobs at once, `zone.stratos.admin.requeuePdsSync` moves every
failed job back to pending.

## Observability

Telemetry is off until you configure it.

```bash
# Metrics over OTLP/HTTP
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT="http://collector:4318/v1/metrics"
OTEL_METRIC_EXPORT_INTERVAL=15000
OTEL_RESOURCE_ATTRIBUTES="service.instance.id=stratos-1"

# Error reporting
SENTRY_DSN="https://key@sentry.example.com/1"
SENTRY_ENVIRONMENT="production"
SENTRY_RELEASE="0.3.1"
```

The repository includes a sample collector configuration at
`observability/otel-collector.yml`. See
[Operations](/operator/operations#monitoring) for the metric names.

`LOG_LEVEL` sets log verbosity. It accepts `fatal`, `error`, `warn`, `info`,
`debug`, `trace`, and `silent`.

## Development mode

```bash
STRATOS_DEV_MODE="true"
```

::: danger Never enable development mode in production
Development mode accepts `Authorization: Bearer <did>` with no proof. Any
caller can act as any member.
:::

Development mode also allows OAuth over plain HTTP and trusts loopback origins
for redirects and admin requests. The value must be exactly `true` or `false`.

## October Spaces rollout

The October transport upgrade has its own procedure. See
[October spaces rollout](/operator/upgrades/october-spaces).

## Environment variable reference

Every variable, with its default, is in
[Environment variables](/reference/env). Filter it by category, or show
only the required ones.
