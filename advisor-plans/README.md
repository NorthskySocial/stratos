# Spaces alignment delivery plans

Prepared with the Improve skill on 2026-09-28 at `02f1e15d116ded61ae97c6985b7c5a0a621ad287`. Implementation status is tracked below. Existing `plans/` contains an older Feedgen migration sequence; these plans use `advisor-plans/` and do not rewrite that sequence.

## Management UI planning

| Plan                                                                       | Deliverable                                                                        | Priority | Effort | Depends on                           | Status                                           |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------ | ------------------------------------------------ |
| [020: boundary management workspace](020-boundary-management-workspace.md) | Parent design and cumulative acceptance contract                                   | P1       | M-L    | Existing catalog and membership APIs | DECOMPOSED; implementation not started           |
| [021: navigation and Overview](021-boundary-workspace-navigation.md)       | Reactive contextual URLs and read-only configuration summary                       | P1       | M      | Existing catalog API                 | TODO                                             |
| [022: contextual Members](022-boundary-workspace-members.md)               | Filtered members, advisory previews and safe single-membership changes             | P1       | L      | Accepted 021                         | TODO                                             |
| [023: Settings and completion](023-boundary-workspace-settings.md)         | Settings preview, lifecycle extraction, draft navigation and cumulative acceptance | P1       | L      | Accepted 022                         | TODO; navigation feasibility checkpoint required |

Execute **021 → 022 → 023**, serially in the open workspace on `ui/boundary-management-workspace`, only after implementation authorization. These plans supersede 020's coarse execution steps, not its product contract. Plan 020 remains the parent specification; it is not an extra implementation task. No backend, permission-model, group-governance, or shared-repository implementation is included. History/recovery dashboards, invitations, stewards, subgroup inheritance and My Spaces remain deferred.

### UI track model and checkpoint policy

For 020-023 only, the following overrides the historical migration model/delivery rules below: `openai/gpt-6-luna` implements; `openai/gpt-6.1-sol` independently reviews Standards and Spec; `openai/gpt-6-astra` supervises at entry, blocker and acceptance checkpoints. No continuous co-author supervision. If z.ai/Moonshot is requested, ask the user to assign a model to each role. No substitutions. Astra maintains statuses, dependencies and evidence; user decisions remain required for product changes, scope expansion and waived gates.

Use one serial task branch, preserving unrelated work. No automatic commit, push, PR, merge or deployment. Review may identify an uncommitted candidate by baseline HEAD, exact patch and changed/new-file hashes. Changed candidates require renewed affected evidence. The UI gates are local unit/build/typecheck/lint/format, mocked browser smoke and scoped helper mutation; historical AiaB/commit-before-review requirements are not inherited by this separate UI-only track. Mocked smoke does not establish live authorization/custody interoperability. Parent completion requires cumulative integration review, not merely three isolated approvals.

### Planning evidence and limits

Prepared at `c6f879ad0183fac61a493426f3906ef9ae5997f2` on 2026-10-20. Source remained unchanged on `main`; only advisor plans were written. Direct admin Vitest passed 19 tests across 2 files. Nested `pnpm exec vitest` fails under pnpm 11 because admin-ui lacks a package manifest; the plans use the verified direct Node entry. The installed Stryker CLI supports explicit `--testFiles` and `--dryRunOnly`. Build/browser/typecheck/mutation execution is reserved for implementation, not claimed as passed here.

Independent GPT-6.1 Sol cold review of 020-023 returned PASS with no actionable planning blockers. Router source confirms reactive query support but no cancelable leave guard: 023 requires an evidence-based feasibility checkpoint before extraction and must escalate any additional navigation-coordinator file. Parent navigation safety is not waived. No whole-product audit, external CGS/Habitat re-audit, production operation or live interoperability test was performed.

The older migration status rows below are historical and are not a current merge-status report.

## Active migration scope and execution gates

