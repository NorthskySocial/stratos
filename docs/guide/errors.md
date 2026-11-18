# Error Reference

## Error Structure

Stratos returns standard XRPC errors.

```json
{
  "error": "ForbiddenBoundary",
  "message": "Boundary 'did:web:stratos.example.com/writers' not allowed"
}
```

Most rejections use HTTP 400 with a specific `error` name. The exceptions
are authentication (401) and rate limiting (429).

## Authentication

| Error                    | Status | Meaning                                                                    |
| ------------------------ | ------ | -------------------------------------------------------------------------- |
| `AuthenticationRequired` | 401    | No valid DPoP-bound session. Also sent when a fresh DPoP nonce is needed.  |
| `NotEnrolled`            | 400    | The caller's identity is valid, but they are not enrolled with the service |

Stratos accepts `Authorization: DPoP <token>` with a `DPoP` proof header. A
`Bearer` token is not a valid user credential.

When a response carries a `DPoP-Nonce` header, retry once with that nonce in
the proof. OAuth client libraries do this for you.

## Writing records

| Error                      | Status | Meaning                                                              |
| -------------------------- | ------ | -------------------------------------------------------------------- |
| `InvalidDomainCount`       | 400    | The record does not carry exactly one boundary                       |
| `InvalidDomain`            | 400    | The boundary name is not valid                                       |
| `ServiceMismatch`          | 400    | The boundary belongs to a different Stratos service                  |
| `ForbiddenBoundary`        | 400    | The boundary is not active, or the user does not hold it             |
| `InvalidRecord`            | 400    | The record does not match its lexicon                                |
| `InvalidCollection`        | 400    | The collection is not allowed on this procedure                      |
| `PdsCustodyWriteForbidden` | 400    | The user's records are kept on their own PDS. Write there instead.   |
| `ServiceWriteForbidden`    | 400    | The caller is a service identity. Services can read but never write. |
| `InvalidSwap`              | 400    | A `swapCommit` or `swapRecord` condition did not match               |
| `ConcurrentModification`   | 400    | Another write to the same repository won the race. Retry.            |
| `RateLimitExceeded`        | 429    | Too many writes. Back off, then retry.                               |

