---
audience: App developers
type: Explanation and how-to
status: current
---

# Custody and Routing

Custody says who holds a user's private records: the Stratos service, or the
user's own PDS. Membership works the same for both. Only the storage differs.

Your app must know which one holds a user's records before it reads or
writes.

## The two custody classes

| Custody   | Who hosts the repo  | Who signs commits                   | Write methods                           |
| --------- | ------------------- | ----------------------------------- | --------------------------------------- |
| `stratos` | The Stratos service | Stratos, with a per-user P-256 key  | `com.atproto.repo.*` on Stratos         |
| `pds`     | The user's own PDS  | The user, with their `#atproto` key | `com.atproto.space.*` on the user's PDS |

Stratos is the space authority for both classes. It decides who belongs to a
boundary. For `pds` custody it does not hold the records.

Stratos sets custody once, at enrollment. A PDS that grants the Stratos space
scope gets `pds` custody. Every other PDS gets `stratos` custody.
Reauthorization never changes custody. See
[Enrollment space grant and custody](/client/enrollment#enrollment-space-grant-and-custody).

## Reading custody from the enrollment

The enrollment record on the user's PDS carries two routing fields:

| Field      | Meaning                                                           |
| ---------- | ----------------------------------------------------------------- |
| `custody`  | `stratos` or `pds`. A record without the field means `stratos`.   |
| `repoHost` | The PDS endpoint for `pds` custody. Absent for `stratos` custody. |

`getEnrollmentByServiceDid` and `discoverEnrollments` return both fields on
`StratosEnrollment`. The parser keeps an unknown `custody` string as it is, so
routing can refuse it. It keeps `repoHost` only for `pds` custody, and only
when the value is a bare `https` origin.

::: warning repoHost is a hint
The service attestation covers the boundaries, the DID, and the signing key.
It does not cover `custody` or `repoHost`. Anyone who can write to the user's
PDS can change them. Never send credentials to `repoHost` or to
`enrollment.service` because the record names them.
:::

## Resolving the repository target

`resolveRepositoryTarget` picks the host. It reads only `custody` from the
enrollment. Every URL comes from you:

```typescript
import {
  getEnrollmentByServiceDid,
  resolveRepositoryTarget,
} from '@northskysocial/stratos-client'
import type { RepositoryTarget } from '@northskysocial/stratos-client'

// Both values come from your app configuration.
const STRATOS_URL = 'https://stratos.example.com'
const STRATOS_DID = 'did:web:stratos.example.com'

async function resolveTarget(
  userDid: string,
  sessionPdsUrl: string,
): Promise<RepositoryTarget> {
  const enrollment = await getEnrollmentByServiceDid(
    userDid,
    sessionPdsUrl,
    STRATOS_DID,
  )
  return resolveRepositoryTarget(enrollment, {
    authorityServiceUrl: STRATOS_URL,
    sessionPdsUrl,
  })
}
```

`sessionPdsUrl` is the PDS endpoint of the signed-in session. It is the
`#atproto_pds` service endpoint in the user's DID document.

The second argument has three optional fields:

| Field                   | Use                                                           |
| ----------------------- | ------------------------------------------------------------- |
| `authorityServiceUrl`   | The Stratos service URL. Used for `stratos` custody.          |
| `authoritativeRepoHost` | A repo host that the authority reported. Preferred for `pds`. |
| `sessionPdsUrl`         | The PDS of the signed-in session. Fallback for `pds`.         |

The result is one of three shapes:

| `kind`       | Meaning                                    |
| ------------ | ------------------------------------------ |
| `stratos`    | Send `com.atproto.repo.*` calls to `url`.  |
| `pds`        | Send `com.atproto.space.*` calls to `url`. |
| `unresolved` | Do not send anything. `reason` says why.   |

Each trusted URL must be a bare `https` origin: no path, query, fragment, or
credentials. The function fails closed with one of these reasons:

| `reason`               | Cause                                                                     |
| ---------------------- | ------------------------------------------------------------------------- |
| `missing-enrollment`   | The enrollment is `null`.                                                 |
| `unsupported-custody`  | `custody` is neither `stratos` nor `pds`.                                 |
| `missing-trusted-host` | You passed no URL for this custody class.                                 |
| `invalid-trusted-host` | The URL is not a bare `https` origin.                                     |
| `host-mismatch`        | `authoritativeRepoHost` and `sessionPdsUrl` are both set and they differ. |

`resolveServiceUrl` is a different helper. It returns `enrollment.service`,
the authority URL. It does not select a repository host.

## Two record addresses

Custody also decides the shape of a record URI. A `stratos`-custody record
keeps the familiar three segments. A `pds`-custody record lives in a space.
Its URI has seven segments and starts with the authority. The author is the
fifth segment.

<RecordUri kind="space" />

The space itself is the first four segments. The boundary
`did:web:stratos.example.com/engineering` is the space
`at://did:web:stratos.example.com/space/zone.stratos.space.feed/engineering`.
[Permissioned Spaces](/architecture/permissioned-spaces) explains the mapping.

`stratos-client` does not export a space URI parser. The grammar lives in
`@northskysocial/stratos-core/spaces` (`boundaryToSpaceUri`, `parseRecordUri`,
`formatSpaceUri`). The webapp imports it from there.

## Writing by custody

### Stratos custody

Send repo methods to the Stratos service with the user's DPoP session:

```typescript
import { Client } from '@atcute/client'
import { createServiceFetchHandler } from '@northskysocial/stratos-client'
import type { FetchHandler } from '@northskysocial/stratos-client'

function createStratosClient(
  authenticatedHandler: FetchHandler,
  targetUrl: string,
): Client {
  return new Client({
    handler: createServiceFetchHandler(authenticatedHandler, targetUrl),
  })
}
```

`authenticatedHandler` is the fetch handler of your OAuth session. It attaches
the access token and the DPoP proof. Call this only when
`target.kind === 'stratos'`.

Stratos refuses repo writes from a `pds`-custody user. `createRecord`,
`deleteRecord`, and `applyWrites` all answer `400 PdsCustodyWriteForbidden`.

### PDS custody

Send space methods to the user's own PDS. The webapp does it with the session
fetch handler, which already targets that PDS:

```typescript
import type { OAuthSession } from '@atproto/oauth-client-browser'

async function createSpacePost(
  session: OAuthSession,
  spaceUri: string,
  text: string,
): Promise<void> {
  const response = await session.fetchHandler(
    '/xrpc/com.atproto.space.createRecord',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        space: spaceUri,
        repo: session.sub,
        collection: 'zone.stratos.feed.post',
        validate: false,
        record: {
          $type: 'zone.stratos.feed.post',
          text,
          createdAt: new Date().toISOString(),
        },
      }),
    },
  )
  if (!response.ok) {
    throw new Error(`PDS write failed (${response.status})`)
  }
}
```

The record carries no `boundary` field. The space names the boundary.

Deletion uses `com.atproto.space.deleteRecord` with `space`, `repo`,
`collection`, and `rkey` in the body.

Both calls need a space scope on the session. See
[Space scope](#space-scope) below.

::: warning A boundary on a PDS record is a claim
Never grant access from a boundary written inside a PDS-hosted record. Take
the boundary from Stratos enrollment state, as the feed generator does. See
the [three custody rules](/operator/architecture#three-rules).
:::

## Reading by custody

| Custody   | Read path                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------ |
| `stratos` | `com.atproto.repo.getRecord`, `listRecords`, `zone.stratos.repo.hydrateRecord(s)` on Stratos.          |
| `pds`     | The feed generator (`zone.stratos.feedgen.getFeed`). It syncs member PDS spaces and checks membership. |

The feed generator serves both custody classes in one feed. See
[Reading Records](/client/reading-records) and
[Private Feed Attachments](/client/feedgen-blobs).

## Space scope

A `pds`-custody write needs this scope on the user's OAuth session:

```text
space:zone.stratos.space.feed?authority={serviceDid}&collection=zone.stratos.feed.post&action=read&action=create
```

Add `action=delete` to let users delete their posts. Build the string with
`buildSpaceWriteScope` instead of typing it. The authority DID must be
percent-encoded, and the helper does that.

A PDS without spaces support ignores the scope. Check the granted scope before
you offer a PDS-custody write.

## Browser helpers: stratos-browser

The webapp does its OAuth and DPoP work through
`@northskysocial/stratos-browser`. It wraps `@atproto/oauth-client-browser`.

| Export                 | Purpose                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `createBrowserAuth`    | Builds the OAuth client. Returns `init`, `signIn`, `signOut`, `getSession`, `hasScope`, `getScopeStatus`. |
| `buildSpaceWriteScope` | Builds the space scope string. Default actions are `read` and `create`.                                   |
| `createServiceFetch`   | Routes a session's DPoP fetch to another service. Retries once on a DPoP nonce challenge.                 |
| `createServiceAgent`   | Returns an `@atproto/api` `Agent` on that fetch, with the Stratos lexicons registered.                    |
| `configureAgent`       | Registers the Stratos lexicons on an existing `Agent`.                                                    |

This is the webapp's setup, reduced to its required fields:

```typescript
import {
  buildSpaceWriteScope,
  createBrowserAuth,
  createServiceAgent,
} from '@northskysocial/stratos-browser'
import { buildStratosScopes } from '@northskysocial/stratos-client'

const STRATOS_URL = 'https://stratos.example.com'
const STRATOS_DID = 'did:web:stratos.example.com'
const SPACE_ACTIONS = ['read', 'create', 'delete'] as const

const isLoopback = () => window.location.hostname === 'localhost'

const auth = createBrowserAuth({
  appName: 'My App',
  scopes: buildStratosScopes(),
  spaceWriteScope: { serviceDid: STRATOS_DID, actions: SPACE_ACTIONS },
  handleResolver: 'https://bsky.social',
  getBaseUrl: () => window.location.origin,
  isLoopback,
})

const session = await auth.init()

if (session) {
  // For Stratos custody: an Agent that sends DPoP requests to Stratos.
  const stratosAgent = createServiceAgent({ session, serviceUrl: STRATOS_URL })

  // For PDS custody: confirm the space scope before a space write.
  const spaceScope = buildSpaceWriteScope({
    serviceDid: STRATOS_DID,
    actions: SPACE_ACTIONS,
  })
  const status = await auth.getScopeStatus(session, spaceScope)
  // status is 'granted', 'missing', or 'unavailable'
}
```

`getScopeStatus` separates a missing scope from a failed lookup. Treat
`missing` as "sign in again" and `unavailable` as "try again".

`createServiceFetch` accepts only `https` targets, or `http` on a loopback
host. It rejects a `Request` object; pass a URL or a string.

## How the authority reports a repo host

`zone.stratos.space.listRepos` lists the members of a space with each member's
`custody`, `host`, and `hostSource`. It accepts a service JWT or a space
credential, never a user session. It serves syncing services such as the feed
generator. A user-facing app uses `sessionPdsUrl` instead.
[Repo Host Discovery](/architecture/repo-host-discovery) has the design.
