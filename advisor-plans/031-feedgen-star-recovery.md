# Plan 031: Add feedgen STAR snapshot decoding behind a recovery mode

> **Executor instructions**: This plan adds a decoder and a disabled-by-default
> recovery mode. Do not enable it against a repo host that does not serve STAR.
> Do not change the existing `listRepoOps` path. If the pinned PDS cannot produce
> STAR, STOP after the unit/fixture work; do not fake a live proof.
>
> **Drift check (run first)**:
> `git diff --stat c6f879ad0183fac61a493426f3906ef9ae5997f2..HEAD -- stratos-feedgen-ng test/feedgen-harness test/spaces-alignment/sources.json`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plan 025
- **Category**: migration / perf
- **Planned at**: commit `c6f879ad0183fac61a493426f3906ef9ae5997f2`, 2026-10-21
- **Activation gate**: reviewed STAR-capable sandbox source/image provenance and live
  recovery evidence, plus a credential for the complete author repo within ONE space.

## Why this matters

Feedgen's PDS-custody path currently relies on `listRepoOps` deltas. A STAR
snapshot is a simpler full-state recovery transport and avoids CAR/MST block
graph handling. This plan lands the decoder and recovery plumbing so feedgen can
use merged upstream support at `232b2cdcec7a54a92d6e3c6461d07775d611d1ad`.
It does not claim the older pinned October PDS or deployed images serve STAR.

## Current state

- `stratos-feedgen-ng/src/space_host.rs:145-201` implements `list_repo_ops` for
  `com.atproto.space.listRepoOps`, with credential presentation headers and a
  pinned origin.
- `stratos-feedgen-ng/src/pds_space_sync.rs:161-230` syncs pages, verifies the
  terminal commit with `SpaceCommitVerifier`, and stages mutations.
- `stratos-feedgen-ng/src/space_commit.rs:45-93` verifies the signed commit
  envelope; it does not verify repository contents.
- `stratos-feedgen-ng/src/store/space.rs:898-1030` provides staged page,
  promotion, and discard operations with membership-generation checks.
- `stratos-feedgen-ng/Cargo.toml` has `sha2`, `cid`, `serde_cbor`, and `reqwest`;
  it does not have a BLAKE3 implementation.
- The pinned October PDS source in `test/spaces-alignment/sources.json` is
  `79d6307e19908f3af406838ea0e5fae42847f182`, older than the inspected merge.
  A separately authorized pin/image update and real STAR suite are prerequisites
  for live acceptance; this plan does not modify that pin.

## Commands you will need

| Purpose       | Command                                                                    | Expected |
| ------------- | -------------------------------------------------------------------------- | -------- |
| Format        | `cargo fmt --all --check`                                                  | exit 0   |
| Clippy        | `cargo clippy --locked -p stratos-feedgen-ng --all-targets -- -D warnings` | exit 0   |
| Tests         | `cargo test --locked -p stratos-feedgen-ng`                                | all pass |
| TS harness    | `pnpm exec vitest run --config test/feedgen-harness/vitest.config.ts`      | all pass |
| AiaB baseline | `--suite baseline`                                                         | pass     |

## Scope

**In scope**:

- `stratos-feedgen-ng/Cargo.toml`, `Cargo.lock` (add BLAKE3)
- `stratos-feedgen-ng/src/star_lthash.rs` (create)
- `stratos-feedgen-ng/src/star_archive.rs` (create)
- `stratos-feedgen-ng/src/space_host.rs`
- `stratos-feedgen-ng/src/pds_space_sync.rs`
- `stratos-feedgen-ng/src/config.rs`
- `stratos-feedgen-ng/src/main.rs`
- `stratos-feedgen-ng/src/store/space.rs` (ledger, snapshot staging and atomic promotion)
- `stratos-feedgen-ng/README.md` (planned mode and activation prerequisites)
- STOP for separately approved schema/migration scope if durable ledger storage needs other files.
- Rust tests beside the new modules and in `pds_space_sync.rs`
- `test/feedgen-harness/` fixtures/tests for cross-language vectors
- `advisor-plans/README.md` (status row only)

**Out of scope**:

- Enabling STAR recovery by default.
- Changing Stratos-custody service-stream ingestion.
- Widen boundary credentials to obtain an actor-wide export.
- Changing the pinned PDS source or claiming deployment proof from source inspection.
- Spaces credential/signing changes.
- Production performance claims.

## Git workflow

- Branch: `advisor/031-feedgen-star-recovery`
- Keep the decoder, host client, and recovery mode in separate commits.
- Do not push or open a PR without explicit authorization.

## Steps

### Step 1: Add the LtHash verifier and STAR decoder

Add a Rust BLAKE3 implementation that supports XOF. Pin the crate version in
`Cargo.toml` and `Cargo.lock`.

Create `star_lthash.rs` and `star_archive.rs`. Share framing/LtHash primitives
with 025, but decode the UPSTREAM profile, never the internal actor metadata:

- magic `2a6c0100`, framed canonical DRISL metadata then framed key/value pairs
  to EOF; no standalone hash prefix;
