# ADR: Replace MST-backed repositories with flat records and STAR snapshots

- Status: Accepted direction; implementation pending; proposed internal signing contract requires acceptance
- Date: 2026-10-20
- Baseline: `c6f879ad0183fac61a493426f3906ef9ae5997f2`

## Context

Stratos maintains an MST for each hosted actor repository. Record writes require
record persistence plus tree traversal, structural block updates, commit creation,
and obsolete-node pruning. The implementation includes root-spine preloading,
block caching, process-local write queues, database root locks, and concurrency
retries. Single writes and batch writes maintain commits through separate paths.

Relevant implementation points:

- `stratos-core/src/repo/manager.ts`: shared repository manager and MST persistence.
- `stratos-core/src/mst/builder.ts`: tree mutation and commit construction.
- `stratos-service/src/api/records/batch.ts`: separate batch commit path.
- `stratos-service/src/infra/storage/postgres/actor-store.ts`: root locking and block storage.
- `stratos-core/src/repo/export.ts`: CAR export.
- `stratos-service/src/api/handlers/repo-read-handlers.ts`: complete CAR buffering before response.

STAR represents repositories as ordered path/record pairs. This fits the records
Stratos stores and the records feedgen consumes without requiring a block graph.
Bluesky proposal 114 is the trigger for adopting this direction, not a requirement
to redesign Stratos around Spaces. That proposal replaces CAR exports, not LtHash.

STAR is a serialization format, not a transactional database. Replacing CAR alone
would leave MST write costs intact. This decision therefore changes the internal
repository representation as well as its snapshot format.

## Decision

Make a flat actor-scoped record map authoritative. Use STAR for repository snapshots
and feedgen full-state recovery. Remove MST maintenance from the private repository
write path after migration and compatibility gates pass.

Preserve:

- Actor-scoped repositories and current physical storage partitioning initially.
- Boundary authorization, enrollment rules, and mixed-mode custody.
- Canonical record bytes, record CIDs, collection names, and record keys.
- Blob references, durable changes, boundary-scoped removals, and write preconditions.
- Existing API semantics except where a versioned format or commitment change is necessary.

Do not repartition repositories by space. Do not make standard Spaces APIs,
credentials, signing, or writer discovery prerequisites for this migration.
PDS-custody repositories remain externally hosted; this migration does not transfer
custody or permit Stratos to sign as their authors.

### Storage and commitments

Persist canonical record bytes and a unique path-to-CID mapping. Store repository
format version, revision, commitment state, and commit envelope explicitly.
STAR archives are generated from this state, not rewritten as files on every write.

Use a non-MST commitment for the new representation. Use the upstream LtHash construction described below, with cross-language vectors
as an implementation gate. Do not implement a new accumulator by inference.

Selecting an MST-backed STAR variant would change serialization without meeting
this decision's objective. The implementation must not retain an MST merely to
produce the new snapshot commitment.

The selected commitment and authentication envelope must preserve explicitly
specified verification guarantees. A record CID proves byte integrity; a set hash
proves agreement with a complete set; neither alone authenticates an author.
Do not silently replace existing signature guarantees with Spaces deniability.

### One transactional write engine

Route create, update, delete, and batch operations through one engine. Within the
transaction:

1. Establish database serialization before reading previous record values.
2. Check preconditions and apply batch operations in their defined order.
3. Remove old commitment contributions and add new contributions.
4. Update records, indexes, boundary-related state, and blob references.
5. Persist the new revision, commitment envelope, and durable operation log.
6. Commit before publishing subscriber notifications or mutable cached state.

Repeated keys in a batch must see preceding operations in that batch. Failed
transactions must leave records, commitments, and operation logs unchanged.

Keep database serialization. Commutative hash additions do not make replacements
or deletes concurrency-safe. Establish a lockable state row safely for new actors;
an absent PostgreSQL root row cannot supply a row lock.

Keep process-local queuing initially as backpressure. Remove tree-specific retries,
preloading, pruning, and caches only when their consumers are gone. Reassess other
concurrency machinery using cross-process tests and measurements, not appearance.

