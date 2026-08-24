# @northskysocial/stratos-feedgen

Standalone feed generator for stratos. Serves boundary-scoped, hydrated feeds to stratos enabled clients by subscribing to a single Stratos service and caching posts + blobs locally.

This works by relying on service auth via `atproto-proxy` as the JWT identifies the DID. This DID is then used to resolve the boundary membership and is used to serve the appropriate records in the feed.

## Architecture

```mermaid
flowchart TD
    Client[Stratos-aware client]
    PDS[User PDS]
    FG([Feed Gen])
    Verify[Verify incoming JWT<br/>resolve user DID]
    BCache[Viewer boundaries cache<br/>TTL + LRU]
    Index[(SQLite post index<br/>uri, did, boundary,<br/>sortAt, recordJson)]
    Hydrate[Stratos hydrateRecords<br/>service-auth]
    Blob[Feed Gen getBlob]
    S3[(S3 blob cache)]
    StratosBlob[Stratos com.atproto.sync.getBlob]
    ResolveEnr[Stratos resolveEnrollments]

    SvcSub[Service-level subscribeRecords<br/>replays #enrollment events]
    Enrolled[(enrolled_actor table)]
    ActorSub[Per-actor subscribeRecords<br/>did + domain=boundary]

    Client -->|DPoP / OAuth| PDS
    PDS -->|atproto-proxy: feedgenDID#stratos_feedgen<br/>service-auth JWT| FG
    FG --> Verify
    FG --> BCache
    FG --> Index
    BCache -.miss.-> ResolveEnr
    Index -.miss.-> Hydrate
    Hydrate -.blob ref rewrite.-> Blob
    Blob --> S3
    S3 -.miss.-> StratosBlob

    SvcSub --> Enrolled
    Enrolled --> ActorSub
    ActorSub --> Index

    classDef client fill:#fde2e4,stroke:#c98a93,color:#3a2a2d
    classDef pds fill:#fad2e1,stroke:#c79bb1,color:#3a2a35
    classDef fg fill:#cddafd,stroke:#8aa0d6,color:#1f2a4a
    classDef store fill:#e2ece9,stroke:#8fb3aa,color:#1f3a35
    classDef cache fill:#fff1e6,stroke:#d4ad7f,color:#4a3520
    classDef upstream fill:#dbe7e4,stroke:#9bb8b1,color:#243a36
    classDef worker fill:#f0efeb,stroke:#b8b3a3,color:#3a382e

    class Client client
    class PDS pds
    class FG,Verify fg
    class Index,Enrolled store
    class BCache,S3,Blob cache
    class Hydrate,ResolveEnr,StratosBlob upstream
    class SvcSub,ActorSub worker
```

**Background workers.** A service-level `subscribeRecords` stream (no `did`) replays `#enrollment` events and upserts an `enrolled_actor` table, starting and stopping per-actor WebSocket subscriptions. Per-actor `subscribeRecords` streams (with `did` and `domain=<boundary>`) decode commits and upsert post + post_boundary rows.

### Auth flow

| Direction                    | Mechanism                                                                                 | Verification                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Client → PDS                 | OAuth + DPoP                                                                              | PDS validates DPoP-bound token                                                 |
| PDS → Feed Gen               | Bearer service-auth JWT (`iss=userDID`, `aud=feedgenDID`, `lxm=<endpoint>`, `exp<60s`)    | Feed gen resolves user DID, verifies signature via atproto verification method |
| Feed Gen → Stratos           | Bearer service-auth JWT (`iss=feedgenDID`, `aud=stratosDID`, `lxm=<endpoint>`)            | Stratos `service` verifier resolves feed gen DID                               |
| Feed Gen → Stratos (sync WS) | `Authorization: Bearer` header = same JWT shape, `lxm=zone.stratos.sync.subscribeRecords` | Stratos `subscribeAuth` verifier                                               |

### Identity