- `$type: atproto-space-repo`, `did`, `space`, flattened `ver`, `rev`, `hash`,
  `ikm`, `sig`, `mac`;
- strictly increasing UTF-8 `collection/rkey` bytes, not CBOR length-first order;
- 1 MiB record maximum; generic metadata/key limits 64 MiB and value 64 GiB,
  lowered by explicit local metadata/key/total-byte/time budgets before allocation;
- shortest unsigned varints, at most six bytes; EOF only at a pair boundary;
- canonical metadata re-encoding check. Decode record values as plain maps and
  compute CIDs from raw bytes. Upstream does not explicitly re-encode records
  for canonicality; do not copy 025's stricter private-profile rule silently;
- verify account context signature and MAC using the existing upstream contract:
  `atproto-space-v1` plus uint16be-framed space/author/rev/random ikm, then
  HKDF-expand SHA-256 and HMAC over hash. This predates PR 5705 and is deniable
  binding, not a direct account signature over the hash;
- no complete-content success until the iterator drains EOF and LtHash matches.

Use pinned upstream-generated space-profile fixtures, including valid signatures,
plus shared 025 framing/LtHash vectors. Record generator revision and commands;
never generate expected values using only the decoder under test. Include unequal
path lengths to distinguish byte ordering from CBOR ordering.

**Verify**: `cargo test --locked -p stratos-feedgen-ng -- star_` → all vectors pass.

### Step 2: Add the snapshot request

Extend `PinnedSpaceHostClient`:

```rust
pub async fn get_repo(
  &self,
  space_uri: &str,
  actor_did: &str,
) -> Result<StagedSpaceSnapshot, SpaceHostError>
```

- Use `com.atproto.space.getRepo` with the same space credential and audience
  headers as `list_repo_ops`.
- Request `Accept: application/octet-stream`; validate real magic and profile too.
  Supply only `space` and `repo`; no `since`, `collection`, or `excludeValues`.
  A credential for that space permits this author-within-space snapshot, not a
  whole-actor export. Blobs are fetched separately.
- Enforce a response-byte budget and the decoder limits.
- Reject redirects, non-HTTPS origins, invalid content type, and oversized
  bodies.
- Stream into bounded, encrypted, non-visible staging owned by the recovery
  operation. Return a fully drained verified stage handle, not an unbounded array.
  Dispose the response and discard the stage on any error or cancellation.

Unit tests use an in-process HTTP fixture. Live PDS support is not assumed.

**Verify**: `cargo test --locked -p stratos-feedgen-ng -- space_host` → pass.

### Step 3: Add a recovery mode without changing the default

Add a configuration enum, not a boolean:

```rust
pub enum PdsRecoveryMode {
    Operations,
    StarSnapshot,
}
```

Default `Operations`. `StarSnapshot` is selected only by explicit configuration
and rejects unsupported responses on recovery. There is no invented capability
advertisement or discovery field: validate the actual media type, magic, profile
and authenticated target on every response.

In `PdsSpaceSynchronizer`, add a separate `recover_target` path:

1. Capture current membership and host generations; request the exact authorized target.
2. Validate metadata `did`, `space`, revision, account key, context signature and MAC.
3. Stream ALL records into a staged full verification ledger and build a staged
   feed projection, including non-feed and application-rejected records in the
   ledger. Projection rejection must not omit a hash contribution. Keep the live
   ledger, projection and checkpoint unchanged throughout snapshot and catch-up.
   Enforce per-target/global rows, bytes, disk, lifetime and time budgets; clean
   abandoned stages after errors and restart. Projection retention cannot prune the ledger.
4. Drain EOF, recompute LtHash and compare authenticated hash before visibility.
   Upstream state reads and record paging are not visibly transactional. Concurrent
   writes may invalidate an export; discard and retry within budgets, never promote
   a partial match or promise that every concurrent export succeeds.
5. Compare checkpoint identity `(space, author, rev, hash)` under pinned host and
   membership generations. Fresh `ikm`, `sig`, or `mac` do not change content identity.
   Older revisions are rollback and rejected. Equal revision/equal hash may repair
   a lost projection after full verification; equal revision/different hash fails.
   Host-generation changes require explicit rebootstrap, not silent rollback acceptance.
6. Bridge from snapshot `rev` to `listRepoOps` without gaps: resume exclusive changes
   after that revision and apply every catch-up page only to the staged ledger and
   projection. Prove continuity through a terminal boundary, verify its commit and
   authenticated hash against the complete staged ledger, and prepare its checkpoint.
   Keep repository revisions, pagination cursors and stream sequences distinct.
   On truncated/unavailable history, verification failure, cancellation or exhausted
   budgets, discard the entire snapshot and catch-up stage without changing live
   state or declaring readiness; retry full recovery only within budgets.
7. Only after the terminal gap-free boundary is verified, atomically replace the
   live ledger and feed projection, delete absent records, and persist the terminal
   checkpoint in one transaction. Recheck membership/revocation and pinned host
   generation fences and compare the live checkpoint with the captured checkpoint
   inside that transaction; reject stale recovery if live state advanced. A failed
   fence or promotion leaves all live state unchanged and discards the stage.
   Declare readiness only after successful promotion.