### STAR export and feedgen recovery

Export records in strict bytewise path order from one consistent repository
snapshot. The metadata, revision, commitment, and body must describe the same state.
Use bounded streaming with backpressure and cancellation instead of collecting the
whole archive in memory. Define the snapshot lifetime and resource limits so a slow
reader cannot hold database resources indefinitely.

A complete snapshot is not a revision-filtered delta. Keep incremental operations
separate and version or reject legacy partial-export parameters explicitly.

Whole-actor recovery requires a whole-repository entitlement. Boundary-scoped
credentials do not supply one. For an actor with records in several boundaries, an
engineering-only consumer cannot verify a whole-actor commitment without receiving
leadership records. Do not widen export authorization to satisfy verification, and
do not present a filtered export as a complete snapshot.

Scoped recovery remains available where its existing authorization contract permits
it. Its records are not a whole-actor verification set. Complete-set verification for
a restricted consumer remains unsupported until a separately approved contract
defines an authorized commitment. This distinction does not make Spaces export
translation a prerequisite for flat-storage activation.

Feedgen stages incoming snapshots outside the live generation. It validates the
selected profile, canonical encodings, paths, lengths, ordering, uniqueness,
record CIDs, authentication context, and final set commitment before promotion.
Parse failures or digest mismatches reject the entire snapshot. It also rejects an
authenticated snapshot older than its persisted verified checkpoint. Equal revision
and equal content hash may repair a lost projection after complete verification;
equal revision with a different hash is a conflict, not recovery.
A valid signature alone does not authorize regression to an older state.

Maintain a complete verification ledger distinct from retained feed posts.
Non-feed records and application-rejected records still contribute to a repository
commitment. Projection retention must not change verification state.

Bound staging and ledger storage with cumulative disk budgets, and clean up
interrupted stages. Neither an abandoned import nor unbounded retained verification
state may exhaust the host.

Promotion replaces the complete recovered set, including deletions, and persists
the verified checkpoint atomically. Membership and host-generation fences remain
in force. Define a gap-free bridge from the snapshot checkpoint to later operations;
stream sequences, repository revisions, and pagination cursors remain distinct.

Owner-only actor exports remain owner-only. This decision does not authorize a
boundary-scoped reader to download an actor's complete repository.

## Migration and rollback

### 1. Pin contracts and establish the baseline

Pin the STAR profile, commitment algorithm, authentication envelope, and test
vectors. Inventory export consumers, proof APIs, commit responses, and checkpoint
formats. Define reader negotiation and explicit unsupported-version errors.

Measure the current backend before removing it. Record source revision, workload,
database configuration, and hardware with each result.

### 2. Build and verify the new representation

Backfill flat repository state from a consistent legacy snapshot. Reconcile every
path and CID against the MST contents. Stop and report discrepancies rather than
choosing one representation silently. Preserve canonical bytes.

Preserve non-content policy metadata, including takedowns. Takedown state changes
without changing record bytes, and ordinary record enumeration excludes suppressed
records. A migration that rebuilds indexes from filtered listings can either omit
committed records or make suppressed records readable while the commitment still
reconciles. Use an unfiltered migration source that retains suppressed records in
authoritative verification state, and exclude them only from ordinary projections.
Reverse migration must preserve the same distinction.

Record the source checkpoint and migration progress. Make migration resumable and
idempotent. Use a brief actor write pause or durable change replay to close the gap
between backfill and activation. Prove that replay includes deletes and boundary
moves and cannot skip writes because history was truncated.

If shadow writes are used, update both representations atomically. Do not introduce
an asynchronous second state without a tested reconciliation protocol.

### 3. Deploy readers and prove recovery

Deploy STAR-capable feedgen and required client changes before authoritative
writers switch. Round-trip snapshots into an empty staging store and compare all
paths, CIDs, and bytes. Test interruption, malformed input, concurrent writes, and
snapshot-to-log catch-up. Retain necessary legacy readers during the transition.

### 4. Activate per actor

