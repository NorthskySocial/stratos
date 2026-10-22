# Plan 030: Remove MST write machinery and retire CAR exports

> **Executor instructions**: Do this only after every hosted actor is active on flat state and the
> rollback window is closed. This plan deletes code and changes an export format.
> Follow the preconditions before deleting anything. If any actor is still on the
> MST format, STOP.
>
> **Drift check (run first)**:
> `git diff --stat c6f879ad0183fac61a493426f3906ef9ae5997f2..HEAD -- stratos-core/src/mst stratos-core/src/repo stratos-service/src/api stratos-service/src/features/pull-sync stratos-service/src/features/repo stratos-client/src lexicons package.json pnpm-lock.yaml`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: plan 029
- **Category**: tech-debt / migration
- **Planned at**: commit `c6f879ad0183fac61a493426f3906ef9ae5997f2`, 2026-10-21

## Why this matters

This is the payoff. Once every actor is on flat state and the rollback window is
closed, MST construction, node pruning, transaction retries for missing nodes,
and CAR graph assembly have no remaining production purpose. Removing them
reduces write cost and eliminates the duplicate representation. Keeping them
"just in case" recreates the complexity this migration exists to remove.

## Current state

- `stratos-core/src/mst/builder.ts` and `stratos-core/src/mst/index.ts` implement
  MST mutation and commit construction.
- `stratos-core/src/repo/manager.ts` preloads root spines, signs MST v3 commits,
  persists structural blocks, and deletes removed CIDs.
- `stratos-service/src/api/records/batch.ts` no longer has its own builder after
  plan 027.
- `stratos-core/src/repo/export.ts` emits CAR from the root commit and block
  iterator.
- `stratos-service/src/api/handlers/repo-read-handlers.ts` serves CAR and STAR.
- `stratos-core/package.json` and `stratos-service/package.json` depend on
  `@atcute/mst`.
- Retry classification in `stratos-service/src/api/records/validation.ts`
  includes missing MST blocks.
- `stratos_repo_block` also stores canonical record bytes. Do not drop the table.

## Preconditions (hard gates)

All must be true before Step 1:

1. Enumerate ALL hosted actors from the authoritative actor catalog on both backends,
   including empty, inactive and suppressed repositories, not just state rows.
2. Left-join that inventory to state: zero missing rows, zero unknown schema
   versions, zero `activeFormat != flat`, and zero unreconciled revisions.
   Fence new actor creation so it cannot introduce a legacy/missing state row.
3. The rollback window from plan 029 has closed by operator decision.
4. A verified backup/snapshot exists outside the test environment.
5. `getRepoStar` has been the owner export for one full release cycle.
6. Revalidate 029's reader inventory and independent review/supervisor acceptance.
   031 does not upgrade actor streams. Unknown or incompatible readers block removal.
7. Inventory independent public-repository MST/CAR proof consumers. Retain their
   code, dependencies and tests; only private-repository machinery is removable.

Record the query, date, operator, and backup reference in the PR description
without secrets.

## Commands you will need

| Purpose       | Command                                              | Expected                           |
| ------------- | ---------------------------------------------------- | ---------------------------------- |
| Core tests    | `pnpm --filter @northskysocial/stratos-core test`    | all pass                           |
| Service tests | `pnpm --filter @northskysocial/stratos-service test` | all pass                           |
| Client tests  | `pnpm --filter @northskysocial/stratos-client test`  | all pass                           |
| Typecheck     | `pnpm run typecheck`                                 | exit 0                             |
| Lint          | `pnpm run lint`                                      | exit 0                             |
| Format        | `pnpm exec prettier --check .`                       | exit 0                             |
| AiaB suite    | `--suite star-cutover`                               | baseline + updated assertions pass |

## Scope

**In scope**:

- `stratos-core/src/mst/**` (delete only private writer code without independent proof consumers)
- `stratos-core/src/repo/manager.ts`
- `stratos-core/src/repo/export.ts` (delete after endpoint change)
- `stratos-core/src/repo/index.ts`
- `stratos-core/src/repo/lru-block-cache.ts` only if no remaining consumer
- `stratos-service/src/api/handlers/repo-read-handlers.ts`
- `stratos-service/src/api/handlers.ts`
- `stratos-service/src/api/records/validation.ts`
- `stratos-service/src/features/repo/engine.ts` or plan 027's engine module
- `stratos-service/src/features/pull-sync/oplog.ts` (remove MST branch only)
- `stratos-client/src/verification.ts`
- `stratos-client/src/lexicons.gen.ts` (generated)
- `lexicons/zone/stratos/sync/getRepo.json`
- `stratos-core/package.json`, `stratos-service/package.json`,
  `pnpm-lock.yaml` (remove `@atcute/mst`)
- Tests that reference MST/CAR: `stratos-core/tests/mst.test.ts`,
  `mst-properties.test.ts`, `repo-manager.test.ts`, `repo-export.test.ts`,
  `stratos-service/tests/mst-handlers.test.ts`, and plan 027/029 tests
