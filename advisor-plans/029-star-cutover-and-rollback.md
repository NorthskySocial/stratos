# Plan 029: Activate STAR per actor and prove rollback

> **Executor instructions**: This is a per-actor format switch, not a data
> deletion. Keep the MST write path during the rollback window. Do not remove MST
> code. If rollback cannot restore the previous behavior after new writes, STOP.
>
> **Drift check (run first)**:
> `git diff --stat c6f879ad0183fac61a493426f3906ef9ae5997f2..HEAD -- stratos-service/src/features/pull-sync stratos-service/src/features/repo stratos-service/src/api stratos-client/src lexicons stratos-core/src/repo test/spaces-alignment/scenarios`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans 027, 028
- **Category**: migration
- **Planned at**: commit `c6f879ad0183fac61a493426f3906ef9ae5997f2`, 2026-10-21

## Why this matters

The shadow state and STAR export must become authoritative for an actor without
losing the ability to return to MST. Because plan 027 keeps both representations
updated in one transaction, rollback can be a format flip rather than a data
rebuild. This plan activates that switch, versions the commit contract, and proves
the switch in both directions.

## Current state

- `stratos-core/src/repo/manager.ts` still writes MST commits; plan 027 adds flat
  state in the same transaction.
- `stratos-service/src/features/pull-sync/oplog.ts:40-64` defines a fixed
  `SignedCommit` shape with `data` as the MST root CID.
- `stratos-service/src/features/pull-sync/oplog.ts:50-80` reads persisted commits;
  it does not re-sign.
- `stratos-service/src/api/handlers/repo-read-handlers.ts` serves CAR `getRepo`
  and, after plan 028, STAR `getRepoStar`.
- `stratos-service/src/storage/sqlite/actor-store.ts` and the PostgreSQL twin
  expose `stratos_repo_state.formatVersion` from plan 026.
- `stratos-client/src/verification.ts:34-51` delegates CAR/MST verification to
  `@atcute/repo`.

Reads already use `stratos_record`, not the MST, for ordinary record hydration.
The switch changes commit identity, exports, and verification contracts, not
boundary or record authorization.

## Commands you will need

| Purpose       | Command                                              | Expected                     |
| ------------- | ---------------------------------------------------- | ---------------------------- |
| Core tests    | `pnpm --filter @northskysocial/stratos-core test`    | all pass                     |
| Service tests | `pnpm --filter @northskysocial/stratos-service test` | all pass                     |
| Client tests  | `pnpm --filter @northskysocial/stratos-client test`  | all pass                     |
| Typecheck     | `pnpm run typecheck`                                 | exit 0                       |
| Lint          | `pnpm run lint`                                      | exit 0                       |
| Format        | `pnpm exec prettier --check .`                       | exit 0                       |
| AiaB suite    | `--suite star-cutover`                               | baseline + 5 assertions pass |

## Scope

**In scope**:

- `stratos-service/src/features/pull-sync/oplog.ts`
- `stratos-service/src/features/pull-sync/handler.ts` only if error mapping changes
- `stratos-service/src/features/repo/cutover.ts` (create)
- `stratos-service/src/bin/cutover-flat-repo.ts` (create)
- `stratos-service/src/api/handlers/repo-read-handlers.ts`
- `stratos-service/src/api/handlers.ts`
- `stratos-core/src/repo/flat-state.ts` (read/verify helpers only)
- `stratos-core/src/repo/index.ts`
- `stratos-client/src/verification.ts`
- `stratos-client/src/lexicons.gen.ts` only if lexicons change
- `lexicons/zone/stratos/sync/listRepoOps.json` only for an optional commit union
- `stratos-service/tests/star-cutover.test.ts` (create)
- `stratos-service/tests/star-rollback.test.ts` (create)
- `stratos-client/tests/verification.test.ts` if present; otherwise the existing
  verification test file
- `test/spaces-alignment/scenarios/star-cutover.ts` (create)
- `test/spaces-alignment/scenarios/star-cutover.test.ts` (create)
- `stratos-service/scripts/benchmark-repo-writes.ts` (create)
- `stratos-client/README.md` and `docs/architecture/star-repository.md` (contract docs)
- `advisor-plans/README.md` (status row only)

**Out of scope**:

- Removing MST writing, blocks, or pruning. That is plan 030.
- Turning off CAR `getRepo`.
- Changing boundary filtering or making an actor-wide export available to a
  scoped consumer.
- Spaces `space-ref` or credential changes.
- Automatic cutover of all actors. Activation is per actor and explicit.

## Git workflow

- Branch: `advisor/029-star-cutover-and-rollback`
- Do not commit operator reports or private receipts.
- Do not push or open a PR without explicit authorization.

## Steps

### Entry gate: deploy compatible readers

Complete the ADR reader inventory before activation: actor streams, Rust and
legacy feedgens/indexer, pull-sync, clients, proof APIs and persisted checkpoints.
Record tested versions or explicit retirement and rollback handling for each.
031 does NOT upgrade Stratos actor readers. Missing implementations need their
own approved scope before this plan proceeds. Independent reviewer checks the
inventory; supervisor accepts reader readiness and rollback at this checkpoint.

### Step 1: Version the commit contract

Add a discriminated commit shape:

```ts
export interface MstCommit {
  $type: 'zone.stratos.repo.mstCommit'
  did: string
  version: number
  data: string
  rev: string
  prev?: string
  sig: string
}

export interface FlatCommit {
  $type: 'zone.stratos.repo.star'
  version: 1
  did: string
  rev: string
  hash: Uint8Array
  signer: string
  keyId: string
  sig: Uint8Array
}

export type RepoCommit = MstCommit | FlatCommit
```

The flat shape is the exact signed metadata from 025, already persisted by
026/027, not a new unsigned contract. Verify the direct custody signature and
trusted actor key attestation. The CID is derived from canonical signed bytes
and carried separately where needed. JSON transports use lexicon byte encoding.
Schema `formatVersion = 1` stays constant for shadow and active state.

Rules:

- `activeFormat: mst` returns `MstCommit` exactly as today.
- `activeFormat: flat` returns `FlatCommit` from `stratos_repo_state`.
- Do not relabel an MST commit as flat or fabricate a `hash` from a CID.
- `listRepoOps` reads the actor's active format. The oplog cursor remains
  sequence-based and opaque; it is not a revision.
- Update the lexicon description if the output shape is declared. If the lexicon
  is untyped JSON, document the union in `docs/architecture/star-repository.md`.
- `stratos-client` verification rejects an unknown `$type`; it must not assume
  `data` exists.

**Verify**: service and client tests cover both commit shapes and an unknown
type. `pnpm run codegen` is not needed unless a lexicon changed.

### Step 2: Implement per-actor activation

Create `stratos-service/src/features/repo/cutover.ts`:

```ts
export async function activateFlatRepository(
  actorStore: ActorStore,
  did: string,
): Promise<{ activeFormat: 'flat'; rev: string }>

export async function rollbackToMstRepository(
  actorStore: ActorStore,
  did: string,
): Promise<{ activeFormat: 'mst'; rev: string }>
```

Activation:

1. Serialize against writers, then read state and MST root in one transaction.
2. Require the flat state's `rev`, authenticated hash, `sourceMstCommitCid`, and entries to agree with the
   current records. Re-run the plan 026 reconciliation if needed.
3. Require the STAR export round trip to succeed before activation. If the actor
   has no exportable state, STOP.
4. Set `activeFormat = flat` in the same transaction; do not change schema version.
5. Emit an audit log with DID, old format, new format, and revision. Do not log
   record content.

Rollback:

1. Require that MST writes have continued for this actor.
2. Verify the MST root's current revision matches the latest MST commit written by
   the dual-write path.
3. Set `activeFormat = mst`.
4. Audit-log the transition.

No in-place data deletion. No automatic rollback on read error; surface the error.

**Verify**: focused tests prove activation is idempotent. After activation,
exercise single and batch writes; after each write and before rollback, assert
persisted `activeFormat = flat` and flat commit output from `listRepoOps`.
Then prove explicit rollback preserves those writes.

### Step 3: Add the operator command

Create `stratos-service/src/bin/cutover-flat-repo.ts`:

- `--did <did>` required.
- `--activate` or `--rollback` required, mutually exclusive.
- Dry run by default? No: explicit `--dry-run` is the safe default for a mutating
  command. Require `--apply` as well for mutation.
- Print a JSON report: DID, from, to, rev, verification counts, whether the
  rollback window is still valid.