Independently recompute the new commitment, reconcile through the final checkpoint,
and atomically set `activeFormat = flat`. Schema `formatVersion = 1` also
exists in shadow state and is not an activation flag. Restart must select the recorded
active format, not guess from which tables exist. Never publish a partly migrated
actor or a partly verified feedgen generation.

### 5. Close the rollback window and remove MST

Choose and rehearse one rollback strategy before activation:

- A short, explicitly bounded transactional dual-write window; or
- Rebuilding the legacy repository from current canonical records under a write pause.

A frozen legacy MST is not a rollback strategy after new writes occur. Reverse
migration must account for records, deletes, boundaries, blobs, and consumer
checkpoints. Newly reconstructed legacy commits cannot be presented as the original
historical commits. Consumers may require explicit full recovery.

After acceptance and the rollback window, remove private-repository MST building,
structural blocks, pruning, tree-specific caching, and obsolete retries. Preserve
independently needed public-repository proof support. Delete legacy data only with
an explicit retention and operator recovery policy.

## Spaces export translation: separate follow-up

A future adapter may project an actor snapshot into a Spaces-compatible STAR
archive without changing authoritative actor storage:

`authorized actor snapshot -> boundary projection -> ordered records -> subset commitment -> target profile`

Preserve record bytes and paths. Recompute the commitment over exactly the exported
subset; changing metadata on a whole-actor archive is insufficient. Define overlap,
boundary moves, takedowns, and policy-change fencing explicitly.

Initially, generate the subset from a consistent snapshot on demand. If standard
incremental Spaces sync is later required, design derived per-space revisions,
accumulators, and operation logs separately. They are not prerequisites here.

Archive structure compatibility does not establish authentication compatibility.
A Stratos-held custody key is not automatically the author's DID account key.
Resolve the recipient's verification rules and custody-compatible envelope before
claiming upstream interoperability.

### Verified upstream contract: PR 5705

Inspected merge `232b2cdcec7a54a92d6e3c6461d07775d611d1ad` against parent
`90bc26a2657abc929b39392af37bd7c687192834` in the read-only upstream checkout.
This supersedes the earlier local draft comparison, not Stratos runtime APIs.

- `com.atproto.space.getRepo` now returns STAR-lite v1, not a two-root CAR.
  Parameters are `space` and `repo`; no `since`, `collection`, or `excludeValues`.
  Index-only export is removed. Deltas remain `listRepoOps`; blobs use `getBlob`.
- Media type is `application/octet-stream`. Magic is `2a6c0100`, followed by
  length-framed canonical DRISL metadata, then framed key/value pairs to EOF.
  There is no standalone hash prefix.
- Upstream metadata is `$type: atproto-space-repo`, `did`, `space`, and flattened
  `ver`, `rev`, `hash`, `ikm`, `sig`, `mac`. Its scope is one author's repository
  within ONE space. A credential for that space can authorize full recovery;
  this is not a whole-actor entitlement.
- Keys are UTF-8 `collection/rkey`, strictly increasing by bytewise comparison,
  not CBOR length-first ordering. Record values are at most 1 MiB.
- Generic framing limits are 64 MiB metadata, 64 MiB keys, and 64 GiB values.
  Unsigned varints must use their shortest encoding and at most six bytes.
  Applications must impose smaller resource budgets before allocating frames.
- The consumer checks metadata canonicality by re-encoding. It decodes records
  as plain maps without an explicit canonical re-encode check, computes CIDs from
  received raw bytes, and verifies completeness only after draining through EOF.
  Yielded records are untrusted for promotion until that final comparison.
- LtHash is unchanged: BLAKE3 XOF of UTF-8 `collection/rkey/canonical-CID`
  produces 2,048 bytes, interpreted as 1,024 little-endian u16 lanes. Add/subtract
  modulo 65,536; SHA-256 of the serialized state is the final 32-byte hash.
