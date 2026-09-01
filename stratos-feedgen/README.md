# @northskysocial/stratos-feedgen

Standalone feed generator for Stratos. It serves boundary-scoped, hydrated
feeds from a rebuildable local index fed by two custody-aware ingestion arms:
Stratos actor subscriptions and bounded polling of `pds`-custody member repos.

This works by relying on service auth via `atproto-proxy` as the JWT identifies the DID. This DID is then used to resolve the boundary membership and is used to serve the appropriate records in the feed.

## Architecture

```mermaid
flowchart TD
    Client[Stratos-aware client]
    PDS[User PDS]
    FG([Feed Gen])
    Verify[Verify incoming JWT<br/>resolve user DID]
    BCache[Viewer boundaries cache<br/>TTL + LRU]
    Index[(Post index<br/>uri, did, boundary,<br/>sortAt, recordJson)]
    Hydrate[Stratos hydrateRecords<br/>service-auth]
    Blob[Feed Gen getBlob]
    S3[(S3 blob cache)]
    StratosBlob[Stratos com.atproto.sync.getBlob]
    ResolveEnr[Stratos enrollment and space APIs]

    SvcSub[Service-level subscribeRecords<br/>replays #enrollment events]
    Enrolled[(enrolled_actor table)]
    ActorSub[Per-actor subscribeRecords<br/>did + domain=boundary]
    SpaceMembership[Space membership pass<br/>listRepos + custody partition]
    SpaceScheduler[Bounded space-sync scheduler]
    MemberHost[Member repo host<br/>listRepoOps + getRecord]
    SpaceCursor[(space_sync_cursor<br/>space + member)]
    SpaceStage[(space_sync_stage<br/>unverified delta)]
    Purger[Revocation and commit-failure purge]

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
    SpaceMembership -->|DPoP space credential| ResolveEnr
    SpaceMembership --> SpaceScheduler
    SpaceScheduler -->|DPoP space credential| MemberHost
    MemberHost --> SpaceStage
    SpaceStage -->|verified terminal commit| Index
    SpaceScheduler --> SpaceCursor
    SpaceScheduler --> SpaceStage
    SvcSub --> Purger
    SpaceMembership --> Purger
    Purger --> Index
    Purger --> SpaceCursor
    Purger --> SpaceStage

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
    class Index,Enrolled,SpaceCursor,SpaceStage store
    class BCache,S3,Blob cache
    class Hydrate,ResolveEnr,StratosBlob,MemberHost upstream
    class SvcSub,ActorSub,SpaceMembership,SpaceScheduler,Purger worker
```

**Background workers.** The Stratos-custody arm consumes service enrollment
events, maintains `enrolled_actor`, and starts or stops per-actor WebSocket
subscriptions. The PDS-custody arm enumerates each configured space with
`zone.stratos.space.listRepos`, polls only explicit `custody=pds` members, and
stages `listRepoOps`/`getRecord` deltas with a cursor per `(space, member)`.
Both arms share the purge path, so unenrollment, boundary loss, malformed
cursors, and invalid foreign commits clear derived state when detected. A
foreign-repo delta stays in `space_sync_stage` and is never served until the
host's terminal commit verifies. Verified promotion applies staged updates and
tombstones atomically to the index.

### Auth flow

| Direction                    | Mechanism                                                                                 | Verification                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Client → PDS                 | OAuth + DPoP                                                                              | PDS validates DPoP-bound token                                                 |
| PDS → Feed Gen               | Bearer service-auth JWT (`iss=userDID`, `aud=feedgenDID`, `lxm=<endpoint>`, `exp<60s`)    | Feed gen resolves user DID, verifies signature via atproto verification method |
| Feed Gen → Stratos           | Bearer service-auth JWT (`iss=feedgenDID`, `aud=stratosDID`, `lxm=<endpoint>`)            | Stratos `service` verifier resolves feed gen DID                               |
| Feed Gen → Stratos (sync WS) | `Authorization: Bearer` header = same JWT shape, `lxm=zone.stratos.sync.subscribeRecords` | Stratos `subscribeAuth` verifier                                               |
| Feed Gen → Stratos (space)   | DPoP-bound space credential for `listRepos`; mint uses a short-lived delegation JWT       | Stratos verifies the authority, credential scope, DPoP key, `htu`, and `ath`   |
| Feed Gen → member repo host  | The same scoped credential plus a fresh DPoP presentation for each foreign-host request   | Member host verifies the space authority and request-bound DPoP proof          |