Do not treat snapshot mode as a replacement for incremental `listRepoOps`. No
promotion or readiness until full verification and a proven catch-up boundary.

**Verify**: Rust tests cover wrong did/space/rev, unordered/duplicate keys,
digest mismatch, stale snapshot, revocation during recovery, and promotion
failure. Assert that snapshot verification alone and intermediate catch-up pages
leave the live ledger, projection and checkpoint unchanged. All pass.

### Step 4: Keep activation gated

- Do not set `StarSnapshot` as the default.
- Fail recovery closed if the selected host returns a non-STAR response.
- Document the exact activation precondition in `stratos-feedgen-ng/README.md`:
  the repo host must serve the verified upstream profile, and the credential
  must authorize the author's complete repository within that one space.
- If the pinned PDS does not serve STAR, record that live AiaB coverage of the
  mode is unavailable. Do not substitute a fake host in AiaB.

**Verify**: `cargo fmt`, clippy, tests pass. `rg "StarSnapshot" src/` shows the
default remains `Operations`.

## Test plan

- Cross-language vectors for empty, single, replacement, deletion, malformed,
  duplicate, unordered, truncated, and digest-mismatch archives.
- Host-client tests for content type, redirects, size limits, and credential
  headers.
- Recovery tests for wrong identity, stale revision, revocation, staging
  budget, interrupted promotion, and cleanup.
- Recovery ordering: no live ledger, projection or checkpoint changes after a
  verified snapshot or intermediate catch-up pages. A verified gap-free terminal
  boundary promotes all three atomically, including catch-up replacements/deletes.
- Catch-up truncation, unavailable history, terminal verification failure,
  cancellation and budget exhaustion discard the entire stage without live changes
  or readiness. Restart cleans abandoned snapshot and catch-up stages.
- Promotion rechecks membership/revocation, host generation and concurrent live
  checkpoint changes; stale fences and injected transaction failures leave all
  three live stores unchanged and recovery not ready.
- Existing `listRepoOps` tests remain unchanged.
- Verification: Rust suite plus feedgen harness.

## AiaB gate (required at the end)

Run the mandatory baseline. The new mode remains disabled, so a `star-recovery`
live suite cannot be honest until the pinned repo host serves STAR.

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir /home/evelyn/git/northsky/ops/sandbox/atmosphereinabox \
  --source "$(git rev-parse --show-toplevel)" \
  --suite baseline \
  --review-receipt "$REVIEW_RECEIPT" \
  --report-dir "$NEW_REPORT_DIR"
```

State explicitly in the PR that baseline proves no regression, not STAR recovery
interoperability. Before activation, require a real `star-recovery` suite against
that separately pinned image: non-feed records, replacement/delete, truncation,
wrong-space denial, equal-checkpoint repair, changed envelope/same content,
concurrent-export mismatch/retry, revocation and host fences, quotas/restart cleanup,
and gap-free snapshot-to-oplog catch-up. A fixture-only phase remains PARTIAL,
not completion of this live gate. Independent reviewer checks evidence; supervisor
accepts at entry, blocker and activation checkpoints, without continuous supervision.

## Done criteria

- [ ] Rust decoder matches the TypeScript vectors.
- [ ] `getRepo` client is bounded, credential-scoped, and rejection-tested.
- [ ] `StarSnapshot` is opt-in and refuses unsupported hosts.
- [ ] Recovery verifies identity, revision, commitment and membership; snapshot
      and catch-up remain staged until a verified terminal gap-free boundary.
- [ ] One fenced transaction promotes the terminal ledger, projection and
      checkpoint; readiness follows commit, never snapshot verification alone.
- [ ] Failed catch-up, stale fences and failed promotion leave live state unchanged
      and discard staging; tests prove no partial promotion or premature readiness.
- [ ] Existing operations sync remains the default and unchanged.
- [ ] Rust fmt/clippy/tests, feedgen harness, and AiaB baseline pass.
- [ ] Real STAR suite and source/image provenance pass before live activation; otherwise report PARTIAL.
- [ ] No live STAR claim is made without a host that serves it.

## STOP conditions

- No pinned repo host serves STAR; stop before claiming live interoperability.
- Recovery would require a whole-actor export for a boundary-scoped credential.
- The store cannot stage snapshot and catch-up together or atomically promote the
  terminal ledger, projection and checkpoint with membership/host/checkpoint fences.
- Snapshot-to-oplog continuity cannot be proven through a verified terminal boundary.
- The decoder cannot match the shared vectors.
- A required gate fails twice after a reasonable in-scope fix.

## Maintenance notes

- Upstream support is merged. Obtain separate authorization for the sandbox pin
  and source-bound image update plus a real `star-recovery` suite before live
  acceptance. Record source revision, Dockerfile/lock hashes, immutable image ID,
  reviewed candidate and nonzero no-skip assertion results. Do not change the default
  merely because that evidence exists; require supervisor acceptance.
- The decoder is shared with any future Spaces export adapter; do not fork the
  framing rules.
- Keep `Operations` recovery until a rollback path is proven for the STAR mode.
