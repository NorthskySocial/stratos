# Repo Export & Import

## Current runtime and planned STAR migration

Stratos-custody repositories currently use MSTs. The owner-only
`zone.stratos.sync.getRepo` export returns `application/vnd.ipld.car` and retains
its legacy `since` parameter. A partial export is not a complete-state proof.
The import contract below is not implemented; do not treat the example or its
proposed constraints as an available recovery path.

Upstream PR 5705 at `232b2cdcec7a54a92d6e3c6461d07775d611d1ad` changes
`com.atproto.space.getRepo`, not this Stratos endpoint. Upstream now uses
`application/octet-stream` STAR-lite v1 (`2a6c0100`), framed metadata and ordered
path/record pairs to EOF, with no separate hash prefix. It takes only `space`
and `repo`, not `since`, `collection`, or `excludeValues`. A space credential
can recover one author's complete repo within that space; blobs are separate.

The [STAR architecture](../architecture/star-repository.md) plans a distinct
private actor profile and direct custody-service signature. It is not shipped,
not an upstream account proof, and not a replacement for current proof APIs yet.
The AiaB pin remains `79d6307e19908f3af406838ea0e5fae42847f182`; merged upstream
source does not establish live interoperability. Reader migration and rollback
gates must pass before CAR retirement. Independent public-repository proof support
remains separate from private MST removal.

## Verifying a Record (Inclusion Proof)

### Using `stratos-client` (recommended)

The `fetchAndVerifyRecord()` helper handles fetching, CAR parsing, and signature verification in a
single call:

```typescript
import {
  fetchAndVerifyRecord,
  verifyCidIntegrity,
  resolveServiceSigningKey,
} from '@northskysocial/stratos-client'

// Full verified fetch (fetches the CAR and verifies it)
const serviceKey = await resolveServiceSigningKey('did:web:stratos.example.com')
const verified = await fetchAndVerifyRecord(serviceUrl, did, collection, rkey, {
  serviceSigningKey: serviceKey,
})

// Or verify a CAR you already have (CID integrity only)
const result = await verifyCidIntegrity(carBytes, collection, rkey, did)
```

### Using raw XRPC

Request a verifiable CAR containing the signed commit, MST inclusion proof, and record block:

```typescript
async function getRecordProof(
  stratosEndpoint: string,
  accessToken: string,
  did: string,
  collection: string,
  rkey: string,
): Promise<Uint8Array> {
  const params = new URLSearchParams({ did, collection, rkey })
  const response = await fetch(
    `${stratosEndpoint}/xrpc/com.atproto.sync.getRecord?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!response.ok) throw new Error('Failed to get record proof')
  return new Uint8Array(await response.arrayBuffer())
}
```

The returned CAR contains:

1. **Signed commit** — the repo root with the custody service's per-actor P-256 signature.
2. **MST inclusion proof** — tree nodes proving the record exists in the repo.
3. **Record block** — the actual record data.

## Exporting a Repository

Export the full repository as a CAR file containing all records, MST nodes, and the signed commit:

```typescript
async function exportRepo(
  stratosEndpoint: string,
  accessToken: string,
  did: string,
  since?: string,
): Promise<Uint8Array> {
  const params = new URLSearchParams({ did })
  if (since) params.set('since', since)

  const response = await fetch(
    `${stratosEndpoint}/xrpc/zone.stratos.sync.getRepo?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!response.ok) throw new Error('Failed to export repo')
  return new Uint8Array(await response.arrayBuffer())
}
```

## Importing a Repository (planned, not implemented)

Import a previously exported CAR file. The caller must be enrolled and the CAR's commit DID must
match the authenticated user:

```typescript
async function importRepo(
  stratosEndpoint: string,
  accessToken: string,
  carBytes: Uint8Array,
): Promise<{ imported: number }> {
  const response = await fetch(
    `${stratosEndpoint}/xrpc/zone.stratos.repo.importRepo`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/vnd.ipld.car',
      },
      body: carBytes,
    },
  )
  if (!response.ok) {
    const err = await response.json()
    throw new Error(err.message ?? 'Import failed')
  }
  return response.json()
}
```

## Import Constraints

| Constraint    | Value                                    |
| ------------- | ---------------------------------------- |
| Max CAR size  | 256 MiB (configurable by operator)       |
| CID integrity | Verified for every block                 |
| Target repo   | Must not already have an existing commit |

The proposed import contract validates that the commit DID matches the authenticated user, then indexes all records
from the MST.
