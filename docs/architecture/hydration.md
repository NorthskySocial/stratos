# Hydration

Hydration is an authorized read of a private record, not a client-side
expansion step. A reference tells an application _which_ record it wants; the
service decides whether the authenticated viewer may receive the content.

There are two useful delivery shapes:

- **Direct hydration** reads named records from Stratos when an application has
  their `at://` URI.
- **Feed delivery** lets Feedgen return complete posts from its verified local
  projection for one configured boundary.

The two shapes share the same rule: identity comes from the credential, never
from a DID supplied in the request body.

## Direct hydration

`zone.stratos.repo.hydrateRecord` reads one URI. The service derives the viewer
from the authenticated OAuth credential, or derives a single permitted boundary
from a space credential. It then loads the record and checks access:

1. The record owner may read their own record.
2. An authenticated non-owner must share at least one current boundary with the
   record.
3. An unauthenticated caller cannot read a private record.
4. A record with no boundary fails closed for non-owners.

The optional CID is a strong-reference guard: if it does not match the current
record, the request does not return a different revision by accident.

`zone.stratos.repo.hydrateRecords` accepts up to 100 URIs and reports each
outcome without forcing a client to repeat individual calls:

| Result     | Meaning                                                                  | Record content returned? |
| ---------- | ------------------------------------------------------------------------ | ------------------------ |
| `records`  | The caller passed the boundary check.                                    | Yes                      |
| `blocked`  | The record exists but its boundary or takedown policy blocks the caller. | No                       |
| `notFound` | The URI or requested CID could not be resolved.                          | No                       |

Applications should treat `blocked` and `notFound` as different rendering
states, but must not attempt to recover private content from a blocked result.

## Feed generator delivery

Feedgen does not pass a list of private record references back to the browser
for a second, unauthenticated hydration step. It maintains a boundary-scoped
projection for its configured feeds and returns complete post views after it
has identified the viewer and checked their membership.

The request path is:

1. The viewer asks their PDS to proxy a feed request.
2. The PDS forwards a short-lived service-authenticated request to Feedgen.
3. Feedgen verifies the request and resolves the viewer's enrolled boundaries.
4. If the viewer belongs to the feed's boundary, Feedgen reads that boundary's
   projection rows and returns the hydrated feed.

Feedgen checks its readiness before the request, after membership resolution,
and after the projection query. If its authoritative subscription or
reconciliation state changes during the request, it returns an unavailable
response instead of mixing old authorization state with new content.

The projection may contain posts from two ingestion arms. Stratos-custody
records arrive over `zone.stratos.sync.subscribeRecords`; records from a
spaces-capable member PDS arrive through the credentialed pull-sync path. The
mixed-mode architecture assigns the same authoritative boundary to both before
they become feed rows. See [Architecture Overview](/architecture/diagrams) for
the full flow.

## References, integrity, and authenticity

Some record views carry a `source` field. `source.subject` contains the
authoritative record URI and CID, and `source.service` identifies the Stratos
service entry responsible for that subject. Recomputing the CID verifies that
returned content matches that reference.

CID equality is an integrity check, not complete proof of authorship. To verify
authenticity, obtain the signed commit and Merkle Search Tree inclusion proof,
then verify the commit signature against the user's enrolled signing key from
the [enrollment attestation](/architecture/enrollment-signing). For a
PDS-custody space record, Feedgen also verifies the space commit before it
promotes the staged record into its feed projection.
