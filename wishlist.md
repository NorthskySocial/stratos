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

## Signing key rotation and user migration

When a Stratos operator rotates their service signing key, all previously stored record attestation signatures become unverifiable against the new key. Risks:

- Clients verifying historical records via `sync.getRecord` will fail signature checks if only the current key is published in the DID document.
- Users migrating data to another Stratos instance would need re-signed attestations from the new operator's key.
- The integrity chain (`stratos_repo_root.digest` + `sig`) is also bound to the signing key — a rotation invalidates the entire chain unless the old key is retained for verification.

Options to explore:
- Retain old public keys in the DID document (`verificationMethod` array) with validity periods so verifiers can match key to attestation era.
- Store the service `did:key` identifier in each attestation so verifiers know which key to resolve.
- Provide a re-signing migration tool that updates all attestation sigs and recomputes the chain under the new key.

## Attestation boundary inclusion

Explore whether including the record's boundary domains in the attestation payload (alongside the CID which already covers them) provides meaningful benefit. Potential use case: verifiers could check boundary claims without decoding the full record. Likely low-value since the CID integrity check already covers all record content.

## Repo chain coverage for boundary mutations

The repo integrity chain currently only covers record mutations (create/update/delete) within the per-actor database. Boundary changes (setBoundaries, addBoundary, removeBoundary) go through the enrollment store in the service-wide database and are not included in the chain. Explore whether cross-database coordination is worth the complexity for full audit coverage.
