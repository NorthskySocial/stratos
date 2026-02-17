# MST & Signed Commits Implementation Plan

## Goal

Make Stratos a spec-compliant ATProto repo host by adding Merkle Search Tree (MST) structure and signed commits. This enables self-verifying records, standard `sync.getRecord` proofs, full repo export via `sync.getRepo`, and data portability to other private namespace services.

## Current State

Today, Stratos stores records as flat CBOR blocks keyed by CID. There is no MST, no signed commits, and no verifiable repo structure.

**What happens on `createRecord`:** ([records.ts](../stratos-service/src/api/records.ts))

1. CBOR-encode record → compute CID (dag-cbor, `cidForLex`)
2. `store.repo.putBlock(cid, bytes, rev)` — single block insert
3. `store.repo.updateRoot(cid, rev, did)` — root points at latest record CID
4. Sequence the change for firehose

**What happens on `sync.getRecord`:** ([handlers.ts](../stratos-service/src/api/handlers.ts))

1. Fetch record from index
2. Get stored block bytes (or re-encode)
3. Build minimal CAR with single block, record CID as root
4. No commit, no MST proof

**What exists:**

- `StratosSqlRepoReader` / `StratosSqlRepoTransactor` with `putBlock`, `putBlocks`, `getBytes`, `updateRoot`, `has`, `getBlocks`, `iterateCarBlocks`, `deleteBlock(s)` — the right shape, but stores only record blocks
- `stratos_repo_root` table: `{ did, cid, rev, indexedAt }` — one row per actor
- `stratos_repo_block` table: `{ cid, repoRev, size, content }` — flat block store
- Service-level `signingKey` (Secp256k1) at `{dataDir}/signing_key`
- `@atproto/repo` is already a dependency of `stratos-service` (^0.8.12)

## Target State

After implementation:

- Every actor repo has an MST and a service-signed commit chain
- `createRecord` / `updateRecord` / `deleteRecord` go through `Repo.formatCommit()` → `applyCommit()`
- `sync.getRecord` returns a full proof CAR: signed commit + MST path + record block
- `sync.getRepo` exports the complete verifiable repo as a CAR stream
- Existing actor stores are migrated to the MST structure

---

## Resolved Decisions

### D1: Service-Wide Signing Key

**Decision:** Use the single service-wide signing key (`ctx.signingKey`) for all actor commits.

Stratos is a supplementary store, not the user's canonical identity host. Using the service key makes commits verifiable as "issued by this Stratos instance" which is the meaningful trust boundary. No per-actor key management, no DID document modifications, no migration concern for existing actors.

### D2: `@atproto/repo` in stratos-core

**Decision:** Add `@atproto/repo` as a direct dependency of `stratos-core`.

The repo transactor lives in stratos-core, and it needs to implement `@atproto/repo`'s `RepoStorage` interface. Adding the dependency directly is simpler than an adapter layer in stratos-service, and stratos-core already depends on `@atproto/syntax`, `@atproto/common-web`, and `multiformats` — `@atproto/repo` is a natural addition for a project that manages ATProto repos.

This also lets us replace Stratos's custom `BlockMap`/`CidSet` with `@atproto/repo`'s canonical versions directly in stratos-core.

### D3: Dual Verification Model (Commit Signing + PDS Stub Chain)

**Decision:** Commits use `did: actorDid` and are signed by the service key. Verification works at two levels:

**Primary verification (service-level):** Resolve the Stratos service DID → get the service public key → verify the commit signature. This proves "this Stratos instance produced this commit." Any consumer that knows they're talking to a Stratos endpoint can perform this verification.

**Secondary verification (actor-level):** For records sourced by a public PDS stub (the standard hydration pattern), the actor's PDS contains a stub record in its own MST — signed by the actor's own key through the PDS commit chain. The stub references the Stratos service endpoint. This provides transitive actor authorization:

```
Actor's PDS (actor-signed MST)
  └─ stub record: { $type, source: "stratos", stratos endpoint }
       └─ Stratos service (service-signed MST)
            └─ full private record content
```

A verifier performing secondary verification:

1. Reads the record from Stratos (service-key-signed proof CAR)
2. Reads the corresponding stub from the actor's PDS (actor-key-signed proof CAR)
3. Confirms the stub references the same Stratos endpoint and the record URI matches
4. Concludes: the actor authorized this data to live on Stratos, and Stratos attests to the content

This avoids modifying actor DID documents (not scalable) while still providing actor-level trust when needed. Standard ATProto verification against the actor's DID doc will NOT work for Stratos commits directly — consumers must be aware they're verifying a supplementary store.

---

## Phase 1: Make StratosSqlRepoTransactor Implement RepoStorage

The `@atproto/repo` `Repo` class requires a `RepoStorage` interface to operate. Stratos's existing transactor is close but needs adaptation.

### Current Stratos Signatures vs Required RepoStorage

| Method                      | Stratos Has                                     | `RepoStorage` Needs                                  | Gap                                                                   |
| --------------------------- | ----------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------- |
| `getRoot()`                 | `Promise<CID \| null>`                          | `Promise<CID \| null>`                               | None                                                                  |
| `getBytes(cid)`             | `Promise<Uint8Array \| null>`                   | `Promise<Uint8Array \| null>`                        | None                                                                  |
| `has(cid)`                  | `Promise<boolean>`                              | `Promise<boolean>`                                   | None                                                                  |
| `getBlocks(cids)`           | `Promise<{ blocks: BlockMap, missing: CID[] }>` | `Promise<{ blocks: BlockMap, missing: CID[] }>`      | `BlockMap` type difference (Stratos has own, `@atproto/repo` has own) |
| `putBlock(cid, bytes, rev)` | Has                                             | `putBlock(cid: CID, block: Uint8Array, rev: string)` | Same                                                                  |
| `putMany(blocks, rev)`      | `putBlocks(blocks, rev)`                        | `putMany(blocks: BlockMap, rev: string)`             | Name + BlockMap type                                                  |
| `updateRoot(cid, rev)`      | `updateRoot(cid, rev, did)`                     | `updateRoot(cid: CID, rev: string)`                  | Extra `did` param                                                     |
| `applyCommit(commit)`       | **Missing**                                     | `applyCommit(commit: CommitData)`                    | Must implement                                                        |
| `readObj(cid, def)`         | **Missing**                                     | Provided by `ReadableBlockstore` base                | Inherit from base                                                     |
| `readRecord(cid)`           | **Missing**                                     | Provided by `ReadableBlockstore` base                | Inherit from base                                                     |

### Changes

1. **Add `@atproto/repo` as a dependency of `stratos-core`** and import `RepoStorage`, `ReadableBlockstore`, `BlockMap`, `CidSet`, `CommitData` types directly.

2. **Replace Stratos's custom `BlockMap`/`CidSet`** with `@atproto/repo`'s `BlockMap`/`CidSet`. They have the same shape but Stratos re-implemented them. Removing the duplicates avoids type incompatibility at the boundary.

3. **Add `applyCommit(commit: CommitData)`** to the transactor:

   ```
   applyCommit(commit):
     updateRoot(commit.cid, commit.rev)
     putMany(commit.newBlocks, commit.rev)
     deleteMany(commit.removedCids)
   ```

4. **Make `updateRoot` not require `did`** — the per-actor SQLite DB already uses `did: 'self'` (as seen in `SqliteRepoStoreWriter`). The adapter in `stratos-core` uses the actual DID but this is just stored in the single-row `stratos_repo_root` — can default to `'self'`.

5. **Inherit from `ReadableBlockstore`** (from `@atproto/repo/storage`) to get `readObj`, `readRecord`, `attemptRead`, etc. for free. These are all derived from `getBytes`/`has`/`getBlocks`.

### Storage Interface Updates

The `RepoStoreReader`/`RepoStoreWriter` port interfaces in `stratos-core/src/storage/repo-store.ts` need a `getRootDetailed()` returning `{ cid, rev }`, a `cacheRev(rev)` method, and a `getBlocksForCids(cids)` that returns a `BlockMap`.

---

## Phase 2: Wire Service Key Into Transact Flow

The service-wide signing key (`ctx.signingKey`, a `Secp256k1Keypair`) needs to be available inside the actor store transaction so that `Repo.formatCommit()` / `Repo.formatInitCommit()` can sign commits.

### Changes

