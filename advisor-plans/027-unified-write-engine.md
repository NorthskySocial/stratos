# Plan 027: Route single and batch writes through one repository engine

> **Executor instructions**: Keep MST authoritative until plan 029. This plan
> changes how writes are assembled, not which representation clients read. Every
> write must remain one transaction. If a change would split the transaction,
> STOP.
>
> **Drift check (run first)**:
> `git diff --stat c6f879ad0183fac61a493426f3906ef9ae5997f2..HEAD -- stratos-core/src/repo stratos-core/src/record stratos-service/src/api/records stratos-service/src/features/repo stratos-service/src/shared stratos-service/src/storage stratos-service/src/infra/storage stratos-core/tests stratos-service/tests`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plan 026
- **Category**: migration / tech-debt
- **Planned at**: commit `c6f879ad0183fac61a493426f3906ef9ae5997f2`, 2026-10-21

## Why this matters

Single writes use `ActorRepoManager`, while batch writes rebuild the MST directly
in `batch.ts`. Both must be right, and both have separate retry and persistence
logic. This is the freestanding complexity the STAR migration is meant to remove.
Unifying the write assembly now gives one transaction boundary, one set of
preconditions, and one place for the flat-state update that plan 029 will make
authoritative.

## Current state

- `stratos-core/src/repo/manager.ts:80-125` locks the root, builds and signs the
  MST commit, persists blocks, deletes removed nodes, updates the root, and
  sequences changes.
- `stratos-service/src/api/records/batch.ts:164-230` performs its own lock,
  MST build, block persist, commit sign/persist, record results, and sequencing.
- `stratos-service/src/api/records/create.ts:225-320` performs DID mutex,
  transaction, manager call, record index, and blob associations.
- `stratos-service/src/api/records/update.ts:126-236` performs lock/retry/
  transaction, old-boundary read, manager, index replacement, and blob refs.
- `stratos-service/src/api/records/delete.ts:67-124` performs lock/transaction,
  root read, manager, index/blob removal.
- `stratos-service/src/shared/repo-write-lock.ts:31-63` is a process-local DID
  mutex used as backpressure. Keep it in this plan.
- `stratos-core/src/repo/transactor.ts:20-22` SQLite `lockRoot` only reads. Do not
  assume it locks. PostgreSQL uses `FOR UPDATE NOWAIT` at
  `stratos-service/src/infra/storage/postgres/actor-store.ts:861-865`.
- `stratos-service/src/api/records/validation.ts:209-248` classifies retryable
  concurrency failures. Keep it and move the call sites behind the engine.

## Commands you will need

| Purpose              | Command                                                                                                     | Expected |
| -------------------- | ----------------------------------------------------------------------------------------------------------- | -------- |
| Core tests           | `pnpm --filter @northskysocial/stratos-core test`                                                           | all pass |
| Service tests        | `pnpm --filter @northskysocial/stratos-service test`                                                        | all pass |
| Typecheck            | `pnpm run typecheck`                                                                                        | exit 0   |
| Lint                 | `pnpm run lint`                                                                                             | exit 0   |
| Format               | `pnpm exec prettier --check .`                                                                              | exit 0   |
| Postgres integration | `TESTCONTAINERS_RYUK_DISABLED=true pnpm exec vitest run stratos-service/tests/postgres-integration.test.ts` | all pass |

## Scope

**In scope**:

- `stratos-core/src/repo/write-engine.ts` (create)
- `stratos-core/src/repo/write-plan.ts` (create)
- `stratos-core/src/repo/manager.ts`
- `stratos-core/src/repo/transactor.ts`
- `stratos-core/src/repo/index.ts`
- `stratos-service/src/api/records/create.ts`
- `stratos-service/src/api/records/update.ts`
- `stratos-service/src/api/records/delete.ts`
- `stratos-service/src/api/records/batch.ts`
- `stratos-service/src/api/records/validation.ts` (classification only)
- `stratos-service/src/features/repo/engine.ts` (create if the service adapter
  belongs there)
- `stratos-core/tests/write-plan.test.ts` (create)
- `stratos-core/tests/write-engine.test.ts` (create)
- `stratos-service/tests/flat-write-engine.test.ts` (create)
- `advisor-plans/README.md` (status row only)

