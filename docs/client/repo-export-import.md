# Repo Export & Import

A user can export their whole Stratos repository as one CAR file. It holds
every record, the tree that indexes them, and a signed commit on top.

This page applies to `stratos` custody, where Stratos hosts the repo. A
`pds`-custody user's repo is on their own PDS.

## Status

| Feature                                           | Status                            |
| ------------------------------------------------- | --------------------------------- |
| Export, `zone.stratos.sync.getRepo`               | Served. Repo owner only.          |
| Import, `zone.stratos.repo.importRepo`            | Defined as a lexicon. Not served. |
| Single-record proof, `com.atproto.sync.getRecord` | Not served.                       |

## Exporting a repository

`zone.stratos.sync.getRepo` returns the full repo as a CAR file. It needs the
user's DPoP session, and the caller must own the repo:

```typescript
import type { OAuthSession } from '@atproto/oauth-client-browser'

async function exportRepo(
  session: OAuthSession,
  stratosUrl: string,
  since?: string,
): Promise<Uint8Array> {
  const url = new URL('/xrpc/zone.stratos.sync.getRepo', stratosUrl)
  url.searchParams.set('did', session.sub)
  if (since) url.searchParams.set('since', since)

  const response = await session.fetchHandler(url.href, { method: 'GET' })
  if (!response.ok) throw new Error(`Export failed (${response.status})`)
  return new Uint8Array(await response.arrayBuffer())
}
```

| Parameter | Required | Description                                         |
| --------- | -------- | --------------------------------------------------- |
| `did`     | Yes      | The repo to export. Must equal the caller's DID.    |
| `since`   | No       | A revision. Only blocks newer than it are returned. |

The response has content type `application/vnd.ipld.car`.

A request for another user's repo answers HTTP 400 with `RepoNotFound`. So
does a DID with no Stratos-hosted repo. The owner-only rule stops a viewer
from copying records in boundaries they do not hold.

## Verifying records in an export

The CAR holds a signed commit. For `stratos` custody, Stratos signs each
commit with the user's P-256 key. That key is the `signingKey` in the user's
enrollment record.

`verifyCidIntegrity` checks one record against the commit tree without a
signature check:

```typescript
import { verifyCidIntegrity } from '@northskysocial/stratos-client'

async function checkRecord(
  carBytes: Uint8Array,
  userDid: string,
  rkey: string,
) {
  // Throws when the record is missing or the tree does not match.
  return verifyCidIntegrity(carBytes, 'zone.stratos.feed.post', rkey, userDid)
}
```

The result has `level: 'cid-integrity'`.

`verifyStratosRecord` takes the same CAR and a service DID. It resolves the
service's signing key and checks the commit signature against it:

```typescript
import { verifyStratosRecord } from '@northskysocial/stratos-client'

async function checkRecordWithServiceKey(
  carBytes: Uint8Array,
  userDid: string,
  rkey: string,
) {
  return verifyStratosRecord(
    carBytes,
    userDid,
    'zone.stratos.feed.post',
    rkey,
    'did:web:stratos.example.com',
  )
}
```

`verifyStratosRecord` checks against the service key only. A commit signed
with the user's P-256 key does not pass that check, and the call throws. For
a current Stratos export, use `verifyCidIntegrity`.

## Importing a repository

The `zone.stratos.repo.importRepo` lexicon describes a CAR import into an
empty repo. The Stratos service does not register a handler for it. A call
fails. Do not build on it yet.

To move many records into Stratos today, write them with
`com.atproto.repo.applyWrites` and respect the write rate limit.
