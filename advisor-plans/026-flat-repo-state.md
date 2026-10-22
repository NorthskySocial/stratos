# Plan 026: Add flat repository state and a reconciled backfill

> **Executor instructions**: This plan adds parallel state. It must not change the
> authoritative read or write path. Run the drift check and every gate. If MST and
> flat records disagree, STOP; do not pick a winner.
>
> **Drift check (run first)**:
> `git diff --stat c6f879ad0183fac61a493426f3906ef9ae5997f2..HEAD -- stratos-core/src/db stratos-core/src/storage stratos-core/src/repo stratos-service/src/storage stratos-service/src/infra/storage stratos-service/src/features/repo stratos-core/tests stratos-service/tests`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plan 025
- **Category**: migration
- **Planned at**: commit `c6f879ad0183fac61a493426f3906ef9ae5997f2`, 2026-10-21

## Why this matters

The current repository has one structural source of truth (the MST root and
blocks) and one record index (`stratos_record`). Removing the MST requires a flat
state that can be built and compared without changing production behavior. This
plan adds that state alongside the MST so later plans can write both atomically,
verify parity, and then cut over.

This plan is not the cutover. If it changes query results or writes, it is out of
scope.

## Current state

- `stratos-core/src/db/schema/tables.ts:13-36` defines `stratos_repo_root` and
  `stratos_repo_block`.
- `stratos-core/src/db/schema/pg-tables.ts:11-29` defines the PostgreSQL twins.
- `stratos-core/src/db/index.ts:95-118` and `stratos-core/src/db/pg.ts:43-66`
  create these tables with `CREATE TABLE IF NOT EXISTS`.
- `stratos-core/src/db/schema/tables.ts:40-56` defines `stratos_record` with
  `uri`, `cid`, `collection`, `rkey`, `repoRev`, `indexedAt`, `takedownRef`.
  This is the complete path → CID index for an actor and includes taken-down
  records.
- Canonical record bytes live in `stratos_repo_block.content`, keyed by CID.
- `stratos-core/src/repo/reader.ts` and `transactor.ts` implement block reads and
  writes. `stratos-core/src/storage/repo-store.ts` is the port interface.
- `stratos-service/src/storage/sqlite/actor-store.ts` and
  `stratos-service/src/infra/storage/postgres/actor-store.ts` implement the
  service-side stores.
- `@atcute/mst` exposes `NodeWalker.entries()` in
  `node_modules/@atcute/mst/dist/node-walker.d.ts:112`. Use it to enumerate the
  existing MST; do not add a second tree implementation.

## Target state table

Add `stratos_repo_state` (one row per actor):

| Column               | Type              | Meaning                                                   |
| -------------------- | ----------------- | --------------------------------------------------------- |
| `did`                | text, primary key | Actor DID                                                 |
| `formatVersion`      | integer, not null | `1` for flat-state schema, including shadow state         |
| `activeFormat`       | text, not null    | `mst` during shadow; `flat` only after 029                |
| `sourceMstCommitCid` | text, nullable    | Legacy reconciliation checkpoint, not flat authentication |
| `commitBytes`        | blob, not null    | Canonical signed internal metadata from 025               |
| `rev`                | text, not null    | Last reconciled revision                                  |
| `commitCid`          | text, not null    | CID of independently signed flat metadata; never MST CID  |
| `hash`               | blob, not null    | 32-byte SHA-256 of the LtHash state                       |
| `lthashState`        | blob, not null    | 2,048-byte accumulator                                    |
| `updatedAt`          | text, not null    | ISO timestamp                                             |

The flat record set is `stratos_record` joined to `stratos_repo_block` by CID.
Do not duplicate record bytes.

## Commands you will need

| Purpose              | Command                                                                                                     | Expected                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------- |
| Core tests           | `pnpm --filter @northskysocial/stratos-core test`                                                           | all pass                  |
| Service tests        | `pnpm --filter @northskysocial/stratos-service test`                                                        | all pass                  |
| Typecheck            | `pnpm run typecheck`                                                                                        | exit 0                    |
| Lint                 | `pnpm run lint`                                                                                             | exit 0                    |
| Format               | `pnpm exec prettier --check .`                                                                              | exit 0                    |
| Postgres integration | `TESTCONTAINERS_RYUK_DISABLED=true pnpm exec vitest run stratos-service/tests/postgres-integration.test.ts` | all pass, Docker required |

## Scope

**In scope**:

- `stratos-core/src/db/schema/tables.ts`
- `stratos-core/src/db/schema/pg-tables.ts`
- `stratos-core/src/db/schema/index.ts`
- `stratos-core/src/db/index.ts`
- `stratos-core/src/db/pg.ts`
- `stratos-core/src/storage/repo-store.ts`
- `stratos-core/src/repo/reader.ts`
- `stratos-core/src/repo/transactor.ts`
- `stratos-core/src/repo/flat-state.ts` (create)
- `stratos-core/src/repo/index.ts`
- `stratos-core/src/app/` only if a new error type is required; prefer an
  existing domain error
