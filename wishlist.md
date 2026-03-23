# Wishlist

Living in code so making a doc of things to address:

## Exclusive open enrollment

Open enrollment should have the possibility to allow automatic enrollment to specific domains.

If stratos allow apple, berry, tomato open enrollment should be set to auto enroll to one or more of them.

## Allow List - User List

Have the option of referencing a user list for allow list so we don't have to maintain a did collection ourselves. For the did collection option, maybe give it a friendly name and we dump it into valkey but use it specifically for bootstrapping? Otherwise we're reloading the service every time it is updated.

## Verify user membership

Appview is checking the record in a users collection to see what their endpoint and membership is. Are we verifying this against stratos?

## applyWrites atomicity

The `com.atproto.repo.applyWrites` handler processes create/update/delete operations sequentially, each in its own `actorStore.transact()` call. If an operation in the middle of the batch fails, earlier operations are already committed and their PDS stubs are already written.

Should wrap the entire batch in a single `actorStore.transact()` call and defer PDS stub writes until all local writes succeed. Stub writes are already non-critical (failure logged as warning), but the local store should be atomic.

With MST verification in place this gap is more visible: each partial commit is now a fully signed, externally observable repo state. A failed batch leaves the repo at an intermediate signed commit rather than rolling back cleanly.

## Lazy inter-service verification on import

When a user imports a CAR from another Stratos service, the destination service could attempt to contact the source service (discovered from the CAR's commit `did` field via the user's enrollment record on their PDS) to verify the commit signature is authentic. If the source service is unreachable or uncooperative, the import proceeds with a warning rather than failing — preserving portability in the hostile service case while still providing a signal when verification is possible.

This would open the door for operators to optionally enforce strict inter-service verification as a policy (e.g., reject imports where the source service is reachable but refuses to confirm the signature). Tracked as a note in the mst-verification requirements.

## ~~importRepo re-signing with service key~~

**Done**: The `importRepo` handler now re-signs incoming commits with the user's per-enrollment P-256 key. The original commit block is discarded, a new `UnsignedCommitData` is built from the original MST root CID and rev, and the commit is signed with the user's key. This makes imported repos verifiable against the user's enrollment record.

## Property-based tests for MST operations

`fast-check` is installed in both packages but unused. The MST implementation plan called for property-based tests covering: MST reflects current record state, commit signature round-trip, getRecord CAR proof completeness, MST determinism (confluence), write-then-delete round-trip, MST serialization round-trip, and import/export round-trip. The 330 deterministic tests cover the core paths but property tests would catch edge cases in key/CID distribution and ordering.

## Per-user signing key — sign collections with user key

**Done**: All record commits (create, update, delete, batch writes) are signed with the actor's per-enrollment P-256 key. The service Secp256k1 key is used as a fallback when a user's key is not yet available (forward-only migration — existing commits are not re-signed). `importRepo` re-signs incoming commits with the user's P-256 key so imported repos are verifiable against the user's enrollment record.

The client library (`stratos-client`) supports a `'user-signature'` verification level: `resolveUserSigningKey()` extracts the user's public key from their enrollment attestation, and `fetchAndVerifyRecord()` prefers it over the service key when verifying records.

## Encryption at rest

The service signing key is stored as unencrypted raw bytes on disk at `{dataDir}/signing_key`. Per-actor SQLite databases in `{dataDir}/actors/` also store all record data, blob metadata, and repo blocks unencrypted. Anyone with filesystem access can read private key material and user data directly.

With PostgreSQL, encryption at rest can be offloaded to the database layer (e.g., TDE, encrypted volumes, or column-level encryption). SQLite has no built-in encryption support, so a solution is needed that covers the SQLite storage backend. The signing key file needs its own protection regardless of database backend.
