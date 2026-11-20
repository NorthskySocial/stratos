---
audience: Operators
type: Examples
status: current
---

# Deployment Examples

Everything needed to stand up Stratos lives in the repository root. There are
no per-scenario bundles to copy. These files cover the supported deployments:

| File                                       | Purpose                                                      |
| ------------------------------------------ | ------------------------------------------------------------ |
| `docker-compose.yml`                       | Base Stratos stack; its bundled indexer is deprecated        |
| `stratos-feedgen-ng/compose.rehearsal.yml` | Constrained feed generator rehearsal profile                 |
| `docker-compose.feedgen.yml`               | Deprecated TypeScript feedgen overlay, retained for rollback |
| `.env.example`                             | Service configuration template. Copy it to `.env`            |

The current [Run the feed generator](/operator/feedgen-ng) keeps its own encrypted
database. The older TypeScript overlay below is only for rollback.

## Base Stack (`docker-compose.yml`)

The root `docker-compose.yml` brings up four services:

- **`stratos`** (port `3100`): the Stratos service. Member storage defaults to
  SQLite, persisted in the `stratos-data` volume at `/app/data`. The same
  volume holds the service signing identity.
- **`valkey`**: the replay store and cache. The `stratos` service waits for it
  and reads it through `STRATOS_VALKEY_URL`. Space credentials need it.
- **`indexer`** (port `3002`): the deprecated standalone indexer. It writes
  into the Postgres `bsky` database (`BSKY_DB_POSTGRES_URL`).
- **`postgres`** (port `5432`): Postgres 18, backing the indexer's database.

An optional MinIO service for S3-compatible blob storage is included, commented
out.

Copy the environment template, fill in the required values, then start the
stack:

```bash
cp .env.example .env
# edit .env: set STRATOS_SERVICE_DID, STRATOS_PUBLIC_URL, STRATOS_ADMIN_DIDS,
# and STRATOS_ALLOWED_DOMAINS for your first boundaries
docker compose up -d
```

To run Stratos without the deprecated indexer, start only what the service
needs:

```bash
docker compose up -d stratos valkey
```

The indexer needs `STRATOS_SYNC_TOKEN` in `.env`. The Stratos service does not
read that variable.

The compose file passes a fixed list of variables into the `stratos`
container. A variable outside that list, such as `STRATOS_ADMIN_DIDS`, does not
reach the service from `.env` alone. Add it under `environment:` in a Compose
override file.

## Choosing a Storage Backend

The Stratos service defaults to SQLite (`STORAGE_BACKEND=sqlite`), which keeps
per-member databases on the mounted volume. That fits single-node and
development instances.