- Signing predates this merge. The account signature covers `atproto-space-v1`
  followed by uint16be-length-framed space, author, revision, and random `ikm`.
  HKDF-expand SHA-256 derives the HMAC key from `ikm` and that context; HMAC binds
  the hash. This is deniable content binding, not a direct signature over hash.
  Fresh response envelopes can differ for the same revision/content.
- The handler reads state and pages records without a visible snapshot transaction.
  Do not promise valid exports under concurrent writes: reject mismatches and
  retry within budgets. This does not relax the consistent-snapshot requirement
  for the planned Stratos exporter.

Source evidence: upstream `packages/space/src/{star,types,lthash,repo-commit}.ts`,
`packages/space/src/sync/{provider,consumer}.ts`, `packages/crypto/src/hmac.ts`,
and `packages/pds/src/api/com/atproto/space/getRepo.ts` plus
`packages/pds/src/actor-store/space/reader.ts`.
The AiaB source remains `79d6307e19908f3af406838ea0e5fae42847f182` in
`test/spaces-alignment/sources.json`; source support is not image or deployment proof.

### Proposed internal actor profile and custody commitment

Share finalized STAR framing, not the upstream profile or deniable signature.
The proposed private metadata is canonical DRISL with exactly these fields:
`$type: zone.stratos.repo.star`, `version: 1`, `did` (actor DID), `rev` (TID),
`hash` (32-byte byte string), `signer` (custody-service DID), `keyId` (absolute
service key identifier), and `sig` (64-byte P-256 IEEE-P1363 signature).
There is no `space`, nested `commit`, `ikm`, or `mac`.

The exact proposed signature payload is canonical DRISL of the map containing
all those fields EXCEPT `sig`. Sign with ECDSA P-256/SHA-256; require low-S
signatures. The `$type` and `version` domain-separate this payload. The commit
CID is CIDv1 dag-cbor/sha2-256 over the complete canonical metadata including
`sig`; it is stored separately and never included in its own signed payload.
The API commit representation uses this same map, not a second unsigned shape.

Verify the expected actor, profile, version, revision, hash and signer, then
resolve `keyId` only through an independently trusted custody-service identity
and authenticated actor enrollment/key attestation. Never trust a key solely
because the archive names it. Pin accepted key identity and rotation history for
checkpoint verification; key retirement must not silently authorize a new signer.
This is custody-service authentication, NOT a user DID signature or upstream
Spaces proof. Existing per-actor keys require an authenticated service attestation
mapping them to that actor and key identifier before this profile can ship.

Internal limits are 8 KiB metadata, 1 KiB key, and 1 MiB canonical record values,
with finite caller byte/time budgets. Compute CIDs from raw bytes; additionally
require canonical record re-encoding for this private profile. These stricter
rules must not be misrepresented as upstream consumer behavior.

Implementer produces vectors and key-resolution/rotation tests; independent
reviewer checks Standards and Spec; supervisor accepts this proposed signing
and trust-root contract at the plan 025 checkpoint before implementation proceeds.
Unresolved key attestation transport is a STOP, not permission to borrow the
upstream deniable envelope. No model assignment or continuous supervision is implied.

### Reader inventory gate

Before 029 activation and again before 030 deletion, inventory actor subscriptions,
Rust and legacy feedgen/indexer readers, pull-sync clients, export/import clients,
commit responses, proofs, and persisted checkpoints. Record each reader's version,
negotiation, authentication, rollback behavior and tested compatibility or explicit
retirement. Unknown consumers block activation. Plan 031 upgrades only upstream
PDS-space recovery; it does not upgrade Stratos actor-stream readers. Scope any
missing reader implementation separately before activation. Preserve independent
public-repository MST/CAR proof support.

## Performance expectations and measurement

Expected benefits are fewer structural database operations, shorter write
transactions, lower export memory, and simpler sequential feedgen recovery.
These are hypotheses about magnitude, not benchmark results.

Measure creates, updates, deletes, and batches across representative actor sizes.
Test both a contended actor and independent actors on SQLite and PostgreSQL.
Capture write p50/p95 latency, throughput, transaction duration, lock waits, SQL
operations, CPU, export bytes, peak memory, and recovery time.