**Out of scope**:

- Changing HTTP/XHRC request or response shapes.
- Changing authorization, boundary resolution, custody, blob validation, or
  takedown policy.
- Making flat state authoritative.
- Removing MST or CAR export.
- Changing retry counts or weakening concurrency checks.

## Git workflow

- Branch: `advisor/027-unified-write-engine`
- Keep commits small enough to review: planner, engine, single writes, batch,
  tests.
- Do not push or open a PR without explicit authorization.

## Steps

### Step 1: Define the pure transition plan

Create `stratos-core/src/repo/write-plan.ts`:

```ts
export type RepoMutation =
  | { action: 'create'; path: string; cid: string }
  | { action: 'update'; path: string; cid: string }
  | { action: 'delete'; path: string }

export interface RepoTransition {
  next: Array<{ path: string; cid: string }>
  changedPaths: string[]
  removedCids: string[]
}

export function planRepoTransition(
  current: ReadonlyArray<{ path: string; cid: string }>,
  mutations: readonly RepoMutation[],
): RepoTransition
```

Rules:

- Current entries are sorted unique `{collection}/{rkey}` paths.
- Apply mutations in order. A later mutation for the same path wins.
- `create` on an existing path is an update for state purposes.
- `update` on an absent path is invalid.
- `delete` on an absent path is invalid.
- Return sorted `next`, sorted `changedPaths`, and the CIDs that are no longer
  referenced by any path.
- Do not perform I/O.

**Verify**: `pnpm --filter @northskysocial/stratos-core test -- write-plan`
→ duplicate-key, create-on-existing, update-on-absent, delete-on-absent, and
removal cases pass.

### Step 2: Build one repository write operation

Create `stratos-core/src/repo/write-engine.ts`:

```ts
export interface RepoWriteContext {
  currentEntries: () => Promise<Array<{ path: string; cid: string }>>
  lockRoot: () => Promise<{ cid: string; rev: string } | null>
  buildCommit: (input: {
    did: string
    rev: string
    transition: RepoTransition
    previousCommit: string | null
  }) => Promise<{
    commitCid: string
    commitBytes: Uint8Array
    blocks: Array<{ cid: string; bytes: Uint8Array }>
  }>
  persist: (input: {
    commitCid: string
    commitBytes: Uint8Array
    blocks: Array<{ cid: string; bytes: Uint8Array }>
    removedCids: string[]
    rev: string
    flatState: FlatRepoState
  }) => Promise<void>
}

export async function applyRepoWrite(
  did: string,
  mutations: readonly RepoMutation[],
  context: RepoWriteContext,
): Promise<{
  rev: string
  commitCid: string
  transition: RepoTransition
  flatState: FlatRepoState
}>
```

`applyRepoWrite` must:

1. Call `lockRoot` first.
2. Read current entries and existing flat state, including `activeFormat`,
   **after** acquiring the lock.
3. Build the transition.
4. Build the commit and blocks.
5. Build the accumulator/hash using plan 026, then independently sign the plan
   025 metadata through the service seam. Persist flat `commitBytes`/`commitCid`
   separately from `sourceMstCommitCid`; never use an MST signature for flat hash.
6. Persist blocks, both authenticated commits, root, sequence-equivalent state, and flat state through
   one `persist` callback.
7. Return the revision and commit identity.

It must not notify subscribers, write record indexes, or touch blob associations.
Those remain in the service transaction. Extend the callback contract to carry
the signed flat metadata as well as the legacy commit; signing failure rolls back
both representations. Keep `formatVersion = 1`. Initialize `activeFormat = mst`
only when creating new shadow state. Later writes must preserve the existing
`activeFormat` read under the lock, including `flat` after plan 029 activation;
ordinary writes must never reset it to `mst`.

**Verify**: `pnpm --filter @northskysocial/stratos-core test -- write-engine`
→ lock-before-read, rollback-on-persist-failure, and state/commit agreement cases
pass.

### Step 3: Replace the manager call in single writes

In create, update, and delete handlers:

- Keep the existing DID mutex and retry wrapper.
- Keep the transaction.
- Replace the direct `ActorRepoManager.applyWrites` call with
  `applyRepoWrite`.
- Keep record index, boundary, takedown, blob-reference, and sequence updates in
  the same callback.
