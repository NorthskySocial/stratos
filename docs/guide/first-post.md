# Create a Private Post

This guide assumes that the user has completed OAuth enrollment and the client has access to the user PDS OAuth session.

## Discover the service

Read the user `zone.stratos.actor.enrollment` record from the PDS. The service DID is the enrollment record key. `stratos-client` provides a direct lookup and a routing helper:

```ts
import {
  createServiceFetchHandler,
  getEnrollmentByServiceDid,
  resolveServiceUrl,
} from '@northskysocial/stratos-client'
import { Client } from '@atcute/client'

const enrollment = await getEnrollmentByServiceDid(userDid, pdsUrl, serviceDid)
if (!enrollment) throw new Error('The user is not enrolled with this service.')

const serviceUrl = resolveServiceUrl(enrollment, pdsUrl)
const handler = createServiceFetchHandler(session.fetchHandler, serviceUrl)
const rpc = new Client({ handler })
```

The helper passes an absolute Stratos URL to the OAuth fetch handler. This causes the DPoP proof to bind to the Stratos origin instead of the PDS origin.

## Select a boundary

Use a fully qualified boundary that appears in the current enrollment. Do not send the unqualified local name.

```ts
const boundary = 'did:web:stratos.example.com/engineering'
```

## Create the record

```ts
await rpc.call('com.atproto.repo.createRecord', {
  data: {
    repo: userDid,
    collection: 'zone.stratos.feed.post',
    record: {
      $type: 'zone.stratos.feed.post',
      text: 'Private engineering update.',
      boundary: {
        $type: 'zone.stratos.boundary.defs#Domains',
        values: [
          {
            $type: 'zone.stratos.boundary.defs#Domain',
            value: boundary,
          },
        ],
      },
      createdAt: new Date().toISOString(),
    },
  },
})
```

Stratos validates the collection, actor, boundary, and OAuth identity before it writes. It encodes the record, computes the CID, updates the actor MST, signs a new commit, and emits a subscription event.

## Observe the result

The record exists at an AT URI under the user DID, but the record content remains in the Stratos repository. A feed generator can ingest the commit into its local projection. A reader receives the record only when the reader passes the current shared-boundary check.

For client patterns beyond this single write, read [Creating Records](/client/creating-records) and [Reading Records](/client/reading-records).
