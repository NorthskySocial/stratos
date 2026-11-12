# Error Reference

When Stratos turns a request away, it says why in two words: a status code
and an error name. This page lists the names you will meet and what to do
about each one.

## The shape of an error

Stratos returns standard XRPC errors. The body has an `error` name and a
human-readable `message`:

```json
{
  "error": "ForbiddenBoundary",
  "message": "Boundary 'did:web:stratos.example.com/writers' not allowed"
}
```

Match on `error`. Do not parse `message`; its wording can change.

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
| `InvalidCollection`        | 400    | The collection is not a `zone.stratos.*` collection                  |
| `PdsCustodyWriteForbidden` | 400    | The user's records are kept on their own PDS. Write there instead.   |
| `ServiceWriteForbidden`    | 400    | The caller is a service identity. Services can read but never write. |
| `InvalidSwap`              | 400    | A `swapCommit` or `swapRecord` condition did not match               |
| `ConcurrentModification`   | 400    | Another write to the same repository won the race. Retry.            |
| `RateLimitExceeded`        | 429    | Too many writes. Back off, then retry.                               |

`PdsCustodyWriteForbidden` is not a failure of your user. It means your app
sent the write to the wrong place. Resolve the repository target from the
enrollment's custody first; see
[Your First Post](/guide/first-post#_3-find-the-right-door).

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
