# Getting Started

This page takes an app from sign-in to its first private post. You find the
user's enrollment, learn who holds their records, and send each new post to
the right place.

New to the ideas? Read
[What Is Shared Private Data?](/guide/what-is-stratos) first.

## What you are integrating

| Concept         | Description                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------- |
| Stratos service | The space authority. It decides who belongs to each boundary.                                       |
| Enrollment      | A user joins a Stratos service through OAuth. A record on their PDS announces it.                   |
| Boundary        | A named access group, written `{serviceDid}/{name}`, such as `did:web:stratos.example.com/general`. |
| Custody         | Who hosts the user's private records: `stratos` or `pds`.                                           |
| Private post    | A `zone.stratos.feed.post` record in exactly one boundary.                                          |

## The packages

`@northskysocial/stratos-client` has the framework-neutral building blocks:

| Module       | What it provides                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| discovery    | `getEnrollmentByServiceDid`, `discoverEnrollments`, `parseEnrollmentRecord`                                                |
| routing      | `resolveRepositoryTarget`, `createServiceFetchHandler`, `findEnrollmentByService`, `resolveServiceUrl`, `serviceDIDToRkey` |
| verification | `verifyRecordCid`, `verifyStratosRecord`, `verifyCidIntegrity`, `resolveServiceSigningKey`, `resolveUserSigningKey`        |
| attestation  | `verifyEnrollmentAttestation`                                                                                              |
| scopes       | `buildStratosScopes`, `buildCollectionScope`, `buildRpcScope`, `STRATOS_SCOPES`                                            |

```bash
npm install @northskysocial/stratos-client
```