Compare equivalent validation, durability, authentication, and recovery guarantees.
Separate streaming improvements from format improvements. CAR can also stream;
the current handler buffers it. STAR has path framing and commitment-computation
costs, so smaller archives and lower CPU must be measured rather than assumed.

A cost-based estimate can use:

`speedup = 1 / ((1 - old_MST_fraction) + replacement_fraction)`

Both fractions refer to the original operation time. This models isolated latency,
not queueing under contention. No percentage or throughput multiplier is accepted
until measured against a representative baseline. Set performance acceptance
budgets after collecting that baseline and before evaluating the replacement.

## Verification gates

- Cross-language commitment vectors: empty sets, insertion order, add/remove
  inversion, replacements, repeated keys, invalid persisted state, and CID encoding.
- Cross-process first-write and existing-repository concurrency on both backends.
- Failure injection proving atomic rollback of records, commitments, indexes,
  blob references, and durable operations.
- STAR round trips and rejection of duplicate, unordered, malformed, truncated,
  oversized, non-canonical, or digest-mismatched archives.
- Recovery with non-feed records, absent-record deletions, concurrent writes,
  interrupted migration, crashes around activation, revocation, and host changes.
- Rejection of an authenticated snapshot older than the persisted verified checkpoint.
- Staging and ledger quotas, interrupted-stage cleanup, and restart after exhaustion.
- Scoped recovery denied whole-actor export, and verification limitations reported
  rather than treated as complete-set validation.
- Forward and reverse migration preserving taken-down records and their suppression.
- Authorization parity and explicit legacy API/checkpoint compatibility tests.
- Rehearsed forward migration and rollback after post-cutover writes.
- Representative performance results with identical correctness guarantees.

Run affected package tests, typechecks, and lint checks. Use scoped Stryker for
changed TypeScript behavior without lowering thresholds. For feedgen changes run
`cargo fmt --all --check`,
`cargo clippy --locked -p stratos-feedgen-ng --all-targets -- -D warnings`, and
`cargo test --locked -p stratos-feedgen-ng`, plus relevant shared harness contracts.

## Alternatives considered

### Replace CAR with STAR but keep MST

Reject as the end state. It changes transport but retains the internal complexity
and write amplification motivating this decision. It may be a temporary reader
compatibility step, not the completed migration.

### Repartition Stratos into upstream Spaces repositories

Reject for this migration. It changes product semantics and greatly expands scope.
A future export adapter can derive subsets from actor storage.

### Rewrite a STAR file for every mutation

Reject. An archive format does not provide transactional record updates, indexes,
or concurrent-write control. Keep the database authoritative.

### Remove all write serialization

Reject. Commitment arithmetic does not protect preconditions, old-value reads,
record replacement, revision allocation, or related indexes from races.

## Consequences

The private repository write path becomes simpler and no longer maintains a tree
that its principal consumers do not need. Both service and feedgen gain a flat
snapshot contract. Migration requires explicit format versions, verified recovery,
and real rollback support.

MST inclusion proofs cannot be silently preserved by a flat set commitment.
Affected APIs must retain a separate supported proof path, explicitly change their
guarantees, or be versioned out. Complete-set verification requires consuming the
complete committed set, even when the feed projection uses only part of it.

This ADR accepts the direction. It does not assert implementation completion,
measured performance gains, final upstream wire compatibility, or resolution of the
Spaces signing follow-up. Existing Spaces-alignment restrictions remain in force
until separately revised with interoperability evidence.

## References

- [Bluesky proposal 114](https://github.com/bluesky-social/proposals/pull/114)
- Local STAR source: `/home/evelyn/git/atprotocol/star`
- Historical draft only: `star-lite/spaces-archive.md`
- [October writer-sync contract](october-writer-sync-contract.md)
- [Spaces alignment](spaces-alignment.md)
- Existing follow-up: `advisor-plans/D02-full-content-proof-and-recovery.md`.
  It now targets the upstream STAR profile and remains a design/probe track.
