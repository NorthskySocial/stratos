# October writer-sync contract

## STAR source update versus current runtime

Upstream PR 5705 merged at `232b2cdcec7a54a92d6e3c6461d07775d611d1ad`.
Its `com.atproto.space.getRepo` returns `application/octet-stream` STAR-lite v1
with magic `2a6c0100`, framed canonical metadata and path/record pairs through EOF.
Metadata uses `atproto-space-repo`, `did`, `space`, and flattened signed-commit
fields. There is no standalone hash prefix or index-only export. Only `space`
and `repo` are request parameters; deltas remain `listRepoOps`, blobs remain separate.
The existing context signature/MAC is deniable content binding, not a direct
signature over the repository hash. Complete-content verification requires all
records and the final EOF hash comparison; upstream paged export does not visibly
hold one snapshot transaction, so consumers must reject/retry mismatches.

This is upstream source behavior, not shipped Stratos STAR support. Current
Stratos custody still uses MST/CAR and actor subscriptions; current PDS ingestion
uses `listRepoOps` and terminal envelope verification, not full-content recovery.
The AiaB source pin remains `79d6307e19908f3af406838ea0e5fae42847f182`.
No pin, runtime code or deployment changes accompany this documentation.
Planned PDS recovery requires an independently reviewed source/image pin and real
STAR suite, stays opt-in, and validates actual response profile rather than an
invented capability advertisement. A credential for ONE space can authorize the
full author repo in that space; it does not authorize a whole Stratos actor export.

See [the STAR architecture](star-repository.md) for the distinct proposed internal
actor signature, reader gates and migration. Spaces custody signing compatibility
remains unresolved; shared framing alone does not resolve it.

## Problem and decision

Keep enrollment membership separate from standard writer updates. Replacing the current member snapshot with a writer delta would revoke unchanged members incorrectly. Treating a notification as membership would admit unauthorized writers.

This design is for authority and syncer developers. It adds no production endpoint, storage, scheduler, or discovery role. Stratos continues to serve its custom membership listing. A polling-only Feedgen can keep polling; migrating credentials does not require a notification server.

We select two independent contracts:

- Current enrollment authorizes writer admission and selects repositories to read. Membership generation fences prevent removed writers' staged work from becoming visible.
- Standard writer metadata identifies changed repositories. It neither authorizes access nor proves repository contents. Confirm state directly with the repository host.

Hosting responsibility, access, data lifecycle, and shared control remain separate under the accepted [credential revocation decision](./credential-revocation-contract.md). Departure is not deletion. Retained hosting does not authorize a new write notification. D02 full-content proof and D03 foreign blob delivery remain separate work.

## Why two listings are necessary

| Contract      | Current custom membership snapshot                  | Proposed standard writer listing                                                                 |
| ------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Method        | `zone.stratos.space.listRepos`                      | `com.atproto.space.listRepos`                                                                    |
| Source        | Active enrollment carrying the boundary             | Latest accepted update for each writer                                                           |
| Row           | `did`, `custody`, optional host and Stratos `rev`   | `did`, `repoRev`, `hash`, `spaceRev`                                                             |
| Cursor        | Enrollment DID; returned for a full page            | Exclusive plain string naming the last returned space revision; returned for every nonempty page |
| Completion    | No next cursor                                      | Empty `repos`, with no cursor                                                                    |
| Repeated DID  | Invalid in the current member snapshot              | Expected if that writer changes while paging                                                     |
| Omission      | Relevant only after complete membership enumeration | Not removal; unchanged writers are absent from a delta                                           |
| Authorization | Current enrollment and boundary                     | No authority to grant membership or read access                                                  |

The current Rust reconciler replaces its member set only after complete custom enumeration. Partial failures preserve the previous baseline. Its duplicate-member rejection belongs to that snapshot, not standard writer catch-up. Do not feed standard pages into that reconciler.

A Stratos-custody MST root is not the SHA-256 digest of a standard LtHash state. Do not fabricate `hash` from a CID or silently migrate custody. Keep Stratos-custody repositories on their existing signed sync path. Publishing a mixed-space standard role remains blocked on an explicit representation decision.

## Reference: writer listing

The final lexicon has `space`, optional `limit` (1–1000, default 100), and optional `cursor`. There is no `since` parameter. Output is `{ repos, cursor? }`, with no top-level `spaceRev`. Each row contains:

| Field      | Meaning                                                                      |
| ---------- | ---------------------------------------------------------------------------- |
| `did`      | Writer's account DID                                                         |
| `repoRev`  | Writer's latest reported repository revision, a TID                          |
| `hash`     | Reported SHA-256 digest of its LtHash state, encoded as lexicon bytes        |
| `spaceRev` | Authority-assigned revision of that writer update, ordered across this space |

Actual signed repository commits still use `rev`. Renaming notification/listing metadata does not rename commit fields.

`cursor` is a plain string, not a schema-constrained TID. Forward it unchanged, including strings that are not parseable TIDs. Do not reuse a custom DID cursor. The reference selects `spaceRev > cursor`, sorts ascending, and returns the last row's `spaceRev` even on a short page. Continue until an empty page. Preserve the last successfully processed checkpoint when the empty page omits its cursor.

Writer rows are latest state, not an event log. Intermediate writes can coalesce. A writer may reappear after a later write. Processing must be idempotent and must not remove other writers. A bounded consumer that reaches a page/time budget yields and resumes; it must not declare completion merely because a page is short.

## Reference: notification authentication and admission

| Hop                            | Authentication and authorization                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repo host to authority         | Verify service JWT signature, validity and exact `lxm = com.atproto.space.notifyWrite`. Require `iss = repo`; address `aud = authority#atproto_space_host`. The inspected reference also accepts the bare authority DID. |
| Authority to registered syncer | Independently verify service JWT from the authority; audience is the registered service identifier, including its fragment. A repo-issued JWT is not authority forwarding.                                               |
| Listing read                   | Space credential with HTTP presentation signature, matching space, and bare authority read audience. Service JWT notification audiences are not credential read audiences.                                               |

Input requires `space`, `repo`, `repoRev`, and `hash`. Forwarded notifications additionally carry authority-assigned `spaceRev` and, except on the first update, `prevSpaceRev`. Ignore any sender-supplied sequencing claims when accepting a repo notification.

For the proposed Stratos adapter, check current active enrollment and boundary for every write admission, including retries. A retained writer row, a valid signature, or retained hosting is insufficient. Reject unsolicited writers without adding members, assigning boundaries, or overriding host discovery. Continue re-deriving boundaries from enrollment during foreign ingest.

Reject a repository revision more than five minutes in the future. Ignore `repoRev <= accepted repoRev` without changing its hash or allocating a new space revision. For each accepted newer update, atomically allocate a globally increasing `spaceRev` within that space and record the previous global value as `prevSpaceRev`. “Global” means across all writers in one space, not across spaces. Concurrent writers must not receive the same revision. Membership removal racing with admission or durable projection needs a generation fence, not a cached preflight check alone.

The authority records a claim; it does not verify the full content or signature behind the reported hash on this hop. Syncers verify repository state at the actual host before durable promotion. A `prevSpaceRev` gap triggers listing catch-up from the last durable space checkpoint. Duplicate notifications are harmless; an older notification must not roll state backwards.

## Delivery policy: proposal, not shipped Stratos behavior

Keep repo-host delivery separate from authority fanout. The reference repo host sends immediately, coalesces retryable failures by `(space, repo)` durably, and retains the newest `repoRev` and hash. Newer revisions reset its backoff and 24-hour window. A leased worker drains bounded batches; takeover can duplicate delivery. Backoff doubles from one minute to one hour with 50–100% jitter, and requests have a ten-second timeout. Successful or permanent failures clear only retries no newer than the attempted revision. Expired retries stop after 24 hours. Removed accounts clear retries; deactivated or taken-down accounts are rescheduled within the window.

The reference has an immediate-send-to-queue crash window: it does not establish a transactional outbox with the repo commit. Do not describe this as guaranteed delivery of every write. Authority-to-syncer fanout uses a background queue with reasonable effort, not that durable repo-host retry queue. Polling repairs notification loss.

For a future Stratos repo-host implementation, propose a transactional durable outbox, latest-state coalescing, bounded backoff, and compare-and-clear protection against old completions deleting newer work. Retry transient transport/status and local storage failures; stop and record permanent authorization/schema failures without retaining tokens or content. Define retry exhaustion, operator diagnostics, queue capacity, lease takeover, and re-admission after policy repair before shipping. No outbox or scheduler is added here.

## Migration and recovery

Keep the custom snapshot and its DID cursor unchanged. A selected standard consumer starts a new namespace keyed by authority, full space URI, and protocol generation. Never reinterpret persisted member cursors as space revisions. First load current membership, then bootstrap standard writer state from no cursor, confirming each authorized repo at its host. Persist work idempotently and reconcile membership independently throughout catch-up.