1. **Add `signingKey` to `StratosActorStore` constructor** — pass it from `AppContext` when creating the store.
2. **Pass `signingKey` into the transact callback** — either as part of the `StratosActorTransactor` interface or as a closure. The simplest approach: add `signingKey: crypto.Keypair` to `StratosActorTransactor`.
3. **No per-actor key files** — every commit is signed by the same service key. On verification, consumers resolve the Stratos service DID to obtain the public key.

---

## Phase 3: Rewrite Record Write Path

This is the core change. Replace the manual "put block + update root" flow with `Repo.formatCommit()` / `Repo.formatInitCommit()`.

### Init Commit (First Write to Actor Repo)

When an actor's repo doesn't have a root yet (first record create):

```
1. Repo.formatInitCommit(storage, did, keypair, [createOp]) → CommitData
2. storage.applyCommit(commitData, isCreate=true)
3. Index record in stratos_record
4. Process blobs
5. Sequence change
```

### Subsequent Writes

```
1. Repo.load(storage, currentRoot) → repo instance
2. repo.formatCommit([writeOps], keypair) → CommitData
3. storage.applyCommit(commitData)
4. Index record in stratos_record
5. Process blobs
6. Sequence change
```

### Changes to records.ts

**`createRecord`:** Replace lines 105-140 (the transaction body):

- Before: `encodeRecord` → `computeCid` → `putBlock` → `updateRoot`
- After: Build `RecordCreateOp` → call repo `formatInitCommit` or `formatCommit` → `applyCommit`
- Record bytes and CID are now computed by `@atproto/repo`'s `BlockMap.add()` internally
- The `rev` comes from the commit, not generated separately

**`updateRecord`:** Same pattern — `RecordUpdateOp` → `formatCommit` → `applyCommit`.

**`deleteRecord`:** `RecordDeleteOp` → `formatCommit` → `applyCommit`. Commit removes the MST entry and the record block.

**`applyWrites`:** Already dispatches to create/update/delete — but should ideally batch all ops into a single `formatCommit` call for atomicity (addresses the wishlist item).

### Blob Processing

The current blob flow (trackBlob → associateWithRecord → makePermanent) remains unchanged. Blob references in records are CID links; the MST stores the record CID, not blob CIDs directly.

### Sequence Events

The firehose event format changes: the commit CID and rev now come from the signed commit, and `relevantBlocks` could be included for consumers that want to verify.

**Deferred decision:** Whether `subscribeRecords` events should include `relevantBlocks` (the MST proof blocks). The reference PDS firehose includes new blocks. This increases event size but enables consumer-side verification. For the initial implementation, include only the commit CID, rev, and record data — proof blocks can be added later.

---

## Phase 4: Update sync.getRecord for Proof CARs

Replace the current minimal CAR builder with `@atproto/repo`'s `getRecords()`:

```
1. Get committed root from storage
2. Call getRecords(storage, commitCid, [{ collection, rkey }])
3. Return the CAR stream
```

The returned CAR will contain:

1. **Signed commit block** (root of the CAR)
2. **MST node blocks** from root to the target key
3. **Record block**

This is the standard ATProto proof format that `@atcute/repo`'s `verifyRecord` and similar libraries expect.

### Manual CAR Building Removed

The current manual CAR v1 construction in `handlers.ts` (varint encoding, header building) is replaced entirely by `@atproto/repo`'s `writeCarStream`. The imports for `@ipld/dag-cbor`, manual varint encoding, etc. can be removed.

---

## Phase 5: Implement sync.getRepo (Full Repo Export)

New XRPC endpoint: `com.atproto.sync.getRepo`

```
handler:
  1. Validate `did` param, check actor exists
  2. Get committed root
  3. Call getFullRepo(storage, commitCid) from @atproto/repo
  4. Return the CAR stream
```

The full export CAR contains: signed commit → MST (all nodes) → all record blocks. This is the standard format for repo migration and backup.

### Optional: `since` Parameter

The reference PDS supports `since` (a rev) to get a delta export. This requires storing the full commit chain (prev pointers). For the initial implementation, we may skip `since` and always export the full repo.

**Deferred:** `since` (delta export) is not needed for the initial implementation. Always export the full repo. Delta export can be added later once the commit chain is established.

