---
audience: App developers
type: How-to and reference
status: current
---

# User Enrollment

Enrollment is how a user joins a Stratos service. The user signs in through
OAuth, Stratos records their boundaries, and Stratos writes an enrollment
record to the user's PDS.

Your app does two things with enrollment. It reads the record to find out
where the user stands. It starts the OAuth flow when the user has no record.

## Enrollment record

Stratos publishes one `zone.stratos.actor.enrollment` record per service on
the user's PDS. The record key is the service DID:

```text
at://did:plc:abc123/zone.stratos.actor.enrollment/did:web:stratos.example.com
```

A user enrolled in two Stratos services has two records.

A `stratos`-custody record:

```json
{
  "service": "https://stratos.example.com",
  "boundaries": [
    { "value": "did:web:stratos.example.com/general" },
    { "value": "did:web:stratos.example.com/writers" }
  ],
  "signingKey": "did:key:zDnae...",
  "attestation": {
    "sig": { "$bytes": "base64..." },
    "signingKey": "did:key:zQ3sh...",
    "issuedAt": "2025-01-15T00:00:00.000Z"
  },
  "custody": "stratos",
  "createdAt": "2025-01-15T00:00:00.000Z"
}
```

A `pds`-custody record differs in three fields:

```json
{
  "signingKey": "did:key:zQ3sh...",
  "custody": "pds",
  "repoHost": "https://pds.example.com"
}
```

| Field                    | Type                       | Description                                                                                                |
| ------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `service`                | `string` (URI)             | The Stratos service endpoint. A hint; route by your own configuration.                                     |
| `boundaries`             | `Array<{ value: string }>` | The user's boundaries, each `{serviceDid}/{name}`. At most 50.                                             |
| `signingKey`             | `string` (did:key)         | `stratos` custody: a P-256 key that Stratos generates and holds. `pds` custody: the user's `#atproto` key. |
| `attestation`            | object                     | The service's signature over the enrollment.                                                               |
| `attestation.sig`        | `bytes`                    | Signature over DAG-CBOR `{boundaries, did, signingKey, issuedAt}` with sorted boundaries.                  |
| `attestation.signingKey` | `string` (did:key)         | The service key that made the signature.                                                                   |
| `attestation.issuedAt`   | `string` (datetime)        | Signed issue time. Older attestations omit it from the record and the payload.                             |
| `custody`                | `string`                   | `stratos` or `pds`. An absent field means `stratos`.                                                       |
| `repoHost`               | `string` (URI)             | The repo host for `pds` custody. Absent for `stratos` custody. Not covered by the attestation.             |
| `createdAt`              | `string` (datetime)        | When the enrollment was created.                                                                           |

For `stratos` custody, enrollment also creates the user's Stratos repo with an
empty signed commit, and a signing key for it. The repo is valid before the
first post. For `pds` custody, Stratos creates no repo and no key.

