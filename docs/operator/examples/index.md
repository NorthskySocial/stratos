# Deployment Examples

Everything needed to stand up Stratos lives in the repository root — there are no
per-scenario bundles to copy. Two Compose files and one environment template cover the
supported deployments:

| File                                       | Purpose                                                       |
| ------------------------------------------ | ------------------------------------------------------------- |
| `docker-compose.yml`                       | Base Stratos stack; its bundled AppView indexer is deprecated |
| `stratos-feedgen-ng/compose.rehearsal.yml` | Constrained feed generator rehearsal profile                  |
| `docker-compose.feedgen.yml`               | Deprecated TypeScript feedgen overlay, retained for rollback  |
| `.env.example`                             | Annotated service configuration template — copy to `.env`     |

The current [Feed Generator](/operator/feedgen-ng) keeps its own encrypted
database. The older TypeScript overlay below is only for rollback.

## Base Stack (`docker-compose.yml`)

The root `docker-compose.yml` brings up three services:

- **`stratos`** (port `3100`) — the Stratos service. Actor storage defaults to SQLite,
  persisted in the `stratos-data` volume at `/app/data`.
- **`indexer`** (port `3002`) — the standalone indexer that feeds an AppView. It writes
  into the Postgres `bsky` database (`BSKY_DB_POSTGRES_URL`).
- **`postgres`** (port `5432`) — Postgres 16 backing the indexer's AppView database.

An optional MinIO service for S3-compatible blob storage is included, commented out.

Copy the environment template, fill in the required values, then start the stack:

```bash
cp .env.example .env
# edit .env — at minimum set STRATOS_SERVICE_DID, STRATOS_PUBLIC_URL,
# STRATOS_ALLOWED_DOMAINS, STRATOS_SYNC_TOKEN, and (for the bundled
# indexer) BSKY_DB_POSTGRES_URL
docker compose up -d
```

## Choosing a Storage Backend

The Stratos service defaults to SQLite (`STORAGE_BACKEND=sqlite`), which keeps per-actor
databases on the mounted volume — a good fit for single-node and development instances.

For high-traffic or high-availability deployments, switch the service to PostgreSQL by
setting `STORAGE_BACKEND=postgres` and either `STRATOS_POSTGRES_URL` or the individual
`STRATOS_PG_*` variables. See the
[Database Storage Backend](/operator/configuration#database-storage-backend) section of
the Configuration reference for the full variable list and precedence rules.

The bundled `postgres` service provisions only the indexer's AppView database (`bsky`) —
there is no `stratos` database by default. To reuse the same instance for Stratos actor
storage, create a separate database first:

```bash
docker compose exec postgres createdb -U stratos stratos
```

then point `STRATOS_POSTGRES_URL` at it (for example
`postgres://stratos:stratos@postgres:5432/stratos`). Do not point `STRATOS_POSTGRES_URL`
at the `bsky` database — it is shared with the indexer's AppView.

Blob storage is a separate choice: `local` (default) or `s3`. See
[Blob Storage](/operator/configuration#blob-storage) for MinIO/S3 settings.

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
[Feed Generator](/operator/feedgen-ng) for the data flow and privacy controls.

## Legacy TypeScript Feed Generator Overlay (`docker-compose.feedgen.yml`)

This section describes the deprecated TypeScript rollback path only. Its
temporary tunnel DID does not meet the current feed DID domain requirement;
do not use this overlay for a new production deployment. Follow
[Feed Generator](/operator/feedgen-ng) and its
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

`.env.example` is the template for the common configuration — copy it to `.env` and fill
in the required values. It is not exhaustive: the storage-backend variables
(`STORAGE_BACKEND`, `STRATOS_POSTGRES_URL`, `STRATOS_PG_*`) are documented in the
[Database Storage Backend](/operator/configuration#database-storage-backend) and
[Blob Storage](/operator/configuration#blob-storage) sections linked above. The
[Configuration](/operator/configuration) page groups every variable by concern —
enrollment modes, domain boundaries, service enrollments, signing keys, storage, and
blobs.