`@northskysocial/stratos-browser` adds browser OAuth and DPoP helpers. The
demo webapp uses it. See
[Browser helpers](/client/custody#browser-helpers-stratos-browser).

## Authentication in one paragraph

Stratos accepts the user's AT Protocol OAuth session. Every authenticated user
request carries two headers: `Authorization: DPoP <access_token>` and
`DPoP: <proof>`. Stratos does not accept `Authorization: Bearer` from a user.
Your OAuth library builds both headers when you pass it the absolute Stratos
URL. See [DPoP-aware transport](#dpop-aware-transport).

## The walk

### 1. Discover the enrollment

The enrollment record lives on the user's PDS. Its record key is the Stratos
service DID, so one `getRecord` call finds it:

```typescript
import { getEnrollmentByServiceDid } from '@northskysocial/stratos-client'

// Both values come from your app configuration.
const STRATOS_URL = 'https://stratos.example.com'
const STRATOS_DID = 'did:web:stratos.example.com'

async function findEnrollment(userDid: string, sessionPdsUrl: string) {
  return getEnrollmentByServiceDid(userDid, sessionPdsUrl, STRATOS_DID)
}
```

A `null` result means the user is not enrolled. Send them through
[enrollment](/client/enrollment#initiating-enrollment).

`STRATOS_URL` and `STRATOS_DID` are trusted values from your configuration.
The record's own `service` and `repoHost` fields are hints. Do not route
credentials by them.

### 2. Read custody and resolve the target

The enrollment says who keeps the user's records. `resolveRepositoryTarget`
turns that into a host you can trust:

```typescript
import { resolveRepositoryTarget } from '@northskysocial/stratos-client'
import type {
  RepositoryTarget,
  StratosEnrollment,
} from '@northskysocial/stratos-client'

const STRATOS_URL = 'https://stratos.example.com'

function resolveTarget(
  enrollment: StratosEnrollment | null,
  sessionPdsUrl: string,
): RepositoryTarget {
  return resolveRepositoryTarget(enrollment, {
    authorityServiceUrl: STRATOS_URL,
    sessionPdsUrl,
  })
}
```

The result has a `kind`:

- `stratos`: Stratos hosts the repo. Use `com.atproto.repo.*` on `target.url`.
- `pds`: the user's PDS hosts the repo. Use `com.atproto.space.*` there.
- `unresolved`: stop. `target.reason` names the cause.

[Custody and Routing](/client/custody) lists every reason and the rules for
trusted hosts.

### 3. Write the post

Branch on `target.kind`. The Stratos branch writes a three-segment record. The
PDS branch writes into a space.

```typescript
import { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-browser'
import type { RepositoryTarget } from '@northskysocial/stratos-client'

function createRoutedAgent(session: OAuthSession, targetUrl: string): Agent {
  return new Agent((url: string, init: RequestInit) => {
    const fullUrl = new URL(url, targetUrl)
    return session.fetchHandler(fullUrl.href, init)
  })
}

async function createPrivatePost(
  session: OAuthSession,
  target: RepositoryTarget,
  boundary: string,
  spaceUri: string,
  text: string,
): Promise<void> {
  const createdAt = new Date().toISOString()

  if (target.kind === 'stratos') {
    const agent = createRoutedAgent(session, target.url)
    await agent.com.atproto.repo.createRecord({
      repo: session.sub,
      collection: 'zone.stratos.feed.post',
      record: {
        $type: 'zone.stratos.feed.post',
        text,
        boundary: {
          $type: 'zone.stratos.boundary.defs#Domains',
          values: [
            { $type: 'zone.stratos.boundary.defs#Domain', value: boundary },
          ],
        },
        createdAt,
      },
    })
    return
  }

  if (target.kind === 'pds') {
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
          record: { $type: 'zone.stratos.feed.post', text, createdAt },
        }),
      },
    )
    if (!response.ok) {
      throw new Error(`PDS write failed (${response.status})`)
    }
    return
  }

  throw new Error(`Cannot route the write: ${target.reason}`)
}
```

`boundary` is one of the user's boundaries, such as
`did:web:stratos.example.com/general`. `spaceUri` is the same boundary as a
space: `at://did:web:stratos.example.com/space/zone.stratos.space.feed/general`.

Three rules apply to the Stratos branch:

- `values` holds exactly one boundary. Zero or two fail with
  `InvalidDomainCount`.
- The boundary must belong to this service and to the user.
- Stratos answers `PdsCustodyWriteForbidden` if the user has `pds` custody.

The PDS branch needs the space scope on the session. See
[Space scope](/client/custody#space-scope).

::: warning Common mistake
`new Agent(session)` followed by `agent.serviceUrl = new URL(target.url)`
still sends requests to the session's PDS. Pass the absolute target URL to the
session's fetch handler, as `createRoutedAgent` does.
:::

### 4. Read

For a single Stratos-hosted record, call `com.atproto.repo.getRecord` on
Stratos. For a feed, call the feed generator. It serves posts from both
custody classes. See [Reading Records](/client/reading-records).

## Which operations go where

| Operation                                        | Host                       | Auth                            |
| ------------------------------------------------ | -------------------------- | ------------------------------- |
| `com.atproto.repo.createRecord`                  | Stratos, `stratos` custody | DPoP                            |
| `com.atproto.repo.deleteRecord`                  | Stratos, `stratos` custody | DPoP                            |
| `com.atproto.repo.applyWrites`                   | Stratos, `stratos` custody | DPoP                            |
| `com.atproto.repo.uploadBlob`                    | Stratos, `stratos` custody | DPoP                            |
| `com.atproto.repo.getRecord`, `listRecords`      | Stratos, `stratos` custody | Optional DPoP                   |
| `com.atproto.repo.describeRepo`                  | Stratos, `stratos` custody | None                            |
| `com.atproto.sync.getBlob`                       | Stratos, `stratos` custody | Optional DPoP                   |
| `zone.stratos.sync.getRepo`                      | Stratos, `stratos` custody | DPoP, repo owner only           |
| `zone.stratos.enrollment.status`                 | Stratos                    | Optional DPoP                   |
| `com.atproto.space.createRecord`, `deleteRecord` | User's PDS, `pds` custody  | The PDS session and space scope |
| `zone.stratos.feedgen.getFeed`                   | Feed generator             | Service auth JWT                |

Stratos does not serve `com.atproto.repo.putRecord`,
`com.atproto.sync.getRecord`, or `zone.stratos.repo.importRepo`. The
[API Reference](/client/api-reference) has the full list.

## DPoP-aware transport

A DPoP proof names the URL it was made for, in its `htu` claim. The OAuth
client derives `htu` from the request URL. So one rule covers everything:
pass an absolute URL on the target origin to the session's fetch handler. The
proof then matches the Stratos origin instead of the PDS.

`createServiceFetchHandler` does this for `@atcute/client`:

```typescript
import { Client } from '@atcute/client'
import { createServiceFetchHandler } from '@northskysocial/stratos-client'
import type { FetchHandler } from '@northskysocial/stratos-client'

function createStratosClient(
  authenticatedHandler: FetchHandler,
  stratosUrl: string,
): Client {
  return new Client({
    handler: createServiceFetchHandler(authenticatedHandler, stratosUrl),
  })
}
```

`authenticatedHandler` is any function `(pathname, init) => Promise<Response>`
that attaches the access token and the proof. The returned object resolves
each pathname against `stratosUrl`. A third argument, `{ headers }`, sets extra
headers on every request.

Use this transport for `stratos` custody only.

## Adoption path

Add Stratos support in steps:

### Step 1: Read

1. Discover the enrollment when a session starts. Cache it for the session.
2. Resolve the repository target.
3. Show a feed from the feed generator.
4. Render an empty state for a `stratos`-custody repo that has no records yet.

### Step 2: Write

1. Add the Stratos scopes to your OAuth client metadata. See
   [OAuth Scopes](/client/enrollment#oauth-scopes).
2. Branch the composer on `target.kind`.
3. Let the user pick one boundary per post.

### Step 3: Verify

1. Verify the enrollment attestation.
2. Verify record CIDs with `verifyRecordCid`.
3. Show the verification level honestly. See
   [Attestation Verification](/client/attestation).

### Step 4: Rich features

1. Boundary chips and filters.
2. Images. See [Creating Records](/client/creating-records#post-with-images).
3. Feed attachments. See [Private Feed Attachments](/client/feedgen-blobs).

## social-app integration mapping

For a React Native app shaped like Bluesky's
[social-app](https://github.com/bluesky-social/social-app):

### State layer

| Concept           | social-app location           | Pattern                                                             |
| ----------------- | ----------------------------- | ------------------------------------------------------------------- |
| Enrollment state  | `src/state/stratos.tsx` (new) | React Context with `StratosEnrollment \| null \| undefined`         |
| Repository target | `src/state/stratos.tsx` (new) | Derived from the enrollment with `resolveRepositoryTarget`          |
| Discovery trigger | `src/state/session/index.tsx` | Call `getEnrollmentByServiceDid` in `resumeSession` / `login` flows |
| Cleanup on logout | `src/state/session/index.tsx` | Reset enrollment state in the logout handler                        |

### View integration

| View            | Integration point                | What changes                                   |
| --------------- | -------------------------------- | ---------------------------------------------- |
| Feed            | `src/state/queries/post-feed.ts` | Add a feed generator query for private posts   |
| Settings        | `src/screens/Settings/`          | Enrollment status and boundaries               |
| Record creation | Post composer                    | Select repo or space `createRecord` by custody |

## Next steps

- [Custody and Routing](/client/custody): the two custody classes, record
  addresses, and trusted hosts.
- [User Enrollment](/client/enrollment): the enrollment record, the OAuth
  flow, and scopes.
- [Creating Records](/client/creating-records): posts, replies, and images.
- [Reading Records](/client/reading-records): single records, feeds, and
  verification.
- [Domain Boundaries](/client/boundaries): visibility rules.
- [Attestation Verification](/client/attestation): the trust model.
