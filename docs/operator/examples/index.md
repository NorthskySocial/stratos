# Deployment Examples

Everything needed to stand up Stratos lives in the repository root — there are no
per-scenario bundles to copy. Two Compose files and one environment template cover the
supported deployments:

| File                         | Purpose                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| `docker-compose.yml`         | Base stack: the Stratos service, the AppView indexer, Postgres |
| `docker-compose.feedgen.yml` | Optional overlay that adds the feed generator                  |
| `.env.example`               | Annotated configuration template — copy to `.env`              |

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

## Feed Generator Overlay (`docker-compose.feedgen.yml`)

To run the boundary-scoped feed generator alongside the service, layer the feedgen
overlay on top of the base stack. The overlay adds a `feedgen` service (SQLite-backed) and
an ephemeral Cloudflare tunnel so the feedgen's `did:web` document is reachable over
HTTPS.

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
