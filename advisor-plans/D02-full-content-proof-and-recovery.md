# Plan D02: Design full space content verification and STAR recovery

> Follow the steps and gates in order. This is a planning artifact; no implementation is complete. Update the local index only after recording actual results.

## Status

- Status: TODO
- Priority: P3; effort: L; change risk: HIGH
- Category: direction; confidence: confirmed limitation; proposed design
- Depends on: 001, 003, 004, 005, 007, 008
- Planned at: `02f1e15d116ded61ae97c6985b7c5a0a621ad287`, 2026-09-28
- Branch: `advisor/d02-full-content-proof-and-recovery`
- Deliverable: design, sandbox probes and follow-up implementation slices; no production activation

## Drift check

```sh
git diff --stat 02f1e15d116ded61ae97c6985b7c5a0a621ad287..HEAD -- 'docs/architecture/space-content-proof.md' 'test/spaces-alignment/scenarios/content-proof-recovery.*'
git status --short
```

Expected: a clean isolated checkout; inspect any changed source against the excerpts below. Prerequisites may legitimately change these paths; reconcile their tested contract before proceeding.

## Why this matters

The Rust syncer authenticates terminal commit signature/MAC but does not bind the projected values to a fully reconstructed upstream repo hash. Full verification and history-loss recovery were accepted limitations, so they need a dedicated design and bounded proof before implementation.

## Upstream reference pins