- Keep notification after the transaction commits. Do not move it inside.
- Do not read old record values before the lock. Move any such read after the
  engine has locked the root, or use the engine's current state.

Add a test that a failing flat-state persist rolls back the record index, root,
blocks, and sequence. Use an existing integration harness.

**Verify**: focused create/update/delete tests and
`pnpm --filter @northskysocial/stratos-service test -- records-` → all pass.

### Step 4: Replace the batch path

In `batch.ts`:

- Keep parsing, validation, precomputed record bytes, and result formatting.
- Delete the local `buildCommit`/`signAndPersistCommit` orchestration.
- Call `applyRepoWrite` once with ordered `RepoMutation[]`.
- Apply record-index, boundary, blob, and sequence updates inside the same
  transaction.
- Preserve current behavior for repeated keys, deletes, and `swapCommit`.
- Do not change the response `results` ordering.

Add tests:

- Two mutations for the same key produce the last operation's effect.
- One failing mutation rolls back all records, the commit, flat state, and
  sequence.
- Batch delete and update preserve boundary-scoped removals.
- Existing `swapCommit` behavior remains unchanged. If it is intentionally
  unsupported, assert the current behavior rather than inventing support.

**Verify**: `pnpm --filter @northskysocial/stratos-service test -- batch`
→ all pass.

### Step 5: Remove duplicate orchestration and update retry classification

- Delete the old MST build/persist path from `batch.ts`.
- Keep `ActorRepoManager` as a thin adapter or remove its unused methods only if
  no caller remains. Do not delete code that still has a production caller.
- Keep `withConcurrencyRetry` in one shared place. Do not change retry codes.
- Add one test per backend for two concurrent writers; assert one retries and the
  final state contains both successful writes.

**Verify**: `pnpm run typecheck`, focused service tests, and Postgres integration
tests pass.

## Test plan

- `write-plan.test.ts`: ordered mutations, repeated keys, invalid transitions,
  removed CID calculation.
- `write-engine.test.ts`: lock ordering, flat state matches commit, persist
  failure propagates, new shadow state initializes to `mst`, and later single
  and batch writes preserve the locked `activeFormat` for both `mst` and `flat`.
- `flat-write-engine.test.ts`: record + repo + flat state atomicity, retry,
  taken-down record still listed.
- Integration coverage on both SQLite and PostgreSQL.
- Verification: full core and service suites plus Postgres integration.

## AiaB gate (required at the end)

Run the real `baseline` on the reviewed candidate. The change is internal and has
no new external endpoint, so baseline is the required e2e. A new suite would only
test a shadow table.

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir /home/evelyn/git/northsky/ops/sandbox/atmosphereinabox \
  --source "$(git rev-parse --show-toplevel)" \
  --suite baseline \
  --review-receipt "$REVIEW_RECEIPT" \
  --report-dir "$NEW_REPORT_DIR"
```

## Done criteria

- [ ] Single and batch writes use one `applyRepoWrite` path.
- [ ] The root lock is acquired before reading current entries.
- [ ] Flat state is updated in the same transaction as records and commit.
- [ ] Only new shadow state initializes to `mst`; later single and batch writes
      preserve the locked `activeFormat`, including `flat` after activation.
- [ ] Notifications still occur only after commit.
- [ ] Retry behavior and error classification are unchanged.
- [ ] SQLite and PostgreSQL concurrency/rollback tests pass.
- [ ] Core/service suites, typecheck, lint, Prettier pass.
- [ ] AiaB baseline passes on the reviewed candidate.

## STOP conditions

- The current code reads old record state before the root lock and moving it
  would change a documented API behavior. Report the exact path and decision.
- A single transaction cannot include record indexes, blob references, boundary
  state, sequence, and flat state on one backend.
- Batch semantics for repeated keys cannot be preserved.
- A required existing test fails for an unrelated reason and cannot be isolated.

## Maintenance notes

- Plan 029 will switch reads to the flat state. At that point
  `applyRepoWrite` becomes the only write path.
- Any new record mutation must be expressed as a `RepoMutation`; do not add a
  third commit builder.
- If `swapCommit` becomes required, implement it as a precondition inside
  `applyRepoWrite`, not as handler-specific logic.