- `stratos-service/src/storage/sqlite/actor-store.ts`
- `stratos-service/src/infra/storage/postgres/actor-store.ts`
- `stratos-service/src/features/repo/backfill.ts` (create)
- Existing service actor-signing seam (adapter wiring only; STOP if attestation needs broader scope)
- `docs/architecture/star-repository.md` (migration safety only)
- `stratos-service/src/bin/backfill-flat-repo.ts` (create)
- `stratos-core/tests/flat-state.test.ts` (create)
- `stratos-service/tests/flat-repo-backfill.test.ts` (create)
- `package.json` (script only)
- `advisor-plans/README.md` (status row only)

**Out of scope**:

- Changing `ActorRepoManager`, record handlers, or export behavior.
- Writing `stratos_repo_state` from production writes.
- Deleting MST blocks or legacy columns.
- Hidden migration on service startup that mutates user data.

## Git workflow

- Branch: `advisor/026-flat-repo-state`
- One implementation PR. Do not include generated backfill reports or data.
- Do not push or open a PR without explicit authorization.

## Steps

### Step 1: Add the state schema and ports

Add `stratosRepoState` to both Drizzle schema files and to the schema barrel.
Add raw DDL to `stratos-core/src/db/index.ts` and `stratos-core/src/db/pg.ts`:

```sql
CREATE TABLE IF NOT EXISTS stratos_repo_state (
  did TEXT PRIMARY KEY,
  formatVersion INTEGER NOT NULL,
  activeFormat TEXT NOT NULL,
  sourceMstCommitCid TEXT,
  commitBytes BLOB NOT NULL,
  rev TEXT NOT NULL,
  commitCid TEXT NOT NULL,
  hash BLOB NOT NULL,
  lthashState BLOB NOT NULL,
  updatedAt TEXT NOT NULL
)
```

PostgreSQL uses `BYTEA` instead of `BLOB`. Do not alter existing tables.

Extend `stratos-core/src/storage/repo-store.ts`:

```ts
export interface FlatRepoState {
  did: string
  formatVersion: 1
  activeFormat: 'mst' | 'flat'
  sourceMstCommitCid: string | null
  commitBytes: Uint8Array
  rev: string
  commitCid: string
  hash: Uint8Array
  lthashState: Uint8Array
}

export interface FlatRepoStateReader {
  getFlatState: () => Promise<FlatRepoState | null>
  listFlatEntries: () => Promise<Array<{ path: string; cid: string }>>
  getRecordBytes: (cid: string) => Promise<Uint8Array | null>
}

export interface FlatRepoStateWriter extends FlatRepoStateReader {
  putFlatState: (state: FlatRepoState) => Promise<void>
}
```

`listFlatEntries` must return every `stratos_record` row for the actor, including
rows with a non-null `takedownRef`. It must return `path = collection + "/" +
rkey`, sorted by path bytes. It must reject duplicate paths and rows whose CID
has no block.

Implement in both service adapters. SQLite and PostgreSQL must have identical
sorting and duplicate semantics. Do not use `listRecordsForCollection`; it filters
takedowns.

**Verify**: `pnpm --filter @northskysocial/stratos-core typecheck` and focused
schema/adaptor tests pass. A unit test proves a taken-down record is listed.

### Step 2: Implement pure flat-state construction

Create `stratos-core/src/repo/flat-state.ts`:

```ts
export interface FlatEntry {
  path: string
  cid: string
}

export function buildFlatState(input: {
  did: string
  rev: string
  entries: readonly FlatEntry[]
}): { hash: Uint8Array; lthashState: Uint8Array }
```

- Validate sorted unique paths and canonical CIDs.
- Start from an empty LtHash state from plan 025.
- Add each `{path, cid}` contribution.
- Return the 32-byte commitment.
- Do not read the database or encode records.

Add `verifyFlatState(state, entries)` that recomputes and returns a typed
mismatch result. Plan 026 only needs equality; plan 027 will reuse it.

**Verify**: `pnpm --filter @northskysocial/stratos-core test -- flat-state` and
`pnpm --filter @northskysocial/stratos-core typecheck` → exit 0.

### Step 3: Implement MST reconciliation

Create `stratos-service/src/features/repo/backfill.ts` with:

```ts
export interface BackfillOptions {
  did: string
  apply: boolean
  expectedFormatVersion: 1
}

export async function reconcileActorRepository(
  actorStore: ActorStore,
  options: BackfillOptions,
): Promise<BackfillReport>
```

Behavior:

1. Open one consistent actor transaction, serialized against writes when applying.
   Refuse an already active flat actor; backfill must never reset activation.
2. Read existing state; evaluate `already-current` only after reconciliation below
   proves the same revision, source MST checkpoint, hash and valid flat signature.
3. Read the current root commit from `stratos_repo_root`.
4. Enumerate MST entries with `NodeWalker.entries()` using the existing
   `RepoTransactor` block adapter. Produce `{path, cid}`.
5. Read flat entries with `listFlatEntries()`.
6. Compare path sets exactly. Stop on any missing, extra, duplicate, or CID
   mismatch. Report counts and up to 10 mismatched paths, no record content.
7. Recompute the flat state from flat entries. Through the service signing seam,
   create the plan 025 signed metadata for this actor/revision/hash; persist its
   bytes and CID separately from `sourceMstCommitCid`. Never relabel the MST commit.
8. Return `{status: 'dry-run', state}` when `apply` is false.
9. When `apply` is true, insert or update the state row in the same transaction.
   Initialize `activeFormat = mst`, `formatVersion = 1`; persist signed
   metadata in the state row without changing the root, record index or sequence.
10. Re-running apply after success returns `already-current`.

Do not read through ordinary record listing. Do not swallow blocks that are
missing from the MST traversal.

**Verify**: `pnpm --filter @northskysocial/stratos-service test -- flat-repo-backfill`
→ tests pass.

### Step 4: Add the operator command

Create `stratos-service/src/bin/backfill-flat-repo.ts`:

- Required `--did <did>`.
- Default dry run; `--apply` writes.
- Refuse a DID that has no repository root.
- Emit a JSON report to stdout and a structured log line. Never print record
  bytes, tokens, or credentials.
- Exit 0 only for `dry-run` or `already-current` or successful `apply`.
- Exit non-zero on any mismatch or missing state.

Add a root script:

```json
"backfill:flat-repo": "tsx stratos-service/src/bin/backfill-flat-repo.ts"
```

**Verify**: against a local test actor, dry run reports matching counts; apply
creates one state row; a second apply reports `already-current`. A modified CID
in a copy produces a non-zero exit and no state write. Use synthetic anime names.

### Step 5: Document migration safety

Add a short section to `docs/architecture/star-repository.md`:

- The command is dry-run by default and idempotent.
- It does not change authoritative reads or writes.
- It preserves taken-down records in state.
- Operators must keep the rollback window from plan 029.

**Verify**: `pnpm exec prettier --check .` → exit 0.

## Test plan

- `stratos-core/tests/flat-state.test.ts`: sorted/unordered/duplicate paths,
  invalid CID, empty repo, remove-to-empty, hash recomputation.
- `stratos-service/tests/flat-repo-backfill.test.ts`: matching state, missing MST
  entry, extra record, CID mismatch, taken-down record included, apply is
  idempotent, dry run does not write.
- PostgreSQL case in `stratos-service/tests/postgres-integration.test.ts` for
  state insert/read and inclusive takedown listing.
- Model after `stratos-core/tests/repo-manager.test.ts` and
  `stratos-service/tests/postgres-integration.test.ts`.
- Verification: focused tests plus full package suites.

## AiaB gate (required at the end)

Run `baseline` on the reviewed candidate. No production endpoint exposes the new
state yet, so a new suite would only test the harness. Record the receipt and
confirm zero skips/failures.

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir /home/evelyn/git/northsky/ops/sandbox/atmosphereinabox \
  --source "$(git rev-parse --show-toplevel)" \
  --suite baseline \
  --review-receipt "$REVIEW_RECEIPT" \
  --report-dir "$NEW_REPORT_DIR"
```

## Done criteria

- [ ] `stratos_repo_state` exists in both backends with identical semantics.
- [ ] Flat listing includes taken-down records and canonical block bytes.
- [ ] Backfill reconciles against the actual MST and stops on disagreement.
- [ ] Backfill is dry-run by default, resumable, and idempotent.
- [ ] Production reads and writes are unchanged.
- [ ] Core/service tests, typecheck, lint, Prettier pass.
- [ ] AiaB baseline passes on the reviewed candidate.

## STOP conditions

- `NodeWalker` cannot enumerate the current MST without changing the writer.
- Flat entries and MST paths disagree; report the mismatch, do not choose one.
- A backend cannot atomically read entries and blocks in one snapshot.
- Adding the table would require mutating existing data at startup.
- A required gate fails twice after a reasonable in-scope fix.

## Maintenance notes

- Plan 027 will write this state in the same transaction as MST writes. Keep
  `buildFlatState` pure so both paths share it.
- If record bytes move out of `stratos_repo_block`, update `listFlatEntries` and
  the verification tests together.
- Do not use the state table for authorization. Boundary and takedown policy stay
  in their existing stores.
