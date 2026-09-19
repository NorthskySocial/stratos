# Service signing key history

Stratos keeps its existing `did:web` identifier when its service signing key rotates.
`zone.stratos.identity.getKeyHistory` publishes the service's public signing history as a lexicon XRPC query.
The service starts with one genesis entry and adds one entry for each authorized rotation.
Per-actor repo keys and MST commits are separate. Service key rotation does not re-sign those records.

## Trust and signatures

The design borrows hash chaining and authorized updates from [did:webvh](https://didwebvh.info/latest/).
It does not implement that DID method. It does not use a SCID, witnesses, portability, or optional pre-rotation commitments.

Each entry contains `versionId`, `key`, `validFrom`, `previousVersionId`, `proof`, and `acceptance`.
The envelope contains `serviceDid` and an ordered `entries` array.

1. Encode `{type: "zone.stratos.identity.keyHistory", serviceDid, key, validFrom, previousVersionId}` as DAG-CBOR.
2. Compute SHA-256 over those bytes. `versionId` is the one-based version number, a hyphen, and the lowercase hexadecimal digest.
3. Sign DAG-CBOR `{type, purpose: "authorize", versionId, entry}` with the previous entry's key. `entry` is the encoded bytes from step 1.
4. Sign the same structure with `purpose: "accept"` using the new entry's key.
5. Store these signatures as standard Base64 in `proof` and `acceptance`.

Genesis uses `previousVersionId: null` and signs both proofs with its own key.
Keys cannot recur. Timestamps use canonical UTC with milliseconds and increase strictly.
The current DID document's `#atproto` key must match the final history key.

**The new-key acceptance signature corrects a gap in the original proposal.**
A previous-key signature alone does not authenticate the history against its final key.
An attacker can authorize a rotation from their own key to the real service's public key without possessing that key.
Requiring the new key to sign the exact entry prevents that forged parallel history.

The current DID document remains the root of trust. A compromised current private key or compromised DID hosting can authorize false history.
Without an external witness or pinned prior checkpoint, clients cannot detect a controller rewriting its entire history.
A signed issue time is a claim by the signing service, not independent timestamp evidence.
A stolen retired key can backdate a forged attestation into that key's validity window.
Operators must protect and retire private keys accordingly; this log is not a revocation or external timestamp service.

## Client verification

Supply the expected service DID from trusted application configuration. Do not infer trust from an enrollment's embedded signing key or endpoint.

```typescript
import { verifyEnrollmentAttestation } from '@northskysocial/stratos-client'

const result = await verifyEnrollmentAttestation(enrollment, userDid, {
  serviceDid: 'did:web:stratos.example.com',
})
if (!result.valid)
  throw new Error(result.error ?? 'Invalid enrollment attestation')
```

The client resolves the current DID document on each attestation check, even when a CAR-verification key cache is provided.
When the embedded key equals the current key, it verifies the signature without fetching history.
Otherwise it fetches history from the DID document's `#stratos` service endpoint, verifies every hash and both proofs, and checks the current-key anchor.
History fetches require HTTPS, reject credentials and redirects, have a ten-second timeout, and cap response bodies at two megabytes.
The log contains at most 1,024 entries. Server-side callers must supply a network-policy-enforcing `fetchFn` when service DIDs are untrusted.

The historical key must cover the signed `attestation.issuedAt` in its `[validFrom, nextValidFrom)` interval.
New attestations sign DAG-CBOR `{boundaries, did, signingKey, issuedAt}` with sorted boundary strings.
Legacy attestations omit `issuedAt` from both the record and signed payload. They remain valid only while their key is current.
The enrollment's unsigned `createdAt` cannot replace a signed issue time.
Refresh legacy enrollment records through the existing enrollment/PDS synchronization flow before retiring their service key.
History cannot reconstruct rotations or signed timestamps that were never recorded.

`resolveServiceSigningKey(serviceDid, {attestation: {signingKey, issuedAt}})` exposes the same authenticated key resolution.
Calls without `attestation` retain their current-key behavior. Historical keys are not cached as current keys.

## Durable storage and local rotation

On first startup, Stratos imports the existing raw `signing_key` without changing its public key.
Fresh installations create that key and a genesis entry.
The active key and history then live together in `{dataDir}/service-signing-identity.json`, with file mode `0600`.
This private bundle is the authoritative identity after migration. The public XRPC response contains only its history.
Changes to the old `signing_key` file no longer rotate the service.
Back up the bundle securely with the rest of the service data, for either SQLite or Postgres deployments.

Each write creates and fsyncs a private temporary file, atomically renames it over the bundle, then fsyncs the directory.
A rotation cannot publish history and its active private key separately.
Startup rejects invalid chains, a different service DID, or an active key that does not match the history head.
Do not restore an older identity bundle after publishing a rotation: that rolls back the current trust anchor.

The supported service runtime is Linux with the `flock` utility installed; the Docker image includes Alpine's `flock` package.
Use a local filesystem that supports POSIX file locking, atomic rename, and directory fsync for the identity directory, including when enrollment storage uses Postgres.
Network filesystems without these semantics are unsupported.
The service holds an exclusive kernel lock on `{dataDir}/service-signing-identity.lock` for its lifetime.
A short `flock` helper locks the inherited file descriptor; the service retains that descriptor after the helper exits.
The offline rotation command obtains the same lock and refuses to run while it is held.
Closing the descriptor or process death, including `SIGKILL`, releases ownership automatically, so a crash does not require manual lock cleanup.
The empty lock file remains on disk deliberately. Never unlink it: replacing its inode would allow two processes to hold different locks.
Missing `flock` or failed locking aborts startup and rotation before identity changes.
See the [util-linux descriptor-lock documentation](https://github.com/util-linux/util-linux/blob/master/sys-utils/flock.1.adoc) for the kernel ownership semantics.

To rotate locally:

1. Back up the private identity bundle securely and prepare a new, exportable secp256k1 private key file in the same raw format as the original `signing_key`.
2. Stop all Stratos processes using that data directory. Keep the old private key available until the update is signed.
3. Run the installed command with file paths, not private key material in arguments:

   ```sh
   stratos-rotate-service-key /var/lib/stratos did:web:stratos.example.com /secure/next-signing-key
   ```

4. Start Stratos with the same service DID and data directory. Its DID document publishes the new key automatically.
5. Check the public history query and a newly signed enrollment attestation. Retain the public history permanently.

The command signs authorization with the current key and acceptance with the supplied new key, then commits both atomically.
It never prints private key material. The original identifier, enrollments, and per-actor repo signing keys remain unchanged.
There is no remote rotation API or admin-interface rotation control.

This history verification applies to attestations. Existing JWT and space-credential validators continue to use the current signing key.
Previously issued credentials can require refresh after rotation, and other DID consumers may retain a cached key until their normal refresh.
