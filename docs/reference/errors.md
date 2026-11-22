---
audience: App developers and operators
type: Reference
status: current
---

# Error codes

Every error the Stratos service returns, by area. The feed generator has its
own errors. They are listed in
[Run the feed generator](/operator/feedgen-ng#request-limits-and-errors).

## Error structure

Stratos returns standard XRPC errors.

```json
{
  "error": "ForbiddenBoundary",
  "message": "Boundary 'did:web:stratos.example.com/writers' not allowed"
}
```

Match on the `error` name, not the message. Most rejections use HTTP 400. The
tables give the status of each error.

## Authentication and limits

| Error                    | Status | Meaning                                                                                                     |
| ------------------------ | ------ | ----------------------------------------------------------------------------------------------------------- |
| `AuthenticationRequired` | 401    | No valid DPoP-bound session, a fresh DPoP nonce is needed, or the caller wrote to another user's repository |
| `NotEnrolled`            | 400    | The caller's identity is valid, but they have no active enrollment with the service                         |
| `RateLimitExceeded`      | 429    | The DID passed the write rate limit. Back off, then retry.                                                  |

Stratos accepts `Authorization: DPoP <token>` with a `DPoP` proof header. A
`Bearer` token is not a valid user credential.

When a response carries a `DPoP-Nonce` header, retry once with that nonce in
the proof. OAuth client libraries do this for you.

## Writing records

| Error                      | Status | Meaning                                                              |
| -------------------------- | ------ | -------------------------------------------------------------------- |
| `InvalidDomainCount`       | 400    | The record does not carry exactly one boundary                       |
| `InvalidDomain`            | 400    | The boundary name is not a valid space key                           |
| `ServiceMismatch`          | 400    | The boundary belongs to a different Stratos service                  |
| `ForbiddenBoundary`        | 400    | The caller does not hold the boundary                                |
| `InvalidRecord`            | 400    | The record does not match its lexicon                                |
| `InvalidCollection`        | 400    | The collection is not allowed on this procedure                      |
| `PdsCustodyWriteForbidden` | 400    | The user's records are kept on their own PDS. Write there instead.   |
| `ServiceWriteForbidden`    | 400    | The caller is a service identity. Services can read but never write. |
| `InvalidSwap`              | 400    | A `swapCommit` or `swapRecord` condition did not match               |
| `ConcurrentModification`   | 400    | Another write to the same repository won the race. Retry.            |

`PdsCustodyWriteForbidden` is not a failure of your user. It means your app
sent the write to the wrong place. Resolve the repository target from the
enrollment's custody first. See
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
| `InvalidRecord`        | 400    | For a reply: the parent cannot be read in this boundary               | Reply in the boundary of a parent that the member can read            |

The reply message starts with `Reply boundaries must be a subset of the
parent's boundaries` and names the reply's boundary. It is the same for every
parent the reply cannot have. A parent in another boundary, a parent that
Stratos holds but cannot find, and a parent that is taken down all return it,
byte for byte. The error does not tell them apart. Stratos reads the parent's
boundary from its store at the time of the write, so a reply to a parent that
has just moved is refused at once. The older `com.atproto.repo` methods do not
check a parent that is missing or taken down.

The subject message is the same for every wrong subject, whatever the
`validate` value. A subject that is not a `{ uri, cid }` reference, a post that
Stratos holds but cannot find, a post in another boundary, a URI that is not
canonical and a wrong CID all return it. The error does not tell them apart.

For a post by a member who hosts their own repo, Stratos does not hold the
record. It checks neither that the record exists nor its CID. `subject.cid`
must still be a valid CID. Stratos checks that the author is an
active member of the boundary who hosts their own repo, and that the URI is
well formed for that boundary.

`ScopeUpgradeRequired` is returned only when the member's stored grant has a
space grant for this service that lacks the collection. See
[Differences from the upstream procedures](/reference/api#differences-from-the-upstream-procedures).

`RecordNotFound` also appears when reading. There it also covers a record that
the caller may not read.

## Reading records

| Error            | Status | Meaning                                                                             |
| ---------------- | ------ | ----------------------------------------------------------------------------------- |
| `RecordNotFound` | 400    | The record does not exist, or the caller may not read it                            |
| `RecordBlocked`  | 400    | The caller may not read the record. Sent by `zone.stratos.repo.hydrateRecord` only. |
| `RepoNotFound`   | 400    | No such repository on this service, or the caller does not own it (`getRepo`)       |
| `BlobNotFound`   | 400    | The repository has no such blob                                                     |
| `BlobBlocked`    | 400    | The caller may not read the blob                                                    |
| `TooManyUris`    | 400    | A batch hydration request named more than 100 records                               |

### Why "not found" also means "not allowed"

`com.atproto.repo.getRecord` and `zone.stratos.space.getRecord` give the same
answer for a record that does not exist and a record the caller may not read.
Both are `RecordNotFound`.

This is deliberate. A distinct "forbidden" answer would confirm that a
private record exists. A stranger could then map a community's activity
without reading a single post.

Note the status: `RecordNotFound` arrives with HTTP 400, not 404. Match on
the error name.

## Space credentials

| Error                 | Status | Meaning                                                                                  |
| --------------------- | ------ | ---------------------------------------------------------------------------------------- |
| `AuthRequired`        | 400    | No session and no delegation token                                                       |
| `InvalidToken`        | 400    | The delegation token or client attestation did not verify, or it names another space     |
| `ProofRequired`       | 400    | No key proof to bind the credential to                                                   |
| `UnknownSpace`        | 400    | The space URI is malformed or not a space of this service, or the boundary is not active |
| `NotEnrolled`         | 400    | No active enrollment that holds the space's boundary                                     |
| `AttestationRequired` | 400    | The space has an app allow-list and no attestation was presented                         |
| `ClientNotAllowed`    | 400    | The attested `client_id` is not on the allow-list                                        |

These come from `zone.stratos.space.getSpaceCredential`. `UnknownSpace` is
also the answer when the boundary changes while the request is authorized.
The space read endpoints answer `AuthRequired` with HTTP 401 when the caller
is not admitted to the space.

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

| Error            | Status | Meaning                                                                                   |
| ---------------- | ------ | ----------------------------------------------------------------------------------------- |
| `OplogTruncated` | 400    | `listRepoOps` cannot serve that position. Recover with `listRecordPaths`.                 |
| `FutureCursor`   |        | Declared by the `subscribeRecords` lexicon. Stratos does not send it. See the note below. |

A `subscribeRecords` cursor ahead of the newest event does not fail. Stratos
resumes the stream from the newest event. A cursor older than the retained
events gets an `OutdatedCursor` info frame, and the stream continues.

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
