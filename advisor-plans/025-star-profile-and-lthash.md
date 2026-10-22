# Plan 025: Freeze the internal STAR profile and LtHash codec

> **Executor instructions**: Work in `stratos-core` only unless a step says
> otherwise. Run each verification before proceeding. Report a STOP condition
> instead of choosing a different wire format.
>
> **Drift check (run first)**:
> `git diff --stat c6f879ad0183fac61a493426f3906ef9ae5997f2..HEAD -- stratos-core/src/repo stratos-core/src/atproto stratos-core/tests docs/architecture/star-repository.md`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plan 024
- **Category**: migration
- **Planned at**: commit `c6f879ad0183fac61a493426f3906ef9ae5997f2`, 2026-10-21

## Why this matters

STAR and LtHash are not in Stratos today. Every later plan depends on one
unambiguous encoder, one commitment algorithm, and one rejection contract.
Implementing these ad hoc in the service would allow the writer, exporter, and
feedgen to disagree while each looks correct in isolation.

Upstream PR 5705 merged at `232b2cdcec7a54a92d6e3c6461d07775d611d1ad`.
Use its finalized STAR-lite v1 framing, but a distinct internal actor profile.
The ADR's proposed direct custody-service signature is not upstream deniability.
Before implementation, the independent reviewer checks the proposed payload,
trust root and rotation vectors; the supervisor accepts that contract. Unresolved
key attestation transport blocks implementation. Roles are checkpoints, not
continuous supervision, and do not assign models.

## Current state

- No STAR or LtHash implementation exists in `stratos-core/src`.
- `stratos-core/src/atproto/index.ts` exports `encodeRecord`, `computeCid`, and
  `parseCid`. Reuse these; do not add a second record encoder.
- `stratos-core/package.json` already has `@atcute/cbor`, `@atcute/cid`, and
  `@atproto/lex-cbor`. `@noble/hashes@1.8.0` is present transitively but is not a
  direct dependency.
- The ADR's "Proposed internal actor profile and custody commitment" is normative
  for this proposed internal contract. Upstream sources are `packages/space/src/`
  at the merge above, not the obsolete local STAR-lite draft.

Repository conventions:

- kebab-case files, named exports, no default exports.
- Strict TypeScript. Prefer interfaces for public shapes.
- Tests in `stratos-core/tests/*.test.ts`, Vitest.
- No comments that restate code. Comments explain why.

## Chosen internal profile

Write this profile into the ADR before implementation. Values:

| Field           | Value                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------- |
| Magic           | `2a6c0100`                                                                                    |
| Framing         | framed metadata, then framed key/value pairs through EOF; no hash prefix                      |
| Metadata        | canonical DRISL, maximum 8,192 bytes                                                          |
| Metadata fields | `$type: zone.stratos.repo.star`, `version: 1`, `did`, `rev`, `hash`, `signer`, `keyId`, `sig` |
| Commitment      | 32-byte SHA-256 of the 2,048-byte LtHash state, in metadata `hash`                            |
| Data key        | UTF-8 `collection/rkey`, maximum 1 KiB                                                        |
| Data value      | canonical DRISL plain-map record, maximum 1,048,576 bytes                                     |
| Ordering        | strictly increasing key bytes, not CBOR length-first order                                    |

Sign exactly the canonical metadata map without `sig`, using the ADR's
P-256/SHA-256, low-S, 64-byte IEEE-P1363 contract. The complete metadata's
CIDv1 dag-cbor/sha2-256 is the flat commit CID. It is not a metadata field.
Authenticate the expected custody service and its actor key attestation independently;
archive-supplied keys are not trust roots. No `space`, `ikm`, `mac`, or nested
`commit`. Do not claim user DID proof or Spaces signing interoperability.

Generic STAR limits upstream are 64 MiB metadata/key and 64 GiB value; this
private profile deliberately lowers them. Varints are shortest-form unsigned,
at most six bytes. Share framing and LtHash vectors with 031, not metadata or
signature vectors: 031 decodes `atproto-space-repo`.

LtHash:

1. Element bytes: UTF-8 of `{collection}/{rkey}/{record_cid}`, where
   `record_cid` is the lowercase base32 CID string.
2. Expand with BLAKE3 XOF to 2,048 bytes.
3. Interpret 1,024 little-endian `u16` lanes.
4. Add or subtract each lane modulo 65,536. Insertions are not idempotent.
5. Serialize 1,024 little-endian `u16` lanes; commitment is SHA-256 of that
   state.