- Feed gen DID: `did:web:<feedgen-host>`.
- DID document publishes an `#atproto` verification method (the feed gen's signing keypair) and a service entry with `id=#stratos_feedgen`, `type=NorthskyStratosFeedGen`, `serviceEndpoint=<https URL>`.
- The same signing key is used to mint outgoing service-auth JWTs to Stratos and to prove the feed gen's identity to callers.

### Storage choices

| Concern                        | Choice                               |
| ------------------------------ | ------------------------------------ |
| Post / boundary / cursor index | SQLite (WAL) via Drizzle             |
| Blob cache                     | S3 or filestore                      |
| Feed configuration             | Static — JSON/YAML file or env var   |
| Viewer boundary cache          | In-process TTL + LRU (300 s default) |

### Moderation labels

Not yet implemented. The planned design (labeler subscription via a
`FEEDGEN_LABELERS` env var, a local `label` table, label merging on
`postView.labels` honoring `atproto-accept-labelers`) is recorded here as
intent only — the current feedgen neither fetches nor serves labels.

## Lexicons

| Lexicon                             | Type                    | Purpose                                                       |
| ----------------------------------- | ----------------------- | ------------------------------------------------------------- |
| `zone.stratos.feedgen.getFeed`      | query (authenticated)   | Returns fully-hydrated boundary-scoped posts                  |
| `zone.stratos.feedgen.describeFeed` | query (unauthenticated) | Returns configured feed list for operator/debug introspection |

Definitions live in [`stratos/lexicons/zone/stratos/feedgen/`](../lexicons/zone/stratos/feedgen/).

## Package layout

```
src/
  config.ts              Env-driven config loader
  upstream/              Typed RPC client for the single upstream Stratos
    client.ts            UpstreamStratosClient (resolveEnrollments,
                         hydrateRecords, getBlob, mintServiceAuthToken)
    jwt.ts               mintServiceJwt — per-call 60 s service-auth JWTs
    errors.ts            StratosClientError (status, body, url, lxm)
    index.ts             Barrel
  index.ts               Public package exports
tests/
  upstream.test.ts       Unit tests for the upstream client
```

**Naming note.** The module is called `upstream` and the class `UpstreamStratosClient` to avoid colliding with the public [`@northskysocial/stratos-client`](../stratos-client/) package.

## Configuration

| Env var               | Required | Description                                                                    |
| --------------------- | -------- | ------------------------------------------------------------------------------ |
| `FEEDGEN_SERVICE_DID` | yes      | This feed generator's service DID (e.g. `did:web:feedgen.example.com`)         |
| `FEEDGEN_SIGNING_KEY` | yes      | Private signing key for this feed generator's service identity (hex secp256k1) |
| `STRATOS_SERVICE_URL` | yes      | Base URL of the upstream Stratos service                                       |
| `STRATOS_SERVICE_DID` | yes      | DID of the upstream Stratos service                                            |
| `FEEDGEN_LOG_LEVEL`   | no       | Pino log level (default `info`)                                                |

Additional configuration (DB path, port, S3 cache settings, feed definitions, labeler DIDs) is added as the corresponding subsystems land.

## Observability

### Logging

Structured JSON logs via pino. Every request logs one completion line with
`requestId`, `viewerDid` (when authenticated), `endpoint`, `status`, and
`durationMs`. An inbound `X-Request-Id` header (sanitized, max 64 chars) is
honored and echoed on the response; otherwise a UUID is generated. `/health`
and `/metrics` requests are counted in metrics but not logged.

### `/metrics`

Prometheus text format. Feedgen-specific metrics:

| Metric                                  | Type      | Labels            |
| --------------------------------------- | --------- | ----------------- |
| `feedgen_requests_total`                | counter   | `endpoint,status` |
| `feedgen_request_duration_seconds`      | histogram | `endpoint`        |
| `feedgen_subscriptions_open`            | gauge     | `kind`            |
| `feedgen_subscription_reconnects_total` | counter   | `kind`            |
| `feedgen_index_posts_total`             | counter   |                   |
| `feedgen_boundary_cache_hits_total`     | counter   |                   |
| `feedgen_boundary_cache_misses_total`   | counter   |                   |

`kind` is `service` (enrollment stream) or `actor` (per-actor syncers).
Process defaults (`process_resident_memory_bytes`, `process_open_fds`,
event-loop lag, …) are included. Blob-cache metrics land with the blob cache
itself (WP9); no blob cache exists yet.

### `/health`

Returns `{ok, version, serviceStreamConnected, actorPoolSize}`. `ok` is
independent of subscription state: with `FEEDGEN_SUBSCRIBE_ENROLLMENTS=false`
the stream fields read `false`/`0` by design.

### Shutdown semantics

On SIGTERM/SIGINT the feedgen stops accepting connections and drains in-flight
HTTP requests (15 s deadline, then open sockets are destroyed), stops the
service stream, waits for in-flight actor commit applies to finish (cursors
are durable per applied commit, so this is the cursor flush), then closes the
DB and exits 0. A second signal exits 1 immediately.
`unhandledRejection`/`uncaughtException` log the error and exit 1.

### Manual soak test

Run locally with sqlite, seeded posts, and `FEEDGEN_SUBSCRIBE_ENROLLMENTS=false`.
Drive ~50 req/s for 5 minutes against `getFeed` with a static service JWT, e.g.
`autocannon -R 50 -d 300 -H "authorization=Bearer $JWT" "$BASE/xrpc/zone.stratos.feedgen.getFeed?feed=<id>"`.
Record before/after RSS (`ps -o rss= -p <pid>`) and FD count
(`ls /proc/<pid>/fd | wc -l`), and cross-check
`process_resident_memory_bytes` / `process_open_fds` from `/metrics`.
Pass: RSS growth < 50 MB and no FD growth.

## Build & test

From the package directory or via the workspace:

```sh
# build
pnpm --filter @northskysocial/stratos-feedgen build

# unit tests (vitest)
pnpm --filter @northskysocial/stratos-feedgen test
```

### Testing conventions

| Class       | Runner | Location                                                                                        |
| ----------- | ------ | ----------------------------------------------------------------------------------------------- |
| Unit        | vitest | `tests/**/*.test.ts` (in-process, fully mocked, no network)                                     |
| Integration | vitest | `tests/**/*.integration.test.ts` (in-process with real SQLite / in-memory HTTP)                 |
| Smoke / E2E | Deno   | [`stratos/test/scripts/feedgen-*.ts`](../test/scripts/) (phases of the existing Deno E2E suite) |

Cross-service smoke and E2E live under `stratos/test/scripts/` and reuse the helpers in `stratos/test/scripts/lib/`. The feed gen does **not** carry per-package smoke scripts or `test/e2e/` directories. Manual staging runs use the same Deno scripts with `STRATOS_SERVICE_URL` (and friends) overridden — there is no separate "manual smoke" artifact.
