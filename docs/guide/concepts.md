# Core Concepts

## Boundary

A **boundary** is an access-control scope. Records carry one or more boundary values; a viewer must share at least one boundary with a record to access it.

Boundary values are addressable in `{serviceDid}/{name}` format:

```
did:web:stratos.example.com/general
did:web:stratos.example.com/writers
```

The bare name (e.g. `general`) is what operators configure in `STRATOS_ALLOWED_DOMAINS`. At startup the service qualifies each name with its own DID. Clients must send the fully-qualified form when creating records.

## Enrollment

Enrollment is the process of a user registering with a Stratos service. It happens via ATprotocol OAuth. On successful enrollment the service:

1. Initialises a per-user repo (empty signed commit + MST).
2. Generates a P-256 signing keypair for the user.
3. Creates a service attestation (DAG-CBOR payload signed by the service secp256k1 key).
4. Writes a `zone.stratos.actor.enrollment` record to the user's PDS.

The enrollment record on the PDS is the public anchor for discovery: any AppView or client can read it to find the Stratos endpoint and verify the user's boundaries.

## Stub Record

When a user creates a Stratos record, the service also writes a **stub record** to the user's PDS. The stub contains only a `source` field pointing back to Stratos:

```json
{
  "$type": "zone.stratos.feed.post",
  "source": {
    "vary": "authenticated",
    "subject": {
      "uri": "at://did:plc:abc/zone.stratos.feed.post/tid123",
      "cid": "bafyre..."
    },
    "service": "did:web:stratos.example.com#atproto_pns"
  },
  "createdAt": "2024-01-15T12:00:00.000Z"
}
```

AppViews detect the `source` field and call `getRecord` at the Stratos service to hydrate the full content, subject to boundary checks.

## Sync Stream

The `zone.stratos.sync.subscribeRecords` WebSocket endpoint emits a commit event for every record write in a user's repo. This is the same pattern as the ATProto PDS firehose, but scoped per-actor and protected by service auth.

AppViews subscribe once per enrolled user and maintain a cursor to resume after disconnects.

## Profile Record

The `zone.stratos.actor.enrollment` record on the user's PDS is the **profile record**. It contains:

| Field         | Description                              |
| ------------- | ---------------------------------------- |
| `service`     | Stratos service endpoint URL             |
| `boundaries`  | User's boundary assignments              |
| `signingKey`  | User's P-256 public key (did:key)        |
| `attestation` | Service attestation (DAG-CBOR signature) |
| `createdAt`   | Enrollment timestamp                     |

## MST Repo

Every enrolled user gets a per-user MST repository compatible with the ATProto PDS repo format. Every record write produces a new signed commit, enabling:

- Inclusion proofs: `com.atproto.sync.getRecord` returns a CAR with the signed commit, MST path, and record block.
- Full export: `zone.stratos.sync.getRepo` exports the complete repo as a CAR file.
- Import: `zone.stratos.repo.importRepo` imports a CAR into a fresh actor repo.

## Trust Model

Boundary access is enforced internally — when a request arrives, Stratos validates the caller's actual current membership before returning any content. No enforcement is delegated to a client or AppView (though it is encouraged).

The attestation serves a separate, complementary purpose: it is a public declaration written to the user's PDS repo that lets any app verify independently that the user is enrolled with a specific Stratos service. It binds the user's DID, assigned boundaries, and signing key into a signature from the service's secp256k1 key.

<script setup>
import TrustChainAnimation from '../.vitepress/theme/components/TrustChainAnimation.vue'
</script>

<TrustChainAnimation />

The attestation proves service endorsement of the enrollment and enables user authorship verification on individual records. Actual access to create/access content is always gated by Stratos's live boundary check.