For production, switch the service to PostgreSQL by setting
`STORAGE_BACKEND=postgres` and either `STRATOS_POSTGRES_URL` or the individual
`STRATOS_PG_*` variables. See
[Database Storage Backend](/operator/configuration#database-storage-backend)
for the variables and precedence rules. Keep the `stratos-data` volume: the
service signing identity stays on disk with either backend.

The bundled `postgres` service provisions only the indexer's database (`bsky`).
There is no `stratos` database by default. To reuse the same instance for
Stratos storage, create a separate database first:

```bash
docker compose exec postgres createdb -U stratos stratos
```

Then point `STRATOS_POSTGRES_URL` at it:

```bash
STRATOS_POSTGRES_URL="postgres://stratos:stratos@postgres:5432/stratos"
```

Do not point `STRATOS_POSTGRES_URL` at the `bsky` database.

Blob storage is a separate choice: `local` (default) or `s3`. See
[Blob Storage](/operator/configuration#blob-storage) for MinIO and S3 settings.

## Test the feed generator before launch

Build the Rust image and use its 1 vCPU / 512 MiB test configuration. Prepare
a separate encrypted data directory, private key files, and an approved feed
list:

> Before running Compose, use a feed `did:web` under the Stratos-controlled
> space domain and grant it membership in every feed boundary. See
> [Deployment](/operator/deployment) for the DID, DNS, and enrollment setup.

```sh
docker build -f stratos-feedgen-ng/Dockerfile -t stratos-feedgen-ng:rehearsal .
docker compose --env-file stratos-feedgen-ng/rehearsal.env \
  -f stratos-feedgen-ng/compose.rehearsal.yml up
```

The env file contains operator-specific paths and is not checked in. The
profile applies 1 vCPU and 512 MiB limits; confirm them inside the cgroup and
run an authenticated feed probe before routing traffic. See
[Run the feed generator](/operator/feedgen-ng) for the data flow and privacy controls.

## Legacy TypeScript Feed Generator Overlay (`docker-compose.feedgen.yml`)

This section describes the deprecated TypeScript rollback path only. Its
temporary tunnel DID does not meet the current feed DID domain requirement;
do not use this overlay for a new production deployment. Follow
[Run the feed generator](/operator/feedgen-ng) and its
`stratos-feedgen-ng/compose.rehearsal.yml` rehearsal profile instead.

To run the boundary-scoped feed generator alongside the service, layer the feedgen
overlay on top of the base stack. The overlay adds a `feedgen` service (SQLite-backed) and
an ephemeral Cloudflare tunnel so the feedgen's `did:web` document is reachable over
HTTPS.

The older feed generator keeps posts, boundaries, and its position in the
update stream in memory by default. It rebuilds that data after a restart.
The overlay still mounts a small `feedgen-control` volume and sets
`FEEDGEN_MEMBERSHIP_SQLITE_PATH=/app/data/feedgen-membership.sqlite`. That database holds
only saved enrollment and space membership lists, which help it restart and
check for changes.

Those saved lists do not grant access. Before using records received again
after a restart, the older feed generator checks current membership with
Stratos. If it cannot confirm membership, it keeps feeds unavailable and
retries. The overlay also disables core dumps because the process can hold
private content.

Until it has checked all current memberships with Stratos, the older feed
generator returns HTTP `503` `FeedNotReady`. It repeats that check after a
connection loss. If `FEEDGEN_RECONCILE_MAX_ACTORS` stops a check early, feeds
stay unavailable. Keep `FEEDGEN_SUBSCRIBE_ENROLLMENTS` enabled; disabling it
also keeps feeds unavailable.

Saving private posts to disk is separately opt-in. Add a deployment-specific
Compose override:

```yaml
services:
  feedgen:
    environment:
      FEEDGEN_SQLITE_PATH: /app/data/feedgen.sqlite
```

Layer that file after `docker-compose.feedgen.yml`. The `feedgen-control`
volume is still required. The new database also saves private posts, their
boundaries, and the positions needed to resume updates. Protect both as
private data. Saved membership lists help recovery but do not replace a
current membership check with Stratos.

Using `FEEDGEN_STORAGE_BACKEND=postgres` with `FEEDGEN_POSTGRES_URL` saves
posts and membership lists in PostgreSQL. Protect that database as private
data.

A bare `docker compose -f docker-compose.yml -f docker-compose.feedgen.yml up -d` is not
enough on its own: the feedgen's identity is derived from `FEEDGEN_HOST`
(`FEEDGEN_SERVICE_DID=did:web:${FEEDGEN_HOST}`), and that host is the tunnel's ephemeral
`*.trycloudflare.com` address — so `FEEDGEN_HOST` (the public host, no scheme) and
`FEEDGEN_SIGNING_KEY` must be set before the feedgen starts.

The working order is: bring the tunnel up first, take the public host from its logs,
generate (or reuse) a secp256k1 signing key, then start the feedgen with `FEEDGEN_HOST`
and `FEEDGEN_SIGNING_KEY` exported. The header comments in `docker-compose.feedgen.yml`
document the exact flow and the manual compose path — start there if you script the
startup for your own deployment.

## Configuration Reference

`.env.example` is a starting template, not the reference. It still carries a
few names the service does not read, such as `STRATOS_PLC_URL`, `USE_OAUTH`,
and `STRATOS_SIGNING_KEY_HEX`. The
[Configuration](/operator/configuration) page is the reference. It groups every
variable by concern and lists the ones that do nothing.