---

## Phase 6: Migrate Existing Actor Repos

Existing actors have flat block stores with no MST or commit structure. They need migration to the new format.

### Migration Strategy

For each existing actor:

1. Read all records from `stratos_record` index
2. For each record, read its block from `stratos_repo_block`
3. Build a fresh repo: `Repo.formatInitCommit(storage, did, keypair, allRecordOps)`
4. Apply the commit — this creates the MST structure and signed commit
5. Old record blocks are preserved (same CIDs); new blocks added (MST nodes + commit)
6. Update root to the commit CID

### Migration Timing

Options:

- **Eager:** Run migration for all actors on service startup. Could be slow for large deployments.
- **Lazy:** Migrate each actor on first write after upgrade. Reads continue to work against the flat store until then.
- **Background:** Queue actors for migration, process in background.

**Deferred decision:** Eager vs lazy vs background migration. Lazy (migrate on first write) is the safest default — reads can detect the absence of a commit root and fall back to the current minimal behavior.

### Backward Compatibility During Migration

While actors are un-migrated:

- `sync.getRecord` should detect the absence of a commit root and fall back to the current minimal CAR behavior
- Record CRUD should detect "no existing repo" and use `formatInitCommit` (which is the same as the fresh-actor path)

---

## Phase 7: Cleanup

1. **Remove Stratos's custom `BlockMap`/`CidSet`** from `stratos-core/src/repo/reader.ts` — use `@atproto/repo`'s versions
2. **Remove manual CAR building** from `handlers.ts`
3. **Remove `encodeRecord`/`computeCid` helpers** from `records.ts` — `@atproto/repo`'s `BlockMap.add()` handles this
4. **Update the port interfaces** in `stratos-core/src/storage/repo-store.ts` to reflect the new capabilities
5. **Update tests** — all 20 handler tests need updating for the new proof CAR format
6. **Update docs** — hydration architecture doc, operator guide

---

## Implementation Order

| Step                                                               | Scope                         | Estimated Effort | Dependencies |
| ------------------------------------------------------------------ | ----------------------------- | ---------------- | ------------ |
| 1. Add `@atproto/repo` to stratos-core, replace BlockMap/CidSet    | stratos-core                  | Small            | None         |
| 2. Make repo transactor implement `RepoStorage`                    | stratos-core                  | Medium           | Step 1       |
| 3. Wire signing key into actor store transact flow                 | stratos-service/context.ts    | Small            | Step 2       |
| 4. Rewrite `createRecord` to use `formatInitCommit`/`formatCommit` | stratos-service/records.ts    | Medium           | Steps 2, 3   |
| 5. Rewrite `updateRecord` and `deleteRecord`                       | stratos-service/records.ts    | Medium           | Step 4       |
| 6. Batch `applyWrites` into single commit                          | stratos-service/handlers.ts   | Small            | Step 5       |
| 7. Update `sync.getRecord` for proof CARs                          | stratos-service/handlers.ts   | Small            | Step 4       |
| 8. Implement `sync.getRepo`                                        | stratos-service/handlers.ts   | Small            | Step 4       |
| 9. Migration logic for existing actors                             | stratos-service               | Medium           | Steps 2, 4   |
| 10. Cleanup (remove manual CAR, old helpers)                       | stratos-core, stratos-service | Small            | Steps 7, 8   |
| 11. Update tests                                                   | tests                         | Medium           | All above    |
| 12. Update docs                                                    | docs                          | Small            | All above    |

---

## Risks & Concerns

### R1: BlockMap Type Incompatibility

Stratos has its own `BlockMap`/`CidSet` in `stratos-core/src/repo/reader.ts`. `@atproto/repo` has its own. These are structurally similar but are different TypeScript classes. Any boundary where they meet requires conversion or replacement.

**Mitigation:** Replace Stratos's classes with re-exports from `@atproto/repo` in Phase 1. This is a breaking change to the internal API but the classes have identical semantics.

### R2: Performance Impact of MST Operations

Every record write now involves:

- Loading the MST from storage (reads several blocks)
- Computing the diff (new vs old tree)
- Serializing new MST nodes
- Writing more blocks (MST nodes + commit in addition to record block)

