# Session Continuation: Stratos + pdsls Work

Date: 2026-02-17

## Original Request Chain

The user has been working on two related projects:

1. **Stratos** — standalone private namespace service for ATProtocol
2. **pdsls** — AT Protocol PDS browser/inspector (SolidJS app)

The goal is to make pdsls support browsing a user's Stratos service. A support plan exists at `pdsls/docs/stratos-support-plan.md` with 6 implementation phases. Several Stratos-side prerequisites were implemented in prior sessions (OAuth scopes, audience fix, DPoP wrapper, 4 XRPC handlers, uploadBlob, tests — 277 total passing).

## Current Status

### Completed

- **MST implementation plan** written at `docs/mst-implementation-plan.md` with 7 phases, 3 resolved decisions (D1: service-wide signing key, D2: @atproto/repo in stratos-core, D3: dual verification model). **SHELVED by user decision** — not proceeding with full MST implementation.
- **20 handler tests** added and passing (277 total across the project)
- **Stratos-side prerequisites** for pdsls support: OAuth scopes, token audience fix, DPoP wrapper, handlers for `describeRepo`, `applyWrites`, `sync.listBlobs`, `sync.getRecord`, `uploadBlob`
- **Issue #6 analysis complete** — root cause identified, solution designed (see below)

### Issue #6: sync.getRecord CAR Verification (READY TO IMPLEMENT)

**Problem:** pdsls verifies records fetched via `com.atproto.sync.getRecord` using `@atcute/repo`'s `verifyRecord()`. Stratos returns a minimal 1-block CAR with just the record block (CID as root). This fails verification because:

1. `verifyRecord` expects root block to be a v3 Commit (`isCommit` check fails — root is a record, not a commit)
2. Even if that passed, there are no MST nodes for the DFS inclusion proof

**Verification chain in pdsls:**

- `pdsls/src/views/record.tsx` lines ~281-305: `verifyRecordIntegrity()` calls `sync.getRecord` on the service, then `verifyRecord({ did, collection, rkey, carBytes })` from `@atcute/repo`
- No `publicKey` is passed → signature verification is skipped
- `@atcute/repo` verification (at `atcute/packages/utilities/repo/lib/verify.ts`): CAR root → `isCommit` → optional DID match → optional signature → MST DFS inclusion proof

**isCommit type guard** (`atcute/packages/utilities/repo/lib/types.ts`):

```ts
{ version: 3, did: string, data: CidLink, rev: string, sig: Bytes, prev: CidLink | null }
```

**MST NodeData** (`atcute/packages/utilities/mst/lib/types.ts`):

```ts
{ l: CidLink | null, e: TreeEntry[] }
// TreeEntry: { p: number, k: Bytes, v: CidLink, t: CidLink | null }
// p = prefix length shared with previous key, k = remaining key bytes, v = value CID, t = right subtree
```

**Recommended Solution: Synthetic Proof CAR (Option 1)**

Build a structurally valid 3-block proof CAR per-request in `sync.getRecord`:

1. **Record block**: the actual record CBOR bytes (already have this)
2. **MST node block**: single-entry NodeData: `{ l: null, e: [{ p: 0, k: encode("collection/rkey"), v: { $link: recordCid }, t: null }] }`
3. **Commit block (root)**: signed v3 Commit: `{ version: 3, did: actorDid, data: { $link: mstNodeCid }, rev: TID, sig: sign(commitBytes), prev: null }`

CAR header: `{ version: 1, roots: [commitCid] }`

This passes ALL `verifyRecord` checks:

- `isCommit`: valid v3 commit with all required fields ✓
- DID check: `commit.did === actorDid` ✓
- Signature: skipped (pdsls doesn't pass publicKey) ✓
- MST DFS: single entry at target key `collection/rkey`, CID matches record ✓
- Depth: single entry, trivially consistent with fanout ✓

**Implementation location:** `stratos-service/src/api/handlers.ts` lines 600-670 (current `sync.getRecord` handler)

**What's needed:**

- CBOR-encode the MST NodeData → hash → get CID
- Build commit object → CBOR-encode → sign with `ctx.signingKey` → add sig bytes → re-encode → hash → get CID
- Build 3-block CAR with commit CID as root
- All required imports already exist in handlers.ts (`dagCbor`, `cborEncode`, `sha256`, `CID`)
- `ctx.signingKey` (Secp256k1Keypair) is available in the handler context
- MST key format: UTF-8 bytes of `"collection/rkey"` (forward slash separated)
- TreeEntry `k` field is CBOR `Bytes` type (Uint8Array with the key string encoded as UTF-8)
- TreeEntry `p` = 0 for single entry (no previous key to share prefix with)

**Estimated effort:** ~50-60 lines of handler code replacement

**Alternative options considered and rejected:**

- Option 2 (Persistent Commit without MST): Not viable — `verifyRecord` DFS specifically validates `isNodeData` structure
- Option 3 (Persistent Single-Record MSTs): Same as Option 1 but persisted; marginal benefit, more complex write path
- pdsls-side skip/fallback: Would mask the problem, not solve it

### Remaining Open Issues (from pdsls support plan)

**Issue #5: Silent Auth Degradation on Reads** — NOT YET ADDRESSED

- `optionalStandard` auth verifier silently returns `{type:'none'}` when DPoP verification fails
- Boundary-gated reads appear empty instead of returning 401
- Needs investigation in Stratos auth verifier code

**Issue #7: Enrollment Schema Docs** — LOW PRIORITY

- Architecture docs describe outdated multi-service enrollment shape
- Lexicon and code agree on current shape; docs just need updating

**Issue #8: Scope Bookkeeping** — LOW PRIORITY

- pdsls saves `pendingScopes` as `grantedScopes` on OAuth callback without verifying the authorization server's response
- Pre-existing pdsls issue, not Stratos-specific

### pdsls Implementation Plan Status

The full pdsls support plan is at `pdsls/docs/stratos-support-plan.md` (486 lines). None of the 6 phases have been implemented in pdsls yet:

| Phase | Description                                                | Status      |
| ----- | ---------------------------------------------------------- | ----------- |
| 1     | State & Discovery (`src/stratos/state.ts`, `discovery.ts`) | Not started |
| 2     | Service Routing (`src/stratos/client.ts`, view updates)    | Not started |
| 3     | Navbar Toggle & Boundary Display                           | Not started |
| 4     | Scope Selector Updates                                     | Not started |
| 5     | Navigation & Reactivity                                    | Not started |
| 6     | Lexicon Registration (optional)                            | Not started |

One prerequisite file exists: `pdsls/src/stratos/dpop-fetch.ts` (DPoP wrapper, created in prior session).

## Key Files Reference

### Stratos

| File                                              | Description                                                |
| ------------------------------------------------- | ---------------------------------------------------------- |
| `stratos-service/src/api/handlers.ts` (722 lines) | All XRPC handlers including sync.getRecord (lines 600-670) |
| `stratos-service/src/api/records.ts`              | Record CRUD operations                                     |
| `stratos-service/src/context.ts`                  | AppContext with signingKey, auth verifiers                 |
| `stratos-service/src/features/index.ts`           | Feature handler registration                               |
| `docs/mst-implementation-plan.md` (387 lines)     | MST plan (SHELVED)                                         |

### pdsls

| File                                             | Description                                                  |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `pdsls/docs/stratos-support-plan.md` (486 lines) | Full implementation plan with 6 phases                       |
| `pdsls/src/views/record.tsx` (~583 lines)        | Record view with `verifyRecordIntegrity()` at lines ~281-305 |
| `pdsls/src/stratos/dpop-fetch.ts`                | DPoP wrapper for Stratos requests (exists)                   |
| `pdsls/src/auth/session-manager.ts`              | OAuth session management                                     |
| `pdsls/src/auth/scope-utils.ts`                  | Granular scope definitions                                   |

### atcute (verification library)

| File                                                       | Description                          |
| ---------------------------------------------------------- | ------------------------------------ |
| `atcute/packages/utilities/repo/lib/verify.ts` (245 lines) | `verifyRecord` implementation        |
| `atcute/packages/utilities/repo/lib/types.ts`              | `Commit` interface, `isCommit` guard |
| `atcute/packages/utilities/mst/lib/types.ts` (~60 lines)   | `NodeData`, `TreeEntry`, validators  |

## Suggested Next Steps (Priority Order)

1. **Implement Synthetic Proof CAR** in `stratos-service/src/api/handlers.ts` — replace the current `sync.getRecord` handler with the 3-block CAR approach described above
2. **Update/add tests** for the new sync.getRecord response format
3. **Address Issue #5** (silent auth degradation) — investigate `optionalStandard` auth verifier behavior
4. **Begin pdsls Phase 1** (State & Discovery) per `pdsls/docs/stratos-support-plan.md`
5. **Continue pdsls phases 2-5** in order

## Technical Notes for Implementation

### MST Key Encoding

The MST key for a record at `collection/rkey` is the UTF-8 bytes of the string `"collection/rkey"` (literal forward slash, not path separator). In the TreeEntry:

- `p: 0` (no previous key)
- `k: new TextEncoder().encode('collection/rkey')` — this becomes CBOR Bytes
- `v: { $link: recordCid.toString() }` — CidLink to the record block
- `t: null` — no right subtree

### Commit Signing

The commit is signed as: encode commit without `sig` field → sign bytes with `ctx.signingKey` → set `sig` field to signature bytes → re-encode full commit with `sig`. The signing key is a Secp256k1Keypair available at `ctx.signingKey`.

### CID Construction

All blocks use dag-cbor codec (0x71) with sha-256 hash (0x12). CID v1:

```ts
const bytes = dagCbor.encode(block)
const hash = await sha256.digest(bytes)
const cid = CID.createV1(0x71, hash) // 0x71 = dag-cbor codec
```

### CAR Format

CAR v1: varint(headerLen) + CBOR({ version: 1, roots: [commitCid] }) + for each block: varint(cidLen + dataLen) + cidBytes + dataBytes

The existing `encodeVarint()` helper at the bottom of handlers.ts can be reused.
