# Boundary membership history

Stratos keeps authority-signed history of stored boundary membership changes.
Each actor has an independent sequence and hash chain in the service database.
Administrators can read that history through lexicon XRPC queries.

## Why this remains necessary

[Issue #15](https://github.com/NorthskySocial/stratos/issues/15) still applies.
Enrollment attestations sign a boundary snapshot during enrollment and publication.
They do not preserve every intervening membership change.
The repo oplog records creates, updates, and deletes of repository records.
It does not record authority decisions about boundary membership.

The issue's suggested path was to add signed boundary operations to each actor's repo oplog.
Mixed custody requires an adaptation.
A PDS-custody actor owns and signs their repository on their PDS.
Stratos cannot insert authority decisions into that repository as if the actor authorized them.
An actor's repository signature cannot authorize a boundary change.

We sequence boundary operations alongside the actor's repo history, in a separate authority log.
This preserves signed incremental replay without coordinating transactions across repository databases.
Boundary sequences and repository revisions are separate positions; there is no total order across them.

## Atomic capture

The central enrollment store captures `enroll`, `unenroll`, `updateEnrollment`, `setBoundaries`,
`addBoundary`, and `removeBoundary`.
Capture happens below OAuth, admin handlers, service reconciliation, and boundary lifecycle workers.
It includes inactive enrollments and retains history after unenrollment.

Each changed membership state commits these values in one service-database transaction:

- The stored enrollment and boundary rows.
- A signed operation containing the complete before and after states.
- The actor's next sequence and the hash of the preceding operation.

The state contains `enrolled`, `active`, and a sorted, unique `boundaries` array.
Metadata changes and repeated operations that leave this state unchanged produce no new signature or history row.
A signing or persistence failure rolls the entire membership mutation back.
There is no successful mutation waiting for a later signing worker.
Postgres locks the actor's audit head across processes; SQLite serializes transactions on its connection.

Existing rows are not rewritten during migration.
The first operation records their stored state as its `before` value.
That baseline proves the service's observation at the first audited mutation.
It does not reconstruct earlier history.

This log describes stored membership, not every effective access-policy decision.
Reserved domains can be included by policy before they are physically stored.
An inactive boundary definition can deny access before its lifecycle worker removes membership rows.
Keep evaluating current boundary policy when authorizing requests.

## Replay and recovery

Both endpoints require a current OAuth admin session cookie.
Ordinary user tokens, service tokens, and anonymous callers cannot read membership history.
No history endpoint is available through an unauthenticated discovery route.

| Query                                      | Parameters                           | Result                                                |
| ------------------------------------------ | ------------------------------------ | ----------------------------------------------------- |
| `zone.stratos.admin.listBoundaryOps`       | `did`, optional `limit` and `cursor` | `operations`, `cursor`, `hasMore`                     |
| `zone.stratos.admin.getBoundaryAuditState` | `did`                                | Signed `checkpoint`, `signature`, and resume `cursor` |

`limit` defaults to 50 and accepts integers from 1 through 100.
The cursor binds the actor DID, sequence, and operation hash.
Keep the final cursor after `hasMore` becomes false and use it for subsequent polling.
Applying an operation with an already-applied sequence is an idempotent replay.
Persist the accepted sequence and hash together with your local membership state.

```typescript
const params = new URLSearchParams({ did, limit: '50' })
if (cursor) params.set('cursor', cursor)

const response = await fetch(
  `/xrpc/zone.stratos.admin.listBoundaryOps?${params}`,
  { credentials: 'same-origin' },
)
```

Missing operations, invalid cursors, changed hashes, and invalid signatures fail closed.
The server returns `BoundaryHistoryTruncated` when it cannot prove a requested history window.
Read `getBoundaryAuditState`, verify its signature, and replace your local state with the checkpoint.
Resume incremental replay using the checkpoint's cursor.
The checkpoint binds a consistent state to its sequence and head hash.
The next signed operation binds its previous hash to the checkpoint, even after older rows are pruned.

Operations and audit heads are retained by default.
No API deletes audit history, and there is no automatic retention sweep.
An operator who archives or prunes old operation rows must preserve audit heads.
Recovery restores current state; it cannot recover deleted historical evidence.
Keep external copies when complete historical evidence matters.

## Verification and trust

An operation has type `zone.stratos.boundary.operation`.
Its signed payload contains the authority DID, actor DID, sequence, previous hash, timestamp,
signing key, and before and after states.
`hash` is the lowercase hexadecimal SHA-256 digest of the DAG-CBOR encoded operation.
`signature` is the service signature over those same bytes, encoded as base64.
The first operation has sequence 1 and an empty `previousHash`.

A checkpoint has type `zone.stratos.boundary.checkpoint`.
Its signed payload contains the authority DID, actor DID, sequence, head hash, timestamp, signing key,
and stored membership state.
An actor without audit operations has sequence 0 and an empty head hash.

Verify these properties before accepting history:

1. Establish that `signingKey` belongs to the expected Stratos authority.
   Use a trusted current DID document, authenticated service key history, or an operator-pinned key.
   A self-declared `did:key` is insufficient.
2. Encode the operation or checkpoint with DAG-CBOR and verify its signature.
3. Check the expected authority and actor DIDs.
4. For operations, verify the payload hash, consecutive sequence, previous hash, and matching before state.
5. For a checkpoint, bind its cursor position to the signed sequence and head hash.

Key rotation preserves earlier signatures and continues the hash chain with the new service key.
`recordedAt` is included in the signature and uses canonical UTC ISO timestamps.
It is the service's time claim, not an independent timestamp proof.
An exposed old key can sign backdated claims, so signatures do not replace compromise response or external checkpoints.

The log attributes the decision to the Stratos authority.
It does not identify the individual administrator or claim that the actor consented.
Raw database changes outside the central enrollment store are outside this audit contract.
