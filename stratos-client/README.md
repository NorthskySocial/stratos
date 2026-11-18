# Stratos Client Integration Guide

This guide takes you through how to integrate Stratos into an ATProto client. It is based on how it
was integrated with [pdsls](https://github.com/pdsls/pdsls) to test things out and maps patterns to
the Bluesky [social-app](https://github.com/bluesky-social/social-app) codebase as a reference
architecture so this should cover most use cases. If you see something missing open an issue (or PR)
to cover it. The goal of the guide is to make it as easy and as straightforward as possible to
integrate it, therefore we're just going to assume you are using the `atcute` package as it's fairly
lightweight when compared `atproto` plus it is used in `stratos-client`.

The `@northskysocial/stratos-client` package provides the building blocks for enrollment discovery,
service routing, record verification, and OAuth scope management. This guide shows how to wire it
into your app. The package is standalone — it has no runtime dependency on `@northskysocial/stratos-core`,
only on `@atcute/*` packages, so pulling it into a client app doesn't drag in server-side dependencies.

1. [Enrollment discovery](#1-enrollment-discovery)
2. [Service routing](#2-service-routing)
3. [DPoP-aware transport](#3-dpop-aware-transport)
4. [Read path integration](#4-read-path-integration)
5. [Write path integration](#5-write-path-integration)
6. [Blob support](#6-blob-support)
7. [Record verification](#7-record-verification)
8. [OAuth scope declarations](#8-oauth-scope-declarations)
9. [Lexicon registration](#9-lexicon-registration)
10. [CORS and header requirements](#10-cors-and-header-requirements)
11. [Known pitfalls](#11-known-pitfalls)
12. [social-app mapping](#12-social-app-mapping)
13. [Minimum viable adoption path](#13-minimum-viable-adoption-path)

---

## 1. Enrollment Discovery

A user's Stratos enrollments are published as `zone.stratos.actor.enrollment` records on their PDS
collection, created during the enrollment process via OAuth. Each enrollment record represents a
connection to a different Stratos service — **a user can be enrolled in multiple Stratos services
simultaneously**, with each enrollment stored as a separate record using the **service's DID** as
the record key. This makes enrollment records deterministically addressable: knowing the service DID
is sufficient to look up a specific enrollment. So as to prevent a confused deputy scenario, domains
are also fully addressable using the service DID and stored this way.

The enrollment process initializes the user's Stratos repository with an empty signed commit, so the
repo is immediately valid for reads and writes. A P-256 signing key is generated for the user and
stored by the Stratos service — this key is used for signing record commits, making them verifiable
against the `signingKey` published in the enrollment record. If the per-user key is unavailable, the
service falls back to its own Secp256k1 key.

To discover a user's enrollments, list the enrollment collection via `com.atproto.repo.listRecords`
on the user's PDS and verify each record using the service's public key.

### Enrollment record schema

Each enrollment record is stored at `at://<did>/zone.stratos.actor.enrollment/<service-did>` where
`<service-did>` is the Stratos service's DID (e.g., `did:web:stratos.example.com`):

```json
{
  "service": "https://stratos.example.com",
  "boundaries": [
    { "value": "did:web:stratos.example.com/WestCoastBestCoast" },
    { "value": "did:web:stratos.example.com/TeaDrinkers" }
  ],
  "signingKey": "did:key:zDnae...",
  "attestation": {
    "sig": { "$bytes": "base64..." },
    "signingKey": "did:key:zDnae..."
  },
  "createdAt": "2025-01-15T00:00:00.000Z"
}
```

A user enrolled in two Stratos services would have two records in their collection:

```
at://did:plc:abc123/zone.stratos.actor.enrollment/did:web:service-a.example.com  → Service A
at://did:plc:abc123/zone.stratos.actor.enrollment/did:web:service-b.example.com  → Service B
```

| Field                    | Type                       | Description                                                                                          |
| ------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `service`                | `string` (URI)             | Stratos service endpoint where user's private data lives                                             |
| `boundaries`             | `Array<{ value: string }>` | Service-DID-qualified boundaries the user can access, each in `{serviceDid}/{domainName}` format     |
| `signingKey`             | `string` (did:key)         | User's P-256 public key, generated at enrollment and used to sign record commits                     |
| `attestation`            | `ServiceAttestation`       | Service attestation vouching for enrollment, boundaries, and signing key                             |
| `attestation.sig`        | `bytes`                    | Signature over DAG-CBOR encoded `{boundaries, did, signingKey}` (sorted keys), signed by service key |
| `attestation.signingKey` | `string` (did:key)         | The Stratos service's public key used to verify the attestation                                      |
| `createdAt`              | `string` (datetime)        | When the enrollment was created                                                                      |

### Discovery functions

```typescript
import { getEnrollmentByServiceDid } from '@northskysocial/stratos-client'
import type { StratosEnrollment } from '@northskysocial/stratos-client'

// Direct lookup by service DID (recommended)
const enrollment: StratosEnrollment | null = await getEnrollmentByServiceDid(
  did,
  pdsUrl,
  'did:web:stratos.example.com',
)

if (enrollment) {
  console.log(`Service: ${enrollment.service}, rkey: ${enrollment.rkey}`)
}

// With an existing FetchHandler (e.g. from an authenticated agent)
import type { FetchHandler } from '@atcute/client'

const target = await getEnrollmentByServiceDid(did, agent.handle, serviceDid)
```

`getEnrollmentByServiceDid` uses `com.atproto.repo.getRecord` with the service DID as the rkey
for a direct O(1) lookup. This is more efficient than listing all records when targeting a
specific service.

### Parsing raw enrollment records

If you already have a raw record value — from `com.atproto.repo.listRecords`, a firehose event, or
a cache — you don't need a network round trip to turn it into a `StratosEnrollment`:

```typescript
import {
  parseEnrollmentRecord,
  ENROLLMENT_COLLECTION,
} from '@northskysocial/stratos-client'

const enrollment = parseEnrollmentRecord(record.value, rkey)
if (enrollment) {
  console.log(`Service: ${enrollment.service}`)
}
```

`parseEnrollmentRecord(val, rkey)` validates and decodes a raw `zone.stratos.actor.enrollment`
record value into a `StratosEnrollment`, returning `null` if the shape doesn't match. It does not
verify the attestation — see [Verifying the attestation](#verifying-the-attestation) for that.

`ENROLLMENT_COLLECTION` is the `zone.stratos.actor.enrollment` NSID constant, useful when filtering
`listRecords` output or matching firehose commits by collection.

### Service DID to rkey conversion

AT Protocol rkeys cannot contain `%` characters, but `did:web` DIDs with ports use `%3A` encoding (
e.g., `did:web:localhost%3A3100`). The `serviceDIDToRkey` helper handles this:

```typescript
import { serviceDIDToRkey } from '@northskysocial/stratos-client'

serviceDIDToRkey('did:web:stratos.example.com') // => 'did:web:stratos.example.com'
serviceDIDToRkey('did:web:localhost%3A3100') // => 'did:web:localhost:3100'
```

### Enrollment selection

When a user has multiple enrollments, you can find the right one by iterating or using direct lookups if you have the service DIDs. `getEnrollmentByServiceDid` is the preferred way to retrieve a specific enrollment.

Boundaries are service-DID-qualified: each boundary `value` is stored in `{serviceDid}/{domainName}`
format (e.g., `did:web:stratos.example.com/animal-lovers`). This makes every boundary globally
addressable — the same domain name on two different Stratos services produces two distinct boundary
values, so cross-enrollment conflicts are impossible by design.

Discovery should happen at session establishment (login/resume) and the result cached for the
session lifetime. Reset enrollment state on account switch or logout.

### Verifying the attestation

Verify the signature and its service identity together. Pass the expected service DID from trusted configuration:

```typescript
import { verifyEnrollmentAttestation } from '@northskysocial/stratos-client'

const result = await verifyEnrollmentAttestation(enrollment, userDid, {
  serviceDid: 'did:web:stratos.example.com',
})
if (!result.valid) throw new Error(result.error ?? 'Invalid attestation')
```

The client checks the current DID key first. For a retired key, it verifies the public
`zone.stratos.identity.getKeyHistory` hash chain, both rotation signatures, and the signed issue-time window.
Legacy attestations without `issuedAt` are accepted only against the current DID key.
`VerifyAttestationOptions.serviceDid` is required; an arbitrary embedded key no longer establishes service identity.
See the [service key history design](../docs/architecture/service-key-history.md) for storage, rotation, and trust limits.

---

## 2. Service Routing

Select the write route from the enrollment's custody. Stratos custody uses the authority service.
PDS custody uses the user's spaces-capable PDS and `com.atproto.space.*` methods.

When a user has multiple enrollments, select the target enrollment first (see
`findEnrollmentByService` in Section 1), then select the repository target from its custody and
trusted host information.

### Routing logic

`resolveServiceUrl(enrollment, pdsUrl)` returns the authority service URL if enrolled, otherwise
the fallback PDS URL. It does not select a repository host; use `resolveRepositoryTarget` below.

`custody` defaults to `stratos` only when the published field is absent. Unknown values stay
visible and cannot select a repository target. `repoHost` is a validated HTTPS origin hint only
for PDS custody. Neither field is covered by the current service attestation. Resolve the actual
write host from the live authority or the authenticated session before forwarding credentials.

```typescript
import {
  createBoundaryRecord,
  resolveRepositoryTarget,
} from '@northskysocial/stratos-client'

const target = resolveRepositoryTarget(enrollment, {
  authorityServiceUrl, // live authority endpoint for Stratos custody
  authoritativeRepoHost, // live authority answer when available
  sessionPdsUrl, // PDS endpoint bound to this authenticated session
})
if (target.kind === 'unresolved') throw new Error(target.reason)

const result = await createBoundaryRecord(
  { handler: authenticatedHandler, resolveTarget: () => target },
  {
    boundary: 'did:web:stratos.example.com/general',
    repo: did,
    collection: 'zone.stratos.feed.post',
    record: post,
  },
)
if (!result.ok) throw new Error(result.reason)
```

`createBoundaryRecord` calls `zone.stratos.repo.createRecord` on a `stratos` target. On a `pds`
target it calls `com.atproto.space.createRecord` with the boundary's space URI. See
[Write Path Integration](#5-write-path-integration) for the four helpers.

The PDS result URI has seven segments:
`at://{authorityDid}/space/{type}/{spaceKey}/{authorDid}/{collection}/{rkey}`.
The legacy `com.atproto.repo.*` methods still serve `stratos` custody. They take the boundary
from the record body and refuse likes and reposts. Changing only the origin of a legacy call does
not write into the space.

### Routing applies to

| Operation                               | Routes to Stratos?                                                    |
| --------------------------------------- | --------------------------------------------------------------------- |
| `com.atproto.repo.getRecord`            | Stratos custody only                                                  |
| `com.atproto.repo.listRecords`          | Stratos custody only                                                  |
| `com.atproto.repo.describeRepo`         | Stratos custody only                                                  |
| `com.atproto.repo.createRecord`         | Stratos custody only                                                  |
| `com.atproto.repo.deleteRecord`         | Stratos custody only                                                  |
| `com.atproto.repo.applyWrites`          | Stratos custody only                                                  |
| `zone.stratos.repo.createRecord`        | Stratos custody only (boundary as a parameter)                        |
| `zone.stratos.repo.putRecord`           | Stratos custody only (boundary as a parameter)                        |
| `zone.stratos.repo.deleteRecord`        | Stratos custody only (boundary as a parameter)                        |
| `zone.stratos.repo.applyWrites`         | Stratos custody only (boundary as a parameter)                        |
| `com.atproto.sync.getRecord`            | Stratos custody only                                                  |
| `zone.stratos.space.listBlobs`          | Yes (lists blob CIDs in a space)                                      |
| `zone.stratos.sync.getRepo`             | Yes (full repo export as CAR)                                         |
| `zone.stratos.repo.importRepo`          | Yes (import repo from CAR)                                            |
| `zone.stratos.sync.subscribeRecords`    | Yes (WebSocket firehose)                                              |
| `zone.stratos.sync.listRepoOps`         | Yes (pull oplog; falls back to `listRecordPaths` on `OplogTruncated`) |
| `zone.stratos.sync.listRecordPaths`     | Yes (full-state recovery enumeration)                                 |
| `zone.stratos.space.getSpaceCredential` | Yes (mints standard HTTP-signature or legacy DPoP space credentials)  |
| `com.atproto.sync.getBlob`              | Yes (downloads blob content)                                          |

`zone.stratos.space.getSpaceCredential` is a POST procedure. A client with a
space delegation sends `Authorization: Bearer <delegation JWT>`, a standalone
`DPoP` proof for this procedure, and a JSON body containing the `space` URI.
The proof must omit `nonce` and `ath`. The delegation targets that exact space
and is consumed after membership, app access, and proof checks pass. Existing
clients may continue to send `delegationToken` in the JSON body with the same
standalone `DPoP` proof and no `Authorization` header. A body delegation
combined with any `Authorization` header, including a DPoP session token, is
rejected. This custom Stratos endpoint does not advertise the
upstream `com.atproto.space.*` namespace.

The additive HTTP-signature profile sends the delegation as Bearer authorization
and uses RFC 9421 `Signature-Input` and `Signature` headers with the
`atproto-space` label. Exchange covers exactly `authorization` and requires a
P-256 `did:key` in `keyid`. Do not send a DPoP header with this profile.
The resulting credential binds `cnf.kid`, not `cnf.jkt`.

Present that credential as `Authorization: Atproto-Space <credential JWT>`.
The signature covers exactly `authorization` then `atproto-space-audience`.
Set `Atproto-Space-Audience` to the actual repo owner's DID for
`zone.stratos.space.getRecord`, `zone.stratos.space.listBlobs`,
`zone.stratos.sync.listRepoOps`, and `zone.stratos.sync.listRecordPaths`.
For `zone.stratos.space.listRepos`, use the bare authority DID instead.
The service derives the expected audience from the operation, never from the
header itself. Unsupported operations and ambiguous repo parameters are rejected.
The same signature may be reused for the same credential and audience until
expiry. An optional presentation `keyid` must match `cnf.kid`; an optional
`alg` must be `ecdsa-p256-sha256`.

Operators configure this profile with
`STRATOS_SPACE_HTTP_CREDENTIAL_TTL_SECONDS` (default 600, maximum 3600,
positive integer seconds). Legacy `STRATOS_SPACE_CREDENTIAL_TTL_SECONDS`
remains unchanged (default 7200). Existing OAuth-session minting, body delegation,
and Bearer delegation with standalone DPoP continue to produce `cnf.jkt`
credentials. Keep each cached credential associated with its original key and
profile. Failed HTTP verification never falls back to OAuth, service auth, or
legacy DPoP. Ordinary OAuth DPoP and service JWT authentication are unchanged.

For a coordinated upgrade, discard cached grants and reacquire credentials with
fresh keys. The Rust client has no legacy fallback; do not deploy it against an
old receiver. October PDS hosts require the standard profile even though Stratos
continues to support legacy clients. Roll back the receiver, client, and compatible
PDS set together, then clear grant caches. See the
[operator rollout procedure](../docs/operator/configuration.md#october-spaces-rollout).

The issued legacy credential covers one whole space until expiry (normally two
hours), not just the member who requested it. Production reads require a fresh
DPoP proof from the bound key; Bearer presentation is limited to development
mode. Removing a member blocks new credentials and service-member requests,
but does not revoke an already-issued capability on a foreign PDS. Stratos
rejects a locally issued credential when its catalog boundary is deleted or
revised; a foreign host does not understand that private revision claim. See
[the current spaces contract](../docs/architecture/spaces-alignment.md).

---

## 3. DPoP-Aware Transport

Stratos endpoints require authenticated requests using the same DPoP credentials as the user's PDS
session. The key insight: _pass an absolute URL to the OAuth agent's fetch handler to redirect
requests to a different origin while keeping DPoP proof generation valid._

The underlying DPoP implementation derives `htu` (the HTTP URI claim in the DPoP proof JWT) from the
actual request URL. By passing an absolute URL with the Stratos origin, the proof is generated for
that origin rather than the PDS. The agent's session audience (PDS) is ignored per the URL
specification when an absolute URL is provided.

### Transport wrapper

This authority transport is for `stratos` custody only. For `pds` custody, select the
authenticated PDS endpoint and space methods as shown in [Service Routing](#2-service-routing).

```typescript
import { createServiceFetchHandler } from '@northskysocial/stratos-client'

// agent.handle is the FetchHandler from your OAuth session
if (enrollment.custody !== 'stratos')
  throw new Error('Expected Stratos custody')
const handler = createServiceFetchHandler(agent.handle, authorityServiceUrl)
```

`createServiceFetchHandler` accepts any `FetchHandler` from `@atcute/client` (a function
`(pathname, init) => Promise<Response>`) and returns a `FetchHandlerObject` that resolves relative
pathnames against the target service URL.

### Client construction

Construct the RPC client from the resolved target in [Service Routing](#2-service-routing).
Do not treat an enrollment's authority `service` URL as the PDS repository host.

---

## 4. Read Path Integration

For `stratos` custody, views that display records, collections, or repo descriptions need to switch
between PDS and Stratos sources based on the active mode. PDS-custody space reads use the trusted
PDS target selected in [Service Routing](#2-service-routing).

### Pattern: reactive refetch on mode change

When the Stratos active state changes, refetch data. In React, this translates to including the
active state in a query key:

```typescript
const { data } = useQuery({
  queryKey: ['record', uri, stratosActive],
  queryFn: () => fetchRecord(uri, stratosActive, enrollment),
})
```

### Pattern: client reset on mode switch

When Stratos mode toggles, any cached RPC client should be discarded since it may point to the wrong
service. Rather than recreating the client on every fetch, cache the PDS and Stratos clients
separately and select the right one based on mode:

```typescript
import {Client} from '@atcute/client'
import {createServiceFetchHandler} from '@northskysocial/stratos-client'

let pdsClient: Client | null = null
let stratosClient: Client | null = null

//pdsClient magic happens elsewhere

const getStratosClient = (
  agent: OAuthUserAgent,
  enrollment: StratosEnrollment,
): Client => {
  if (enrollment.custody !== 'stratos') throw new Error('Expected Stratos custody')
  if (!stratosClient) {
    stratosClient = new Client({
      handler: createServiceFetchHandler(agent.handle, authorityServiceUrl),
    })
  }
  return stratosClient
}

// On logout or account switch, drop both
const resetClients = () => {
  pdsClient = null
  stratosClient = null
}

const fetchRecords = async () => {
  if (
    stratosActive &&
    enrollment &&
    enrollment.custody !== 'stratos' &&
    enrollment.custody !== 'pds'
  ) {
    throw new Error('Unsupported custody')
  }
  if (stratosActive && enrollment?.custody === 'pds') {
    throw new Error('Use the PDS space read route for PDS custody')
  }
  const client = stratosActive && enrollment?.custody === 'stratos'
    ? getStratosClient(agent, enrollment)
    : getPdsClient(agent)
  return client.get('com.atproto.repo.listRecords', {params: {...}})
}
```

This example reads an ordinary PDS repo or a Stratos-custody repo. PDS-custody space reads need
their own PDS space client. Mode toggles pick the cached client without reconstructing it. Call
`resetClients()` on logout or account switch to avoid stale sessions.

### Pattern: auth requirement in Stratos mode

Stratos endpoints require authentication. If the user is not signed in, display a clear message
rather than attempting an anonymous fetch as the user will get access denied or simply not found
error response:

```typescript
if (stratosActive && !agent) {
  throw new Error('Sign in to view Stratos records')
}
```

### Pattern: empty repo handling

For Stratos custody, the service initializes an empty signed commit at enrollment time.
This means `describeRepo` and `getRepo` return a valid (possibly empty) repo for a
Stratos-custody user. A `describeRepo` call against that repo returns an empty `collections`
list until the first record is created — this is normal and should be rendered as an empty state,
not an error.

If Stratos returns `RepoNotFound` for an enrolled user, treat it as a genuine error (service
misconfiguration, auth failure, etc.) rather than an empty repo:

```typescript
if (error.name === 'RepoNotFound' && stratosActive) {
  // This should not happen for enrolled users — the repo is created at enrollment
  throw new Error('Stratos repo not found for enrolled user')
}
```

### Boundary gating: blobs

Stratos supports space-scoped blob listing via `zone.stratos.space.listBlobs` and blob content
retrieval via `com.atproto.sync.getBlob`.

---

## 5. Write Path Integration

Write through the helpers. Each helper takes a boundary, picks the host from the member's custody,
and sends the matching procedure.

| Custody   | Procedure the helper calls                                             |
| --------- | ---------------------------------------------------------------------- |
| `stratos` | `zone.stratos.repo.*` on the Stratos service, with `boundary`          |
| `pds`     | `com.atproto.space.*` on the member's PDS, with the boundary's `space` |

### Helpers

```typescript
import {
  applyBoundaryWrites,
  createBoundaryRecord,
  deleteBoundaryRecord,
  putBoundaryRecord,
  resolveRepositoryTarget,
  ScopeUpgradeRequiredError,
} from '@northskysocial/stratos-client'

const client = {
  handler: authenticatedHandler, // adds the DPoP proof and access token
  resolveTarget: () => resolveRepositoryTarget(enrollment, hosts),
}
const boundary = 'did:web:stratos.example.com/general'

const created = await createBoundaryRecord(client, {
  boundary,
  repo: did,
  collection: 'app.bsky.feed.like',
  record: { $type: 'app.bsky.feed.like', subject: { uri, cid }, createdAt },
})
if (!created.ok) throw new Error(created.reason)

await deleteBoundaryRecord(client, {
  boundary,
  repo: did,
  collection: 'app.bsky.feed.like',
  rkey,
})
```

| Helper                 | Input                                                                   | `value` on success                |
| ---------------------- | ----------------------------------------------------------------------- | --------------------------------- |
| `createBoundaryRecord` | `boundary`, `repo`, `collection`, `record`; optional `rkey`, `validate` | `{ uri, cid, validationStatus? }` |
| `putBoundaryRecord`    | `boundary`, `repo`, `collection`, `rkey`, `record`; optional `validate` | `{ uri, cid, validationStatus? }` |
| `deleteBoundaryRecord` | `boundary`, `repo`, `collection`, `rkey`                                | `{}`                              |
| `applyBoundaryWrites`  | `boundary`, `repo`, `writes`; optional `validate`                       | `{ results }`                     |

Each helper returns `{ ok: true, value }` or `{ ok: false, reason }`.

`resolveRepositoryTarget` accepts only https origins. A service on a local `http` address, such as
`http://127.0.0.1:3100`, is not resolved (`invalid-trusted-host`), so give the client its own
`resolveTarget` that returns `{ kind: 'stratos', url }` for it.

- `reason` is the reason of an `unresolved` target (see `resolveRepositoryTarget`), or
  `invalid-boundary` when a `pds` write names a boundary that has no space URI.
- When `ok` is `false`, the helper has sent no request.
- Any error the service or the PDS returns is thrown as `BoundaryWriteError`. It has `status`,
  `errorName` and `message`.
- When several writes in one `applyBoundaryWrites` call fail validation, the error returned is that
  of the first failing write, in order. The collection, duplicate-key and grant checks run for the whole batch first, then the checks on each record's `boundary` claim and `$type`, and only then the lexicon and subject checks.
- A `writes` entry for `applyBoundaryWrites` is `{ action, collection, rkey?, value? }`, where
  `action` is `create`, `update` or `delete`. The helper sets the `$type` that the chosen
  procedure expects.
- `boundaryToSpaceUri(boundary, spaceType)` is the function the `pds` path uses. It returns
  `{ ok: true, value }` or `{ ok: false, reason }` and never throws.

### The four procedures

All four need a DPoP session. `repo` must be the caller's DID. `boundary` is
`{serviceDid}/{domainName}`.

| Procedure                        | Input                                                          | Output                                   |
| -------------------------------- | -------------------------------------------------------------- | ---------------------------------------- |
| `zone.stratos.repo.createRecord` | `boundary`, `repo`, `collection`, `record`; `rkey`, `validate` | `uri`, `cid`, `validationStatus`         |
| `zone.stratos.repo.putRecord`    | `boundary`, `repo`, `collection`, `rkey`, `record`; `validate` | `uri`, `cid`, `validationStatus`         |
| `zone.stratos.repo.deleteRecord` | `boundary`, `repo`, `collection`, `rkey`                       | `{}`                                     |
| `zone.stratos.repo.applyWrites`  | `boundary`, `repo`, `writes` (1 to 200); `validate`            | `results`, one entry per write, in order |

`applyWrites` is one commit. A `writes` entry has a `$type` of `zone.stratos.repo.applyWrites#create`,
`#update` or `#delete`, plus `collection`, `rkey` and `value`. A `create` may leave out `rkey`. A
`delete` has no `value`. Each result has the matching `#createResult`, `#updateResult` or
`#deleteResult` type.

Errors, by name:

| Error                                                                                                                                            | Returned by                                | Meaning                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------- |
| `BoundaryNotFound`                                                                                                                               | all four                                   | The caller holds the boundary, but it is absent or inactive.         |
| `BoundaryMismatch`                                                                                                                               | `createRecord`, `putRecord`, `applyWrites` | The record claims a boundary other than the one in the request.      |
| `RecordAlreadyExists`                                                                                                                            | `createRecord`, `putRecord`, `applyWrites` | The key is taken, or the member already likes or reposts the post.   |
| `RecordNotFound`                                                                                                                                 | `applyWrites`                              | An update or delete named a record that is not there.                |
| `InvalidRecord`                                                                                                                                  | `createRecord`, `putRecord`, `applyWrites` | The record breaks a rule of its collection, or its subject is wrong. |
| `InvalidCollection`                                                                                                                              | all four                                   | The collection is not allowed.                                       |
| `ScopeUpgradeRequired`                                                                                                                           | `createRecord`, `putRecord`, `applyWrites` | The member must authorize again.                                     |
| `NotEnrolled`, `ServiceWriteForbidden`, `PdsCustodyWriteForbidden`, `ForbiddenBoundary`, `InvalidDomain`, `ServiceMismatch`, `RateLimitExceeded` | all four                                   | As in the [error reference](../docs/guide/errors.md).                |

### When `ScopeUpgradeRequired` is returned

Stratos returns `ScopeUpgradeRequired` for a like or repost. It returns it only when the member's
stored OAuth grant has a space grant for this service and that grant does not allow creating the
collection. A grant from before likes and reposts were allowed is such a grant.

The helpers throw `ScopeUpgradeRequiredError` (a `BoundaryWriteError` with `status` and
`errorName`). The client should start OAuth authorization for the member again. It should not
retry the write first.

Stratos does not return it when the member has no stored session, when the stored scope has no
space grant for this service, or when the scope cannot be read. Posts are never checked.

### Likes and reposts

The `zone.stratos.repo` procedures allow three collections: `zone.stratos.feed.post`,
`app.bsky.feed.like` and `app.bsky.feed.repost`. A like or a repost is written with
`createBoundaryRecord` into the boundary of the post.

- The `subject` must be a post (`zone.stratos.feed.post`) in the same boundary.
- `subject.uri` must be the post's `uri` exactly as the feed returns it. For a post that Stratos
  holds, `subject.cid` must be the post's current CID.
- A post by a member who hosts their own repo (`pds` custody) is not held by Stratos. For such a
  post Stratos checks neither that the record exists nor its CID. `subject.cid` must still be a
  valid CID. Stratos checks that the author is an active member of the boundary who
  hosts their own repo, and that the URI is well formed for that boundary.
- A member has one like or repost per post. A second one is `RecordAlreadyExists`.
- To remove one, call `deleteBoundaryRecord` with the rkey of the record in `viewer.like` or
  `viewer.repost`.
- Any wrong subject (not a `{ uri, cid }` reference, not a post, another boundary, a URI that is
  not canonical, a wrong CID, a post that Stratos holds but cannot find) returns one error, whatever
  the `validate` value: `InvalidRecord` with the message `The subject must be a post in this
boundary`.
- A record in a boundary does not need a `boundary` field. Leave it out of the body, because the
  `boundary` parameter names it. If the body has one, it must name exactly that boundary. An
  entry that carries its own `$type` is a `BoundaryMismatch`.

A member who hosts their own repo (`pds` custody) cannot like or repost yet. The space type
declaration `zone.stratos.space.feed` must be published with the like and repost collections, and
the client's PDS space scope must list those collections.

### Differences from the upstream `com.atproto.space` procedures

The `zone.stratos.repo` procedures follow the upstream shapes, with `boundary` in place of
`space`. These differences are on purpose.

- `$type` is required, and must equal the collection. Upstream fills a missing `$type`.
- Stratos does not require `tid` keys and has no slur check. It checks the record-key syntax only.
- A record that breaks a rule is `InvalidRecord` (HTTP 400). Upstream answers `InvalidRequest`. The
  message text is not the same.
- The body limit is 1,000,000 bytes per request. There is no cap per record. Upstream has a size
  cap for a space.
- `applyWrites` takes 1 to 200 writes. The upstream lexicon does not declare a limit. The
  reference PDS enforces 200. A batch that names the same record twice is refused.
- `deleteRecord` of a record that is missing, or that is in another boundary, succeeds with `{}`.
  It writes no commit and sends no event.
- A boundary the caller does not hold returns `ForbiddenBoundary`, whether or not it exists.
  `BoundaryNotFound` is returned only for a boundary the caller holds that is absent or inactive in
  the catalog. `putRecord` returns
  `RecordAlreadyExists` when the key holds a record in another boundary or a record that was
  taken down.
- A subject may be a space URI (`at://{authority}/space/{type}/{skey}/{author}/{collection}/{rkey}`)
  where the lexicon says `at-uri`. Stratos parses it itself.
- A subject URI must be canonical. A repo URI must have a DID authority and equal its re-parsed
  form. A space URI must equal the URI rebuilt from its parts. Any other spelling is refused.
- There is one like or repost per post for each member and collection. A like that was taken
  down still blocks a second one. Upstream does not limit this.
- `ScopeUpgradeRequired` exists only here. See [above](#when-scopeupgraderequired-is-returned).
- `via` on a repost is not resolved and not indexed. When `validate` is not `false`, its shape is
  checked.
- A `boundary` claim in the record body must be `{ values: [{ value: <boundary> }] }`, with an
  optional `$type` of `zone.stratos.boundary.defs#Domains`. An entry with its own `$type`
  counts as a mismatch.

### Deploy order

Deploy the Rust feed generator (`stratos-feedgen-ng`) before any client calls the new
procedures. It reads the boundary of each write from the sync stream and serves the like and
repost view fields. After clients use the procedures, do not roll back to the TypeScript feed
generator.

## 6. Blob Support

Stratos supports boundary-aware blob management. Blobs uploaded to a Stratos service are only accessible if the viewer has access to at least one record that references that blob.

### Uploading Blobs

You can upload blobs using the standard `com.atproto.repo.uploadBlob` endpoint or the Stratos-specific `zone.stratos.repo.uploadBlob` alias. Both will store the blob in the user's Stratos repository.

```typescript
const response = await rpc.call('com.atproto.repo.uploadBlob', {
  data: imageData, // Uint8Array or Blob
})

const { blob } = response.data
// blob is a BlobRef that can be used in records
```

### Retrieving Blobs

To retrieve a blob, use `com.atproto.sync.getBlob` or `zone.stratos.sync.getBlob`. The service will verify that the authenticated viewer has boundary access to at least one record referencing the requested CID.

```typescript
const response = await rpc.call('com.atproto.sync.getBlob', {
  params: {
    did: actorDid,
    cid: blobCid,
  },
})

// response.data is a Uint8Array containing the blob content
```

The Stratos-specific alias `zone.stratos.sync.getBlob` is preferred when you want to explicitly signal that you are requesting a private blob from a Stratos service.

---

## 7. Record Verification

For Stratos custody, `com.atproto.sync.getRecord` returns a CAR file containing an inclusion proof
for a single record. The service maintains independent repositories per user. Record commits are signed
with the user's per-enrollment P-256 key when available, falling back to the service's Secp256k1
key. This means standard ATproto verification against the user's PDS DID document will fail —
clients must verify against either the user's enrollment `signingKey` or the Stratos service's
signing key.

### Resolving the service signing key

Stratos services publish their signing public key in the `did:web` DID document as a Multikey
`verificationMethod` with the standard `#atproto` fragment. Resolve it once and cache:

```typescript
import { resolveServiceSigningKey } from '@northskysocial/stratos-client'

// serviceDid is the service's did:web, e.g. 'did:web:stratos.example.com'
const signingKey = await resolveServiceSigningKey(serviceDid)

// With a custom fetch function
const signingKey2 = await resolveServiceSigningKey(serviceDid, {
  fetchFn: customFetch,
})
```

### Fetch + verify in one step

```typescript
import {
  fetchAndVerifyRecord,
  resolveUserSigningKey,
  resolveServiceSigningKey,
} from '@northskysocial/stratos-client'

// User-signature verification (strongest — proves authorship)
const userKey = await resolveUserSigningKey(pdsUrl, did, serviceDid)
const verified = await fetchAndVerifyRecord(serviceUrl, did, collection, rkey, {
  userSigningKey: userKey ?? undefined,
})

// Service-signature verification (proves service inclusion)
const serviceKey = await resolveServiceSigningKey(serviceDid)
const verified2 = await fetchAndVerifyRecord(
  serviceUrl,
  did,
  collection,
  rkey,
  {
    serviceSigningKey: serviceKey,
  },
)

// CID integrity only (no signature check)
const verified3 = await fetchAndVerifyRecord(serviceUrl, did, collection, rkey)
```

`verifyStratosRecord` keeps resolved service keys in a cache; when verification fails with a cached
key, it drops the entry and re-resolves once before retrying, so service key rotation self-heals
without a reload.

### Trust model

Record commits are signed with the user's per-enrollment P-256 key. Clients can verify a record was
authored by a specific user by checking the commit signature against the `signingKey` published in
the user's enrollment record. The enrollment attestation (signed by the service's Secp256k1 key)
binds the user's DID, boundaries, and signing key — establishing the service as the root of trust
for that binding.

Verification levels:

| Level               | What it proves                                                            |
| ------------------- | ------------------------------------------------------------------------- |
| `user-signature`    | Record was signed by the user's P-256 key (strongest — proves authorship) |
| `service-signature` | Record was signed by the Stratos service key (proves service inclusion)   |
| `cid-integrity`     | Record CID matches the commit tree (no signature check)                   |

`fetchAndVerifyRecord` prefers the user signing key when provided and falls back to the service key.

---

## 8. OAuth Scope Declarations

Stratos records use AT Protocol auth scopes. Clients should declare the scopes they need in their
OAuth metadata and scope selector UI.

### Required scopes

| Scope                                    | Description                         | Dependency                                    |
| ---------------------------------------- | ----------------------------------- | --------------------------------------------- |
| `repo:zone.stratos.actor.enrollment`     | Read/write enrollment records       | None                                          |
| `repo:zone.stratos.feed.post`            | Read/write Stratos posts            | Requires `repo:zone.stratos.actor.enrollment` |
| `rpc:zone.stratos.feedgen.getFeed?aud=*` | Call any feed generator's `getFeed` | None                                          |
| `rpc:zone.stratos.feedgen.getBlob?aud=*` | Read authorized feed attachments    | None                                          |

### Feed response records

`zone.stratos.feedgen.getFeed` returns hydrated post views from both custody
classes. A post view's `uri` is either a conventional `at://` record URI or a
permissioned space record URI. Its required `boundaries` array contains the
service-qualified boundaries used to admit that indexed record to the feed.
Clients should use `post.author.did` for attribution instead of deriving the
author from a fixed URI segment, because space record URIs place the member DID
after the space authority and key.

`post.blobs` contains authenticated attachment views (`cid`, `url`, optional `mimeType`)
for Stratos-hosted blobs. The signed record and its blob refs remain unchanged.
Call `zone.stratos.feedgen.getBlob` with the exact post `uri` and attachment `cid`.
Send the call through the authenticated PDS proxy with `atproto-proxy: <feedgenDid>#stratos_feedgen`.
Render the response through a local object URL; a direct image URL cannot carry service auth.
Missing blob views retain the existing custody-specific client path. PDS blob support is not added by this endpoint.
See [Private feed attachments](../docs/client/feedgen-blobs.md) for the full contract and cache limits.

Each post view also has `likeCount` and `repostCount`, the number of members who like or
repost the post in the feed's boundary. The Rust feed generator always returns both, with `0`
when there are none. `viewer` holds `like` and `repost`, the URIs of the viewer's own like and
repost records. A key is absent when the viewer has no such record. Use the rkey at the end of
that URI to delete it with `deleteBoundaryRecord`.

### Scope utilities

```typescript
import {
  STRATOS_SCOPES,
  buildCollectionScope,
  buildRpcScope,
  buildStratosScopes,
} from '@northskysocial/stratos-client'

// Individual scope construction
const enrollmentScope = buildCollectionScope(STRATOS_SCOPES.enrollment)
// => 'repo:zone.stratos.actor.enrollment'

// RPC scope construction (aud defaults to '*', any service)
const getFeedScope = buildRpcScope(STRATOS_SCOPES.getFeed)
// => 'rpc:zone.stratos.feedgen.getFeed?aud=*'

// Full scope set for OAuth metadata
const scopes = buildStratosScopes()
// => ['atproto',
//     'repo:zone.stratos.actor.enrollment',
//     'repo:zone.stratos.feed.post?action=create&action=delete',
//     'rpc:zone.stratos.feedgen.getFeed?aud=*',
//     'rpc:zone.stratos.feedgen.getBlob?aud=*']
```

### OAuth client metadata

Add scopes to your `oauth-client-metadata.json`:

```json
{
  "scope": "atproto repo:zone.stratos.actor.enrollment repo:zone.stratos.feed.post rpc:zone.stratos.feedgen.getFeed?aud=* rpc:zone.stratos.feedgen.getBlob?aud=*"
}
```

---

## 9. Lexicon Registration

If you use `@atcute/client` (as this guide assumes), you do **not** need to register lexicon schemas
— atcute issues schema-less typed RPC calls, so Stratos NSIDs like `zone.stratos.feed.post` resolve
without any setup.

If instead you use `@atproto/api`, its `Agent` validates requests and responses against a registered
`Lexicons` set. The base agent only knows the `com.atproto.*` and `app.bsky.*` schemas, so calls to
`zone.stratos.*` endpoints throw until you register the Stratos lexicons. The client ships a
browser-safe, dependency-free bundle for exactly this, exported from the `./lexicons` subpath:

```typescript
import { Agent } from '@atproto/api'
import { stratosLexicons } from '@northskysocial/stratos-client/lexicons'

export function configureAgent(agent: Agent): Agent {
  for (const doc of stratosLexicons) {
    try {
      agent.lex.add(doc)
    } catch {
      // already registered — keep the existing definition
    }
  }
  return agent
}

const agent = configureAgent(new Agent(session))
// zone.stratos.* records now validate against the registered schemas
```

The bundle contains only the `zone.stratos.*` lexicons — the standard `com.atproto.*` and
`app.bsky.*` definitions are already provided by the base `Agent`, so the `try/catch` simply skips
any overlap. The bundle is generated from the canonical lexicon JSON at build time (`pnpm lexgen`)
and exported from the `./lexicons` subpath to keep the package root lightweight for atcute consumers.

The bundle also includes the admin-only `zone.stratos.admin.listEnrollments` and
`zone.stratos.admin.getRepoHost` queries. These endpoints require an operator session. The former
filters by boundary, active state, or repo custody. The latter reports one repository-host resolution
per member space; a PDS-custody member's stored host overrides every one of their spaces.

---

## 10. CORS and Header Requirements

Browser clients making cross-origin requests to a Stratos service depend on correct CORS
configuration. This is especially critical because the Stratos service is a different origin from
the user's PDS.

### Required CORS headers

Stratos services using `@atcute/xrpc-server` get correct CORS behavior from the built-in middleware,
which configures:

**Exposed response headers** (via `Access-Control-Expose-Headers`):

- `dpop-nonce` — required for DPoP nonce rotation
- `www-authenticate` — required for DPoP error recovery (e.g., `use_dpop_nonce`)
- `ratelimit-limit`, `ratelimit-policy`, `ratelimit-remaining`, `ratelimit-reset`

**Allowed request headers** (via `Access-Control-Allow-Headers`):

- `authorization` — carries the DPoP-bound access token
- `dpop` — carries the DPoP proof JWT
- `signature`, `signature-input`, `atproto-space-audience` — standard space credentials
- `content-type`
- `atproto-accept-labelers`, `atproto-proxy`

### Why this matters

When a browser client sends a DPoP-authenticated request to a Stratos service at a different origin:

1. The browser performs a CORS preflight (`OPTIONS`) request
2. The Stratos service must respond with `Access-Control-Allow-Headers` including `authorization`
   and `dpop`
3. On the actual response, `Access-Control-Expose-Headers` must include `dpop-nonce` so the client
   can read the server's nonce for subsequent requests
4. If `www-authenticate` is not exposed, the client cannot parse DPoP error details (like
   `use_dpop_nonce`) from 401 responses

### If you run your own Stratos service

If using `@atproto/xrpc-server`, the defaults are correct. If using another framework directly,
configure:

```typescript
app.use((req, res, next) => {
  const origin = req.headers.origin || '*'
  res.header('Access-Control-Allow-Origin', origin)
  res.header(
    'Access-Control-Allow-Headers',
    'authorization, dpop, signature, signature-input, atproto-space-audience, content-type, atproto-accept-labelers, atproto-proxy',
  )
  res.header('Access-Control-Expose-Headers', 'dpop-nonce, www-authenticate')
  if (req.method === 'OPTIONS') {
    res.header('Access-Control-Max-Age', '86400')
    return res.sendStatus(204)
  }
  next()
})
```

### Failure symptoms

| Missing header                         | Symptom                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `dpop` not in allowed headers          | Preflight fails; all authenticated requests return CORS errors              |
| `dpop-nonce` not exposed               | Client cannot read nonce; subsequent DPoP proofs use stale nonce → 401 loop |
| `www-authenticate` not exposed         | Client cannot parse `use_dpop_nonce` error; falls into generic auth failure |
| `authorization` not in allowed headers | Access token never sent; all requests return 401                            |

---

## 11. Known Pitfalls

### Async discovery race condition

If enrollment discovery is fire-and-forget, account switches can cause stale enrollment data:

```typescript
// Problem: if user switches accounts before discovery completes,
// setEnrollment updates state for the wrong account
getEnrollmentByServiceDid(did, pds, serviceDid)
  .then(setEnrollment)
  .catch(() => setEnrollment(null))
```

Key discovery to the active session and cancel on account change:

```typescript
// React pattern
useEffect(() => {
  let cancelled = false
  getEnrollmentByServiceDid(did, pds, serviceDid).then((enrollment) => {
    if (!cancelled) setEnrollment(enrollment)
  })
  return () => {
    cancelled = true
  }
}, [did, serviceDid])
```

### Global mode state leakage

If Stratos active/inactive is stored as app-global state, unrelated views can inadvertently route to
the wrong service. Prefer scoping the mode to a specific context or view rather than making it
global — or guard every routing decision with an explicit mode check.

### Verification level ambiguity

Stratos mode may fall back from full MST verification to CID-only verification. This should be
clearly communicated to users — "CID verified" means data integrity is confirmed but the commit
chain and signature are not verified. Don't label CID-only verification as "verified" without
qualification.

### Empty repo vs. error masking

For Stratos custody, the service initializes a signed empty commit at enrollment time, so the user
has a valid repository from the start. `RepoNotFound` for a Stratos-custody user is an error — it no longer
indicates "no records yet." Possible causes:

- The Stratos service is unreachable or misconfigured
- Authentication failed silently
- The actor store was not properly initialized during enrollment

An empty `collections` list from `describeRepo` is the normal state for a user who hasn't created
records yet. Differentiate by checking HTTP status codes explicitly rather than catching all errors
as "empty."

### DPoP `htu` claim accuracy

The DPoP proof's `htu` claim must match the actual request URL. When routing through a service fetch
handler, ensure the absolute URL is passed to the agent's `handle()` method — not a relative path —
so the DPoP proof targets the correct origin. The `@atcute/oauth-browser-client` agent derives `htu`
from the URL it receives.

### Blob operations

`com.atproto.sync.getBlob` is implemented by Stratos and follows boundary-based access control.
Space-scoped blob listing via `zone.stratos.space.listBlobs` is available. For more details, see
the [Blob support](#6-blob-support) section.

---

## 12. social-app Mapping

For a React Native/Expo app like Bluesky's social-app:

### State layer

| Concept            | social-app location           | Pattern                                                                                                   |
| ------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| Enrollment state   | `src/state/stratos.tsx` (new) | React Context with `StratosEnrollment \| null \| undefined`                                               |
| Active mode toggle | `src/state/stratos.tsx` (new) | Boolean state with setter                                                                                 |
| Discovery trigger  | `src/state/session/index.tsx` | Call `getEnrollmentByServiceDid` from `@northskysocial/stratos-client` in `resumeSession` / `login` flows |
| Cleanup on logout  | `src/state/session/index.tsx` | Reset enrollment and active state in logout handler                                                       |

### Query hooks

| Hook                     | Location                             | Implementation                                  |
| ------------------------ | ------------------------------------ | ----------------------------------------------- |
| `useStratosEnrollment()` | `src/state/stratos.tsx`              | Context consumer returning enrollment state     |
| `useStratosActive()`     | `src/state/stratos.tsx`              | Context consumer returning active boolean       |
| `useStratosClient()`     | `src/state/queries/stratos.ts` (new) | Returns correctly-routed `Client` based on mode |

### Agent/transport

In `src/state/session/agent.ts`, the `BskyAppAgent` wraps transport. In a query hook, select a
repository target with `resolveRepositoryTarget` before constructing a client. For `stratos`
custody, use the authority URL and repo methods; for `pds` custody, use the authenticated PDS URL
and space methods. See [Service Routing](#2-service-routing) for the complete write example.

### View integration

| View            | Integration point                  | What changes                                                |
| --------------- | ---------------------------------- | ----------------------------------------------------------- |
| Post thread     | `src/screens/PostThread/index.tsx` | Hydrate from Stratos when viewing boundary-scoped posts     |
| Feed            | `src/state/queries/post-feed.ts`   | Include Stratos records in feed via hydration               |
| Settings        | `src/screens/Settings/`            | Stratos enrollment status, mode toggle                      |
| Record creation | Post composer                      | Call `createBoundaryRecord`; it selects the host by custody |

### Key differences from pdsls

| Aspect              | pdsls (SolidJS)        | social-app (React)                   |
| ------------------- | ---------------------- | ------------------------------------ |
| State               | `createSignal()`       | React Context / `useState`           |
| Reactivity          | Signal auto-tracking   | Query key invalidation / `useEffect` |
| Refetch trigger     | Resource source signal | Query key includes `stratosActive`   |
| Client construction | Per-call               | `useMemo` with deps or query hook    |

---

## 13. Minimum Viable Adoption Path

For apps that want to add basic Stratos support incrementally:

### Step 1: Read-only hydration

1. Add enrollment discovery to session establishment
2. Store enrollment state
3. Add a Stratos mode toggle (settings or UI chrome)
4. For Stratos-custody records, route `getRecord` / `listRecords` through the authority client;
   for PDS-custody space records, use the trusted PDS target
5. Handle empty Stratos-custody collections gracefully (the enrolled repo may have no records yet)

### Step 2: Write routing

1. Write through `createBoundaryRecord` and the other helpers in
   [Write Path Integration](#5-write-path-integration). They select the host by custody
2. Add scope declarations to OAuth metadata
3. Add scope selector UI with dependency gating

### Step 3: Verification

1. Implement two-tier verification for Stratos records
2. Surface verification level in UI

### Step 4: Rich features

1. Boundary-aware UI (show boundary chips, filter by boundary)
2. AppView-side hydration for feed integration
3. Blob support (implemented via `com.atproto.sync.getBlob`)

### Administrative boundary history

The generated lexicon bundle includes `zone.stratos.admin.listBoundaryOps` and
`zone.stratos.admin.getBoundaryAuditState`. Both require an OAuth admin session;
ordinary user or service tokens cannot read private membership history.

`listBoundaryOps` pages authority-signed operations for one actor using a DID-bound
sequence/hash cursor. `getBoundaryAuditState` returns a signed current-state
checkpoint for recovery after `BoundaryHistoryTruncated`. These are authority
operations, separate from user-signed repository commits, and work with both
Stratos and PDS custody. See [Boundary History](../docs/operator/boundary-history.md)
for signature verification, replay, retention, and trust requirements.

### Moderation takedown labels

`zone.stratos.moderation.createLabel` is for an allowlisted moderation service,
not for ordinary clients. The service calls it with an inter-service JWT whose
`iss` is on the host's `STRATOS_MODERATION_SERVICE_DIDS` list and whose `lxm` is
`zone.stratos.moderation.createLabel`. User, admin, plain service and
space-credential callers get a 401.

The procedure takes `subject`, `val`, and optional `neg` and `ref`. `val` must
be `!takedown`. Set `neg: true` to lift a takedown.

- **Hosted record:** use the repo-form URI, `at://{did}/{collection}/{rkey}`.
  Reads stop serving the record at once. `SubjectNotFound` means the hosted record
  does not exist. If the call fails after Stratos has hidden the record, it
  stays hidden. Repeat the same request to finish it. A negation records its
  label first and lifts the hiding after, so a failed negation also leaves the
  record hidden.
- **Member's PDS record:** use the seven-segment space-form URI. Stratos records
  the label. Stratos cannot hide a record that it does not host.
- **Account subject:** use `{ "$type": "zone.stratos.moderation.defs#accountSubject", "did": "{did}" }`.
  A takedown deactivates the member's enrollment. A negation reactivates it only
  when no operator hold is set. Stratos writes no record or blob marker.
  `SubjectNotFound` means the DID has no enrollment. Stratos rejects a service
  enrollment as an account subject. This works for both custody classes.

Stratos rejects a space-form subject when:

- its authority is another service;
- its boundary is unknown;
- the author is not an active member of the boundary;
- the author's records are hosted by Stratos; use the repo-form URI.

A negation of a takedown in force skips the membership check. It does not skip the custody check.

The response `label` is absent when the request changed nothing and the subject
has no label. A repeat of the label in force returns that label.

To read labels back, see `queryLabels` below.

#### Account takedowns and the operator hold

A member has two separate holds. Either one leaves the member inactive.

- An operator sets the operator hold with `zone.stratos.admin.setActive` and
  `active: false`. `active: true` clears it.
- An account takedown label sets the takedown hold. A negation clears it.
- The holds are independent. Clearing one never clears the other.
- While an account takedown is in force, `setActive` with `active: true` fails
  with `AccountTakenDown`. It changes nothing.
- `setActive` does not add an event to the sync streams.

Members who were inactive when the operator hold was introduced became
operator-held once.

An inactive member cannot write. `createRecord`, `deleteRecord`,
`applyWrites` and `uploadBlob` are all refused with `NotEnrolled` before the
handler runs. Stratos has no separate `updateRecord` route. Updates go through
`applyWrites`.

An inactive member who completes OAuth gets 403 `EnrollmentDenied` with the
message "Your enrollment on this Stratos service is not active". Nothing
changes. An inactive member also cannot unenroll. `POST /oauth/revoke` and
`zone.stratos.enrollment.unenroll` both refuse. The member can leave once the
hold lifts.

#### Reading labels with `queryLabels`

`zone.stratos.moderation.queryLabels` pages the label log in `seq` order. `createLabel`
writes the labels that this method returns.

Parameters:

- `cursor`: a label `seq` as a decimal string. Omit it to start at the
  beginning.
- `limit`: 1 to 250. The default is 50.
- `subjects`: up to 100 record URIs or account DIDs. Stratos returns labels on
  these subjects only. An empty list sent as repeated empty params is
  rejected. A single empty `subjects=` or an omitted field reads the caller's
  whole scoped log.

The response always carries a `cursor`. Poll again from it. A page can hold
fewer labels than `limit`, or none, while more remain.

A subject matches the exact URI. A space-form subject must use the real URI of
the record, including its space type. A subject that is out of scope looks the
same as a subject with no labels.

Moderation services must bind `lxm` to `zone.stratos.moderation.queryLabels`.
Other services authenticate with ordinary service auth.

A moderation service reads every label. A service that holds a service
enrollment reads a record label only if it shares a boundary with the label. A
record label with no boundaries is visible only to moderation services.

An account label comes back with an `accountSubject` that carries the member's
DID.

A service that holds a service enrollment reads an account label if it shares a
boundary with the member's enrollment. The enrollment can be active or not. It
never reads an account label when the member has no enrollment. The reserved
all-members boundary makes the account label of every enrolled member visible
to every service holding a service enrollment. It also makes every record
label that carries it visible.

Errors:

- `InvalidRequest`: the `cursor` or `subjects` is malformed. An empty
  `subjects` list is malformed.
- Auth errors: a service with no active enrollment, a service with no
  boundaries, a caller whose enrollment is not a service enrollment (for
  example a member who mints a service-auth JWT for their own DID), and every
  user, admin and space-credential caller, get a 401. An operator grants a
  service enrollment by listing the service in `STRATOS_SERVICE_ENROLLMENTS`.
  A moderation service with a wrong audience, an expired token, or a bad
  signature gets the ordinary service-auth message.

#### Takedown and `subscribeRecords` and `listRepoOps`

A takedown changes what the sync streams send. Stratos checks each record when
it reads the frames.

- `subscribeRecords` and `listRepoOps` leave out the create and update ops of a
  record that is taken down now.
- Stratos skips an event that has no ops left.
- Delete ops always pass the takedown filter. The boundary scope rules still
  apply to them. Your copy of a taken-down record can still be removed.
- A takedown never adds an event to either stream. Read labels with
  `queryLabels`.
- After a negation, a replay serves the record again.

A takedown applies to sync frames that Stratos reads after it. A page that
Stratos already read can still deliver the record once. Apply labels in your
consumer.

Deleting a taken-down record that carries a boundary sends a delete event.
Subscribers in the record's boundaries receive it. This holds for a single
delete and for a delete in a batch.

After a taken-down record is deleted, sync replays still leave out its create
and update ops while the latest label is a takedown.

One limit applies:

- An author can delete a taken-down record and create a new one at the same
  URI. The new record has no takedown, so Stratos serves it. While it exists,
  sync replays serve it and the earlier history of that URI. If the author
  deletes it again, replays leave out every create and update for the URI while
  its latest label is a takedown. The delete op still arrives. If you apply
  labels by URI, you still refuse the new record. A moderation service repeats
  `createLabel` to hide it on the host.
