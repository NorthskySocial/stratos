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

## importRepo re-signing with service key

The `importRepo` handler stores the original CAR blocks and commit verbatim, preserving the source signature. The original MST implementation plan called for rebuilding the MST from scratch and re-signing with `ctx.signingKey` so the imported repo is authoritative under the Stratos service's DID. Without re-signing, AppViews that verify commit signatures against the Stratos service DID document will fail verification on imported repos.

## Property-based tests for MST operations

`fast-check` is installed in both packages but unused. The MST implementation plan called for property-based tests covering: MST reflects current record state, commit signature round-trip, getRecord CAR proof completeness, MST determinism (confluence), write-then-delete round-trip, MST serialization round-trip, and import/export round-trip. The 330 deterministic tests cover the core paths but property tests would catch edge cases in key/CID distribution and ordering.

## Per-user signing key — sign collections with user key

**Done**: P-256 signing key generation and storage is implemented. At enrollment time, Stratos generates a P-256 keypair per user, stores the private key at `{dataDir}/actors/{prefix}/{did}/signing_key`, and publishes the public key (`did:key` format) plus a service attestation in the enrollment record on the user's PDS. The attestation is a DAG-CBOR payload (`{boundaries, did, signingKey}`) signed by the service's secp256k1 key. Attestations are regenerated on boundary changes and deleted on unenrollment. The `signingKeyDid` is cached in the enrollment table for efficient status lookups.

**Next**: Use the per-user P-256 key to sign repo commits instead of (or in addition to) the service-wide secp256k1 key. This enables user-level authorship verification — anyone can verify a commit was created by a specific user by checking the signature against the public key in their enrollment record. This also improves data portability: exported repos carry user signatures verifiable independently of the original Stratos service.

## Encryption at rest

The service signing key is stored as unencrypted raw bytes on disk at `{dataDir}/signing_key`. Per-actor SQLite databases in `{dataDir}/actors/` also store all record data, blob metadata, and repo blocks unencrypted. Anyone with filesystem access can read private key material and user data directly.

With PostgreSQL, encryption at rest can be offloaded to the database layer (e.g., TDE, encrypted volumes, or column-level encryption). SQLite has no built-in encryption support, so a solution is needed that covers the SQLite storage backend. The signing key file needs its own protection regardless of database backend.

## Facets support

`app.stratos.feed.post` should support facets (rich text annotations) like `app.bsky.feed.post` does. Facets enable mentions, links, and hashtags embedded in post text. This would involve:

- Adding a `facets` field to the post lexicon referencing `app.bsky.richtext.facet`
- Validating facet byte offsets against the text field
- Test coverage in `generate-posts.ts` for posts with mentions and link facets

## Video embed support

The `app.stratos.feed.post` lexicon already includes `app.bsky.embed.video` in its embed union, but the blob pipeline needs work to handle video:

- Video blob upload (larger files, different MIME types like `video/mp4`)
- Aspect ratio metadata
- Potentially a processing pipeline for transcoding or thumbnail generation
- Test coverage for video embed creation and round-trip verification

## Boundary gating on blob access

`com.atproto.sync.getBlob` needs the same boundary gating as record access. The recommended approach is record-boundary lookup:

- Look up which records reference the blob CID (via `stratos_record_blob` join table)
- For each referencing record, extract boundary domains from the record value
- Check if any of those boundary sets overlap with the viewer's boundaries
- If no overlap across all referencing records, deny access

Design considerations:
- **Owner bypass**: Repo owner always has access to their own blobs
- **Privacy**: Return `BlobNotFound` for both missing and unauthorized blobs (no information leakage about blob existence)
- **Orphan blobs**: Blobs with no record references are inaccessible to non-owners
- **Batch-aware optimization**: For AppView hydration of many posts, a future batch endpoint could accept multiple blob CIDs and a viewer DID, returning accessible blobs in one round-trip. This avoids N+1 queries when hydrating image-heavy feeds.
