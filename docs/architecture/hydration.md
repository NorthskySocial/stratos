# Hydration Architecture

<script setup>
import AppviewHydration from '../.vitepress/theme/components/AppviewHydration.vue'
</script>

A feed is a list of addresses. An app holds a list of `at://` URIs and needs
the posts behind them. Hydration is the trip to the counter: the app hands
Stratos the addresses, shows who is asking, and receives only the posts that
person may read.

This page describes records that Stratos hosts. A member with a
spaces-capable PDS keeps their records on that PDS instead. See
[Permissioned Spaces](/architecture/permissioned-spaces) for those reads.

## One write, one place

When a member creates a record, Stratos stores the full record in that
member's repository on Stratos. Nothing is written to the member's PDS on the
record path. No public stub or pointer record exists.

The only thing Stratos publishes to a member's PDS is the
`zone.stratos.actor.enrollment` record. That record tells apps where the
member's Stratos service is.

```json
{
  "$type": "zone.stratos.feed.post",
  "text": "Private message for my community",
  "boundary": {
    "values": [{ "value": "did:web:stratos.example.com/fanart" }]
  },
  "createdAt": "2024-01-15T12:00:00.000Z"
}
```

A record carries exactly one boundary.

## Hydration flow

<AppviewHydration />

1. The app reads the member's enrollment record from the member's PDS.
2. The record's `service` field names the Stratos service URL.
3. The app sends the record URIs to that service, with the viewer's
   credential.
4. Stratos checks the viewer's boundaries and returns the records the viewer
   may read.

## Endpoints

| Endpoint                           | Type      | Use                                    |
| ---------------------------------- | --------- | -------------------------------------- |
| `zone.stratos.repo.hydrateRecord`  | Query     | One record by `uri`                    |
| `zone.stratos.repo.hydrateRecords` | Procedure | Up to 100 records in one call          |
| `com.atproto.repo.getRecord`       | Query     | One record, standard AT Protocol shape |

### Single record

`hydrateRecord` takes a `uri` and an optional `cid`. It returns the record:

```json
{
  "uri": "at://did:plc:abc/zone.stratos.feed.post/tid123",
  "cid": "bafyreibeef...",
  "value": {
    "$type": "zone.stratos.feed.post",
    "text": "Private message for my community",
    "boundary": {
      "values": [{ "value": "did:web:stratos.example.com/fanart" }]
    },
    "createdAt": "2024-01-15T12:00:00.000Z"
  }
}
```

The response has three fields: `uri`, `cid`, and `value`. Stratos adds no
`source` field.

| Error            | Meaning                                              |
| ---------------- | ---------------------------------------------------- |
| `RecordNotFound` | No record exists at that URI                         |
| `RecordBlocked`  | The record exists, and the viewer shares no boundary |

### Batch

`hydrateRecords` takes a `uris` array of at most 100 entries. It returns three
lists:

- `records`: the records the viewer may read.
- `blocked`: URIs the viewer may not read.
- `notFound`: URIs with no record.

### What a denied read reveals

The two hydration endpoints say that a blocked record exists.
`com.atproto.repo.getRecord` does not. It returns HTTP 400 `RecordNotFound`
for a missing record and for a record the viewer may not read:

| Caller                                    | `getRecord` result        |
| ----------------------------------------- | ------------------------- |
| Enrolled and shares the record's boundary | The record                |
| Enrolled in a different boundary          | HTTP 400 `RecordNotFound` |
| Anonymous                                 | HTTP 400 `RecordNotFound` |

Use `getRecord` when existence itself must stay hidden.

## Viewer identity

The viewer comes strictly from the authenticated credential. The hydration
endpoints accept no viewer DID from the request, so a caller cannot widen
their access by naming someone else.

Hydration accepts two kinds of credential:

- **A member's OAuth access token with DPoP.** Stratos resolves that member's
  current boundaries.
- **A space credential.** Visibility is limited to the boundary of that one
  space.

The same rule covers service identities. A service reads only within its own
boundaries.

## Finding the service

Apps find a member's Stratos service through the member's
`zone.stratos.actor.enrollment` record:

1. List the enrollment records in the member's PDS repository.
2. Read the `service` URL from the record for the expected service.
3. Call that service.

`@northskysocial/stratos-client` does this with `discoverEnrollments` and
`getEnrollmentByServiceDid`. Supply the expected service DID from your own
configuration. Do not trust a service only because a record names it.

## Trust model

The `cid` in a hydration response lets an app check that the content matches
its address:

```typescript
import { verifyRecordCid } from '@northskysocial/stratos-client'

// Encodes the value as DAG-CBOR again and compares the CID.
await verifyRecordCid(hydrated.value, hydrated.cid)
```

Know the limit of this check. The value and the CID come from the same
response. Matching them proves the response is internally consistent. It does
not prove who wrote the record.

Stratos does not serve per-record inclusion proofs. There is no
`com.atproto.sync.getRecord` on the service. Two stronger checks exist:

- **The repository owner** can export their full repository with
  `zone.stratos.sync.getRepo`. The export contains the signed commit and the
  tree.
- **Any app** can verify the enrollment attestation. It proves that the
  service endorsed the member, their boundaries, and their signing key. See
  [Enrollment Signing](/architecture/enrollment-signing).

An app that hydrates over TLS from a service DID it trusts relies on that
service for record authenticity.
