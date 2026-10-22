# Plan 028: Serve snapshot-consistent STAR repository exports

> **Executor instructions**: Add a new export endpoint while retaining the
> existing CAR endpoint. Do not change `getRepo` output. Run the drift check and
> gates. If the actor store cannot provide a stable snapshot, STOP.
>
> **Drift check (run first)**:
> `git diff --stat c6f879ad0183fac61a493426f3906ef9ae5997f2..HEAD -- stratos-core/src/repo stratos-core/src/storage stratos-service/src/api stratos-service/src/features/repo stratos-service/src/storage stratos-service/src/infra/storage lexicons stratos-client/src test/spaces-alignment/scenarios`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plan 027
- **Category**: migration
- **Planned at**: commit `c6f879ad0183fac61a493426f3906ef9ae5997f2`, 2026-10-21

## Why this matters

Stratos can produce a STAR archive but nothing serves it. The existing owner
export builds a CAR from the MST and buffers the entire file in memory. This plan
adds a streaming STAR export from the shadow flat state, with one consistent
snapshot for metadata, records, and commitment. Cutover in plan 029 depends on this endpoint and a separately accepted actor-reader
inventory. Plan 031 is PDS-space recovery, not an actor-stream upgrade.

## Current state

- `stratos-core/src/repo/export.ts:26-43` emits a CAR rooted at the MST commit and
  supports a `since` revision.
- `stratos-service/src/api/handlers/repo-read-handlers.ts:83-125` restricts export
  to the owner, checks the actor exists, collects every CAR chunk into a Buffer,
  and returns `application/vnd.ipld.car`.
- `lexicons/zone/stratos/sync/getRepo.json` declares only
  `application/vnd.ipld.car` and a `since` parameter.
- `stratos-service/src/api/handlers.ts:36-38,91-111` registers handlers; import is
  declared but not implemented.
- XRPC response bodies may be a `Readable`; the installed server pipes it at
  `node_modules/.pnpm/@atproto+xrpc-server@0.12.5*/dist/server.js:243-246`.
- `stratos-service/src/storage/sqlite/actor-store.ts:347-369` opens an actor
  transaction. `stratos-service/src/infra/storage/postgres/actor-store.ts:1478-1496`
  wraps reads but does not explicitly select repeatable read.

## Commands you will need

| Purpose       | Command                                              | Expected                                 |
| ------------- | ---------------------------------------------------- | ---------------------------------------- |
| Codegen       | `pnpm run codegen`                                   | exit 0, generated lexicon bundle updated |
| Core tests    | `pnpm --filter @northskysocial/stratos-core test`    | all pass                                 |
| Service tests | `pnpm --filter @northskysocial/stratos-service test` | all pass                                 |
| Typecheck     | `pnpm run typecheck`                                 | exit 0                                   |
| Lint          | `pnpm run lint`                                      | exit 0                                   |
| Format        | `pnpm exec prettier --check .`                       | exit 0                                   |
| AiaB suite    | `--suite star-export`                                | baseline + 4 assertions pass             |

## Scope

**In scope**:

- `lexicons/zone/stratos/sync/getRepoStar.json` (create)
- `stratos-client/src/lexicons.gen.ts` (generated)
- `stratos-service/src/api/handlers/repo-read-handlers.ts`
- `stratos-service/src/api/handlers.ts`
- `stratos-service/src/features/repo/star-export.ts` (create)
- `stratos-service/src/storage/sqlite/actor-store.ts`
- `stratos-service/src/infra/storage/postgres/actor-store.ts`
- `stratos-core/src/repo/star/` (only snapshot source interfaces if required)
- `stratos-service/tests/star-export.test.ts` (create)
- `stratos-service/tests/star-export.integration.test.ts` (create)
- `test/spaces-alignment/scenarios/star-export.ts` (create)
- `test/spaces-alignment/scenarios/star-export.test.ts` (create)
- `stratos-client/README.md` and `docs/client/repo-export-import.md` (new API docs)
- `advisor-plans/README.md` (status row only)

**Out of scope**:

- Changing `zone.stratos.sync.getRepo` or its CAR output.
- Adding `since` to STAR. A snapshot is complete; deltas stay on the oplog.
- Boundary-scoped actor exports. Owner-only remains.
- Spaces metadata and `space-ref`.
- Feedgen changes.
- Preparing a STAR archive on every write.

## Git workflow

- Branch: `advisor/028-star-export`
- Commit the generated lexicon bundle with the lexicon change.
- Do not push or open a PR without explicit authorization.

## Steps

### Step 1: Add the endpoint contract

Create `lexicons/zone/stratos/sync/getRepoStar.json`:

```json
{
  "lexicon": 1,
  "id": "zone.stratos.sync.getRepoStar",
  "defs": {
    "main": {
      "type": "query",
      "description": "Export the complete repository as a STAR archive.",
      "parameters": {
        "type": "params",
        "required": ["did"],
        "properties": {
          "did": { "type": "string", "format": "did" }
        }
      },
      "output": { "encoding": "application/octet-stream" },
      "errors": [
        {
          "name": "RepoNotFound",
          "description": "The repository does not exist."
        },
        {
          "name": "RepoNotMigrated",
          "description": "The repository has no flat state yet."
        }
      ]
    }
  }
}
```

Register the handler in `handlers.ts` with the existing owner-only auth. Run
`pnpm run codegen` and confirm `stratos-client/src/lexicons.gen.ts` changes.

**Verify**: `pnpm run codegen` exits 0 and
`git diff --exit-code stratos-client/src/lexicons.gen.ts` after committing the
generated file is empty. Do not hand-edit generated output.

