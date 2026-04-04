# Repo Export & Import

Stratos repos are Merkle Search Trees which provides "feature parity" with the PDS. You can export a
full repo as a CAR file and import it into another service.

::: warning Note: Not yet implemented
:::

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

1. **Signed commit** — the repo root with the service's secp256k1 signature.
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

## Importing a Repository

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
| PDS stubs     | Not created on import                    |

The import validates that the commit DID matches the authenticated user, then indexes all records
from the MST.
