# Core Concepts

## Boundary

A **boundary** is a named access group. A viewer must belong to at least one
group named on a post to read it.

Each boundary has a full identifier made from the Stratos service DID and a
short name (`{serviceDid}/{name}`):

```text
did:web:stratos.example.com/general
did:web:stratos.example.com/writers
```

Operators configure short names such as `general` in
`STRATOS_ALLOWED_DOMAINS`. Stratos adds its DID. Apps must use the full
identifier when creating records.

## Enrollment

Enrollment is how a user joins a Stratos service with their AT Protocol account
through OAuth. Stratos records the user's boundaries and publishes a
`zone.stratos.actor.enrollment` record to their PDS. Apps can read that record
to find the Stratos service and verify the enrollment. Depending on whether
the PDS supports protected spaces, private posts are stored by Stratos or in
a protected space on the user's PDS.

## Source Field

For Stratos-hosted posts, Stratos does **not** write a separate public record
for each private post to the user's PDS. The public enrollment record lets
apps find the service.

When a client fetches the full content of a Stratos-hosted record through
`zone.stratos.repo.hydrateRecords`, the returned record carries a `source`
field identifying where it came from:

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

The `source` field lets an app check which service supplied the record and
fetch it again, subject to access checks. The app finds that service through
the user's enrollment record.

## Sync Stream

The `zone.stratos.sync.subscribeRecords` WebSocket endpoint sends updates for
Stratos-hosted records. The feed generator uses it to stay current and saves
its place so it can resume after a disconnect. For posts hosted in protected
PDS spaces, it checks Stratos membership before reading from the member's PDS.

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

Private records use an AT Protocol-compatible repository hosted by Stratos or,
for users with spaces support, by their PDS. For Stratos-hosted repositories,
these endpoints allow:

- Inclusion proofs: `com.atproto.sync.getRecord` returns a CAR with the signed commit, MST path, and
  record block.
- Full export: `zone.stratos.sync.getRepo` exports the complete repo as a CAR file.
- Import: `zone.stratos.repo.importRepo` imports a CAR into a fresh actor repo.

## Trust Model

Before returning private content, Stratos checks the caller's current
membership. The feed generator also checks membership before serving a feed.
Apps must not treat a boundary written inside a PDS-hosted post as permission.

The attestation serves a separate, complementary purpose: it is a public declaration written to the
user's PDS repo that lets any app verify independently that the user is enrolled with a specific
Stratos service. It binds the user's DID, assigned boundaries, and signing key into a signature from
the service's secp256k1 key.

<script setup>
</script>

<TrustChainAnimation />

The attestation shows that Stratos approved the enrollment; it is not a grant
to read posts. Access to feeds and records depends on current membership.