### Identity

- Feed gen DID: `did:web:<feedgen-host>`.
- DID document publishes an `#atproto` verification method (the feed gen's signing keypair) and a service entry with `id=#stratos_feedgen`, `type=NorthskyStratosFeedGen`, `serviceEndpoint=<https URL>`.
- The same signing key is used to mint outgoing service-auth JWTs to Stratos and to prove the feed gen's identity to callers.

### Storage choices

| Concern                              | Choice                                                        |
| ------------------------------------ | ------------------------------------------------------------- |
| Post / boundary / subscription index | SQLite or Postgres via the shared feedgen store               |
| Foreign-repo cursor                  | `space_sync_cursor`, keyed by space URI and member DID        |
| Unverified foreign-repo delta        | `space_sync_stage`, promoted only after terminal verification |
| Membership snapshot                  | SQLite/Postgres; replaced after a complete successful pass    |
| Authorization leases and halt state  | In process; rebuilt from authoritative membership on boot     |
| Space credentials and DPoP keys      | In process; refreshed before expiry, never persisted          |
| Blob cache                           | S3 or filestore                                               |
| Feed configuration                   | Static — JSON/YAML file or env var                            |
| Viewer boundary cache                | In-process TTL + LRU (300 s default)                          |

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
  api/                   Feed, blob, health, metrics, and DID-document handlers
  db/                    SQLite/Postgres store, schemas, and cursor operations
  purge/                 Idempotent actor, boundary, and space-state deletion
  space-credential/      Delegation, DPoP, credential minting, and refresh
  space-sync/            Membership, hardened host client, poller, verification,
                         scheduler, and in-process authorization fencing
  subscription/          Service stream and Stratos-custody actor subscriptions
  upstream/              Typed RPC client for the authority Stratos service
  lifecycle/             Ordered startup/shutdown and panic handling
  config.ts              Env-driven configuration and bounded defaults
  index.ts               Public package exports
tests/
  space-sync-*.test.ts   Foreign-host, membership, cursor, and scheduler coverage
  db/                    Shared SQLite/Postgres store contract
```

**Naming note.** The module is called `upstream` and the class `UpstreamStratosClient` to avoid colliding with the public [`@northskysocial/stratos-client`](../stratos-client/) package.

## Configuration

| Env var                                       | Required    | Description                                                                    |
| --------------------------------------------- | ----------- | ------------------------------------------------------------------------------ |
| `FEEDGEN_SERVICE_DID`                         | yes         | Feed generator service DID                                                     |
| `FEEDGEN_PUBLIC_URL`                          | no          | Public base URL; derived from a `did:web` service DID when omitted             |
| `FEEDGEN_SIGNING_KEY`                         | yes         | Private secp256k1 service-signing key                                          |
| `STRATOS_SERVICE_URL`                         | yes         | Request base URL of the authority Stratos service                              |
| `STRATOS_PUBLIC_URL`                          | no          | Public Stratos origin used in DPoP `htu`; defaults to `STRATOS_SERVICE_URL`    |
| `STRATOS_SERVICE_DID`                         | yes         | DID of the authority Stratos service                                           |
| `FEEDGEN_PLC_URL`                             | no          | PLC directory used for commit-key resolution (default `https://plc.directory`) |
| `FEEDGEN_STORAGE_BACKEND`                     | no          | `sqlite` (default) or `postgres`                                               |
| `FEEDGEN_SQLITE_PATH`                         | conditional | Required for the SQLite backend                                                |
| `FEEDGEN_POSTGRES_URL`                        | conditional | Required for the Postgres backend                                              |
| `FEEDGEN_POSTGRES_SCHEMA`                     | no          | Postgres schema (default `public`)                                             |
| `FEEDGEN_SUBSCRIBE_ENROLLMENTS`               | no          | Set `false` to disable the Stratos subscription arm                            |
| `FEEDGEN_SPACE_SYNC_ENABLED`                  | no          | Enable the PDS-custody polling arm (default `true`)                            |
| `FEEDGEN_SPACE_SYNC_INTERVAL_MS`              | no          | Target interval between jittered passes (default `30000`)                      |
| `FEEDGEN_SPACE_MEMBERSHIP_PAGE_LIMIT`         | no          | Members requested per authority page, `1..1000` (default `100`)                |
| `FEEDGEN_SPACE_MEMBERSHIP_REQUEST_TIMEOUT_MS` | no          | Timeout for membership listing and credential mint requests (default `60000`)  |
| `FEEDGEN_SPACE_SYNC_PAGE_LIMIT`               | no          | Ops requested per page, `1..1000` (default `1000`)                             |
| `FEEDGEN_SPACE_SYNC_MAX_PAGES`                | no          | Pages per member per pass (default `10`)                                       |
| `FEEDGEN_SPACE_SYNC_REQUEST_TIMEOUT_MS`       | no          | Timeout for one foreign-host request (default `10000`)                         |
| `FEEDGEN_SPACE_SYNC_MEMBER_BUDGET_MS`         | no          | Whole-member time budget per pass (default `60000`)                            |
| `FEEDGEN_SPACE_SYNC_MEMBER_CONCURRENCY`       | no          | Concurrent member syncs (default `8`)                                          |
| `FEEDGEN_SPACE_SYNC_MAX_RECORD_BYTES`         | no          | Maximum decoded record size (default `65536`)                                  |
| `FEEDGEN_SPACE_SYNC_MAX_RECORDS_PER_MEMBER`   | no          | Indexed-record cap per member and pass (default `1000`)                        |
| `FEEDGEN_SPACE_SYNC_ALLOW_HTTP_HOSTS`         | no          | Loopback `http://` only: `localhost`, `127/8`, `[::1]`; HTTPS always allowed   |
| `FEEDGEN_LOG_LEVEL`                           | no          | Pino level (default `info`)                                                    |
| `FEEDGEN_METRICS_TOKEN`                       | no          | Bearer token for `/metrics`; unset leaves the endpoint open                    |

## Observability

### Logging

Structured JSON logs via pino. Every request logs one completion line with
`requestId`, `viewerDid` (when authenticated), `endpoint`, `status`, and
`durationMs`. An inbound `X-Request-Id` header (sanitized, max 64 chars) is
honored and echoed on the response; otherwise a UUID is generated. `/health`
and `/metrics` requests are counted in metrics but not logged.

### `/metrics`

Prometheus text format, served on the same listener as the public API. When
`FEEDGEN_METRICS_TOKEN` is set, scrapes must send
`Authorization: Bearer <token>` (constant-time comparison); other requests
get 401. The token travels as a plaintext header, so serve `/metrics` over
HTTPS (TLS-terminating reverse proxy) — on plain HTTP the token is exposed
to any on-path observer. When unset, the endpoint is **open** — the operator
must restrict access at the network layer (firewall or reverse proxy).
Feedgen-specific metrics:

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
HTTP requests (15 s deadline, then open sockets are destroyed), waits for
startup, stops the service stream, and drains the space scheduler. If the
scheduler misses the deadline, shutdown aborts its active pass and still waits
for every raw member call that can access the store. It then drains actor
commit applies, closes the DB, and exits 0. Cursor writes are completed or
restored before the store closes. A second signal exits 1 immediately.
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