- `test/spaces-alignment/scenarios/star-cutover.ts`
- `advisor-plans/README.md` (status row only)

**Out of scope**:

- Deleting `stratos_repo_block` or record bytes.
- Deleting `stratos_repo_root` unless it has no readers after the change.
- Reader implementation (must already pass 029 inventory); 031 is only PDS recovery.
- Changing boundary, custody, enrollment, or blob behavior.
- Rebuilding historical MST commits.

## Git workflow

- Branch: `advisor/030-remove-mst`
- Delete code in separate commits: write path, export path, dependencies/tests.
- Do not push or open a PR without explicit authorization.

## Steps

### Step 1: Remove the dual-write MST path

- Make the engine from plan 027 persist flat state and commit only.
- Remove `ActorRepoManager` MST build/sign/persist methods and root-spine
  preloading.
- Remove `putBlocks`, `deleteBlocks`, and `preloadRootSpine` from the repository
  transactor if no consumer remains.
- Keep `putBlock` for canonical record bytes and the signed commit block.
- Remove `MissingBlockError` and MST-specific retry classification.

**Verify**: `pnpm run typecheck` and the core/service suites. A grep for
`buildCommit(` under `stratos-core/src/mst` returns no production call.

### Step 2: Retire CAR export

Change `zone.stratos.sync.getRepo` to return the STAR archive and update the
lexicon output encoding to `application/octet-stream`. Or keep `getRepoStar` and
remove `getRepo` if clients have migrated; choose one and document the choice.
Do not leave two owner-export endpoints with ambiguous behavior.

Update `stratos-client` generation and verification. Remove
`exportRepoCarStream` when no caller remains. Remove `since` from the contract;
partial history is not a complete snapshot.

**Verify**: `pnpm run codegen`, client tests, and owner-export tests pass.
`rg "exportRepoCarStream|application/vnd.ipld.car" --glob '!*.md'` returns no
private-export matches; independent public proof matches remain permitted.

### Step 3: Remove MST dependencies and dead tests

- Delete only unreferenced private MST writer modules; preserve public proof support.
- Remove `@atcute/mst` only where no independent proof consumer remains.
- Delete tests whose only subject is MST construction or CAR graph export.
- Keep tests that cover record bytes, commit signing, flat state, and STAR.
- Remove unused LRU cache only if `rg` shows no production consumer.

**Verify**: `pnpm install --frozen-lockfile`, `pnpm run typecheck`,
`pnpm run lint`, and full tests pass.

### Step 4: Update the AiaB suite

Extend `star-cutover`:

- `car-export-retired`: the retired endpoint is absent or returns the documented
  STAR encoding; no CAR response is produced.
- `no-mst-commit`: `listRepoOps` always returns the flat commit shape.
- `star-export-parity`: owner export decodes to the same records.

Keep the existing cutover assertions only if cutover commands remain. If
activation is removed because all actors are migrated, replace those assertions
with a migration-state assertion.

**Verify**: suite unit tests pass.

## Test plan

- Flat writes still persist record bytes and signed commits.
- Owner export round trips after CAR removal.
- `listRepoOps` has no MST branch and returns valid flat commits.
- No private writer import of `@atcute/mst`; independent proof tests still pass.
- All prior authorization and boundary tests pass unchanged.
- Verification: full core/service/client suites and AiaB.

## AiaB gate (required at the end)

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir /home/evelyn/git/northsky/ops/sandbox/atmosphereinabox \
  --source "$(git rev-parse --show-toplevel)" \
  --suite star-cutover \
  --review-receipt "$REVIEW_RECEIPT" \
  --report-dir "$NEW_REPORT_DIR"
```

Expected: baseline plus updated `star-cutover` assertions pass, zero
skips/failures, cleanup passed.

## Done criteria

- [ ] All hosted actors, including missing-row checks, are active on flat state before deletion begins.
- [ ] No private writer constructs MST or legacy owner CAR; public proofs remain supported.
- [ ] Unused MST dependencies are removed; required public proof dependencies remain.
- [ ] Owner export returns STAR and verifies.
- [ ] Record bytes and `stratos_repo_block` remain intact.
- [ ] Full tests, typecheck, lint, Prettier, codegen checks pass.
- [ ] AiaB `star-cutover` passes on the reviewed candidate.

## STOP conditions

- Any hosted actor is missing state, has unknown schema, or is not active on flat state.
- Rollback is still required by the operator.
- A remaining consumer needs `data` in the commit shape.
- Removing `stratos_repo_block` would be required; it must not be.
- A required test cannot be replaced without changing authorization behavior.

## Maintenance notes

- Future format changes version `stratos_repo_state.formatVersion`; do not
  reintroduce a second structural representation.
- If a legacy CAR reader is needed for archived exports, serve it from an
  external archive, not from the live repository path.
- Plan 031 handles only PDS-space recovery, not actor reader compatibility.