## Commands you will need

| Purpose        | Command                                                | Expected                                         |
| -------------- | ------------------------------------------------------ | ------------------------------------------------ |
| Install        | `pnpm install --frozen-lockfile`                       | exit 0 (update lock only if adding a dependency) |
| Core tests     | `pnpm --filter @northskysocial/stratos-core test`      | all pass                                         |
| Core typecheck | `pnpm --filter @northskysocial/stratos-core typecheck` | exit 0                                           |
| Lint           | `pnpm run lint`                                        | exit 0                                           |
| Format         | `pnpm exec prettier --check .`                         | exit 0                                           |

## Scope

**In scope**:

- `stratos-core/src/repo/star/profile.ts` (create)
- `stratos-core/src/repo/star/lthash.ts` (create)
- `stratos-core/src/repo/star/archive.ts` (create)
- `stratos-core/src/repo/star/index.ts` (create)
- `stratos-core/src/repo/index.ts`
- `stratos-core/package.json`, `pnpm-lock.yaml` (only for a BLAKE3 dependency)
- `stratos-core/tests/star-lthash.test.ts` (create)
- `stratos-core/tests/star-archive.test.ts` (create)
- `stratos-core/tests/fixtures/star/` (create vectors)
- `docs/architecture/star-repository.md` (profile section only)
- `advisor-plans/README.md` (status row only)

**Out of scope**:

- Database schema, repository state, write paths, endpoints, feedgen.
- Upstream proposal PR 114 wire compatibility.
- Spaces metadata, credentials, signing redesign, per-space partitioning.
- Runtime performance claims.

## Git workflow

- Branch: `advisor/025-star-profile-and-lthash`
- One implementation PR. Do not commit plan files.
- Do not push or open a PR without explicit authorization.

## Steps

### Step 1: Prove the BLAKE3 XOF implementation

`@noble/hashes` must expose BLAKE3 extendable output. Add it as a direct
dependency only after a test proves the exact byte output for a known vector.

Create a temporary test in `stratos-core/tests/star-lthash.test.ts` that:

- hashes `""` and `"abc"` with BLAKE3 XOF to 2,048 bytes;
- compares against vectors produced by the local Rust reference or another
  reviewed implementation;
- documents the command and source used to produce each vector.

If the installed library cannot produce BLAKE3 XOF, STOP. Do not substitute
SHA-256 or concatenated BLAKE3 output.

**Verify**: `pnpm --filter @northskysocial/stratos-core test -- star-lthash` →
vector cases pass.

### Step 2: Implement LtHash

Create `stratos-core/src/repo/star/lthash.ts` with:

```ts
export const LTHASH_STATE_BYTES = 2048
export const LTHASH_LANES = 1024

export function emptyLtHashState(): Uint8Array
export function addLtHashEntry(
  state: Uint8Array,
  path: string,
  cid: string,
): void
export function removeLtHashEntry(
  state: Uint8Array,
  path: string,
  cid: string,
): void
export function ltHashCommitment(state: Uint8Array): Uint8Array
```

Requirements:

- Mutating functions reject a state whose length is not 2,048.
- They reject a path that is not `{collection}/{rkey}` with exactly one slash.
- They reject a CID that is not a canonical lowercase base32 CID string.
- Add and remove are exact inverses for one entry.
- Applying entries in different order produces the same state.
- Applying the same entry twice is deliberately allowed by the primitive; the
  archive layer is responsible for uniqueness. Test that behavior explicitly.

**Verify**: `pnpm --filter @northskysocial/stratos-core test -- star-lthash` and
`pnpm --filter @northskysocial/stratos-core typecheck` → exit 0.

### Step 3: Implement the archive codec

Create `stratos-core/src/repo/star/archive.ts` exposing:

```ts
export interface StarEntry {
  path: string
  cid: string
  bytes: Uint8Array
}

export interface StarRepository {
  $type: 'zone.stratos.repo.star'
  version: 1
  did: string
  rev: string
  hash: Uint8Array
  signer: string
  keyId: string
  sig: Uint8Array
}

export function encodeStarArchive(input: {
  repository: StarRepository
  entries: AsyncIterable<StarEntry> | Iterable<StarEntry>
  signal?: AbortSignal
}): AsyncIterable<Uint8Array>

export async function decodeStarArchive(
  input: AsyncIterable<Uint8Array> | Uint8Array,
  options: { maxBytes?: number },
): Promise<{
  repository: StarRepository
  entries: StarEntry[]
  commitment: Uint8Array
}>
```