### Step 2: Add a stable snapshot reader

Add to both actor stores:

```ts
export interface RepositorySnapshot {
  did: string
  rev: string
  commitCid: string
  commitBytes: Uint8Array
  hash: Uint8Array
  entries: AsyncIterable<{ path: string; cid: string; bytes: Uint8Array }>
}

export function readRepositorySnapshot(did: string): Promise<RepositorySnapshot>
```

Requirements:

- SQLite: open one read transaction and keep it open for the iteration. The first
  read establishes the snapshot. Abort/close on iterator return or error.
- PostgreSQL: use a read-only `REPEATABLE READ` transaction. Do not rely on
  autocommit reads.
- Metadata and entries come from the same `stratos_repo_state` row and database
  snapshot.
- Entries are yielded in strict bytewise path order.
- Reject duplicate paths and missing block bytes.
- The iterator must be cancelable and must release the connection on error.
- Do not buffer all entries.

If the current transaction wrapper cannot hold a snapshot open across an async
iterator, STOP and report the specific wrapper limitation.

**Verify**: focused tests prove a concurrent write does not change an in-flight
snapshot's `rev`, paths, or bytes.

### Step 3: Implement the streaming handler

Create `stratos-service/src/features/repo/star-export.ts`:

```ts
export function exportStarStream(
  snapshot: RepositorySnapshot,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array>
```

- Read independently authenticated flat `commitBytes` and verify its `commitCid`,
  expected custody signer, actor, revision and hash using 025. Emit that exact
  canonical metadata map, not a nested commit. Shadow state must already have
  this flat signature from 026/027; an existing MST commit cannot authenticate it.
- Encode using plan 025's `encodeStarArchive`.
- Compute the commitment from the same entries being written. If the encoder needs
  two passes, reopen the same snapshot; do not take a new snapshot.
- Propagate cancellation from the HTTP request.

Handler rules:

- Owner DID must equal `params.did`; otherwise `RepoNotFound`.
- Missing actor → `RepoNotFound`.
- Missing or invalid flat state → `RepoNotMigrated`.
- Return `encoding: 'application/octet-stream'`, `body: Readable.from(stream)`.
- Set no `Content-Length`. Do not collect the stream.
- On iteration error after headers, destroy the stream; do not throw JSON.

**Verify**: `pnpm --filter @northskysocial/stratos-service test -- star-export`
→ streaming, owner denial, missing state, and abort cases pass.

### Step 4: Add the AiaB scenario

Create `test/spaces-alignment/scenarios/star-export.ts` with suite ID
`star-export` and required assertions:

- `star-magic-and-commitment`: owner export begins with `2a6c0100`, parses, and
  its commitment matches a recomputation over returned entries.
- `star-records-match`: every returned path/CID exists in the actor's current
  records; no committed record, including suppressed records, is omitted; owner export
  must preserve the separately stored takedown policy during recovery.
- `star-owner-only`: a second synthetic user receives denial/`RepoNotFound` for
  the owner's DID.
- `star-consistent-snapshot`: a write during export either appears wholly in the
  decoded archive or not at all; metadata `rev` matches the returned set.

Follow the suite API in `test/spaces-alignment/README.md:161-168`. Model HTTP
and browser helpers after `scenarios/client-custody.ts` and
`scenarios/feed-errors.ts`. Use existing baseline accounts; do not create public
PLC identities.

Add a unit test `star-export.test.ts` in the same directory using the existing
fake-command pattern from `scenarios/client-custody.test.ts`.

**Verify**: `pnpm exec vitest run --config test/spaces-alignment/vitest.config.ts`
→ new suite declaration and unit tests pass.

## Test plan

- Parser round trip through the actual handler, not only the codec.
- Concurrent write during export.
- Empty repository with a valid root exports a valid empty archive.
- Missing flat state returns `RepoNotMigrated`, not a partial archive.
- Abort closes the database iterator/transaction.
- Cross-backend tests for snapshot isolation.
- Verification: focused service tests and full service suite.

## AiaB gate (required at the end)

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir /home/evelyn/git/northsky/ops/sandbox/atmosphereinabox \
  --source "$(git rev-parse --show-toplevel)" \
  --suite star-export \
  --review-receipt "$REVIEW_RECEIPT" \
  --report-dir "$NEW_REPORT_DIR"
```

Expected: baseline plus all four `star-export` assertions pass, zero
skips/failures, cleanup passed.

## Done criteria

- [ ] New lexicon and generated bundle are committed.
- [ ] Owner-only STAR export streams without buffering the archive.
- [ ] Export reads one consistent snapshot on SQLite and PostgreSQL.
- [ ] Existing CAR `getRepo` behavior is unchanged.
- [ ] `star-export` unit tests and AiaB suite pass.
- [ ] Typecheck, lint, Prettier, codegen check pass.
- [ ] No files outside scope are modified.

## STOP conditions

- The XRPC handler cannot stream `Readable` in this service version.
- A backend cannot hold a read snapshot across the stream.
- The signed commit cannot be decoded into the frozen metadata shape.
- Owner-only authorization needs a policy change.
- A required gate fails twice after a reasonable in-scope fix.

## Maintenance notes

- Plan 029 activates flat state; plan 030 separately gates CAR retirement.
  Do not change the CAR endpoint here.
- The snapshot reader is reusable by import/backfill and feedgen. Keep it free of
  HTTP concerns.
- Any profile change in plan 025 must be reflected here and in the `star-export`
  suite.