- Refuse rollback if the MST has stopped advancing or the state is inconsistent.
- Never print record bytes or credentials.

**Verify**: local test actor activate → export → rollback; records remain
readable and both commit shapes are observed.

### Step 4: Add the AiaB cutover scenario

Create `test/spaces-alignment/scenarios/star-cutover.ts` with suite ID
`star-cutover` and required assertions:

- `cutover-activates`: activation returns `activeFormat = flat` and the state row records it.
- `star-export-after-cutover`: `getRepoStar` returns a valid archive with the same
  records as `listRecordPaths`.
- `commit-format-versioned`: `listRepoOps` returns a flat commit with `rev` and
  `hash`; a non-cut-over actor still returns the MST shape. Repeat after each
  post-activation single and batch write, before rollback, and assert the state
  row still records `activeFormat = flat`.
- `rollback-restores-mst`: after a post-activation write, rollback returns `activeFormat = mst` and the MST commit/revision includes that write.
- `records-survive-round-trip`: all post-activation writes are readable after
  rollback.

Use existing baseline accounts and service auth. Do not add public PLC or
production credentials. Model HTTP helpers after `scenarios/client-custody.ts`.

**Verify**: `pnpm exec vitest run --config test/spaces-alignment/vitest.config.ts`
→ suite declaration/unit test passes.

### Step 5: Measure before and after on one workload

Add `stratos-service/scripts/benchmark-repo-writes.ts` (new, private output
only). It must:

- seed a synthetic actor;
- run fixed create/update/delete/batch workloads at three repository sizes;
- record p50/p95 latency, transaction duration, lock waits, SQL statement count,
  and process CPU;
- run the same workload before cutover (`activeFormat = mst`) and after cutover
  (`activeFormat = flat`);
- write JSON to an operator-supplied path, never to the repository.

Do not assert a target percentage. Keep the raw results with the PR's private
evidence. Report correctness and durability gates separately from timing.

**Verify**: two runs on the same machine complete with identical operation
counts and matching final record sets. Record both JSON paths in the status row;
do not paste timings into the PR body.

## Test plan

- Unit: commit union encoding/decoding, unknown type rejection, activation
  preconditions, rollback precondition failures.
- Integration: activate, perform single and batch writes, export, rollback, read
  on SQLite and PostgreSQL. After each post-activation write and before rollback,
  assert persisted `activeFormat = flat` and flat `listRepoOps` commit output.
- Concurrency: activation racing with writes either observes a consistent rev or
  fails without a partial switch.
- Existing CAR export remains valid before and after rollback.
- Verification: all focused and full package suites.

## AiaB gate (required at the end)

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir /home/evelyn/git/northsky/ops/sandbox/atmosphereinabox \
  --source "$(git rev-parse --show-toplevel)" \
  --suite star-cutover \
  --review-receipt "$REVIEW_RECEIPT" \
  --report-dir "$NEW_REPORT_DIR"
```

Expected: baseline plus all five `star-cutover` assertions pass, zero
skips/failures, cleanup passed.

## Done criteria

- [ ] Commit output is versioned; MST and flat commits are distinguishable.
- [ ] Activation is per actor, verified, and idempotent.
- [ ] Post-activation single and batch writes preserve `activeFormat = flat` and
      flat commit output until explicit rollback.
- [ ] Rollback works after new writes because dual-writing still occurs.
- [ ] STAR export and the flat commit agree.
- [ ] Existing CAR export and MST actors are unchanged.
- [ ] Before/after benchmark produces comparable operation counts and final
      record sets; raw results are stored privately.
- [ ] Unit, integration, client, typecheck, lint, and Prettier gates pass.
- [ ] AiaB `star-cutover` passes on the reviewed candidate.

## STOP conditions

- Dual-writing is not atomic on either backend.
- The MST and flat representations disagree at activation.
- Rollback cannot include writes made after activation.
- A client contract cannot tolerate the versioned commit union.
- The AiaB suite would require widening an owner-only export or using public PLC.

## Maintenance notes

- Plan 030 closes the rollback window and removes the MST writer. Until then,
  keep both representations current on every write.
- If a future consumer assumes `data` is always present, update it to dispatch on
  `$type`. Do not add a fake `data` field to flat commits.
- Activation/rollback commands are operator tools; they are not HTTP endpoints.
