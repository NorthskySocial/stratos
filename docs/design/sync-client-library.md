# Design Document: Shared Stratos Sync-Client Library

**Audited at commit `52da35b`** (branch `advisor/015-sync-library-design`),
2026-08-08; corrected 2026-08-21. Every claim about current behaviour below
carries a `file:line` reference at that commit. Paths are relative to the
`stratos/` repository root unless prefixed with `atproto-stratos/`, whose
references are at that repository's `99471e537`.

> **Re-stamp before executing.** The sync code is under active repair (plans 008,
> 011, 016 all landed in the days before this audit). `6aefc4d` (cool-down
> eviction fence) has already landed **above** the audited commit and shifts line
> references into the indexer's `actor-syncer.ts`, `stratos-sync.ts`,
> `config.ts`, and `sync-manager.ts`. If execution starts more than a few weeks
> out, re-verify section 2 against the tree.

---

## 1. Overview

Two services in this repository subscribe to
`zone.stratos.sync.subscribeRecords`: the `stratos-indexer` (writes into the
AppView's Postgres) and the `stratos-feedgen` (writes into its own SQLite/Postgres
index and serves boundary-scoped feeds). They do the same job — connect, back
off, queue frames, drain them one at a time, decode a commit, apply it, advance a
cursor — through two separate implementations, because the second was
hand-copied from the first and the copy says so in its own headers:

`stratos-feedgen/src/subscription/actor-syncer.ts:1-2`

```ts
// copied from stratos-indexer/src/sync/actor-syncer.ts @ 57f907ca8600ff736a30beb2915836b7dca90106
// Todo: extract a shared stratos-sync library used by both the indexer and feedgen
```

`stratos-feedgen/src/subscription/service-stream.ts:1-2`

```ts
// copied from stratos-indexer/src/sync/stratos-sync.ts @ 57f907ca8600ff736a30beb2915836b7dca90106
// Todo: extract a shared stratos-sync library used by both the indexer and feedgen
```

`stratos-feedgen/src/subscription/actor-pool.ts:1-5`

```ts
// copied from stratos-indexer/src/sync/stratos-sync.ts @ 57f907ca8600ff736a30beb2915836b7dca90106
// (specifically the `StratosActorSync` class). Stripped of bsky-specific
// concerns: no IndexingService/BackgroundQueue wiring, no referenced-actor
// discovery, no known-DIDs cache. Idle eviction is retained but gated on
// cap pressure (only evicts when there are waiting actors to promote).
```

The service side of the stream already treats this as a scheduled event:
`stratos-service/src/subscription/subscribe-records.ts:442` defers a reader
unification to "plan 015 (sync-library extraction)".

The maintenance hazard is not theoretical. Since the copy was taken, the two
implementations have diverged on reconnect policy, jitter shape, queue-overflow
handling, socket-identity guards, decode policy, auth scheme, and cursor
durability (section 2). Plans 008 and 016 are the same class of resilience bug
fixed twice, on two schedules, in two dialects.

And the tax has already come due in the worst possible way: **the feedgen's copy
fixed a frame-decoding bug that the original still has, and the fix never
travelled back.** The indexer's Stratos sync data plane cannot decode a single
commit frame (section 2.5). Duplication did not merely double the cost of each
fix; it hid a total data-plane outage in the copy nobody was reading.

---

## 2. Current state

### 2.1 What exists

| Service           | Files                                                                                  | Role                                                               |
| ----------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `stratos-indexer` | `src/sync/actor-syncer.ts`, `src/sync/stratos-sync.ts`, `src/sync/sync-manager.ts`     | Per-actor commit stream + service enrollment stream + bsky wiring  |
| `stratos-feedgen` | `src/subscription/actor-syncer.ts`, `service-stream.ts`, `actor-pool.ts`, `indexer.ts` | The same two streams, plus a pool and a `SubscriptionIndexer` port |

The wire format is common and unchanged. The service emits frames through
`@atproto/xrpc-server`'s `streamMethod`
(`stratos-service/src/subscription/subscribe-records.ts:705`), whose `Frame.toBytes()`
is `Buffer.concat([encode(header), encode(body)])`
(`node_modules/.pnpm/@atproto+xrpc-server@0.10.15/node_modules/@atproto/xrpc-server/dist/stream/frames.js:12-14`).
Both consumers receive identical bytes. **There is no wire divergence** — only a
decode divergence, which is section 2.5.

### 2.2 Drift: per-actor syncer

> **Effective-value note (correction).** The indexer columns in 2.2 and 2.4
> originally cited `DEFAULT_ACTOR_SYNC_OPTIONS` (`stratos-sync.ts:40-52`). Those
> module defaults are dead configuration: `sync-manager.ts:87-99` passes all
> eleven fields from `config.worker.*`, so the env schema in
> `stratos-indexer/src/config.ts` decides every value. Rows below cite the
> effective value first and name the dead default where the two disagree.

