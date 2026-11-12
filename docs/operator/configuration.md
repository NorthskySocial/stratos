# Configuration

Think of the environment as the lease on a building. It fixes the address, the
utilities, and who holds the master key. It does not list the rooms. The rooms
are boundaries, and you manage them in the admin interface after the service
starts.

Stratos reads its configuration from environment variables at startup. An
invalid value stops the service and prints the variable name. Only
`STRATOS_SERVICE_DID` has no default.

This page explains each group of settings, then lists every variable in the
[environment variable reference](#environment-variable-reference).

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

| Setting                       | Effect                                                              |
| ----------------------------- | ------------------------------------------------------------------- |
| `STRATOS_OAUTH_CLIENT_ID`     | Overrides the client ID. Default `{publicUrl}/client-metadata.json` |
| `STRATOS_OAUTH_CLIENT_SECRET` | A PEM private key. Makes Stratos a confidential client              |
| `STRATOS_OAUTH_CLIENT_NAME`   | Name on the consent screen. Default `Stratos Service`               |
| `STRATOS_OAUTH_LOGO_URI`      | Logo on the consent screen                                          |
| `STRATOS_OAUTH_TOS_URI`       | Terms of service link                                               |
| `STRATOS_OAUTH_POLICY_URI`    | Privacy policy link                                                 |

The redirect URIs are fixed: `{publicUrl}/oauth/callback` for enrollment and
`{publicUrl}/admin/oauth/callback` for admin login.

Without `STRATOS_OAUTH_CLIENT_SECRET`, the client authenticates with `none`.
With it, the client uses `private_key_jwt` with ES256.

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

| Variable                              | Default   | Meaning                         |
| ------------------------------------- | --------- | ------------------------------- |
| `STRATOS_PDS_SYNC_TICK_MS`            | `30000`   | How often the worker runs       |
| `STRATOS_PDS_SYNC_CLAIM_LIMIT`        | `10`      | Jobs claimed per run            |
| `STRATOS_PDS_SYNC_ATTEMPT_TIMEOUT_MS` | `30000`   | Timeout for one attempt         |
| `STRATOS_PDS_SYNC_BACKOFF_BASE_MS`    | `30000`   | First retry delay               |
| `STRATOS_PDS_SYNC_BACKOFF_CAP_MS`     | `3600000` | Longest retry delay             |
| `STRATOS_PDS_SYNC_MAX_ATTEMPTS`       | `12`      | Attempts before a job is failed |

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

The October profile is additive. Keep legacy `cnf.jkt` credentials and their
DPoP presentation supported on Stratos. Their TTL setting remains
`STRATOS_SPACE_CREDENTIAL_TTL_SECONDS`, default 7200 seconds.
Use `STRATOS_SPACE_HTTP_CREDENTIAL_TTL_SECONDS` for standard `cnf.kid`
credentials: default 600 seconds, positive integer, maximum 3600.
Ordinary OAuth DPoP does not change.

Standard exchange signs Bearer delegation authorization with a fresh P-256
`did:key`. Reads use `Atproto-Space` authorization and sign authorization then
`Atproto-Space-Audience`. Use the repo owner DID for repo reads and the bare
authority DID for membership listing. Same-audience signatures are reusable
until expiry. They do not bind the method, URL, or body. Preserve the
`Signature`, `Signature-Input`, and `Atproto-Space-Audience` headers through
proxies and allow them in browser CORS preflight.

1. Record the source revision and immutable image identity of each PDS.
   Rehearse the reviewed candidate with `october-interop` and the separate
   regression suites described in the repository's `test/spaces-alignment/README.md`.
2. Stop ingestion during the coordinated receiver, Rust client, and PDS upgrade.
   Do not deploy mixed halves: the Rust client has no legacy fallback, and
   October PDS hosts do not accept legacy DPoP space credentials.
3. Restart clients to discard cached grants. Reacquire each credential with its
   new grant-owned key. Never pair a cached credential with another key or
   reinterpret `cnf.jkt` as `cnf.kid`. Expiry refresh must replace both together.
4. Verify seeded publication, feed delivery, owner-audience denial, and credential
   renewal before resuming ingestion. Preserve OAuth nonce-retry checks.

For rollback, stop ingestion and restore the previously rehearsed receiver,
client, and compatible PDS image set together. Clear grant caches and reacquire
credentials. Do not downgrade an October PDS alone or expect the deprecated
TypeScript client to read it with legacy DPoP. Keep the previous deployment
artifacts and normal data backups; this plan does not authorize production data
migration or rollback of repository state.

Member removal blocks renewal, not every outstanding foreign-host capability.
Early revocation fanout is optional and does not happen automatically on removal.
Plan 017 is not included or deployed by this change; no production deployment
status is attested here. Local catalog revision invalidation does not revoke a
foreign PDS credential. Custom `zone.stratos.space.listRepos` membership
selection remains separate from upstream writer metadata. This is not full
standard authority discovery or enumeration support. The independent DPoP ADR
in PR #217 is not part of this rollout.

## Environment variable reference

### Identity and network

| Variable                      | Required | Default                 | Description                                                   |
| ----------------------------- | -------- | ----------------------- | ------------------------------------------------------------- |
| `STRATOS_SERVICE_DID`         | Yes      |                         | Service DID                                                   |
| `STRATOS_PUBLIC_URL`          |          | `http://localhost:3100` | Public base URL. Set it in every real deployment              |
| `STRATOS_PORT`                |          | `3100`                  | HTTP listen port                                              |
| `STRATOS_SERVICE_FRAGMENT`    |          | `atproto_pns`           | Fragment of the service key entry in the DID document         |
| `PLC_DIRECTORY`               |          | `https://plc.directory` | PLC directory origin                                          |
| `PLC_DIRECTORY_PRIVATE_CIDRS` |          |                         | Comma-separated private CIDRs allowed for the PLC origin only |
| `IDENTITY_PRIVATE_ORIGINS`    |          |                         | Comma-separated origins trusted for private identity requests |
| `IDENTITY_PRIVATE_CIDRS`      |          |                         | Comma-separated private CIDRs allowed for those origins       |
| `STRATOS_REPO_URL`            |          | `http://localhost:3100` | Source link shown on `/` and sent in the outbound User-Agent  |
| `STRATOS_OPERATOR_CONTACT`    |          |                         | Contact sent in the outbound User-Agent                       |

### Enrollment and boundaries

| Variable                            | Required | Default     | Description                                                 |
| ----------------------------------- | -------- | ----------- | ----------------------------------------------------------- |
| `STRATOS_ENROLLMENT_MODE`           |          | `allowlist` | `open` or `allowlist`                                       |
| `STRATOS_ALLOWED_DIDS`              |          |             | Comma-separated DIDs allowed to enroll                      |
| `STRATOS_ALLOWED_PDS_ENDPOINTS`     |          |             | Comma-separated PDS URLs whose users may enroll             |
| `STRATOS_ALLOW_LIST_URI`            |          |             | URL of an external allow list                               |
| `STRATOS_ALLOW_LIST_BOOTSTRAP_NAME` |          |             | Bootstrap name for the external allow list                  |
| `STRATOS_RESERVED_DOMAIN`           |          | `general`   | Bare name of the all-members boundary                       |
| `STRATOS_ALLOWED_DOMAINS`           |          |             | Bare boundary names. Seeds the database on first start only |
| `STRATOS_AUTO_ENROLL_DOMAINS`       |          |             | Automatic-enrollment seed. First start only                 |
| `STRATOS_ROOM_CATALOG_FILE`         |          |             | YAML or JSON room details. First start only                 |
| `STRATOS_SPACE_APP_ACCESS`          |          |             | JSON array of per-space application rules. First start only |
| `STRATOS_SPACE_APP_ACCESS_FILE`     |          |             | File with the same shape, merged with the inline value      |
| `STRATOS_SERVICE_ENROLLMENTS`       |          |             | JSON array of service identities                            |
| `STRATOS_SERVICE_ENROLLMENTS_FILE`  |          |             | File with the same shape, merged with the inline value      |

### Admin and OAuth

| Variable                           | Required | Default                            | Description                                       |
| ---------------------------------- | -------- | ---------------------------------- | ------------------------------------------------- |
| `STRATOS_ADMIN_DIDS`               |          |                                    | Comma-separated admin DIDs that cannot be revoked |
| `STRATOS_OAUTH_CLIENT_ID`          |          | `{publicUrl}/client-metadata.json` | OAuth client ID                                   |
| `STRATOS_OAUTH_CLIENT_SECRET`      |          |                                    | PEM private key for a confidential client         |
| `STRATOS_OAUTH_CLIENT_NAME`        |          | `Stratos Service`                  | Consent screen name                               |
| `STRATOS_OAUTH_LOGO_URI`           |          |                                    | Consent screen logo                               |
| `STRATOS_OAUTH_TOS_URI`            |          |                                    | Terms of service link                             |
| `STRATOS_OAUTH_POLICY_URI`         |          |                                    | Privacy policy link                               |
| `STRATOS_ALLOWED_REDIRECT_ORIGINS` |          |                                    | Comma-separated origins for enrollment redirects  |
| `STRATOS_DEV_MODE`                 |          | `false`                            | `true` or `false`. Never `true` in production     |

### Storage

| Variable                     | Required  | Default   | Description                                                            |
| ---------------------------- | --------- | --------- | ---------------------------------------------------------------------- |
| `STRATOS_DATA_DIR`           |           | `./data`  | Data directory. Used by both backends                                  |
| `STORAGE_BACKEND`            |           | `sqlite`  | `sqlite` or `postgres`                                                 |
| `STRATOS_POSTGRES_URL`       |           |           | Full PostgreSQL URL. Wins over `STRATOS_PG_*`                          |
| `STRATOS_PG_HOST`            |           |           | PostgreSQL host. Setting it builds the URL                             |
| `STRATOS_PG_PORT`            |           | `5432`    | PostgreSQL port                                                        |
| `STRATOS_PG_USERNAME`        |           | `stratos` | PostgreSQL user                                                        |
| `STRATOS_PG_PASSWORD`        |           |           | PostgreSQL password                                                    |
| `STRATOS_PG_DBNAME`          |           | `stratos` | PostgreSQL database                                                    |
| `STRATOS_PG_SSLMODE`         |           | `require` | `disable`, `allow`, `prefer`, `require`, `verify-ca`, or `verify-full` |
| `STRATOS_PG_ACTOR_POOL_SIZE` |           | `200`     | Connections for member transactions                                    |
| `STRATOS_PG_ADMIN_POOL_SIZE` |           | `3`       | Connections for schema work                                            |
| `STRATOS_BLOCK_CACHE_SIZE`   |           | `50000`   | Repository block cache entries (`postgres` backend)                    |
| `STRATOS_BLOB_STORAGE`       |           | `local`   | `local` or `s3`                                                        |
| `STRATOS_S3_BUCKET`          | With `s3` |           | Bucket name                                                            |
| `STRATOS_S3_REGION`          |           |           | Bucket region                                                          |
| `STRATOS_S3_ENDPOINT`        |           |           | Endpoint for an S3-compatible service                                  |
| `STRATOS_S3_ACCESS_KEY`      |           |           | Static access key                                                      |
| `STRATOS_S3_SECRET_KEY`      |           |           | Static secret key                                                      |
| `STRATOS_VALKEY_URL`         |           |           | Valkey or Redis URL for the replay store and cache                     |

### Limits and credentials

| Variable                                    | Required | Default  | Description                                          |
| ------------------------------------------- | -------- | -------- | ---------------------------------------------------- |
| `STRATOS_WRITE_RATE_MAX_WRITES`             |          | `300`    | Writes allowed per DID in the window                 |
| `STRATOS_WRITE_RATE_WINDOW_MS`              |          | `60000`  | Rate limit window                                    |
| `STRATOS_WRITE_RATE_COOLDOWN_MS`            |          | `10000`  | Cooldown after the limit                             |
| `STRATOS_WRITE_RATE_COOLDOWN_JITTER_MS`     |          | `1000`   | Random addition to the cooldown                      |
| `STRATOS_SPACE_HTTP_CREDENTIAL_TTL_SECONDS` |          | `600`    | Standard space credential lifetime. Maximum 3600     |
| `STRATOS_SPACE_CREDENTIAL_TTL_SECONDS`      |          | `7200`   | Legacy DPoP space credential lifetime                |
| `STRATOS_CLIENT_JWKS_CACHE_TTL_MS`          |          | `300000` | Cache lifetime for client keys in client attestation |

### PDS sync queue variables

| Variable                              | Required | Default   | Description                     |
| ------------------------------------- | -------- | --------- | ------------------------------- |
| `STRATOS_PDS_SYNC_TICK_MS`            |          | `30000`   | Worker interval                 |
| `STRATOS_PDS_SYNC_CLAIM_LIMIT`        |          | `10`      | Jobs claimed per run            |
| `STRATOS_PDS_SYNC_ATTEMPT_TIMEOUT_MS` |          | `30000`   | Timeout for one attempt         |
| `STRATOS_PDS_SYNC_BACKOFF_BASE_MS`    |          | `30000`   | First retry delay               |
| `STRATOS_PDS_SYNC_BACKOFF_CAP_MS`     |          | `3600000` | Longest retry delay             |
| `STRATOS_PDS_SYNC_MAX_ATTEMPTS`       |          | `12`      | Attempts before a job is failed |

### Logging and telemetry

| Variable                              | Required | Default       | Description                             |
| ------------------------------------- | -------- | ------------- | --------------------------------------- |
| `LOG_LEVEL`                           |          | `info`        | Log verbosity                           |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` |          |               | OTLP metrics URL. Enables metric export |
| `OTEL_METRIC_EXPORT_INTERVAL`         |          | `15000`       | Export interval in milliseconds         |
| `OTEL_RESOURCE_ATTRIBUTES`            |          |               | Comma-separated `key=value` attributes  |
| `SENTRY_DSN`                          |          |               | Sentry DSN. Enables error reporting     |
| `SENTRY_ENVIRONMENT`                  |          | `development` | Sentry environment name                 |
| `SENTRY_RELEASE`                      |          |               | Sentry release name                     |
| `SENTRY_TRACES_SAMPLE_RATE`           |          |               | Trace sample rate from 0 to 1           |

### Variables that do nothing

Stratos accepts these variables but no code reads them. Setting them has no
effect.

| Variable                                     | Note                                               |
| -------------------------------------------- | -------------------------------------------------- |
| `STRATOS_SIGNING_KEY_HEX`                    | The service key lives in the signing identity file |
| `STRATOS_RETENTION_DAYS`                     | No retention sweep uses it                         |
| `STRATOS_IMPORT_MAX_BYTES`                   | The service does not register a repository import  |
| `STRATOS_DPOP_REQUIRE_NONCE`                 | Nonce handling does not consult it                 |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | Use `STRATOS_VALKEY_URL`                           |

These names appear in older guides and do not exist: `STRATOS_OAUTH_REDIRECT_URI`,
`STRATOS_ALLOWED_APPVIEWS`, `STRATOS_LOG_LEVEL`, and `STRATOS_PLC_URL`.
`STRATOS_SYNC_TOKEN` and `BSKY_DB_POSTGRES_URL` belong to the deprecated
standalone indexer, not to the Stratos service.