Encode rules:

- Write magic, varint metadata length, metadata bytes; then framed path/record pairs.
- Metadata is canonical DRISL. Use `@atcute/cbor`/`@atproto/lex-cbor`; do not
  hand-roll map ordering.
- Use an authenticated commitment from the same stable snapshot in metadata.
  Recompute while streaming and compare at EOF. If no commitment exists, first
  compute/sign it with a bounded spool or two passes over the SAME snapshot.
- Reject an entry whose record bytes do not hash to the supplied CID.
- Reject duplicate or out-of-order paths.

Decode rules:

- Reject unknown magic, unsupported profile `$type`, incorrect commitment length,
  metadata over 8,192 bytes, key over 1 KiB, record over 1,048,576 bytes, non-canonical varints,
  truncated data, duplicates, unordered keys, and commitment mismatch.
- Apply a total byte limit supplied by the caller; default to a documented finite
  limit, not unlimited.
- Require canonical metadata and internal record re-encoding; compute CIDs from raw bytes.
- Never return a partially decoded repository; only EOF completes verification.
- Test signature tampering for every bound field and untrusted/rotated key rejection.

Use `AbortSignal` to stop iteration.

**Verify**: focused Star archive tests pass; typecheck exits 0.

### Step 4: Add cross-language vectors and ADR text

Commit fixed fixtures under `stratos-core/tests/fixtures/star/`:

- empty repository;
- one record;
- two records inserted in both orders;
- replacement (remove old CID, add new CID);
- delete-to-empty;
- non-ASCII path rejection;
- duplicate and out-of-order archives;
- truncated header, metadata, varint, and record;
- commitment mismatch.

Each fixture is a small JSON file with hex bytes and the expected result. Record
the source implementation, revision, and generation command in a README beside
the fixtures. A vector must not be generated by the code under test alone.

Add the frozen profile and vector location to
`docs/architecture/star-repository.md`. State that this is not the Spaces profile
and is not certified against proposal 114.

**Verify**: `pnpm --filter @northskysocial/stratos-core test -- star` → all pass.
`pnpm exec prettier --check .` → exit 0.

## Test plan

- `star-lthash.test.ts`: order independence, add/remove inversion, non-idempotent
  duplicate add, lane overflow modulo 65,536, invalid state length, invalid
  path/CID.
- `star-archive.test.ts`: all encode/decode vectors, interruption via abort,
  total-byte limits, no partial result after failure.
- Model structural tests after `stratos-core/tests/repo-export.test.ts`.
- Verification: `pnpm --filter @northskysocial/stratos-core test` → all pass.

## AiaB gate (required at the end)

Run the mandatory real sandbox baseline on the reviewed candidate:

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir /home/evelyn/git/northsky/ops/sandbox/atmosphereinabox \
  --source "$(git rev-parse --show-toplevel)" \
  --suite baseline \
  --review-receipt "$REVIEW_RECEIPT" \
  --report-dir "$NEW_REPORT_DIR"
```

Expected: `baseline` with nonzero assertions, zero failures/skips, exact reviewed
candidate, cleanup passed. This proves the new codec did not disturb existing
behavior. No new suite is required because the codec is not yet reachable from a
production endpoint.

## Done criteria

- [ ] Profile, commitment algorithm, and rejection limits are documented.
- [ ] LtHash and STAR vectors pass, including cross-language fixtures.
- [ ] No partial archive is returned on any parse or digest failure.
- [ ] Codec is exported from `stratos-core` and has no service dependency.
- [ ] Core tests, core typecheck, lint, and Prettier pass.
- [ ] AiaB baseline passes on the reviewed candidate.
- [ ] No files outside scope are modified.

## STOP conditions

- BLAKE3 XOF is unavailable or produces different bytes than the reviewed
  reference.
- The profile cannot be represented with the existing DRISL encoders without
  reimplementing canonical encoding.
- A vector requires a decision about signed metadata, Spaces `space-ref`, or
  proposal 114 that this plan does not settle.
- Any verification fails twice after a reasonable in-scope fix.

## Maintenance notes

- Any change to magic, metadata fields, element construction, or lane width is a
  format break. Version it; do not edit vectors in place.
- Plan 026 consumes these APIs. If the codec's streaming interface changes,
  update the storage adapter and export tests together.
- Do not add Spaces metadata here. The follow-up translator must recompute a
  subset commitment; it cannot reuse an actor commitment.