Reconciled 2026-10-15: [019](019-decentralized-request-proof-foundation.md) is ABANDONED. [PR #216](https://github.com/NorthskySocial/stratos/pull/216) is closed without merging. Its custom proof helpers, service assertions and test vectors are not migration dependencies. The [DPoP ADR in draft PR #217](https://github.com/NorthskySocial/stratos/pull/217) is an independent design track, not a prerequisite for 014-018 and not implemented by those plans. Preserve existing OAuth DPoP; migrate standard Spaces authentication independently.

All new execution uses `openai/gpt-6.1-sol`; separate Standards and Spec reviews use `openai/gpt-5.6-terra`. No provider/model substitutions. Each plan ends with the full AiaB baseline and its named integration suite, not only plan 016. Stryker mutates only changed production TypeScript files and runs only touched tests related to those files using explicit isolated test selection; verify selection before mutation. Existing global package sweeps are prohibited. All changed behavioral survivors must be resolved without lowering thresholds.

Plans 014-016 are complete and published as separate, unmerged PRs. The approved compatibility contract preserves legacy mint and presentation paths alongside standard HTTP signatures. Plans 017-018 retain their role/design gates and source-bound validation requirements. One PR per plan; no automatic merge or deployment. Keep source work isolated and obtain any required candidate commit/push authorization explicitly. Do not commit parent-doc handoff patches or checksums. Plan 019's retained receipts are historical and cannot certify these plans.

## October 14 update plans

New plans target Stratos `e8c39163` and the October 1 upstream changes. The older status rows and receipts below are historical; they do not certify the new protocol. PRs 208, 210, 211, 212 and 213 are merged in this baseline. Their source changes remain; their old protocol assumptions need the scoped updates below.

- [014: credential transport and lifetime](014-october-space-credential-transport.md), P1, L, HIGH risk, COMPLETE, [PR #218](https://github.com/NorthskySocial/stratos/pull/218), not merged. Accepted candidate `f0d62ac6a1cd5cea6ddafb20d8b861d3643c5582`; full AiaB baseline 10/10 and transport 15/15 passed with both pinned PDS images and cleanup. Receipt: `/home/evelyn/temp/plan014-aiab-f0d62ac6-20261016-fullrun/gate/receipt.json`. User-approved coexistence preserves legacy APIs and TTL while adding the new transport. Early 016 preparation includes a separate October PDS suite, not global baseline replacement. Migrate service exchange/presentation to HTTP signatures and cnf.kid; default 600 seconds, maximum 3600. Preserve OAuth DPoP.
- [015: Rust credential client](015-october-feedgen-credential-client.md), P1, L, HIGH risk, COMPLETE, [PR #219](https://github.com/NorthskySocial/stratos/pull/219), not merged. Accepted candidate `8296c0c3c380ec4ac1867c1609fe09ae5a6dd8e2`; baseline 10/10 and Rust interoperability 11/11 passed. Receipt: `/home/evelyn/temp/plan015-aiab-8296c0c3-first0700/gate/receipt.json`.
- [016: interoperability and cutover](016-october-interop-and-cutover.md), P1, M, MED risk, COMPLETE, [PR #221](https://github.com/NorthskySocial/stratos/pull/221), not merged. Accepted candidate `59d11aaa7254ae60439a60b21f781a9e41301202`; all seven required AiaB suites passed, 135 assertions across successful runs. Evidence: `/home/evelyn/temp/p016-59d11aaa-acceptance/summary.json`. One unchanged October retry resolved an intermittent second-owner UI failure. Full workspace and Rust gates passed. Driver mutation aggregate remains 35.27, exit 1; independent reviews accepted 339 inherited sites, four changed equivalents and two exact manual footer kills. This is not an automated mutation pass.
- [017: targeted revocation](017-targeted-revocation-contract.md), P2, L, HIGH risk, TODO with role-contract decision gate. Required for standard repo-host compliance; optional authority fanout is not included. Depends on 014 and coordinates with D01.
- [018: writer-sync design refresh](018-writer-sync-contract-refresh.md), P2, M design effort, HIGH risk, TODO. Amend D01 for repoRev/spaceRev and catch-up semantics without replacing authorization membership with incremental writer listings. Probe acceptance follows 014-016.

Execution order: 014 → 015 → 016. Prepare the minimum reviewed October sandbox pin and standard-client fixtures early from 016's scope so 014/015 can each pass their own full AiaB gate without a circular dependency. Record that preparation in the responsible candidate and plan status. Completing 014's own PR does not require completing 015/016; deployment requires all three. Do not deploy either transport half alone. Plans 017 and 018 retain their role/design gates: 017 depends on 014; 018's runnable October probes depend on 014-016. Neither depends on 019 or PR #217. The canonical legacy body/session mint contract remains supported by the explicit 014 coexistence decision; do not reinterpret it as standard HTTP signing.

Verified source snapshots: proposal `0c9c2e88ba385809fc9ecba92f362389d9338e16`; implementation PR 5187 `5b95b2f2723a2882824fbb0b819fd6aad884ef20`; alpha branch `79d6307e19908f3af406838ea0e5fae42847f182`. The implementation PR remains open. The combined protocol commit `679724ad62eb9a02f7f40429c3c4fdd65d3e4c79` differs from the inspected PR head only by the migration reference. Alpha packaging differs; a source SHA does not establish deployment provenance.

Audit exclusions and rejected changes: do not remove OAuth DPoP or change commit-signature/MAC semantics; do not add a browser credential subsystem to OAuth-only consumers; do not change all internal type fields to spaceType; do not replace the custom enrollment listing with standard writer deltas. Production searches found no listSpaces/createSpace callers. The new space-ref format still needs installed-validator capability verification. Existing 005-008, D02 and D03 are not duplicated. No production deployment, registry availability, whole-product audit or live interop was verified during this planning pass.

## Required delivery order for every PR

**GPT-6 Sol implementation → local tests and scoped mutation tests → commit → Terra Standards + Spec code reviews → resolve findings and repeat review → AtmosphereInABox on the exact reviewed commit → open that PR.** Any code change or rebase invalidates review and sandbox evidence. Never open a PR before its sandbox gate, and never merge automatically.

Use models `openai/gpt-6.1-sol` and `openai/gpt-5.6-terra`. Each plan includes its scope, source excerpts, regressions, commands, sandbox suite and stop conditions. Keep plans local and exclude them from implementation commits. Status updates belong here with review/sandbox receipt paths and PR URLs.

Write each PR description for a reviewer new to the work: briefly explain why the change is needed and what behavior changed. Do not include verification details, test counts, mutation results, receipts or private evidence paths.

## Implementation order and status

| Plan                                                 | Deliverable                                                     | Priority | Effort | Depends on  | Status      |
| ---------------------------------------------------- | --------------------------------------------------------------- | -------- | ------ | ----------- | ----------- |
| [001](001-sandbox-and-test-gates.md)                 | Make per-PR sandbox evidence reproducible                       | P1       | L      | —           | PR OPEN     |
| [002](002-active-service-admission.md)               | Require active service enrollment before boundary reads         | P1       | S      | 1           | PR OPEN     |
| [003](003-pds-revocation-generation.md)              | Fence PDS ingestion against revoked membership                  | P1       | M      | 1, 2        | PR OPEN     |
| [004](004-bounded-space-staging.md)                  | Apply cumulative limits and expiry to staged space data         | P1       | M      | 3           | PR OPEN     |
| [005](005-verified-sync-checkpoints.md)              | Resume incremental sync from the verified terminal revision     | P2       | M      | 3, 4        | IN PROGRESS |
| [006](006-target-sync-deadlines.md)                  | Bound complete PDS sync operations                              | P2       | S      | 4, 5        | TODO        |
| [007](007-stale-post-replacements.md)                | Remove old projections when their replacement cannot be indexed | P2       | S      | 5           | TODO        |
| [008](008-host-bound-sync-state.md)                  | Invalidate PDS sync state when its host changes                 | P2       | M      | 3, 5        | TODO        |
| [009](009-space-delete-scope.md)                     | Authorize the PDS delete action exposed by the webapp           | P2       | S      | 1           | PR OPEN     |
| [010](010-custody-aware-client-discovery.md)         | Preserve custody information in client discovery                | P2       | M      | 1           | PR OPEN     |
| [011](011-explicit-feed-failure-state.md)            | Show feed failures separately from an empty feed                | P2       | S      | 1, 9        | PR OPEN     |
| [012](012-delegation-transport-adapter.md)           | Accept the current delegation exchange transport                | P2       | M      | 2           | PR OPEN     |
| [013](013-alignment-docs-and-revocation-contract.md) | Publish the current alignment and revocation contract           | P2       | M      | 1, 2, 3, 12 | PR OPEN     |

001 establishes reproducible validation and missing test/mutation configurations. 002–008 protect authority admission and foreign ingestion; retain that dependency ordering. 009 and 010 can run independently after 001; 011 needs 009's production OAuth metadata and private PLC fixes for its required browser sandbox. 012 needs active admission; 013 records the resulting contract. Dependent branches may be stacked using gh-stack, but every branch needs its own reviewed commit and sandbox receipt before opening its PR.

## Separate design tracks

These address documented limitations. They produce ADRs, sandbox experiments and bounded follow-up implementation plans. They do **not** activate production features or claim the limitation has been fixed.

| Plan                                          | Deliverable                                              | Depends on         | Status         |
| --------------------------------------------- | -------------------------------------------------------- | ------------------ | -------------- |
| [D01](D01-standard-authority-contract.md)     | Design the standard space-authority adapter              | 1, 12              | SANDBOX PASSED |
| [D02](D02-full-content-proof-and-recovery.md) | Design full space content verification and STAR recovery | 1, 3, 4, 5, 7, 8   | TODO           |
| [D03](D03-foreign-space-blob-path.md)         | Design authenticated foreign-space blob delivery         | 1, 3, 4, 8, 10, 12 | TODO           |

## Coverage of the audit

| Audit finding or gap                                  | Plan                          |
| ----------------------------------------------------- | ----------------------------- |
| #1 OAuth issuer/token validation proposal             | Excluded by user; no dispatch |
| #2 active membership before service boundary reads    | 002                           |
| #3 revoked PDS writer can race projection purge       | 003                           |
| #4 cumulative staging growth and expiry               | 004                           |
| #5 terminal sync cursor does not retain verified head | 005                           |
| #6 host change leaves old sync state                  | 008                           |
| #7 total sync deadline and scheduler fairness         | 006                           |
| #8 unsupported replacement leaves stale post          | 007                           |
| #9 UI delete missing OAuth action                     | 009                           |
| #10 client loses custody/host information             | 010                           |
| #11 feed errors look like empty feeds                 | 011                           |
| Delegation transport mismatch                         | 012                           |
| Docs and credential lifetime claims                   | 013                           |
| Browser test collection and real sandbox evidence     | 001                           |
| Complete standard authority role/discovery            | D01                           |
| Full content proof and STAR recovery                  | D02                           |
| Foreign-space blobs                                   | D03                           |

## Upstream baseline

Track these independently; they are not interchangeable releases:

- [Spaces proposal](https://github.com/bluesky-social/proposals/tree/119fa6b63476d30c2516846c714319046e0422f3): `119fa6b63476d30c2516846c714319046e0422f3`.
- [Permissioned-data PR #5187](https://github.com/bluesky-social/atproto/pull/5187): draft/open when checked; head `787a730fcd22ed7791e2636beb509a943017ba1c`.
- [Alpha source](https://github.com/bluesky-social/atproto/tree/de009e6e83faea80d92d2fc32a8ad07863586b50): `de009e6e83faea80d92d2fc32a8ad07863586b50`.

No deployment SHA was established from public alpha health. A pinned image digest without source provenance does not prove the September public-blob guard is present. Plan 001 requires provenance or a fresh isolated build from the pinned source.

## AtmosphereInABox gate

The inspected integration lives at `/home/evelyn/git/northsky/ops/sandbox/atmosphereinabox`, preset `feedgen-ng-e2e`. Its relative `../stratos` build context and existing Clubhouse-only smoke are not adequate per-PR evidence. Plan 001 adds the source-bound wrapper and mixed-custody baseline. Later plans add their named assertions. Security scenarios use production auth gates, private sandbox identity/TLS and synthetic accounts. No public alpha fallback or host trust-root installation.

The `test/spaces-alignment/run-sandbox.ts` commands in these plans are **new interfaces to implement in 001**, not existing commands. A suite must reject absent/skipped assertions. Current green unit tests do not substitute for these future runs.

## Considered and excluded

- #1 is excluded per the user's instruction: Bluesky Entryway can be the authorization server while the DID identifies a different PDS resource host. No plan requires issuer equality with that PDS. This exclusion is not a claim that the existing token verification has changed.
- Full LtHash/CAR recovery and foreign blob delivery were accepted limitations, so they are separate design tracks rather than incidental fixes.
- Do not revive stale earlier `plans/` findings without checking live code. The present scopes and excerpts supersede those assumptions for this delivery.
- Parent `../docs/spaces` is not in a Git worktree here. Plan 013 creates tracked canonical docs and a local patch; it cannot promise a parent-repository PR.

## Status vocabulary

Planning QA: Terra cold-reviewed the handoff and identified four blockers (design deliverable scope, local parent-doc patch retention, AiaB pinning, and PDS build provenance). All four were amended and Terra confirmed closure. Local checks passed for all 16 plan structures, index links, scope-derived drift checks and Markdown fences/whitespace. This is plan review, not the future implementation code review or sandbox gate; no implementation tests or sandbox runs were performed during planning.

TODO → IN PROGRESS → REVIEWED → SANDBOX PASSED → PR OPEN. Use BLOCKED with a concrete reason when necessary. DONE means the planned deliverable and all its gates are complete, not merely coded. A design plan's DONE status covers its ADR/probes only. Keep the parent/commit SHA with each status transition.

### Plan 001 implementation status (2026-09-28)

Implementation is committed on `advisor/001-sandbox-and-test-gates` in `tmp/worktrees/advisor-001`: base `02f1e15d116ded61ae97c6985b7c5a0a621ad287`, reviewed candidate `a382666b0eb0bcf430cbe54be41ee911d1529d67`. Separate Terra Standards and Spec reviews of that candidate found no code findings. [PR #204](https://github.com/NorthskySocial/stratos/pull/204) is open against `feat/feedgen-ng-stage-telemetry` (PR #203); no merge was performed.

On the reviewed candidate, build, typecheck, lint, formatting, browser tests (16/16), feedgen harness (26/26), and sandbox-runner tests (14/14) pass. The full root suite passes with this host's settings `TESTCONTAINERS_RYUK_DISABLED=true pnpm test --maxWorkers=4`: 259 files and 3,597 tests passed, one file and 46 tests skipped; private log `/tmp/stratos-001-root-test-a382666b-workers4.log`. Ryuk cannot access the mounted Docker socket on this host (`permission denied`), and default worker concurrency twice timed out an existing feedgen startup test; the focused feedgen test passed 2/2. No Testcontainers containers remained. One-list scoped Stryker covered all four new TypeScript harness sources: 708 mutants, 619 killed, 61 survived, 28 uncovered, 87.43% overall. Meaningful source, image, account, command, and receipt survivors were addressed; remaining equivalents and defensive metadata variants were triaged without lowering thresholds.

The reviewed dual-suffix sandbox uses `.test` for synthetic PDS identities and `.internal` for the OAuth client route. The real source-bound AiaB baseline passed all 10 required assertions, with zero skipped or failed. Its private receipt is `/tmp/stratos-001-sandbox-a382666b/receipt.json`; it records the exact reviewed candidate, pinned AiaB source/fingerprint, pinned PDS source and immutable image ID, template hashes, successful stack steps, and assertion counts. The runner cleaned up its unique Compose project.

### Plan 002 implementation status (2026-09-28)

Implementation is committed on `advisor/002-active-service-admission` in `tmp/worktrees/advisor-002`: fixed parent `a382666b0eb0bcf430cbe54be41ee911d1529d67`, reviewed candidate `64910f7b30e6440af7e67cf64c3e39326899d470`. Separate Terra Standards and Spec reviews approved that exact commit with no findings. [PR #205](https://github.com/NorthskySocial/stratos/pull/205) is open on top of #204 in stack #206; no merge was performed. Its description uses the requested concise why/change/validation structure.

Build, typecheck, lint, formatting, and the full root suite pass. The latter passed 3,601 tests with 46 existing skips using this host's `TESTCONTAINERS_RYUK_DISABLED=true` and four-worker settings. Service-scoped Stryker killed every mutant on the changed admission lines; scenario-scoped Stryker killed 115 of 116 mutants, with one equivalent diagnostic-regex variant. The source-bound AtmosphereInABox receipt at `/tmp/stratos-002-sandbox-64910f7b/receipt.json` records 10/10 baseline and 5/5 service-admission assertions, zero skipped or failed, for the exact reviewed candidate. The disposable Compose project and volumes were removed. Earlier failed receipts remain private diagnostic evidence; they do not count as acceptance.

Plan 009's production Dockerfile hardcodes the published OAuth scope separately from its metadata template, and nginx adds a duplicate Content-Type that the PDS rejects. The user approved adding `webapp/Dockerfile` and `webapp/nginx.conf` to that plan's file scope on 2026-09-28 so the shipped OAuth grant can include delete and its metadata can be accepted; the real OAuth sandbox gate remains required.

Plan 009's separate Terra reviews on candidate `72ae3379abfca1764622bd1f41b28b0a73eae1ab` confirmed the real OAuth/DPoP delete and second-user denial, but found that the private PLC URL bypassed strict Vite environment typing. The user approved adding `webapp/src/vite-env.d.ts` to Plan 009 on 2026-09-28 for the optional declaration; review and source-bound sandbox must repeat on the amended commit.

Plan 004's initial Terra reviews on `9fb7dd6fe2dd5383b3ce690cb8b033449be7bfff` requested validated high-level staging budgets, a named lifetime API, and explicit multi-target global-cap AiaB evidence. The user approved adding `stratos-feedgen-ng/src/main.rs`, `src/retention.rs`, `src/server/tests.rs`, `src/conformance.rs`, and `src/pds_space_scheduler.rs` on 2026-09-28 for narrow budget wiring and constructor updates. The completed result is recorded below.

### Plan 003 implementation status (2026-09-28)

Implementation is committed on `advisor/003-pds-revocation-generation` in `tmp/worktrees/advisor-003`: fixed parent `64910f7b30e6440af7e67cf64c3e39326899d470`, reviewed candidate `4612fc2780d7e806d3be82cc3229409dd3e80622`. Separate Terra Standards and Spec reviews approved that exact commit with no findings. [PR #207](https://github.com/NorthskySocial/stratos/pull/207) is open on top of #205 in stack #206; no merge was performed. Its description follows the requested concise why/change/validation structure.

Rust formatting, strict all-target clippy, and the full crate suite passed (232 library and 2 main tests). Focused space and enrollment cases, the Rust privacy/recovery harness, scenario Vitest, and scoped scenario Stryker (24/24 killed) also passed. The source-bound AtmosphereInABox receipt at `/tmp/stratos-003-sandbox-4612fc27/receipt.json` records 10/10 baseline and 5/5 PDS-revocation assertions, zero skipped or failed, for the exact reviewed candidate. The disposable Compose project and volumes were removed.

### Plan 004 implementation status (2026-09-28)

Plan 004 is committed clean on `advisor/004-bounded-space-staging` at `eae9d53c17a7da3b838906733289e4586376131d`, with fixed parent `4612fc2780d7e806d3be82cc3229409dd3e80622`. Separate Terra Standards and Spec reviews approved that exact SHA after fixes for promotion-time expiry, complete staging metadata accounting, and bounded atomic promotion. [PR #209](https://github.com/NorthskySocial/stratos/pull/209) is open against Plan 003 and linked to remote stack #206; no merge was performed. Its description uses the requested concise why/change/validation structure.

Rust formatting, strict Clippy, the full feedgen crate suite (255 library and 2 main tests), repository-wide Prettier, focused scenario tests, and the privacy/recovery harnesses passed. The official source-bound AtmosphereInABox receipt `/tmp/stratos-004-sandbox-eae9d53/receipt.json` records baseline 10/10 and staging-limits 6/6, zero skips/fails, on the reviewed SHA. The disposable Compose project was removed. The PR head was updated after fixing a remote Prettier failure; all remote checks on the new head passed.

### Plan 009 implementation status (2026-09-28)

Implementation is committed on `advisor/009-space-delete-scope` in `tmp/worktrees/advisor-009`: fixed parent `a382666b0eb0bcf430cbe54be41ee911d1529d67`, final reviewed candidate `dcc02c34e4cf5baa40543e3ad5e1ac03961c181a`. Separate Terra Standards and Spec reviews approved that exact commit with no blocking findings. [PR #208](https://github.com/NorthskySocial/stratos/pull/208) is open against Plan 001's branch, separate from the linear Plan 002–004 chain; no merge was performed. Its description uses the requested concise why/change/validation structure.

Webapp tests passed 133/133; build, typecheck, lint, formatting and affected scoped mutation checks passed. The full root suite passed 3,603 tests with 46 existing skips at the earlier implementation commit; the final typed-environment follow-up passed affected checks. The official source-bound AtmosphereInABox receipt `/tmp/stratos-009-sandbox-dcc02c34-rerun/receipt.json` records baseline 10/10 and `space-delete` 5/5, zero skipped/failed, on the exact reviewed commit. The first official attempt failed transiently at baseline browser startup after successful seed; the clean rerun passed and removed its disposable Compose project and volumes.

### Plan 010 implementation status (2026-09-28)

Plan 010 is committed clean on `advisor/010-custody-aware-client-discovery` at `6cce32c7d49effed816911ce3f519c56da8f8f10`, with fixed parent `a382666b0eb0bcf430cbe54be41ee911d1529d67`. Separate Terra Standards and Spec reviews approved the exact SHA. [PR #210](https://github.com/NorthskySocial/stratos/pull/210) is open against Plan 001's branch as a separate sibling PR; no merge was performed. Its description uses the requested concise why/change/validation structure.

Client tests (170), build, typecheck, lint, formatting, self-contained bundle and exports checks passed. The full root suite passed 3,609 tests with 46 existing skips at the initial implementation commit; affected gates passed after the final scenario and docs changes. Scoped client mutation scored 92.65%, and the final scenario runner's scoped mutation scored 95.58%. The official source-bound AtmosphereInABox receipt `/tmp/stratos-010-sandbox-6cce32c/receipt.json` records baseline 10/10 and client-custody 5/5, zero skips/fails, on the reviewed SHA. The disposable project was removed. The remote docs check passed; the deploy job skipped and no separate test job was reported for this base branch.

### Plan 011 implementation status (2026-09-29)

Plan 011 is committed clean on `advisor/011-explicit-feed-failure-state` at `524cc7b320c62b1ea92bfefcfaff9efbe8456522`, with fixed parent `dcc02c34e4cf5baa40543e3ad5e1ac03961c181a`. Separate Terra Standards and Spec reviews approved that exact SHA. [PR #211](https://github.com/NorthskySocial/stratos/pull/211) is open against Plan 009; no merge was performed. Its description uses the requested concise why/change/validation structure.

Focused webapp tests (70), Chromium tests (10), build, typecheck, lint, and formatting passed. The full root suite passed 3,648 tests with 46 existing skips at the preceding implementation commit; affected gates passed on the final candidate. Scoped scenario Stryker exited 1 at 36.32%, below the unchanged 60% aggregate threshold, but no survivors or uncovered mutants fall on the new revocation-controller lines; the inherited aggregate limitation is disclosed in the PR. The official source-bound AtmosphereInABox receipt `/tmp/stratos-011-sandbox-524cc7b/receipt.json` records baseline 10/10 and feed-errors 6/6, zero skips/fails, on the reviewed SHA. It proved a real test-owned OAuth grant deletion and Feedgen 401/403; the disposable project was removed. The PDS-custody fixture has no hydrated blob URL by current Rust Feedgen design, so the scenario asserts actual private image removal and existing webapp tests cover object-URL cleanup.

### Active implementation status (2026-09-29)

Plan 005 has an uncommitted in-scope implementation and `terminal-checkpoint` scenario in `tmp/worktrees/advisor-005`, based on Plan 004's `eae9d53c`. Library check and strict library Clippy pass; focused scenario tests pass 2/2 and scoped scenario Stryker kills 24/24 mutants. Full Rust test compilation is waiting on a separate pending scope decision for test-only changes to `stratos-feedgen-ng/src/pds_space_scheduler.rs`; that file has not been edited for Plan 005. No review, sandbox, push, or PR has occurred.

Plan 012 is committed clean on `advisor/012-delegation-transport-adapter` at `e2892e61a05ea52aad9f302cbee0a2d15cad7c57`, with fixed parent `64910f7b30e6440af7e67cf64c3e39326899d470`. Separate Terra Standards and Spec reviews approved that exact SHA. [PR #212](https://github.com/NorthskySocial/stratos/pull/212) is open against Plan 002 as a sibling of the Plan 003 chain; no merge was performed. Its description follows the requested concise why/change/validation structure.

Build, typecheck, lint, formatting, focused service and scenario tests passed. Scoped scenario Stryker killed 113/113 mutants; service Stryker's 45.93% aggregate remains below the unchanged 60% threshold due to untouched verifier branches, with no changed-line survivors. The official source-bound AtmosphereInABox receipt `/tmp/stratos-012-sandbox-e2892e61/receipt.json` records baseline 10/10 and `delegation-transport` 9/9, zero skips/fails, on the exact reviewed commit. The disposable Compose project was removed.

Plan 013 is committed clean on `advisor/013-alignment-docs-and-revocation-contract` at `1112e78a13e813591b0897d5528af59e02571211`, with fixed parent Plan 012's `e2892e61`. Separate Terra Standards and Spec reviews approved the exact SHA. [PR #213](https://github.com/NorthskySocial/stratos/pull/213) is open against Plan 012; no merge was performed. Plan 003's Feedgen generation fence is a separate reviewed sibling PR and is documented as a deployment dependency, not as behavior included in this branch.

The full root suite passed 3,621 tests with 46 existing skips; focused service and scenario tests, build, typecheck, lint, formatting, and scoped scenario Stryker (76/76 killed) passed. The official source-bound AtmosphereInABox receipt `/tmp/stratos-013-sandbox-1112e78a/receipt.json` records baseline 10/10 and `credential-lifetime` 12/12, zero skips/fails, on the reviewed SHA; the disposable stack was removed. The separate parent-doc refresh patch remains private and unapplied at `/tmp/stratos-parent-docs.QVC5HO/parent-docs-refresh.patch`, SHA-256 `164ca9a90449738b4eaa8da96365132a6169f9b89d7c6650f1de430b08f431a2`; applicability was checked against disposable source copies.

### D01 design status (2026-09-29)

D01 is committed clean on `advisor/d01-standard-authority-contract` at `fdb11e26aa8401d81f14cbfd4e07e708b8e5c1be`, with fixed parent Plan 012's `e2892e61`. Separate Terra Standards and Spec reviews approved that exact SHA. The design documents the current authority and standard-role gap and adds sandbox-only probes; it does not activate a production standard authority role.

The 49-test spaces harness, static checks, and scoped discovery mutation gate (92.50%, with only message/equivalent survivors) passed. The official source-bound AtmosphereInABox receipt `/tmp/stratos-d01-sandbox-fdb11e26/receipt.json` records baseline 10/10 and `authority-contract` 7/7, zero skips/fails, on the reviewed SHA; the disposable stack was removed. The branch was pushed through the existing GitHub SSH identity. A PR is pending because GitHub CLI credential lookup times out and no signed-in browser is available; the prepared PR body is `/tmp/stratos-d01-pr-body.md` and omits validation details per the user's later preference.

## STAR repository migration

Prepared with the Improve skill on 2026-10-21 at `c6f879ad0183fac61a493426f3906ef9ae5997f2`.
The governing decision is [docs/architecture/star-repository.md](../docs/architecture/star-repository.md).
These plans remove MST from Stratos-custody actor repositories and use STAR for
snapshots. They do not repartition storage by space, change custody, or make
Spaces alignment a prerequisite. Spaces export translation remains a separate
follow-up.

| Plan                                    | Deliverable                                       | Priority | Effort | Depends on                                | Status                                                |
| --------------------------------------- | ------------------------------------------------- | -------- | ------ | ----------------------------------------- | ----------------------------------------------------- |
| [024](024-aiab-ci-e2e.md)               | Run the real AiaB baseline in GitHub CI           | P1       | L      | none                                      | IN PROGRESS; implementation complete, CI AiaB pending |
| [025](025-star-profile-and-lthash.md)   | Freeze the internal STAR profile and LtHash codec | P1       | M      | 024                                       | TODO                                                  |
| [026](026-flat-repo-state.md)           | Add flat repository state and reconciled backfill | P1       | L      | 025                                       | TODO                                                  |
| [027](027-unified-write-engine.md)      | Route single and batch writes through one engine  | P1       | L      | 026                                       | TODO                                                  |
| [028](028-star-export.md)               | Serve snapshot-consistent STAR exports            | P1       | M      | 027                                       | TODO                                                  |
| [029](029-star-cutover-and-rollback.md) | Activate STAR per actor and prove rollback        | P1       | L      | 027, 028, accepted actor-reader inventory | TODO                                                  |
| [030](030-remove-mst.md)                | Remove MST write machinery and retire CAR exports | P2       | M      | 029, all-actor and reader gates           | TODO                                                  |
| [031](031-feedgen-star-recovery.md)     | Add feedgen STAR decoding behind an opt-in mode   | P2       | L      | 025                                       | TODO; live activation gated                           |

### STAR execution rules

These rules override historical model, isolation and commit-before-review rules
above for 025-031 and D02 only. Other tracks retain their own instructions.

- **AiaB is mandatory at the end of every plan.** A plan is not complete until a
  real private-PLC sandbox run passes on its exact reviewed candidate. Baseline is
  the minimum; plans 028, 029, and 030 also require their named suites. Runner
  unit tests, health checks, and predecessor receipts do not substitute.
- Plan 024 adds a separate CI evidence mode. CI runs are regression evidence, not
  independent review approval. Local delivery still uses the review-receipt
  gate.
- Use one implementation PR per plan on its named branch. Do not merge, push, or
  deploy automatically. Keep plan files out of implementation commits.
- For 025-031 and D02, use implementer, independent Standards/Spec reviewer,
  and supervisor roles at entry, blocker and acceptance checkpoints. No continuous
  supervision or model assignments. Freeze uncommitted candidates by baseline,
  patch and file hashes; no commit/push is authorized by this guidance.
- PR 5705 is merged at `232b2cdcec7a54a92d6e3c6461d07775d611d1ad`.
  025 shares finalized STAR framing with upstream but proposes a distinct direct
  custody-service signature; its trust-root contract needs supervisor acceptance.
  031 instead consumes upstream `atproto-space-repo` and its deniable envelope.
- Never weaken the existing authorization, custody, takedown, or transaction
  contracts to make a sandbox scenario pass.

### STAR dependency notes

- 025 pins shared framing/LtHash vectors first. Actor and upstream metadata,
  signature verification and profile limits remain separate.
- 026 is additive: it creates parallel flat state without changing authoritative
  writes. 027 can then write both representations in one transaction.
- 028 can serve STAR before cutover because it reads the shadow state. 029 makes
  that state authoritative only after authenticated flat export round trips and
  accepted actor-reader inventory. Schema version is not activation state.
- 030 may delete MST only after the rollback window in 029 closes. Record bytes
  and the block table remain; only structural nodes and CAR construction go.
- 031 is opt-in upstream PDS-space recovery only; it does not upgrade Stratos
  actor-stream readers. A credential for ONE space may recover that author's full
  space repo; actor-wide export still requires a separate whole-actor entitlement.
- Upstream source support exists, but the sandbox pin remains
  `79d6307e19908f3af406838ea0e5fae42847f182`. A separately authorized pin/image
  update and real STAR recovery suite are required for live acceptance. Baseline
  alone proves no STAR interoperability. D02 supplies ledger/oracle design; align
  its recovery acceptance with 031 rather than revive CAR/index-only recovery.
- 030 checks ALL hosted actors, including missing state rows, and independently
  needed public proof code before removing private MST machinery.

### STAR excluded work

- Repartitioning Stratos into per-space repositories.
- The Spaces export translator, upstream credential/signing compatibility, and
  standard writer-sync adoption. These are separate follow-ups.
- Changing OAuth, custody, enrollment, or boundary semantics.
- Performance percentage claims. Plan 029 defines the before/after measurement;
  no gain is asserted until the receipts exist.
- Claiming internal actor-profile compatibility with upstream Spaces signing,
  or claiming deployment from a merged source change.

## Audit boundaries

This handoff follows the spaces alignment sweep across the proposal, alpha/PR sources, Stratos authority/auth, Rust ingestion, client/browser/webapp and local sandbox integration. It is not a deployment attestation, a whole-product security certification or an implementation run. Source code has not been changed during planning.
