# Hydration Architecture

Stratos uses the _source field pattern_ to separate data storage from presentation. Full records
with boundary content are stored in Stratos; lightweight stub records on the user's PDS point back
to the full record.

## Source Field Pattern

When a user creates a record in Stratos, two writes happen:

1. Full record - stored in Stratos (with text content, boundary, etc.)
2. Stub record - written to the user's PDS with a `source` field

```typescript
interface RecordSource {
  vary: 'authenticated' | 'unauthenticated'
  subject: {
    uri: string // at:// URI of the full record in Stratos
    cid: string // CID of the full record for integrity verification
  }
  service: string // DID + fragment: "did:web:stratos.example.com#atproto_pns"
}
```

### Example

**Full record (in Stratos):**

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

**Stub record (on user's PDS):**

```json
{
  "$type": "zone.stratos.feed.post",
  "source": {
    "vary": "authenticated",
    "subject": {
      "uri": "at://did:plc:abc/zone.stratos.feed.post/tid123",
      "cid": "bafyreibeef..."
    },
    "service": "did:web:stratos.example.com#atproto_pns"
  },
  "createdAt": "2024-01-15T12:00:00.000Z"
}
```

## Hydration Flow

<script setup>
</script>

<AppviewHydration />

## Endpoint Discovery

AppViews and clients discover the Stratos service URL through the user's
`zone.stratos.actor.enrollment` record on their PDS:

> 1. Fetch enrollment record from users PDS repo
> 2. Each record has: { service: "https://stratos.example.com", ... }
> 3. Resolve service DID from: https://stratos.example.com/.well-known/did.json
> 4. Use service DID to hydrate records (validates source.service field matches)

The `source.service` field in stubs is a DID+fragment string, not a URL — the AppView resolves the
full URL by looking up the DID document.

## Hydration Model

Stratos `com.atproto.repo.getRecord` applies boundary access control:

| Scenario                               | Result               |
| -------------------------------------- | -------------------- |
| Caller enrolled + shares boundary      | Full record returned |
| Caller enrolled but different boundary | 404 (not visible)    |
| Caller not enrolled                    | 404                  |
| Unauthenticated (stub only)            | 404                  |

The 404 response for denied access is deliberate — it avoids leaking the existence of records to
unauthorized viewers.

## Trust Model

The `source.cid` in the stub allows AppViews to verify the hydrated record hasn't changed:

```typescript
// AppView verification after hydrating
if (hydratedRecord.cid !== stub.source.subject.cid) {
  throw new Error('Record CID mismatch — content may have been tampered with')
}
```

Combined with the enrollment attestation
system ([Enrollment Signing](/architecture/enrollment-signing)), this gives AppViews a complete
verification chain:

1. Stub CID on PDS matches hydrated record
2. Service attestation verifies user's boundary memberships were endorsed by the service
3. Record commits are signed with the user's P-256 key (enrolled key is in the attestation)