Checked during the alignment audit: [proposal](https://github.com/bluesky-social/proposals/tree/119fa6b63476d30c2516846c714319046e0422f3), [permissioned-data PR source](https://github.com/bluesky-social/atproto/tree/787a730fcd22ed7791e2636beb509a943017ba1c), and [alpha source](https://github.com/bluesky-social/atproto/tree/de009e6e83faea80d92d2fc32a8ad07863586b50). These are separate tracks. Reconcile protocol changes explicitly rather than silently following a moving branch. Image source provenance must be recorded independently.

The recovery target is now upstream PR 5705 merge
`232b2cdcec7a54a92d6e3c6461d07775d611d1ad` (parent
`90bc26a2657abc929b39392af37bd7c687192834`). The older references above remain
historical. AiaB still pins `79d6307e19908f3af406838ea0e5fae42847f182`;
request a separately approved source/image pin update and record immutable image
provenance before live STAR probes. Source inspection is not deployment proof.
Coordinate with 031; this plan designs the full ledger and acceptance oracle,
not a second incompatible decoder or production activation.

## Current state

`stratos-feedgen-ng/src/space_commit.rs:75`:

```text
if !has_valid_mac(&commit, &context) {
    return CommitVerification::Rejected(CommitVerificationFailure::MacMismatch);
}
```

`stratos-feedgen-ng/src/space_sync.rs:167`:

```text
let Ok(cid) = Cid::try_from(cid.as_str()) else {
    skipped += 1;
    continue;
};
```

## Repository conventions

TypeScript uses strict checking, named exports, public interfaces and domain-specific errors. Preserve the port/domain/adapter layout. For example, `stratos-core/src/enrollment/port.ts` declares:

```ts
getEnrollment: (did: string) => Promise<Enrollment | null>
```

Keep Rust domain validation separate from `server/` and `store/` adapters; tests belong beside modules. Model TypeScript regressions on the existing test files named in scope, with explicit positive and negative cases. This plan does not authorize changes to deprecated indexers/feed generators, production infrastructure or OAuth finding #1.

## Execution and review contract

- Implementer works serially in the authorized workspace on a named task branch,
  preserving pre-existing work. Independent reviewer checks Standards and Spec.
  Supervisor accepts entry, blockers and completion; no continuous supervision
  or model assignment is implied.
- Freeze the candidate by baseline SHA, exact patch and file hashes. Run local
  gates, independent review, consolidated repairs, then AiaB on that exact candidate.
  Changed candidates invalidate affected review and sandbox evidence.
- Commit, push and PR publication require explicit authorization, not this plan.
  Keep credentials, sandbox state and private traces out of published artifacts.
- Audit finding #1 is **excluded by user decision**. Bluesky Entryway can be the authorization server while the DID names another PDS resource host. Never add an `iss == DID PDS endpoint` requirement. Do not modify legacy OAuth token verification as an incidental fix. Exclusion does not assert that token authenticity has been repaired.
- Keep Stratos custody (MST + Stratos signing) separate from PDS custody (upstream space repo + account signing). Authority membership selects writers; foreign record boundary claims remain untrusted. Do not discover writers from arbitrary notifications.

## Shared verification rules

Run commands from the authorized Stratos workspace. Read its current AGENTS.md first. No boolean mode flags in domain APIs; preserve feature/port/adapter separation. Use 90s anime names for synthetic test accounts.

For changed TypeScript behavior, scoped Stryker is mandatory. In the owning package, delete only that package's stale `reports/stryker-incremental.json`, then run one `--mutate` argument containing all changed source files (exclude generated bundles, declarations and barrels). Redirect to a private log, never pipe into head/grep. Confirm every expected filename is present; address survivors on changed lines without lowering thresholds. If the package lacks a config, Plan 001 provides it. Rust uses its full crate tests, fmt and clippy, not Stryker.

The sandbox runner exists; this plan must add and execute its content-proof-recovery suite. Do not treat an unknown suite, skipped assertion, health-only check, mocked-only test, or earlier commit's receipt as success. Read `test/spaces-alignment/README.md` before execution. AiaB uses a disposable private PLC, local DNS/TLS, and synthetic accounts. Public alpha and production credentials are out of scope.

A valid receipt contains candidate SHA, parent SHA, independently reviewed SHA/verdicts, AiaB source revision/content fingerprint, PDS source revision plus immutable image ID/digest, suite ID, assertion counts, exit codes and redacted artifact paths. No tokens, keys, real DIDs, post contents or raw HTTP bodies.

## Scope

Only modify:

- `docs/architecture/space-content-proof.md (new design)`
- `test/spaces-alignment/scenarios/content-proof-recovery.* (new sandbox probes/fixtures)`

Everything else is out of scope. Test fixtures and test configuration within the listed directories may change only to exercise this plan. Do not implement the other plans incidentally.

## Steps

### 1. Establish the change

Inspect pinned upstream space repo hash, commit and STAR code and produce test vectors from the disposable PDS. Document the exact DAG-CBOR/CID validation, LtHash construction, key derivation and commit binding. Do not infer algorithm details from names or reuse MST proof logic.

**Verify this step:** `git diff --check` exits 0. Run the focused commands below once the relevant test/config exists; new regression cases must execute, not be silently filtered out. Record test names and counts. A configuration-only step also requires its runner/config to load successfully.

### 2. Implement the next bounded part

Specify a bounded encrypted ledger of all space repo records needed for hash verification, including collections filtered out of feeds, deletes and repeated writes. Keep the full verification ledger distinct from retained feed posts. Design transactional staging/promotion with membership and host generation fencing and cumulative budgets.

**Verify this step:** `git diff --check` exits 0. Run the focused commands below once the relevant test/config exists; new regression cases must execute, not be silently filtered out. Record test names and counts. A configuration-only step also requires its runner/config to load successfully.

### 3. Implement the next bounded part

Define full-state STAR recovery for history truncation, host migration and hash mismatch: frame/record/total-byte/disk/time budgets, raw-byte CID checks, strict path ordering,
canonical metadata, duplicate/truncated pair rejection and authenticated final hash.
Use magic `2a6c0100`, framed metadata and pairs through EOF, no hash prefix;
`application/octet-stream`, `$type: atproto-space-repo`, `did`, `space`, and
flattened `ver/rev/hash/ikm/sig/mac`. No CAR roots, index-only oracle or
`excludeValues`; `getRepo` accepts only `space` and `repo`, not `since` or collection.
A space credential authorizes the author's complete repo within ONE space, not
all actor boundaries. Blobs remain separate. Upstream checks canonical metadata
but only decodes plain-map records, without explicit canonical re-encoding;
CIDs use raw bytes. Completeness requires draining EOF. The signed context/MAC
is deniable and predates 5705, not a direct signature over content hash.

The host's state read and paged export are not visibly transactional: reject/retry
mismatches under concurrent writes. Preserve non-feed/application-rejected records
in the full ledger. Atomically promote ledger, projection, absent-record deletions
and checkpoint with membership/host fences. Same `(space, author, rev, hash)`
can have different `ikm/sig/mac`; equal revision/equal hash permits verified repair,
equal revision/different hash rejects, older revision rejects rollback. Define
explicit rebootstrap for host change and gap-free snapshot-to-oplog catch-up;
truncated history requires another snapshot, never false readiness. Recovery remains unready until it atomically replaces a fully verified generation; never clear a cursor and label a partial log complete.

**Verify this step:** `git diff --check` exits 0. Run the focused commands below once the relevant test/config exists; new regression cases must execute, not be silently filtered out. Record test names and counts. A configuration-only step also requires its runner/config to load successfully.

### 4. Implement the next bounded part

Run sandbox probe fixtures with tampered values, valid signatures over mismatching heads, non-feed records, truncated history and host changes. The current implementation may reject/defer unsupported recovery; collect the limitation explicitly. Use a sandbox-only oracle to prove vectors, not a production bypass.

**Verify this step:** `git diff --check` exits 0. Run the focused commands below once the relevant test/config exists; new regression cases must execute, not be silently filtered out. Record test names and counts. A configuration-only step also requires its runner/config to load successfully.

### 5. Implement the next bounded part

Write a staged implementation plan and storage/migration ADR with resource estimates. Production verifier/ledger/recovery implementation requires its own follow-up PR sequence; do not smuggle it into the design PR. Independent review precedes the final content-proof-recovery run.

Write both the ADR and staged implementation slices as named sections of the in-scope `docs/architecture/space-content-proof.md`. Each slice includes file scope, dependencies and acceptance tests; no separate plan/ADR files are required.

**Verify this step:** `git diff --check` exits 0. Run all commands and scenario assertions below; every required assertion must execute and pass.

## Test plan

- Pinned upstream vectors distinguish valid hash from modified values, omitted collection and incorrect delete.
- STAR oracle rejects corrupted/oversized/incomplete fixtures and validates a full clean snapshot only after EOF.
- No index-only recovery; include non-feed records, equal-checkpoint repair, changed envelopes and concurrent snapshot retry.
- Validate shortest varints (maximum six bytes), bytewise paths and 1 MiB records; bound generic 64 MiB metadata/key and 64 GiB value framing locally.
- Projection retention never changes the repo proof; revoked or host-old generations never publish.

Implement these assertions in the in-scope regression/scenario files. A named test filter returning zero cases is a failure even if its process exits 0.

## Commands and expected results

Use Node 24 and pnpm 10, matching `.github/workflows/test.yml`; use the checked-in Rust toolchain for Rust work and Deno 2.8.3 for the inspected AiaB checkout (reconcile its manifest on drift). Run dependency installation only in the authorized implementation workspace, using `pnpm install --frozen-lockfile` (exit 0); if this plan intentionally updates dependencies, update and review the lockfile there first.

Focused commands (exit 0, nonzero tests, all cases pass):

```sh
pnpm exec vitest run --config test/spaces-alignment/vitest.config.ts
```

Full local gates (all exit 0):

```sh
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm exec prettier --check .
pnpm test
git diff --check
```

For Rust plans that change the TypeScript sandbox scenario runner, also run the focused harness Vitest suite and its scoped mutation gate. For TypeScript/Svelte plans, use the following command separately in every changed source package after clearing that package's stale incremental cache:

```sh
pnpm exec stryker run --mutate "${CHANGED_SOURCE_GLOBS:?one comma-separated relative source list}" > "${MUTATION_LOG:?unique private log path}" 2>&1
```

This command is a template requiring the actual reviewed source list, not permission to mutate the whole repository. Include new nongenerated source files; verify all appear in the result table. No changed-line survivors may remain unaddressed.

After both independent reviews approve the frozen candidate, set `REVIEW_RECEIPT` to the sanitized review receipt and `SPACES_REPORT_DIR` to a new private artifact directory, then run:

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir /home/evelyn/git/northsky/ops/sandbox/atmosphereinabox \
  --source "$(git rev-parse --show-toplevel)" \
  --suite content-proof-recovery \
  --review-receipt "${REVIEW_RECEIPT:?set absolute independent review receipt path}" \
  --report-dir "${SPACES_REPORT_DIR:?set unique private output directory}"
```

Expected: exit 0; suite `content-proof-recovery`, exact reviewed SHA, nonzero assertion counts, and no missing/skipped required cases. This suite must be implemented by this plan (baseline runner by 001). Required assertions are the Test plan above, not merely service health. The wrapper should also run baseline for every suite.

## Done criteria

- [ ] Every listed regression assertion executes and passes; all local gates exit 0.
- [ ] Scoped mutation results cover every changed TypeScript source and address changed-line survivors.
- [ ] `git diff --name-only "$BASE_SHA"..HEAD` contains only the approved scope; `BASE_SHA` is the fixed parent independently reviewed.
- [ ] Independent Standards and Spec receipts approve this exact commit and parent after all fixes.
- [ ] Fresh AtmosphereInABox receipt matches the reviewed commit and parent, with all required assertions passing.
- [ ] Only then open this PR; record its URL and sanitized gate results in the local index. No merge.

## STOP conditions

Stop this plan and report the specific blocker if the source no longer matches the current-state excerpts, a prerequisite is unavailable, the fix requires unrelated files, or upstream wire contracts differ from the pinned sources. Incorporate expected prerequisite changes after explicitly checking their contracts; do not blindly apply stale snippets. Do not stop merely because a fix needs iteration: continue within scope until gates pass or an actual dependency/authorization/design blocker exists.

Never weaken a gate, fall back to public alpha, reuse user-owned sandbox state, or open a PR with a failed/skipped required sandbox scenario. Installing trust roots into the host, changing production identity, migrating real user custody, or enabling a broader compatibility surface is outside these plans.

## Maintenance notes

No full-content-verification claim until the production implementation passes these vectors. Explicitly distinguish oracle success from present runtime capability.
