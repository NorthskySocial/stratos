---
audience: Operators
type: Examples
status: current
---

# Deployment Examples

Everything needed to stand up Stratos lives in the repository root. There are
no per-scenario bundles to copy. These files cover the supported deployments:

| File                                       | Purpose                                      |
| ------------------------------------------ | -------------------------------------------- |
| `docker-compose.yml`                       | Base Stratos stack and optional PostgreSQL   |
| `stratos-feedgen-ng/compose.rehearsal.yml` | Constrained feed generator rehearsal profile |
| `.env.example`                             | Service configuration template               |

## Base Stack (`docker-compose.yml`)

The base stack starts the Stratos service on port `3100` and Valkey on the
internal network. Member storage defaults to SQLite. The `stratos-data`
volume holds member storage and the service signing identity. Valkey provides
the replay store for space credentials and client attestation.

The file also defines an optional PostgreSQL profile and an example MinIO
service for S3-compatible blob storage.

Copy the environment template, fill in the required values, then start the
stack:

```bash
cp .env.example .env
# edit .env: set STRATOS_SERVICE_DID, STRATOS_PUBLIC_URL, STRATOS_ADMIN_DIDS,
# and STRATOS_ALLOWED_DOMAINS for your first boundaries
docker compose up -d
```

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

Start the bundled PostgreSQL server with the `postgres` profile. Create the
`stratos` database if it does not already exist:

```bash
docker compose --profile postgres up -d --wait postgres
docker compose exec postgres createdb -U stratos stratos
```

Set `STORAGE_BACKEND=postgres` and enable the `STRATOS_POSTGRES_URL` line
under the Stratos service in Compose:

```yaml
STRATOS_POSTGRES_URL: postgres://stratos:stratos@postgres:5432/stratos
```

Start the stack with `docker compose --profile postgres up -d`.
The profile uses the existing `pgdata` volume. For a volume from an older
PostgreSQL major version, migrate with `pg_upgrade` or dump and restore.

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

## Configuration Reference

`.env.example` is a starting template, not the reference. It still carries a
few names the service does not read, such as `STRATOS_PLC_URL`, `USE_OAUTH`,
and `STRATOS_SIGNING_KEY_HEX`. The
[Configuration](/operator/configuration) page is the reference. It groups every
variable by concern and lists the ones that do nothing.