For a 1000-record repo, the MST has ~3-4 levels. Each write touches ~4 MST node blocks + 1 commit block + 1 record block = ~6 blocks, vs the current 1 block.

**Mitigation:** The `StratosSqlRepoReader` already has an in-memory `BlockMap` cache, and `@atproto/repo`'s MST uses lazy loading. The reference PDS handles this fine at scale. We can add `cacheRev()` like the reference PDS to pre-warm the cache for the current rev's blocks.

### R3: `@atproto/repo` as stratos-core Dependency

Adding `@atproto/repo` to `stratos-core` increases the dependency footprint. Currently stratos-core is relatively lightweight (drizzle, multiformats, @atproto/syntax, @atproto/common-web). `@atproto/repo` pulls in `@ipld/dag-cbor`, `@atproto/crypto`, and the full MST/commit/CAR machinery.

**Accepted tradeoff:** Stratos manages ATProto repos — having `@atproto/repo` in its core package is architecturally appropriate. The alternative (adapter in stratos-service) adds indirection without meaningful isolation. The dependency footprint increase is justified by the capability gain.

### R4: Migration Failure/Interruption

If migration is interrupted mid-actor (e.g., process restart), the actor's repo could be in an inconsistent state — partial MST blocks written but root not updated.

**Mitigation:** Migration per-actor runs in a single SQLite transaction. Either the entire MST + commit + root update commits, or nothing does. SQLite transactions are atomic.

### R5: Commit `did` Field Semantics

ATProto commits have a `did` field. In the reference PDS, this is the actor's DID and the commit is signed by that actor's key. In Stratos, the commit `did` is the actor's DID but signed by the service key. Standard verification against the actor's DID document will not find the service key.

**Resolution: Dual Verification Model (D3)**

This is addressed by the dual verification model described in D3 above:

1. **Primary (service-level):** Consumers aware they're talking to Stratos resolve the Stratos service DID for the signing key. This is analogous to how AppViews trust the PDS they fetch from.
2. **Secondary (actor-level):** For hydration-sourced records, the actor's PDS stub (signed by the actor's own key in the PDS MST) transitively proves the actor authorized the data to live on Stratos.

Consumers that attempt standard ATProto `verifyCommitSig(commit, actorDidKey)` will get a verification failure. This is expected and must be documented: Stratos proof CARs require service-DID-aware verification. The `sync.getRecord` response should include a header or metadata indicating the signing authority is the service DID, so consumers can resolve the correct public key.

### R6: Sequence Event Size Increase

With MST, each commit produces `relevantBlocks` (proof blocks) that could be included in firehose events. The reference PDS firehose includes new blocks. This increases event sizes significantly (from ~1 record block to ~6 blocks per event).

**Mitigation:** Make block inclusion configurable or match the reference PDS behavior exactly. The current `subscribeRecords` format would need updating regardless since the commit structure changes.

### R7: Two Repo Transactor Implementations

Stratos currently has TWO parallel repo implementations:

1. `StratosSqlRepoReader/Transactor` in stratos-core (used by `StratosActorStore`)
2. `SqliteRepoStoreReader/Writer` in stratos-service/adapters/sqlite (implements the port interfaces)

These are largely redundant. The MST implementation should unify on one.

**Mitigation:** Phase 7 cleanup should consolidate to a single implementation that both satisfies the port interfaces and serves as `RepoStorage` for `@atproto/repo`.

---

## Resolved Questions

| #   | Question                                    | Resolution                       |
| --- | ------------------------------------------- | -------------------------------- |
| Q1  | Service key vs per-actor keys?              | **Service key** — D1             |
| Q2  | `@atproto/repo` in stratos-core or adapter? | **stratos-core** — D2            |
| Q6  | Commit `did` + signing relationship?        | **Dual verification model** — D3 |

## Deferred Decisions

| #   | Question                                     | Default                            | Decide When        |
| --- | -------------------------------------------- | ---------------------------------- | ------------------ |
| Q3  | Include `relevantBlocks` in firehose events? | No (commit CID + record data only) | Phase 3            |
| Q4  | Implement `since` (delta export)?            | No (full export only)              | After initial ship |
| Q5  | Migration strategy?                          | Lazy (on first write)              | Phase 6            |
