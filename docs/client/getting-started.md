# Client Integration

Stratos client integration has two paths: private repository operations and hydrated feed reads.

## Private repository operations

Discover `zone.stratos.actor.enrollment` on the user PDS. Resolve the Stratos service URL from the enrollment. Route private repository XRPC calls to that URL through the authenticated OAuth fetch handler.

```ts
import { Client } from '@atcute/client'
import {
  createServiceFetchHandler,
  resolveServiceUrl,
} from '@northskysocial/stratos-client'

const serviceUrl = resolveServiceUrl(enrollment, pdsUrl)
const handler = createServiceFetchHandler(session.fetchHandler, serviceUrl)
const stratos = new Client({ handler })
```

The absolute target URL matters. The OAuth client generates the DPoP proof for that URL, so the proof remains bound to the Stratos origin.

## Feed reads

A Stratos-aware client requests a configured feed through its PDS proxy. The PDS issues a short-lived service-auth JWT for the feed generator. The feed generator verifies the token and returns fully hydrated records that the viewer may access.

Request the feed generator scope in OAuth metadata when the client reads feeds:

```text
rpc:zone.stratos.feedgen.getFeed?aud=*
```

The feed generator is not a standard `app.bsky.feed.getFeedSkeleton` endpoint. It returns hydrated Stratos records because access control must be checked before content is returned.

## Required client state

Keep these values separate:

| Value           | Source             | Use                                               |
| --------------- | ------------------ | ------------------------------------------------- |
| Enrollment      | User PDS           | Discover the Stratos service and user boundaries. |
| OAuth session   | User PDS           | Create DPoP-bound requests.                       |
| Active service  | Application choice | Select the target Stratos deployment.             |
| Feed definition | Feed generator     | Select a configured boundary-scoped feed.         |

Read [Enrollment](/client/enrollment) for discovery and [Create Records](/client/creating-records) for write requests.