Advance a future per-space checkpoint only after durable processing, or after durable scheduling with a separately proven recovery invariant. A crash before durable completion must replay the same page. Do not checkpoint merely upon HTTP receipt, upon notification receipt, or after enqueueing volatile work. An empty page preserves the last durable checkpoint. Plan 005's per-repo terminal-commit verification remains a separate condition; neither checkpoint substitutes for the other.

On protocol-generation reset, unavailable checkpoint history, authority reset, or incompatible custody representation, explicitly rebootstrap without purging authorized members from a delta. Membership withdrawal, space deletion, and explicit deletion requests use their own contracts and generation fences. A writer listing has no removal tombstone. Re-enrollment needs fresh authorization and must not resurrect completed deletion.

## Bounded implementation follow-ups

### Authority storage and standard handlers

Scope: writer-state Reader/Writer ports, SQLite/PostgreSQL adapters, atomic per-space sequencing, standard listing and dedicated notification authentication/admission. Keep custom membership unchanged. Dependencies: mixed-custody representation decision, source-pin reconciliation, admission/removal race design, migration and runtime space validation. Registration, fanout, and repo-host outbox require separately approved delivery slices; no role publication follows automatically.

Acceptance: real backend concurrency and restart tests; equal/older/future revision tests; correct `prevSpaceRev` across writers; current-enrollment denial; generation races; plain-string exclusive cursors; short-page continuation; exact auth errors; unchanged commit `rev`; mutation gates and reviewed October Spaces alpha PDS probes. Update public API documentation only when the handlers ship.

### Optional syncer catch-up

Scope: a distinct writer-state client and durable per-space checkpoint, not changes that reinterpret the membership reconciler. Dependencies: authority contract above, durable processing/recovery design, explicit product selection of catch-up. Polling-only operation remains valid. An inbound notification server is a separate optional feature.

Acceptance: repeated writers, coalesced updates, gaps, duplicate/late notifications, short pages, empty pages, crash-before/after-durable boundaries, restart, page budgets, rebootstrap, removal during staging, and Plan 005 terminal verification. Prove no omission revokes membership and no received metadata alone promotes records.

## Probe boundary and unresolved contracts

Synthetic reference-model tests cover pagination, repeated writers, admission, ordering, gaps, retries, and crash boundaries. They do not implement or certify a real authority. The `writer-sync-contract` sandbox suite uses the real October Spaces alpha PDS: real account/service authentication, a disposable upstream simplespace authority, writer notifications, listing, and repository commits. It also requires Stratos's standard routes to remain unsupported. The upstream fixture is not Stratos standard-authority support and does not add production simplespace callers.

Runtime acceptance requires the mandatory baseline plus this named suite on the exact independently reviewed candidate. Source inspection and mocked unit tests cannot satisfy that gate. This bounded batch does not provide a runtime receipt.

Still unresolved: standard representation of mixed custody; concrete schema/migration and authority reset generation; transactional admission/removal fencing; production outbox capacity and exhaustion policy; registration expiry/endpoint changes; and whether optional syncer catch-up is selected. These do not reopen retained hosting or authorize new proof mechanisms.

## Source reference

- Reference implementation: `5b95b2f2723a2882824fbb0b819fd6aad884ef20`, `lexicons/com/atproto/space/{listRepos,notifyWrite,defs}.json`, `packages/pds/src/api/com/atproto/space/{listRepos,notifyWrite,util,registerNotify,unregisterNotify}.ts`, and `packages/pds/src/space-notifications.ts`.
- Sandbox October Spaces alpha PDS: `79d6307e19908f3af406838ea0e5fae42847f182`. The inspected listing/notification lexicons, handlers, utility, commit definitions, and retry implementation match the reference pin byte-for-byte. The sandbox runner records immutable image identity separately.
- Proposal: `0c9c2e88ba385809fc9ecba92f362389d9338e16`, `0016-permissioned-data/README.md`, Sync section. Its prose still uses `rev` and “since”; the final lexicons define the wire names above.
- Historical D01: `fdb11e26aa8401d81f14cbfd4e07e708b8e5c1be`. It is not an ancestor of this design's baseline; no matching PR was returned during reconciliation. Its older `rev` listing, DPoP examples, and notification audience are not the October contract. No unmerged production work is imported.