`PdsCustodyWriteForbidden` is not a failure of your user. It means your app
sent the write to the wrong place. Resolve the repository target from the
enrollment's custody first; see
[Your First Post](/guide/first-post#_3-choose-the-repository-host).

## Writing into a boundary

The `zone.stratos.repo.createRecord`, `putRecord`, `deleteRecord` and
`applyWrites` procedures take the boundary as a parameter. They return `NotEnrolled`,
`ServiceWriteForbidden`, `PdsCustodyWriteForbidden`, `ForbiddenBoundary`,
`InvalidDomain`, `ServiceMismatch`, `InvalidCollection` and `RateLimitExceeded`
as in the tables above. They do not return `InvalidDomainCount` or the swap
errors. They allow posts, likes and reposts. `com.atproto.repo.*` allows only `zone.stratos.*`
collections and answers `InvalidCollection` for a like or repost.

| Error                  | Status | Meaning                                                               | What the client does                                                  |
| ---------------------- | ------ | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `BoundaryMismatch`     | 400    | The record body claims a boundary other than the one in the request   | Leave the `boundary` field out of the record, or make it match        |
| `BoundaryNotFound`     | 400    | The caller holds the boundary, but it is absent or inactive           | Choose a boundary from the user's enrollment                          |
| `RecordAlreadyExists`  | 400    | The key is taken, or the member already likes or reposts that post    | Use another `rkey`, call `putRecord`, or delete the existing record   |
| `RecordNotFound`       | 400    | An update or delete in `applyWrites` named a record that is not there | Refresh the record list, then send the batch again                    |
| `ScopeUpgradeRequired` | 400    | The member's grant predates the collection of a like or repost        | Send the member through OAuth authorization again. Do not retry first |
| `InvalidRecord`        | 400    | For a like or repost: `The subject must be a post in this boundary`   | Use the `uri` and `cid` of a post in the same boundary, as served     |

The subject message is the same for every wrong subject. A post that Stratos
holds but cannot find, a post in another boundary, a URI that is not canonical
and a wrong CID all return it. The error does not tell them apart.

For a post by a member who hosts their own repo, Stratos does not hold the
record. It checks neither that the record exists nor its CID. It checks that the
author is an active member of the boundary who hosts their own repo, and that
the URI is well formed for that boundary.

`ScopeUpgradeRequired` is returned only when the member's stored grant has a
space grant for this service that lacks the collection. See
[Differences from the upstream procedures](/client/api-reference#differences-from-the-upstream-procedures).

`RecordNotFound` also appears when reading. There it also covers a record that
the caller may not read.

## Reading records

| Error            | Status | Meaning                                                           |
| ---------------- | ------ | ----------------------------------------------------------------- |
| `RecordNotFound` | 400    | The record does not exist, or the caller may not read it          |
| `RepoNotFound`   | 400    | No such repository on this service, or the caller may not read it |
| `BlobNotFound`   | 400    | The blob does not exist                                           |
| `BlobBlocked`    | 400    | The caller may not read the blob                                  |
| `TooManyUris`    | 400    | A batch hydration request named more than 100 records             |

### Why "not found" also means "not allowed"

Stratos gives the same answer for a record that does not exist and a record
the caller may not read. Both are `RecordNotFound`.

This is deliberate. A distinct "forbidden" answer would confirm that a
private record exists. A stranger could then map a community's activity
without reading a single post.

Note the status: `RecordNotFound` arrives with HTTP 400, not 404. Match on
the error name.

## Space credentials

| Error                 | Status | Meaning                                                          |
| --------------------- | ------ | ---------------------------------------------------------------- |
| `AuthRequired`        | 400    | No session and no delegation token                               |
| `InvalidToken`        | 400    | The delegation token or client attestation did not verify        |
| `ProofRequired`       | 400    | No key proof to bind the credential to                           |
| `UnknownSpace`        | 400    | Not a space of this service, or the boundary is not active       |
| `NotEnrolled`         | 400    | No active enrollment that holds the space's boundary             |
| `AttestationRequired` | 400    | The space has an app allow-list and no attestation was presented |
| `ClientNotAllowed`    | 400    | The attested client is not on the allow-list                     |

These come from `zone.stratos.space.getSpaceCredential`. The space read
endpoints answer `AuthRequired` with HTTP 401 when the caller is not admitted
to the space.

See [Permissioned Spaces](/architecture/permissioned-spaces#credential).

## Enrollment

Enrollment happens in the browser, through `/oauth/authorize` and
`/oauth/callback`. When the service refuses an enrollment, the callback
responds on the Stratos origin with a JSON error:

| Error              | Status | Meaning                                                            |
| ------------------ | ------ | ------------------------------------------------------------------ |
| `EnrollmentDenied` | 403    | The user may not enroll, for example they are not on the allowlist |
| `InvalidState`     | 400    | The OAuth state is missing or expired. Start the flow again.       |
| `CallbackError`    | 500    | The callback failed for another reason                             |

A successful enrollment redirects back to your app with
`?stratos_enrolled=true`.

## Sync

| Error            | Status | Meaning                                                             |
| ---------------- | ------ | ------------------------------------------------------------------- |
| `OplogTruncated` | 400    | Stratos cannot serve that position. Recover with `listRecordPaths`. |

## Handling errors in a client

An XRPC client surfaces the name as `error`:

```typescript
import { XRPCError } from '@atproto/xrpc'

try {
  await stratos.com.atproto.repo.createRecord(input)
} catch (err) {
  if (!(err instanceof XRPCError)) throw err

  switch (err.error) {
    case 'NotEnrolled':
      // send the user through enrollment
      break
    case 'PdsCustodyWriteForbidden':
      // route the write to the user's PDS
      break
    case 'RateLimitExceeded':
      // back off and retry
      break
    default:
      throw err
  }
}
```