Every enrollment includes the reserved all-members boundary. See
[Boundaries](/client/boundaries#the-all-members-boundary).

## Checking enrollment

### From the user's PDS

```typescript
import { getEnrollmentByServiceDid } from '@northskysocial/stratos-client'
import type { StratosEnrollment } from '@northskysocial/stratos-client'

async function findEnrollment(
  userDid: string,
  pdsUrl: string,
): Promise<StratosEnrollment | null> {
  return getEnrollmentByServiceDid(
    userDid,
    pdsUrl,
    'did:web:stratos.example.com',
  )
}
```

The second argument is a PDS URL or a `FetchHandler`. The function calls
`com.atproto.repo.getRecord` with the service DID as the record key. It
returns `null` when the record is missing or invalid.

The returned `StratosEnrollment` has `service`, `custody`, `repoHost`,
`boundaries`, `signingKey`, `attestation`, `createdAt`, and `rkey`.

To list every enrollment, use `discoverEnrollments`. Then pick one with
`findEnrollmentByService`:

```typescript
import {
  discoverEnrollments,
  findEnrollmentByService,
} from '@northskysocial/stratos-client'

async function findByServiceUrl(userDid: string, pdsUrl: string) {
  const enrollments = await discoverEnrollments(userDid, pdsUrl)
  return findEnrollmentByService(enrollments, 'https://stratos.example.com')
}
```

`discoverEnrollments` is all-or-nothing. It returns an empty array when any
page request fails. `discoverEnrollment` (singular) is deprecated.

Run discovery when a session starts and cache the result for the session.
Reset it on logout and on account switch.

### Record keys for services with a port

A record key cannot contain `%`, but a `did:web` with a port does.
`serviceDIDToRkey` converts it. The discovery functions call it for you.

```typescript
import { serviceDIDToRkey } from '@northskysocial/stratos-client'

serviceDIDToRkey('did:web:stratos.example.com') // 'did:web:stratos.example.com'
serviceDIDToRkey('did:web:localhost%3A3100') // 'did:web:localhost:3100'
```

### From the Stratos service

The PDS record is a published copy. The service holds the live state:

```typescript
async function isUserEnrolled(
  stratosUrl: string,
  did: string,
): Promise<boolean> {
  const url = new URL('/xrpc/zone.stratos.enrollment.status', stratosUrl)
  url.searchParams.set('did', did)
  const response = await fetch(url.href)
  if (!response.ok) return false
  const data: { enrolled?: boolean } = await response.json()
  return data.enrolled === true
}
```

The response depends on the caller:

| Case                     | Response                                                                    |
| ------------------------ | --------------------------------------------------------------------------- |
| Enrolled, anonymous call | `{ did, enrolled: true, active, enrolledAt, signingKey, enrollmentRkey }`   |
| Enrolled, DPoP call      | The same, plus `boundaries`, and `attestation` when the DID has a boundary. |
| Not enrolled             | `{ did, enrolled: false, eligible }`                                        |

`eligible: true` means the DID may enroll. Stratos omits `eligible` when it
cannot finish the check. Do not read a missing `eligible` as a refusal.

Two more public queries need no authentication:

- `zone.stratos.identity.resolveEnrollments?did=<did>` returns
  `{ did, enrolled, boundaries }` with boundaries as strings.
- `zone.stratos.server.listDomains` returns `{ domains }`, every boundary on
  the service.

## Verifying the attestation

The attestation proves that the service signed this enrollment. Pass the
service DID from your configuration, never from the record:

```typescript
import { verifyEnrollmentAttestation } from '@northskysocial/stratos-client'
import type { StratosEnrollment } from '@northskysocial/stratos-client'

async function assertAttested(
  enrollment: StratosEnrollment,
  userDid: string,
): Promise<void> {
  const result = await verifyEnrollmentAttestation(enrollment, userDid, {
    serviceDid: 'did:web:stratos.example.com',
  })
  if (!result.valid) throw new Error(result.error ?? 'Invalid attestation')
}
```

The function never throws. A failed check returns `valid: false` with an
`error`.

The attestation covers `boundaries`, the user DID, `signingKey`, and
`issuedAt`. It does not cover `custody` or `repoHost`.
[Attestation Verification](/client/attestation) explains the trust model.

## Initiating enrollment

Redirect the browser to the Stratos authorize route:

```typescript
function startEnrollment(stratosUrl: string, handle: string): void {
  const url = new URL('/oauth/authorize', stratosUrl)
  url.searchParams.set('handle', handle)
  // Where Stratos returns the browser after enrollment.
  url.searchParams.set('redirect_uri', `${window.location.origin}/`)
  // Your client metadata document. Stratos reads it to confirm that you own
  // the redirect target.
  url.searchParams.set(
    'client_id',
    `${window.location.origin}/client-metadata.json`,
  )
  window.location.href = url.toString()
}
```

| Parameter      | Required | Description                                         |
| -------------- | -------- | --------------------------------------------------- |
| `handle`       | Yes      | The user's handle.                                  |
| `redirect_uri` | No       | Where the browser returns after enrollment.         |
| `client_id`    | No       | URL of your client metadata document.               |
| `room`         | No       | A room id. See [Room enrollment](#room-enrollment). |

To use `redirect_uri`, serve a client metadata document at your `client_id`
URL. The `client_id` URL must:

- use `https`
- include a path. `https://app.example` is rejected.
  `https://app.example/client-metadata.json` is accepted.
- carry no fragment
- name a hostname, not an IP address

The document must name itself in `client_id` and declare the redirect
target's origin:

```json
{
  "client_id": "https://app.example/client-metadata.json",
  "client_uri": "https://app.example",
  "redirect_uris": ["https://app.example/"],
  "scope": "atproto",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "application_type": "web",
  "dpop_bound_access_tokens": true
}
```

Stratos reads only `client_id` and `redirect_uris`. AT Protocol requires the
other fields of every OAuth client. Stratos compares origins, so any path on a
declared origin is accepted. Most apps already publish this document for
their own OAuth sign-in.

## Handling the result

### Success

With a `redirect_uri`, Stratos returns the browser there and appends
`?stratos_enrolled=true`. No token, authorization code, or DID is placed on
that URL.

```typescript
function wasEnrollmentRedirect(): boolean {
  const params = new URLSearchParams(window.location.search)
  return params.get('stratos_enrolled') === 'true'
}
```

After the redirect, run discovery again to load the new enrollment.

Without a `redirect_uri`, the callback answers with JSON on the Stratos
origin:

```json
{
  "success": true,
  "did": "did:plc:abc123",
  "enrolled": true,
  "message": "Successfully enrolled in Stratos"
}
```

`enrolled` is `false` when the user was enrolled already.

### Failure

Stratos does not redirect on failure. The browser stays on the Stratos origin
and sees a JSON error. Your app receives no `error` query parameter.

| Step      | Status | `error`              | Cause                                                          |
| --------- | ------ | -------------------- | -------------------------------------------------------------- |
| authorize | 400    | `InvalidRequest`     | Missing `handle`, unknown room, or a rejected `redirect_uri`.  |
| authorize | 400    | `AuthorizationError` | The handle did not resolve.                                    |
| callback  | 403    | `EnrollmentDenied`   | The account is not eligible, for example not on the allowlist. |
| callback  | 400    | `InvalidState`       | Invalid room enrollment state.                                 |
| callback  | 500    | `CallbackError`      | The authorization did not complete.                            |

### Complete flow

```typescript
async function ensureEnrolled(
  stratosUrl: string,
  userHandle: string,
  userDid: string,
): Promise<boolean> {
  if (await isUserEnrolled(stratosUrl, userDid)) return true
  startEnrollment(stratosUrl, userHandle)
  return false
}
```

## Room enrollment

A room is a boundary that the operator lists publicly. A user can ask to join
one during enrollment.

List the rooms with `zone.stratos.server.listRooms`. It needs no
authentication:

```json
{
  "rooms": [
    {
      "id": "writers",
      "boundary": "did:web:stratos.example.com/writers",
      "displayName": "Writers",
      "description": "Drafts and feedback",
      "available": true
    }
  ]
}
```

Add `room=<id>` to the authorize URL. A room request requires `redirect_uri`.
An unknown or unavailable room fails with `400 InvalidRequest`.

After a room enrollment, the redirect carries two parameters:
`stratos_enrolled=true` and `stratos_enrollment=pending`. Stratos reports the
room membership as pending reconciliation. Do not assume the boundary is
active yet. Check the authenticated status query until the boundary appears.

## Unenrolling

`zone.stratos.enrollment.unenroll` removes the user from the service. It is a
procedure with an empty JSON body and DPoP authentication:

```typescript
import type { OAuthSession } from '@atproto/oauth-client-browser'

async function unenroll(
  session: OAuthSession,
  stratosUrl: string,
): Promise<void> {
  const url = new URL('/xrpc/zone.stratos.enrollment.unenroll', stratosUrl)
  const response = await session.fetchHandler(url.href, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (!response.ok) throw new Error(`Unenroll failed (${response.status})`)
}
```

Unenrolling is a hard delete. Stratos deletes the enrollment record from the
user's PDS, the enrollment, the Stratos-hosted records, and the signing key.
It then revokes its OAuth session. Warn the user first.

## OAuth scopes

Two different OAuth clients are involved. Keep them apart.

- **The Stratos enrollment client.** Stratos itself asks the user for
  permission during enrollment. You do not configure this.
- **Your app's client.** Your app asks for the scopes it needs to call
  Stratos, the feed generator, and the user's PDS.

### Scopes for your app

`buildStratosScopes()` returns the standard set:

```typescript
import {
  STRATOS_SCOPES,
  buildCollectionScope,
  buildRpcScope,
  buildStratosScopes,
} from '@northskysocial/stratos-client'

const scopes = buildStratosScopes()
// [
//   'atproto',
//   'repo:zone.stratos.actor.enrollment',
//   'repo:zone.stratos.feed.post?action=create&action=delete',
//   'rpc:zone.stratos.feedgen.getFeed?aud=*',
//   'rpc:zone.stratos.feedgen.getBlob?aud=*',
// ]

const enrollmentScope = buildCollectionScope(STRATOS_SCOPES.enrollment)
// 'repo:zone.stratos.actor.enrollment'

const feedScope = buildRpcScope(STRATOS_SCOPES.getFeed)
// 'rpc:zone.stratos.feedgen.getFeed?aud=*'
```

| Scope                                                     | Used for                                              |
| --------------------------------------------------------- | ----------------------------------------------------- |
| `atproto`                                                 | Identity. Required by every AT Protocol client.       |
| `repo:zone.stratos.actor.enrollment`                      | Enrollment records.                                   |
| `repo:zone.stratos.feed.post?action=create&action=delete` | Private posts.                                        |
| `rpc:zone.stratos.feedgen.getFeed?aud=*`                  | Calling a feed generator's `getFeed`.                 |
| `rpc:zone.stratos.feedgen.getBlob?aud=*`                  | Downloading feed attachments.                         |
| `space:zone.stratos.space.feed?...`                       | Writing to a space on the user's PDS (`pds` custody). |

`buildStratosScopes()` does not include the space scope. Build it with
`buildSpaceWriteScope` from `@northskysocial/stratos-browser`. See
[Space scope](/client/custody#space-scope).

Declare the scopes in your client metadata as one space-separated string:

```typescript
import { buildStratosScopes } from '@northskysocial/stratos-client'

const scope = buildStratosScopes().join(' ')
```

### Enrollment space grant and custody

The Stratos enrollment client requests `atproto`, the enrollment record write
scope, and a space scope for its own authority. The space scope covers
`zone.stratos.space.feed`, collection `zone.stratos.feed.post`, and both
`read` and `create`. It omits `skey` so future boundary memberships remain
covered. A scope permits operations; Stratos boundary membership still
controls access.

Successful OAuth authorization does not establish spaces capability. The
callback reads the granted scope and checks the actual permissions. A grant
for another authority, space type, collection, or only one action does not
satisfy the request.

| Granted scope                                    | Capability verdict | New enrollment custody |
| ------------------------------------------------ | ------------------ | ---------------------- |
| Matching space read and create permissions       | `capable`          | `pds`                  |
| Missing, partial, unrelated, or unreadable grant | `unknown`          | `stratos`              |

An absent grant can mean an ordinary PDS ignored the space request or a user
withheld consent. It does not prove the PDS lacks spaces support. Stratos
records `unknown`, and the user enrolls with `stratos` custody.

Reauthorization preserves existing custody, signing keys, and records.
Missing consent never moves a PDS-hosted repo to Stratos. Granting space
access later never moves a Stratos-hosted repo to the PDS. Either custody
change requires an explicit data migration. Stratos remains the space
authority for both custody classes.

## Troubleshooting

_`NotEnrolled` after completing OAuth_: the service has an allowlist. Check
`eligible` in the status response and contact the operator.

_The redirect fails with `400 InvalidRequest`_: see
[Enrollment Redirect Fails](/client/troubleshooting#enrollment-redirect-fails).