| Concern                      | `stratos-indexer/src/sync/actor-syncer.ts`                                                                                                                                                             | `stratos-feedgen/src/subscription/actor-syncer.ts`                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reconnect ceiling            | Cap `reconnectMaxAttempts` (effective 20, `config.ts:69-73`; dead module default 10, `stratos-sync.ts:51`), then `ACTOR_SYNC_COOLDOWN`, counter reset, 5-min cool-down, resume (`:213-228`) — plan 016 | Unbounded retry, no cap (`:278-289`) — deliberate availability posture                                                                                                                              |
| Backoff curve                | `base * 2^(n-1)`, capped, **additive one-sided** jitter `random() * jitterMs` (`:230-236`); effective 1 s / 60 s / 1 000 ms (`config.ts:54-68`; dead defaults at `stratos-sync.ts:48-50`)              | `base * 2^(n-1)`, capped, **symmetric ±ratio** jitter (`:281-284`); defaults 5 s / 60 s / 0.2 (`:67-69`)                                                                                            |
| Backoff reset                | Stability window, `DEFAULT_STABILITY_RESET_MS = 30_000` (`:10`, armed `:250-257`)                                                                                                                      | Stability window, `DEFAULT_STABILITY_RESET_MS = 30_000` (`:71`, armed `:262-269`), configurable via `stabilityResetMs` (`:50`)                                                                      |
| Queue shape                  | `ActorQueue { pending, draining }` (`:13-16`); cap from `maxActorQueueSize` (effective **10**, `ACTOR_SYNC_QUEUE_PER_ACTOR`, `config.ts:36`; dead default 1000, `stratos-sync.ts:42`)                  | Plain array + `draining` flag (`:95-96`); `DEFAULT_MAX_QUEUE_SIZE = 1_000` (`:70`)                                                                                                                  |
| Queue overflow               | Plain `Error` (no code), `closeAndReconnect()` — closes socket, **keeps `pending`** (`:277-283`, `:298-304`)                                                                                           | `ACTOR_SYNC_OVERFLOW`, `failConnection()` — **clears the queue**, detaches, reconnects (`:322-331`, `:297-301`)                                                                                     |
| Drain admission control      | Global gate: `canStartSync()` + `drainDelayMs` sleep loop (`:317-322`); `onSyncStarted`/`onSyncFinished` accounting                                                                                    | None — drains as fast as the applier allows (`:338-350`); pacing lives in the pool's connect gate                                                                                                   |
| Superseded-socket guard      | **Absent.** `onmessage`/`onclose` do not identity-check the socket (`:171-174`, `:194-201`)                                                                                                            | Present in both (`:220`, `:248`) — plan 008                                                                                                                                                         |
| Frame decode                 | Single-value `decodeFirst(data) as unknown as XrpcFrame`, reads `.t` off the tuple (`:446-456`) — **broken**, see 2.5                                                                                  | Two-value destructure of header then body (`:382-385`, `:399`) — correct for `#commit` frames; `op` is never inspected, so an `ErrorFrame` is discarded in silence (`:396`; see invariant 5's note) |
| Commit body shape validation | None — `frame as unknown as StratosSyncCommit` (`:450`)                                                                                                                                                | `isCommitFrameBody` guards `seq`/`time`/`ops` before apply (`:410-418`, `:474-482`)                                                                                                                 |
| Decode-failure policy        | `return null`, frame silently ignored (`:453-455`); a thrown decode also swallowed at `:352-354`                                                                                                       | Continue, but reported under `ACTOR_SYNC_FRAME_UNDECODABLE`, with the rationale documented (`:352-377`, `:386-418`)                                                                                 |
| Apply-failure policy         | **Swallow and continue** (`:346-355`); a later success writes a cursor past the failed seq (`:401-418`) — see 2.6                                                                                      | `failConnection()`: clear queue, detach, reconnect from the durable cursor, retry the seq forever (`:429-432`)                                                                                      |
| Apply-failure alarm          | None                                                                                                                                                                                                   | `APPLY_FAILURE_ALARM_THRESHOLD = 3` (`:80`) → one `ACTOR_SYNC_STALLED` per stall episode (`:441-463`)                                                                                               |
| Cursor durability            | In-memory `CursorManager`, periodic flush on a timer (`storage/cursor-manager.ts:26-30`, `:57-60`, `:100-110`)                                                                                         | Written inside `applyCommit` in the same store call sequence (`subscription/indexer.ts:61`), read back on connect (`stratos-feedgen/src/subscription/actor-syncer.ts:186`)                          |
| Upstream auth                | `syncToken` as a **query parameter** (`:156-160`), no `Authorization` header (`:162`) — rejected today, see 2.5                                                                                        | Freshly minted service-auth JWT as `Authorization: Bearer` on the upgrade (`:202-204`)                                                                                                              |
| Consumer coupling            | Kysely + the AppView schema baked in (`:2`, `:90`, `:493-565`)                                                                                                                                         | `SubscriptionIndexer` + `Pick<FeedgenStore,'getCursor'>` ports (`:53-59`)                                                                                                                           |
| Fork-only extras             | Referenced-DID discovery `onReferencedActor`, `onHandleNeeded` (`:380-386`, `:463-484`)                                                                                                                | `setConnectGate` for pool-level connect pacing (`:145-147`, `:171-179`); `getLastConnectUrl` test seam (`:137-139`)                                                                                 |
| WebSocket implementation     | Global `WebSocket` (`:162`), untyped/uninjectable                                                                                                                                                      | Injectable `wsCtor`, defaults to `ws` (`:104`, `:120`) — testable without a network                                                                                                                 |

### 2.3 Drift: service-level enrollment stream

| Concern                 | `stratos-indexer/src/sync/stratos-sync.ts`                                                                                  | `stratos-feedgen/src/subscription/service-stream.ts`                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Message ordering        | Serialized queue + drain, generation-swapped on reset (`:170-217`) — plan 016                                               | Serialized queue + drain (`:284-313`) — plan 008                                                                  |
| Queue cap / overflow    | `SERVICE_STREAM_MAX_QUEUE = 1_000` (`:57`); overflow → `SERVICE_STREAM_OVERFLOW`, `resetQueue()`, `ws.close()` (`:172-182`) | `DEFAULT_MAX_QUEUE_SIZE = 1_000` (`:78`); overflow → `SERVICE_STREAM_OVERFLOW`, `failConnection()` (`:285-294`)   |
| Backoff curve           | `1000 * 2^attempt`, cap 30 s, **no jitter** (`:54-55`, `:226-229`) — first retry at 2 s                                     | `5000 * 2^(attempt-1)`, cap 60 s, ±20 % jitter (`:74-76`, `:234-245`) — first retry at 5 s                        |
| Backoff reset           | 30 s stability window (`:56`, `:242-249`)                                                                                   | 30 s stability window, configurable (`:77`, `:218-225`)                                                           |
| Superseded-socket guard | **Absent** (`:131-133`, `:152-159`)                                                                                         | Present (`:178`, `:204`)                                                                                          |
| Callbacks               | `onEnroll` / `onUnenroll`, **synchronous** (`:35-38`, `:280-283`)                                                           | `onEnroll` / `onUnenroll` / `onBoundariesChanged?`, all **awaited** (`:7-21`, `:326-344`)                         |
| `boundaries` action     | Folded into `onEnroll` with the after-set (`:276-280`)                                                                      | Routed to `onBoundariesChanged` so a consumer can diff and purge (`:336-343`)                                     |
| Frame decode            | Single-value `decodeFirst(data)`, reads `.t` off the tuple (`:269`) — **broken**, see 2.5                                   | Two-value destructure (`:319-324`) — correct, though `op` is never inspected here either (see invariant 5's note) |
| Upstream auth           | `syncToken` query parameter (`:120-124`)                                                                                    | Minted service-auth JWT `Authorization: Bearer` (`:161-163`)                                                      |

### 2.4 Drift: pool and dependencies

| Concern        | `stratos-indexer` `StratosActorSync` (`stratos-sync.ts:296-556`)                                                                          | `stratos-feedgen` `ActorPool` (`actor-pool.ts`)                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Connection cap | `maxConnections` effective **20** (`config.ts:43`; dead default 500, `:45`), FIFO `waitingActors`, timer-paced promotion (`:462-521`)     | `DEFAULT_MAX_CONNECTIONS = 500` (`:46`), FIFO `waiting` + `requested` set (`:113-123`) |
| Connect pacing | `connectTimer` promoting one actor every `connectDelayMs` (`:466-470`)                                                                    | Per-syncer async `connectGate` acquiring a spaced slot (`:247-254`)                    |
| Idle eviction  | Gated on waiters (`:528`), effective **60 s** (`config.ts:49-53`; dead default 30 min, `:47`), evicts ≤10 % of cap per sweep (`:543-547`) | Gated on waiters (`:167`), 15 min (`:48`), evicts ≤ waiter count (`:179-190`)          |
| Seeding        | Actors arrive via PDS firehose / enrollment callbacks                                                                                     | `seedFromStore(configuredBoundaries)` from persisted enrollments (`:199-208`)          |
| bsky wiring    | `IndexingService`, `BackgroundQueue`, `indexHandle` scheduling, known-DID TTL cache (`sync-manager.ts:9,12,100-107`; `:297-303`)          | None                                                                                   |
| Observability  | `console.log` stats timer (`:332-345`)                                                                                                    | `getStats()` returning counts (`:149-155`); logging left to the caller                 |
| Package deps   | `kysely`, `@atproto/bsky` (`stratos-indexer/package.json`)                                                                                | Neither (`stratos-feedgen/package.json`)                                               |

### 2.5 Finding: the indexer's Stratos sync path does not run

This was discovered while completing the drift table and is larger than the
extraction question. It is recorded here because it changes the severity
arithmetic in section 7. **It is tracked separately for its own repair plan; this
document does not claim ownership of the fix.**

Three independent breaks, any one of which is sufficient:

**(a) The upgrade is rejected — no `Authorization` header.**
`createSubscribeAuthVerifier` requires an inter-service JWT and documents that
"the master sync token, query-parameter tokens, and anonymous access have been
removed" (`stratos-service/src/infra/auth/verifiers.ts:619-620`); it throws
`AuthRequiredError` unless `authorization` starts with `'Bearer '`
(`:632-634`). The indexer sends `syncToken` as a query parameter and constructs
a bare `new WebSocket(wsUrl)` with no headers, for both the actor stream
(`stratos-indexer/src/sync/actor-syncer.ts:156-162`) and the service stream
(`stratos-indexer/src/sync/stratos-sync.ts:120-124`). The fix is not a
one-line header addition: the indexer constructs the socket with the global
`WebSocket` (`stratos-indexer/src/sync/actor-syncer.ts:162`), whose standard
constructor accepts no headers option, so sending `Authorization: Bearer`
requires swapping the WebSocket implementation — as the feedgen already does
via its injectable `wsCtor` defaulting to `ws`
(`stratos-feedgen/src/subscription/actor-syncer.ts:104,120`), which is what
lets it set the header at `:202-204`.

**(b) Every frame decodes to nothing.** `decodeFirst` returns a
`[value, remainder]` tuple —
`node_modules/.pnpm/@atcute+cbor@2.3.2/node_modules/@atcute/cbor/dist/decode.d.ts:1`:

```ts
export declare const decodeFirst: (
  buf: Uint8Array<ArrayBufferLike>,
) => [value: any, remainder: Uint8Array<ArrayBufferLike>]
```

The indexer reads `.t` directly off that array at both call sites —
`actor-syncer.ts:448` (`const frame = decodeFirst(data) as unknown as XrpcFrame`,
then `frame.t === '#commit'` at `:449`) and `stratos-sync.ts:269` (then
`msg.t === '#enrollment'` at `:270`). An array has no `t` property, so the
comparison is always `undefined === '#commit'` → `false`. `decodeXrpcFrame`
always returns `null`, so `processCommit` (`:401`) is unreachable; the
enrollment branch is never taken. The feedgen destructures correctly
(`service-stream.ts:319-324`, `actor-syncer.ts:382-385`) against the same bytes.

The double assertion `as unknown as` is what hides this from `tsc` today; it
arrived at `57f907c` (the same commit the feedgen copy headers reference) — at
introduction the cast was a single `as XrpcFrame`
(`84df95a:stratos-indexer/src/actor-syncer.ts:403`). The decode itself has
been wrong since that introduction: `84df95a` replaced a **correct**
`decodeXrpcFrame` with the single-value form. At that commit the files
predated the `src/sync/` layout — a file-scoped `git show` against today's
`src/sync/actor-syncer.ts` path returns nothing — and the deleted correct
helper lived in the parent's `stratos-sync.ts`, so the reproducible citation
is `git show 84df95a^:stratos-indexer/src/stratos-sync.ts` (lines 910-929), which
destructures `const [header, remainder] = decodeFirst(data)`, then
`const [body] = decodeFirst(remainder)`, throws on `hdr.op === -1`, and
returns `null` unless `hdr.op` is `1`.

**(c) Nothing reads what it writes.** `batchIndexStratosRecords` writes
`stratos_record`, `stratos_record_boundary` and bsky's `post`
(`actor-syncer.ts:493-565`), tables the indexer creates itself
(`stratos-indexer/src/storage/db.ts:95-120`). The AppView's Stratos feed queries
read `stratos_post` and `stratos_post_boundary`
(`atproto-stratos/packages/bsky/src/stratos/store.ts:47,55,77,119`), created by
`atproto-stratos/packages/bsky/src/data-plane/server/db/migrations/20260312T120000000Z-add-stratos-tables.ts:5,45`.
The two sets of **post-content** tables do not intersect. The service-level
tables are shared, however: `stratos_enrollment` and `stratos_sync_cursor` are
created by both sides (`stratos-indexer/src/storage/db.ts:79-94`; the AppView
migration at `…add-stratos-tables.ts:58,67`) and read by the AppView
(`atproto-stratos/packages/bsky/src/stratos/store.ts:182,237`) — so a revival's
writes are not confined to tables only the indexer touches.

**Consequences at `52da35b`:** zero Stratos posts indexed by the standalone
indexer; `updateStratosCursor` is called from exactly two places
(`actor-syncer.ts:417` inside the unreachable `processCommit`, and
`stratos-sync.ts:399` when an actor is added with an explicit cursor), so the
per-actor Stratos cursor has never advanced from stream traffic; the enrollment
stream is inert. The failure is silent: `isConnected()` reports socket state
only (`actor-syncer.ts:100-102`), and the indexer's own tests never encode a
real frame — `stratos-indexer/tests/actor-syncer.test.ts` exercises reconnect,
cool-down and queueing with a `FakeWebSocket` and contains no CBOR encoding at
all.

**A related question for a maintainer, not resolved here:** were (a) and (b)
repaired without also changing (c), the indexer would begin writing Stratos
private posts into bsky's own public `post` table. The indexer's pool targets
the AppView's database — `postgresUrl: env.BSKY_DB_POSTGRES_URL`
(`stratos-indexer/src/config.ts:171`) — so its `CREATE TABLE IF NOT EXISTS post`
(`db.ts:95-105`) is a no-op against bsky's existing table, and the insert at
`actor-syncer.ts:515-528` lands in the real one. That table carries no boundary
column (`atproto-stratos/packages/bsky/src/data-plane/server/db/tables/post.ts:5-24`),
so no boundary filtering is even available on it, and a public read path
matches directly on it: the dataplane's `searchPosts` does
`.selectFrom('post').where('post.text', 'like', …)` with no boundary and no
collection predicate
(`atproto-stratos/packages/bsky/src/data-plane/server/routes/search.ts:52-55`).

What that establishes, and what it does not: private post plaintext would sit
in a public table with no boundary column, and a public **search** path
matches on `post.text` — at minimum a search-matching oracle over private
content, disclosing the author DID (via the returned URI) and timing. But
`searchPosts` returns URIs only (`search.ts:70-73`), and hydration goes
through `getRecords(db, ids.AppBskyFeedPost, …)`
(`atproto-stratos/packages/bsky/src/data-plane/server/routes/records.ts:206`)
reading the `record` table, which `batchIndexStratosRecords` never writes for
these posts (per (c)) — so verbatim text rendering to end users appears
blocked. Timeline and author feeds join `post` via `feed_item`
(`atproto-stratos/packages/bsky/src/data-plane/server/routes/feeds.ts:16`),
which the Stratos path also never writes, so feeds are not the reachable
surface — search is. And `search.ts:36` carries a
`@TODO post search endpoint still falls back to search service`, so whether
this dataplane implementation is the live production search path is
deployment-dependent and was not established here. The crucial point for
whoever repairs (a) and (b): full text rendering appears blocked only by the
accident of the schema mismatch in (c), not by any access control. It is
flagged, not claimed.

### 2.6 Finding: the indexer's commit-apply failure policy (Step 1b)

The indexer shares the feedgen's pre-008 shape, as the fork direction predicts.

- **Swallow-and-continue.** `handleMessage` wraps decode + `processCommit` in a
  `try/catch` that reports to `onError` and returns; the drain loop proceeds to
  the next frame (`actor-syncer.ts:346-355`, loop at `:316-334`).
- **The cursor advances past the failure.** `processCommit` awaits the batch
  write at `:412` and only then calls `updateStratosCursor(this.did, commit.seq)`
  at `:417`. A throw at `:412` correctly skips the cursor write for _that_
  commit — but the loop continues, and the next commit that succeeds (or that
  has no indexable ops — the batch write at `:411` is skipped, while the cursor
  write at `:417` runs unconditionally) writes its own, higher `seq`. The failed
  sequence is then behind the cursor and is never replayed on reconnect (`:155`).

Answers to Step 1b's four facts:

1. **Cursor advance on skip: yes** (`:346-355` + `:417`, above). The cursor is
   also only flushed periodically (`storage/cursor-manager.ts:26-30`, `:100-110`),
   which widens replay on crash but does not change the skip.
2. **Heal path: server-side yes, client-side no.** The service ships a
   pull-sync surface: `zone.stratos.sync.listRepoOps` serves a signed-commit
   oplog, and its lexicon documents the fallback contract — when `since`
   predates retained history, `OplogTruncated` is returned "so the caller falls
   back to full-state recovery (listRecordPaths)"
   (`lexicons/zone/stratos/sync/listRepoOps.json:7`; handlers in
   `stratos-service/src/features/pull-sync/handler.ts`, `oplog.ts`,
   `recovery.ts`). No consumer calls either endpoint. On the client side,
   `stratos-indexer/src/backfill.ts` cannot repair a Stratos-side hole: it pages
   `com.atproto.repo.listRecords` against `opts.repoProvider` (`:152-169`) — the
   user's **PDS**, which holds stubs, not the private Stratos records — it is
   only ever invoked for referenced-actor discovery and startup seeding, and the
   options object built in `sync-manager.ts:64-71` sets `repoProvider: ''` with
   the comment "This will be set by the caller if needed". There is no
   pull-sync, `zone.stratos.sync.getRepo`, or resync call anywhere in
   `stratos-indexer/src`. A heal path exists; what is missing is a client for
   it — and the shared library is the obvious home for that client.
3. **Indexed row as source of truth: yes, for the AppView's design** — the Stratos
   feed endpoints read `stratos_post`/`stratos_post_boundary` directly with no
   upstream re-hydration (`atproto-stratos/packages/bsky/src/stratos/store.ts:77-135`).
   But per 2.5(c) those are not the rows this indexer writes, so today the
   question is moot.
4. **Path live: no**, on three independent grounds (2.5 a/b/c). This is a stronger
   answer than DIR-03's open "does the feedgen supersede the indexer?" question:
   regardless of intent, the path does not currently function.

**One-sentence finding:** an `applyCommit` failure in the indexer would lose the
failed commit permanently — the cursor advances past it on the next success and
no backfill or resync **client** exists to recover it (the service-side
pull-sync surface has no consumer) — but the code that would do so is
unreachable at `52da35b` because the stream neither authenticates nor decodes.

### 2.7 Third-copy search

`scheduleReconnect` appears in exactly four files in this repository, the two
forks' four sync modules. A fifth match exists in the workspace at
`northsky-pronouns/labeler/src/lib/jetstream.ts` — an unrelated Bluesky
**Jetstream** consumer for `app.bsky.feed.like` with its own protocol, cursor
model and gap detection. It is not a copy of the Stratos sync client and is not
a consumer of `zone.stratos.sync.subscribeRecords`. **No third copy; no STOP.**

---

## 3. Goals, non-goals, and verdict

### Verdict: **EXTRACT**

Extract a shared sync-client library, seeded from the feedgen implementation,
and migrate both services onto it.

The reasoning is section 2.5, not section 2.2. A drift table alone would have
justified "defer" — two forks that each work but disagree on jitter shape are an
annoyance, not a crisis. What the audit actually found is that one fork's
frame-decoding bug was **fixed in the copy and never travelled back to the
original**, and stayed invisible for months behind an `as unknown as` assertion
in a module nobody had reason to re-read. That is the specific failure mode
duplication produces, and no amount of discipline prevents it while two
implementations exist. The indexer's copy must be substantially rewritten anyway
to be revived (auth, decode, superseded-socket guards, apply policy); rewriting
it as a fork is throwaway work.

Cost is bounded and the target shape already exists: the feedgen's syncer is
already port-driven (`SubscriptionIndexer`, `Pick<FeedgenStore,'getCursor'>`,
injectable `wsCtor`), already free of Kysely and `@atproto/bsky`, and already
carries the richer characterization test suite
(`stratos-feedgen/tests/actor-syncer.test.ts`, `service-stream.test.ts`,
`actor-pool.test.ts`).

### Goals

- One implementation of connect, backoff, stability reset, queue + drain,
  socket-identity guarding, frame decode, and failure policy, consumed by both
  services.
- Every current policy difference in section 2.2/2.3 expressed as
  **configuration with a documented default**, not as a fork — including the
  feedgen's unbounded reconnect, which is a deliberate availability posture and
  must remain expressible.
- Correctness properties (section 4.4) fixed as invariants the library does not
  let a consumer configure away.
- Zero dependency on Kysely or `@atproto/bsky`. Storage is the consumer's.

### Non-goals

- Merging the two services, or changing which database either writes.
- Changing wire behaviour, the lexicon, or the service-side stream
  (`stratos-service/src/subscription/subscribe-records.ts`). The library is a
  client only.
- Abstracting the indexing logic. Each consumer keeps its own `applyCommit`:
  the feedgen writes posts + boundaries + blob refs
  (`stratos-feedgen/src/subscription/indexer.ts:33-62`), the indexer writes bsky
  tables through Kysely (`stratos-indexer/src/sync/actor-syncer.ts:493-565`).
  Those have nothing in common and must not be unified.
- Fixing the indexer's data plane (section 2.5). That is its own plan; this
  document only reasons about how it interacts with the extraction.

---

## 4. Proposed shape

### 4.1 Location: a new workspace package, `stratos-sync-client`

Add `stratos-sync-client` to `pnpm-workspace.yaml` (a one-line change to the
existing package list) rather than adding a module to `stratos-core`.

Rejected alternative — `stratos-core/src/sync/`:

- `stratos-core` is a dependency of `stratos-service`
  (`stratos-service` imports `@northskysocial/stratos-core` throughout), and the
  service has no use for a WebSocket **client**. Putting it there forces the
  server to carry a client's runtime deps.
- The library needs a runtime WebSocket implementation (`ws`, imported today at
  `stratos-feedgen/src/subscription/actor-syncer.ts:5`). `stratos-core`'s
  dependency set is domain/storage-shaped — `drizzle-orm`, `postgres`,
  `@libsql/client`, `@atcute/*` — and does not carry `ws`. Adding it there is a
  wider blast radius than adding a package.
- The no-Kysely / no-bsky constraint becomes enforceable by construction: the
  new `package.json` simply never lists them, so a regression is a review-visible
  dependency addition rather than a stray import. (`stratos-core` satisfies the
  constraint today, so this is a preservation argument, not a correction.)
- Mutation testing is per-package (`stratos-feedgen/stryker.config.json`). A
  dedicated package gets its own `stryker.config.json` with `mutate` globs over
  the whole library, instead of diluting `stratos-core`'s thresholds.

Dependencies of the new package: `@atcute/cbor`,
`@northskysocial/stratos-core` (for `StratosError` only), and `ws` **as a
runtime dependency**. Note that `ws` is currently only a _devDependency_ of the
feedgen (`stratos-feedgen/package.json:46`) while being imported by shipped code
(`src/subscription/actor-syncer.ts:5`, `service-stream.ts:5`) that `pnpm start`
runs unbundled from `dist/`; the extraction should declare it properly rather
than inherit the mistake.

### 4.2 Ports the consumer implements

All four are plain interfaces, defined by the library, implemented by each
service. No base classes.

| Port                 | Shape                                                                                                                 | Today's implementations                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Commit applier**   | `applyCommit(args: { did, seq, time, ops: CommitOp[] }): Promise<void>`                                               | feedgen `SubscriptionIndexer` (`stratos-feedgen/src/subscription/indexer.ts:25-62`); indexer's would wrap `batchIndexStratosRecords` (`actor-syncer.ts:493`) |
| **Cursor store**     | `getCursor(did): Promise<number \| null>`; `setCursor(did, seq, time): Promise<void>`                                 | feedgen `FeedgenStore` (`stratos-feedgen/src/db/types.ts:75-76`); indexer `CursorManager` (`storage/cursor-manager.ts:57-60`, `:84-86`)                      |
| **Stream callbacks** | `onEnroll(did, boundaries)`, `onUnenroll(did)`, `onBoundariesChanged?(did, boundaries)`, each `void \| Promise<void>` | feedgen `ServiceStreamCallbacks` (`service-stream.ts:7-21`); indexer `StratosSyncCallbacks` (`stratos-sync.ts:35-38`, lacks the third)                       |
| **Observation sink** | `onError(err: Error)`; optional `onEvent(name, fields)` for counters                                                  | Both pass an `onError` today (`actor-syncer.ts:56`, `stratos-sync.ts:75`)                                                                                    |

Two deliberate decisions inside the port list:

- **The cursor write moves out of `applyCommit`.** The feedgen currently
  advances the cursor as the last statement of its own `applyCommit`
  (`indexer.ts:61`). The library should own that ordering — apply, then persist
  the cursor — so the "never advance past a failure" invariant is enforced by
  the library rather than by each consumer remembering to put the write last.
  A consumer that needs apply + cursor in one transaction can still do so by
  making `setCursor` a no-op and keeping the write inside `applyCommit`; the
  invariant holds either way because the library's failure path never calls
  `setCursor`. Two consequences the port contract must state: `applyCommit`
  must be idempotent per `(did, seq)`, because a crash — or a `setCursor`
  failure — between a successful apply and the cursor persist re-delivers that
  commit on reconnect. And a `setCursor` failure follows the apply-failure
  path (clear the queue, drop the connection, resume from the durable cursor);
  advancing in memory past an unpersisted cursor would hide the re-delivery.
- **`onBoundariesChanged` is optional.** The indexer folds `boundaries` into
  `onEnroll` with the after-set (`stratos-sync.ts:276-280`); the feedgen routes
  it separately (`service-stream.ts:336-343`). Optional preserves both without a
  flag argument: a consumer that omits it simply does not observe the event.

The WebSocket constructor stays injectable (`wsCtor`), as in
`stratos-feedgen/src/subscription/actor-syncer.ts:104,120` — it is what makes the
existing test suite run without a network, and it is the single largest reason
the feedgen's copy is the better seed.

### 4.3 Policy knobs

Defaults below are the values a unified library should ship. Where the two forks
disagree, the recommended default and the loser are both named, because adopting
one silently changes the other service's behaviour (section 6). Indexer values
are the **effective** env-schema values (see the section 2.2 note); the dead
module default is named where the two disagree.

| Knob                          | Type                     | Recommended default | Indexer today                                                                                                                       | Feedgen today                                     | Note                                                                          |
| ----------------------------- | ------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `reconnect.maxAttempts`       | `number \| 'unbounded'`  | `'unbounded'`       | 20 (`config.ts:69-73`; dead default 10, `stratos-sync.ts:51`)                                                                       | unbounded (`actor-syncer.ts:278-289`)             | Indexer keeps `20` + cool-down by config; see 4.4 for why not a give-up       |
| `reconnect.cooldownMs`        | `number`                 | `300_000`           | 300 000 — made configurable by `6aefc4d` as `ACTOR_SYNC_RECONNECT_COOLDOWN_MS` (was `RECONNECT_COOLDOWN_MS`, `actor-syncer.ts:11`)  | n/a (never reaches a cap)                         | Only consulted when `maxAttempts` is numeric                                  |
| `reconnect.baseDelayMs`       | `number`                 | `5_000`             | 1 000 (`config.ts:54-58`; dead default agrees, `stratos-sync.ts:48`)                                                                | 5 000 (`actor-syncer.ts:67`)                      | Service stream: 1 000 vs 5 000 (`stratos-sync.ts:54`, `service-stream.ts:74`) |
| `reconnect.maxDelayMs`        | `number`                 | `60_000`            | 60 000 actor (`config.ts:59-63`) / 30 000 service (`stratos-sync.ts:55`)                                                            | 60 000 both (`:68`, `:75`)                        |                                                                               |
| `reconnect.jitter`            | `{ ratio: number }`      | `{ ratio: 0.2 }`    | additive `random()*1000 ms` actor (`config.ts:64-68`; shape at `actor-syncer.ts:235`), **none** service (`stratos-sync.ts:226-229`) | symmetric ±20 % (`:283`)                          | Symmetric ratio is the only shape that de-synchronises a thundering herd      |
| `reconnect.stabilityResetMs`  | `number`                 | `30_000`            | 30 000 (`actor-syncer.ts:10`, `stratos-sync.ts:56`)                                                                                 | 30 000 (`:71`, `:77`)                             | Agreed; but see the backlog-burst risk in section 6                           |
| `actorQueue.maxSize`          | `number`                 | `1_000`             | **10** (`config.ts:36`; dead default 1 000, `stratos-sync.ts:42`)                                                                   | 1 000 (`actor-syncer.ts:70`)                      | Feedgen 1 000 vs indexer 10 — see R2                                          |
| `serviceQueue.maxSize`        | `number`                 | `1_000`             | `SERVICE_STREAM_MAX_QUEUE` (`stratos-sync.ts:57`)                                                                                   | `DEFAULT_MAX_QUEUE_SIZE` (`service-stream.ts:78`) | Agreed                                                                        |
| `queue.overflowPolicy`        | `'drop-connection'`      | `'drop-connection'` | actor: close-but-keep-pending (`actor-syncer.ts:298-304`); service: clear + close (`stratos-sync.ts:172-182`)                       | clear + detach + reconnect (`:322-331`)           | See the backpressure open question in section 6                               |
| `applyFailure.alarmThreshold` | `number`                 | `3`                 | none                                                                                                                                | `APPLY_FAILURE_ALARM_THRESHOLD` (`:80`)           | Gates an **alarm**, never a skip                                              |
| `drain.admission`             | `DrainAdmission \| null` | `null`              | `canStartSync` + `drainDelayMs` (`actor-syncer.ts:317-322`; effective delay 5 ms, `config.ts:42`)                                   | none                                              | An interface, not a predicate — see below                                     |
| `pool.maxConnections`         | `number`                 | `500`               | **20** (`config.ts:43`; dead default 500, `stratos-sync.ts:45`)                                                                     | 500 (`actor-pool.ts:46`)                          | Feedgen 500 vs indexer 20 — see R1                                            |
| `pool.connectDelayMs`         | `number`                 | `10`                | **200** (`config.ts:44-48`; dead default 10, `stratos-sync.ts:46`)                                                                  | 10 (`actor-pool.ts:47`)                           | Feedgen 10 ms vs indexer 200 ms — see R1                                      |
| `pool.idleEvictionMs`         | `number` (`0` disables)  | `900_000`           | **60 000** (`config.ts:49-53`; dead default 1 800 000, `stratos-sync.ts:47`)                                                        | 900 000 (`actor-pool.ts:48`)                      | Both gate eviction on waiters existing                                        |

Error codes stay as named, stable strings — `ACTOR_SYNC_OVERFLOW`,
`ACTOR_SYNC_APPLY_FAILED`, `ACTOR_SYNC_STALLED`, `ACTOR_SYNC_FRAME_UNDECODABLE`,
`ACTOR_SYNC_COOLDOWN`, `SERVICE_STREAM_OVERFLOW` — since operators alert on them.
The indexer's uncoded plain `Error` for queue overflow
(`actor-syncer.ts:278-280`) is the only one that changes, gaining
`ACTOR_SYNC_OVERFLOW`. The decoder's `ErrorFrame` surfacing (invariant 5)
adds one new code, `SYNC_STREAM_ERROR_FRAME`.

**`drain.admission` is an interface, not a predicate.** The indexer's
`canStartSync` is not a stateless function: it is a closure over live counters
(`stratos-sync.ts:508-510`) that stay current only because the syncer fires
`onGlobalPendingChange` on every enqueue and dequeue (`actor-syncer.ts:286`,
`:326`), `onSyncStarted` when a drain begins (`:328`), and `onSyncFinished` when
it ends (`:332`). A bare `() => boolean` cannot carry that contract. The library
should define:

```ts
interface DrainAdmission {
  canStart(): boolean
  onStarted(): void
  onFinished(): void
  onPendingChange(delta: number): void
}
```

with `null` meaning no gate — the feedgen's posture today.

### 4.4 Non-negotiable invariants

These are correctness properties. The library must not expose configuration that
turns them off.

1. **A failed `applyCommit` clears the pending queue before closing.** Closing
   the socket alone leaves buffered successors to drain and carry the cursor past
   the failed sequence — the exact silent hole plan 008 exists to close. Correct
   today only in the feedgen (`actor-syncer.ts:297-301`); the indexer's
   `closeAndReconnect` deliberately leaves `pending` intact (`:298-304`).
2. **A failed sequence is retried indefinitely — no skip, no cap.** Neither
   consumer ships a resync client today (section 2.6, fact 2 — the service's
   pull-sync surface has no consumer), so a skipped commit is unrecoverable
   until such a client exists, while a stalled actor is observable via
   `ACTOR_SYNC_STALLED` and self-heals when the fault clears.
   **Reconciling this with the indexer's `reconnectMaxAttempts`:** they are not
   in conflict once separated. The apply-failure retry is unbounded, always. The
   _connection_ attempt cap is a knob, and plan 016 already converted its
   terminal branch into a cool-down plus fresh backoff
   (`actor-syncer.ts:213-228`) rather than an abandonment, so a numeric
   `maxAttempts` no longer strands an actor. The library keeps the knob with
   cool-down semantics; there is no permanent give-up at any setting.
3. **Frames from a superseded socket are ignored.** `onmessage` and `onclose`
   identity-check the socket they were registered on
   (`stratos-feedgen/src/subscription/actor-syncer.ts:220,248`); otherwise a late
   delivery refills the queue that invariant 1 just cleared, or a detached
   socket's close event tears down its replacement.
4. **The cursor is never written on a path that did not apply.** The library
   writes the cursor only after `applyCommit` resolves.
5. **A decode failure does not stall.** A frame that fails to decode decodes
   identically on replay, so stalling wedges the actor forever with no fault
   that can clear; it is reported under `ACTOR_SYNC_FRAME_UNDECODABLE` and the
   stream continues. This asymmetry with invariant 2 is deliberate and is
   documented at `stratos-feedgen/src/subscription/actor-syncer.ts:352-377`. A
   body that decodes but has the wrong shape counts as a decode failure and must
   be rejected before `applyCommit` (`:410-418`, `:474-482`), or a non-array
   `ops` is misread as a transient store fault and a non-numeric `seq` reaches
   the cursor.
   One boundary case is **not** a decode failure: an `ErrorFrame`. On a handler
   throw the service emits a frame with `op: -1`
   (`@atproto/xrpc-server@0.10.15/dist/server.js:375`), and
   `subscribe-records.ts` throws `AuthRequiredError` on four paths (`:344`,
   `:349`, `:356`, `:361`). The frame decodes cleanly, but neither consumer
   inspects `op` — the feedgen checks only `header['t'] !== '#commit'`
   (`stratos-feedgen/src/subscription/actor-syncer.ts:396`;
   `service-stream.ts:319-324`) — so an auth rejection is discarded in silence.
   The library's decoder must surface `op: -1` as a coded error
   (`SYNC_STREAM_ERROR_FRAME`, carrying the frame body's `error` and `message`)
   through the observation sink, then drop the connection through the normal
   backoff path — an auth rejection becomes visible, escalating reconnect
   noise instead of silence, and never reaches `applyCommit` or the cursor.
   The step-2 test list must include this case: an auth-rejection `ErrorFrame`
   surfaces the coded error and applies nothing.

### 4.5 What the library owns, and what stays consumer-side

**In the library:** `ActorSyncer` (one socket, one actor), `ServiceStream`
(enrollment events), the frame decoder, and `ActorPool`.

Including the pool is a judgement call, so here is the justification against
section 2.4: the two pools agree on everything structural — a connection cap, a
FIFO waiting list, connect-delay pacing, and waiter-gated idle eviction — though
not on the effective numbers (20 vs 500 connections, 200 ms vs 10 ms pacing;
section 2.4). They differ only in what surrounds them: bsky's
`IndexingService`/`BackgroundQueue`/known-DID cache, and where seeding comes
from. Those are composition, not pool mechanics. So the library ships the pool
with a syncer factory and an eviction policy, and each service keeps:

- **Indexer:** referenced-DID discovery and `onHandleNeeded`
  (`actor-syncer.ts:380-386`), background `indexHandle` scheduling
  (`sync-manager.ts:100-107`), the known-DID TTL cache
  (`stratos-sync.ts:297-303`, `:426-431`), and the global `canStartSync`
  admission gate wired through the optional `drain.admission` hook.
- **Feedgen:** `seedFromStore` (`actor-pool.ts:199-208`) and the boundary
  intersection filter (`:257-262`).

If the pool proves contentious in review, it is the one component that can be
dropped from scope without weakening any invariant — the invariants all live in
the syncer. Say so explicitly at review time rather than discovering it during
migration.

---

## 5. Migration plan

Ordered and reversible. Each step lands independently and leaves the tree green.

**Step 1 — Scaffold the package.** Create `stratos-sync-client` with
`package.json` (deps: `@atcute/cbor`, `@northskysocial/stratos-core`, `ws`),
`tsconfig`, `vitest.config.ts`, and `stryker.config.json` whose `mutate` globs
cover `src/**/*.ts` minus `index.ts`/`*.d.ts`, mirroring
`stratos-feedgen/stryker.config.json`. Add it to `pnpm-workspace.yaml`. No
consumer changes.
_Verify:_ `pnpm -r build`, `pnpm -r test` unchanged.

**Step 2 — Move the implementation in, seeded from the feedgen.** Copy
`stratos-feedgen/src/subscription/{actor-syncer,service-stream,actor-pool}.ts`
into the package; replace `FeedgenStore`/`SubscriptionIndexer` with the section
4.2 ports; introduce the section 4.3 config object with the recommended
defaults. Port the characterization suites —
`stratos-feedgen/tests/{actor-syncer,service-stream,actor-pool}.test.ts` — as the
package's own tests, plus the reconnect/cool-down and queue cases from
`stratos-indexer/tests/{actor-syncer,actor-queue,stratos-sync}.test.ts` so the
indexer's cool-down behaviour is covered before the indexer arrives.
Add tests the existing suites lack: a real two-value CBOR frame decoded
end-to-end, and a cross-generation drain test (section 6).
_Verify:_ new package's suite green; `pnpm --filter @northskysocial/stratos-sync-client mutation`
run, surviving mutants addressed or justified per AGENTS.md. Nothing else changed.

**Step 3 — Migrate the feedgen.** Replace `src/subscription/*` with thin
adapters over the library: a `CursorStore` over `FeedgenStore`, the existing
`SubscriptionIndexer` as the commit applier, and the existing
`ServiceStreamCallbacks`. Delete the three copied files and their fork headers.
Feedgen first because it has no bsky coupling and the largest existing test
surface — it is the cheapest proof the ports are right.
_Verify:_ `pnpm --filter @northskysocial/stratos-feedgen test` passes **unchanged**
except for imports; feedgen mutation run stays above its configured threshold
(the `mutate` globs shed `src/subscription/{actor-syncer,service-stream}.ts`,
which move to the library's config).

**Step 4 — Migrate the indexer.** Coordination point, not a mechanical step: the
indexer's copy is non-functional (section 2.5), so this is a **revival**, not a
port. Whichever plan owns the revival should adopt the library rather than
repair the fork, since repairing decode + auth + guards + apply policy inside a
doomed file is throwaway work. Concretely: a `CursorStore` adapter over
`CursorManager`, a commit applier wrapping `batchIndexStratosRecords`, the
existing enrollment callbacks, and — per R1's mitigation — the full effective
env-schema value set pinned in the indexer's config so the migration changes
no behaviour: `reconnect.maxAttempts: 20` + `reconnect.cooldownMs: 300_000`
(the plan-016 pair, `config.ts:69-73`), `reconnect.baseDelayMs: 1_000`,
`actorQueue.maxSize: 10`, `pool.maxConnections: 20`,
`pool.connectDelayMs: 200`, and `pool.idleEvictionMs: 60_000`
(`config.ts:36`, `:43`, `:44-48`, `:49-53`, `:54-58`). Relax them, if at all,
in a separate commit; only the overflow policy changes, because it is
invariant 1. The `drain.admission` hook is a full `DrainAdmission`
implementation over the existing counters, not a predicate: `canStart()` from
`canStartSync` (`stratos-sync.ts:508-510`), `onStarted()`/`onFinished()` from
`onSyncStarted`/`onSyncFinished`, and `onPendingChange(delta)` from
`onGlobalPendingChange`. The `StratosActorSync` bsky
wiring moves to a consumer-side composition around the library's pool.
_Verify:_ `pnpm --filter @northskysocial/stratos-indexer test` green; the revival
plan's own acceptance test (an actual frame from a running service reaching
`applyCommit`) — which no test in the repo performs today.

**Step 5 — Delete the forks.** Remove `stratos-indexer/src/sync/{actor-syncer,stratos-sync}.ts`
and the fork header comments in the feedgen (already gone at step 3). Update
`AGENTS.md`'s module tables **only now**, when the library exists.
_Verify:_ `grep -rn "57f907ca" stratos-feedgen/src stratos-indexer/src` → no
matches; both suites green.

**Rollback:** steps 3 and 4 are each a single-service revert; the library can sit
unused after step 2 indefinitely without affecting either service.

---

## 6. Risks and open questions

**R1 — Harmonised defaults silently change behaviour.** Every row in 4.3 where
the two forks disagree is a behavioural change for one of them. Explicitly:

- Indexer actor reconnect base delay 1 s → 5 s, and its one-sided additive
  jitter (effective `random()*1000 ms`, `config.ts:64-68`) becomes symmetric
  ±20 %.
- Indexer service-stream backoff changes from `1000 * 2^attempt` with no jitter
  (`stratos-sync.ts:226-229`) to `5000 * 2^(n-1)` with jitter: the first retry
  moves from 2 s to ~5 s, and the cap from 30 s to 60 s.
- Indexer idle eviction 60 s → 15 min (`config.ts:49-53`) — a 15× lengthening,
  not the shortening the dead 30-min default suggests.
- Four further indexer values shift because the recommended defaults match the
  dead module defaults, not the effective env schema: queue bound 10 → 1 000,
  max connections 20 → 500, connect pacing 200 ms → 10 ms, reconnect cap 20 →
  `'unbounded'` (`config.ts:36`, `:43`, `:44-48`, `:69-73`).
- Indexer actor-queue overflow starts clearing pending frames (invariant 1)
  instead of draining them (`actor-syncer.ts:298-304`).
  _Mitigation:_ pin the indexer's existing values in its config at step 4 and
  change them, if at all, in a separate commit. Only the overflow behaviour is
  an invariant and must change.

**R2 — Backlog burst against a bounded queue.** Plan 011 changed the service to
drain its **entire** retained backlog per wake instead of one 100-event page
(`stratos-service/src/subscription/subscribe-records.ts:148-157`, `:217-228`).
At the indexer's effective 10-frame bound (`config.ts:36`) essentially every
reconnect with a backlog overflows; the feedgen's 1 000-frame bound is exceeded
only by large retained backlogs. The feedgen drops the connection on overflow
(`actor-syncer.ts:322-331`); the indexer's actor syncer closes the socket but
keeps draining what it has (`:298-304`), which is accidentally more resilient.
Worse, if overflow lands inside the 30 s stability window the backoff counter
never resets (`:262-269`) and escalates toward the ceiling — a sawtooth that gets
slower exactly when there is most to catch up on.
_Recommended direction (not yet decided):_ prefer backpressure to a bigger bound.
Either arm the stability reset on **drain progress** rather than connection age,
or keep a `lastDrainProgressAt` watchdog and stop reading from the socket —
letting TCP backpressure reach the sender — rather than dropping the connection.
The library is the right place to settle this; both forks would inherit it.
**Open question for review: which of the two.**

**R3 — Cross-generation concurrency.** Plan 016's `resetQueue`
(`stratos-indexer/src/sync/stratos-sync.ts:214-217`) swaps in a fresh queue
object, so serialization is guaranteed _within_ a generation but not _across_
one: an in-flight `await this.handleMessage(...)` from the old generation can
still complete after the reset. It is unreachable in the indexer today because
its `onEnroll`/`onUnenroll` are synchronous (`:35-38`, `:280-283`). The feedgen's
are awaited and genuinely async (`service-stream.ts:326-344`), so a unified
library makes it live. **Invariant to add and test at step 2:** a drain must not
observe or dispatch a frame from a superseded generation; a generation token
checked after each `await` — before dispatching the next frame and before any
post-await write the drain performs, the cursor above all — is the minimal fix.
The loop-side check cannot reach into a consumer callback that is already
suspended; what the library can and must guarantee is that nothing the drain
does after that callback resolves acts for a superseded generation. The step-2
test list must include a case that resets the queue while a callback is
suspended and asserts both halves: no further old-generation frame is
dispatched, and the resumed frame's completion writes no cursor.

**R4 — WebSocket test-fake duplication.** Each fork has its own fake
(`stratos-indexer/tests/actor-syncer.test.ts` defines `FakeWebSocket`; the
feedgen injects via `wsCtor`). The library should export a single test fake so
consumers' integration tests do not re-invent a third. Left out of the ports
list because it is a testing concern, but it is a real deliverable of step 2.

**R5 — Absorbing 008/016 rather than re-diverging them.** Their constants were
deliberately left as named values so the library can turn them into
configuration: `APPLY_FAILURE_ALARM_THRESHOLD`
(`stratos-feedgen/src/subscription/actor-syncer.ts:80`), `RECONNECT_COOLDOWN_MS`
(`stratos-indexer/src/sync/actor-syncer.ts:11`; converted to configuration by
`6aefc4d` as `ACTOR_SYNC_RECONNECT_COOLDOWN_MS`), and the overflow codes.
Section 4.3 does exactly that. The exception is the section 4.4 invariants, which are
correctness properties, not knobs — a reviewer should reject any config surface
that can disable them.

**R6 — The indexer migration is entangled with an unrelated repair.** Step 4 is
not a port; it depends on the revival plan for auth, decode and the read-path
mismatch (section 2.5). If that plan lands before the library exists, it will
repair the fork instead — acceptable, but it makes step 4 a second rewrite.
_Recommendation:_ sequence the revival after step 2 if the schedule allows, so
the revival consumes the library directly.

**Q1 (DIR-03, unresolved):** does the feedgen supersede the indexer→AppView query
path? Section 2.5 shows the indexer's Stratos path does not currently function
in any case, which makes this a decision about whether to revive or retire, not
about current exposure. **If retire:** step 4 becomes a deletion, the extraction
is still worth doing for the feedgen alone (it gets a tested, mutation-covered
library and a real frame-decode test), and section 7's outcome becomes moot.
**If revive:** step 4 proceeds as written and section 7 stands. This is a
maintainer decision, not one this document should make.

**Q2:** should the pool be in the library at all (section 4.5)? Dropping it costs
nothing in correctness.

---

## 7. Disposition: the indexer's commit-apply failure policy

This is the deferral chain's terminus. Plan 008 was feedgen-only; plan 016
explicitly fenced this out and named this document as the destination. Here is
the verdict.

### The finding

The indexer's actor syncer swallows an `applyCommit` failure and continues
(`stratos-indexer/src/sync/actor-syncer.ts:346-355`), and the next commit that
succeeds writes a higher cursor (`:401-418`, cursor at `:417`), so the failed
sequence falls behind the cursor and is never replayed on reconnect (`:155`) —
a permanent, invisible hole, with no heal **client** (the service's pull-sync
surface — section 2.6, fact 2 — has no consumer;
`stratos-indexer/src/backfill.ts:152-169` reads the user's **PDS** via
`com.atproto.repo.listRecords`, not Stratos, and `sync-manager.ts:64-71`
constructs it with `repoProvider: ''`). **But the code path is unreachable at
`52da35b`**: the stream neither authenticates
(`stratos-service/src/infra/auth/verifiers.ts:632-634` requires a `Bearer`
header; `actor-syncer.ts:156-162` sends a query parameter and no headers) nor
decodes (`actor-syncer.ts:448` reads `.t` off the `[value, remainder]` tuple
returned by `decodeFirst`, per
`node_modules/.pnpm/@atcute+cbor@2.3.2/node_modules/@atcute/cbor/dist/decode.d.ts:1`),
so `processCommit` is never called.

### Severity: **latent P1 — currently unreachable, live on the day the stream is repaired**

Arguing from Step 1b's four facts:

| Fact                             | Answer                    | Evidence                                                                                                                                                                                                                                                         |
| -------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cursor advances past a skip      | Yes                       | `actor-syncer.ts:346-355` + `:417`                                                                                                                                                                                                                               |
| A heal path exists               | **Server-side only**      | `listRepoOps`/`listRecordPaths` exist (`stratos-service/src/features/pull-sync/`) with no consumer; `backfill.ts:152-169` pages the PDS, not Stratos; `sync-manager.ts:65` passes `repoProvider: ''`; no pull-sync/`getRepo`/resync call anywhere in the package |
| Indexed rows are source of truth | Yes by design, moot today | `atproto-stratos/packages/bsky/src/stratos/store.ts:77-135` reads indexed rows with no re-hydration — but of `stratos_post`, which this indexer never writes (`actor-syncer.ts:493-565`, `storage/db.ts:95-120`)                                                 |
| The path is live                 | **No**                    | `verifiers.ts:632-634` vs `actor-syncer.ts:156-162`; `actor-syncer.ts:448` vs `@atcute/cbor` `decode.d.ts:1`                                                                                                                                                     |

**The fact that drove the rating is the absence of a heal client**, exactly as
on the feedgen side. A lost commit cannot be recovered by the consumers as they
stand — the service's pull-sync surface (section 2.6, fact 2) has no caller —
which is what makes this class of defect P1 rather than merely annoying.
Building that client, a natural deliverable of the extracted library, is what
would downgrade it.

The fourth fact — the path is dead — reduces **present** exposure to zero, and
that is worth stating plainly rather than dressing up: no data is being lost
today, because no data is flowing. But it does not reduce the severity of the
defect, and it interacts with the repair in a way that makes the naive reading
("unreachable, therefore fine") actively dangerous. Repairing the decode and
auth breaks turns the stream on; the very first transient store fault then
silently and permanently drops a commit, with the cursor advancing over it. The
bug's dormancy is a property of a second bug, and the second bug has a plan
pointed at it.

Two consequences worth making explicit:

1. The decode/auth repair and the apply-policy fix **must land together**. A
   repair that only restores the data plane converts a silent no-op into a
   silent data-loss path — strictly worse, because the system will then look
   like it is working.
2. Immediately after a repair, apply failures will not be rare. Section 2.5(c)
   shows the indexer writes tables the AppView's feed queries do not read; any
   repair that also reconciles the schema will exercise the apply path heavily
   under a new configuration. This is the worst moment to have a
   skip-on-failure policy.

### Who fixes it, and when: **it needs its own plan, opened now**

Exactly one outcome, and it is not "absorbed by extraction" or "no action".

- **Not "absorbed by extraction."** That option is only valid if the migration
  reaches the indexer within an acceptable window. It does not: step 4 is
  deliberately last, and it is explicitly gated on a revival that will almost
  certainly be scheduled first (R6). Relying on extraction here means the fix
  arrives after the very event that makes the bug live.
- **Not "no action."** The bug is unreachable, which is the literal precondition
  for that option — but only because of a separate defect that is already
  tracked for repair. Closing this as "unreachable" hands the next engineer a
  repaired data plane with a P1 hole in it and no record that anyone looked.
  This is precisely the baton-drop the deferral chain was adjusted to prevent.
- **Therefore: a new numbered plan**, scoped as _repair the indexer's Stratos
  sync data plane_, carrying the auth fix (which entails swapping the
  WebSocket implementation, not adding a header — the global `WebSocket`
  constructor takes no headers option; see 2.5(a)), the decode fix, the
  read-path reconciliation, **and** the apply-failure policy as one unit, with the policy
  fix as a stated precondition of enabling the stream. The fix shape is plan
  008's Step 1 transposed: on `applyCommit` failure, clear the pending queue,
  detach the socket, reconnect from the durable cursor, retry the failed
  sequence indefinitely, and never advance the cursor past it — with the
  superseded-socket guards (invariant 3), without which clearing the queue does
  not hold. That plan is **not** written here.

If that plan lands after step 2 of section 5, it should consume the library
rather than patch the fork, and the invariants in 4.4 satisfy its apply-policy
requirement by construction.

### Dependence on DIR-03

The outcome above assumes the indexer is revived. If a maintainer resolves
DIR-03 the other way — the feedgen supersedes the indexer→AppView path — then
the correct action is **deletion, not repair**, and the recommendation collapses
to: retire `stratos-indexer`'s Stratos sync path, and section 5 step 4 becomes a
removal. The extraction verdict in section 3 is unchanged either way, because
the feedgen alone justifies a tested, mutation-covered library with a real
frame-decode test — the test whose absence let this defect live.

This is a maintainer decision. Both branches are specified above; neither is
guessed at here.

---

## References

- `plans/008-feedgen-sync-durability.md` — the feedgen's apply-failure fix
  (`0b464db`, `a98cb6d`, `37a3fa7`, `5b804a1`)
- `plans/016-indexer-sync-resilience.md` — the indexer's cool-down and
  service-stream serialization (`52da35b`)
- `plans/011` — full-backlog drain per wake in the service stream (`0caf319`)
- `docs/design/blob-support.md` — design-doc conventions followed here
- `docs/design/mutation-testing.md` — the mutation gate referenced in section 5
