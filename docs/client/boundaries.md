# Domain Boundaries

A boundary is a room in the house. A post is pinned up in one room, and only
the guests of that room can read it. A post cannot hang in two rooms at once.
To say the same thing in two rooms, write two posts.

## Boundary values

A boundary value is the Stratos service DID, a slash, and a name:

```text
did:web:stratos.example.com/general
did:web:stratos.example.com/writers
```

The service DID is the `did:web` identity of the Stratos service. Read it
from the service's `/.well-known/did.json`. The same name on two services
gives two different boundaries.

Every Stratos record carries its boundary in this shape:

```typescript
const boundary = {
  $type: 'zone.stratos.boundary.defs#Domains',
  values: [
    {
      $type: 'zone.stratos.boundary.defs#Domain',
      value: 'did:web:stratos.example.com/general',
    },
  ],
}
```

`values` is an array for wire compatibility. It holds exactly one entry.

A boundary is also a space. The value above maps to
`at://did:web:stratos.example.com/space/zone.stratos.space.feed/general`.
See [Permissioned Spaces](/architecture/permissioned-spaces).

## Visibility rules

| Viewer                      | Can read the record? |
| --------------------------- | -------------------- |
| Record owner                | Always               |
| User who holds the boundary | Yes                  |
| User without the boundary   | No                   |
| Unauthenticated             | No                   |

## The all-members boundary

Every Stratos service has one reserved boundary that every enrolled user
holds. The operator names it with `STRATOS_RESERVED_DOMAIN`. The default name is `general`.

Stratos adds the reserved boundary to every enrollment. An operator cannot
remove it from a user. A post in this boundary is readable by every enrolled
user of the service.

## Finding a user's boundaries

The user's boundaries come from their enrollment. Three sources exist:

| Source                                     | Auth | Notes                                                    |
| ------------------------------------------ | ---- | -------------------------------------------------------- |
| The enrollment record on the user's PDS    | None | A published copy. Verify the attestation.                |
| `zone.stratos.enrollment.status`           | DPoP | The live list. `boundaries` needs an authenticated call. |
| `zone.stratos.identity.resolveEnrollments` | None | The live list as plain strings.                          |

```typescript
import { getEnrollmentByServiceDid } from '@northskysocial/stratos-client'

async function getUserBoundaries(
  userDid: string,
  pdsUrl: string,
  serviceDid: string,
): Promise<string[]> {
  const enrollment = await getEnrollmentByServiceDid(
    userDid,
    pdsUrl,
    serviceDid,
  )
  return enrollment?.boundaries.map((boundary) => boundary.value) ?? []
}
```

`zone.stratos.server.listDomains` returns every boundary on the service, not
one user's. `zone.stratos.server.listRooms` returns the boundaries that the
operator lists publicly, with a display name and description.

## Write checks

Stratos checks the boundary of every record it stores:

| Check                                  | Error                |
| -------------------------------------- | -------------------- |
| The record names exactly one boundary. | `InvalidDomainCount` |
| The name is a valid space key.         | `InvalidDomain`      |
| The boundary belongs to this service.  | `ServiceMismatch`    |
| The boundary exists on this service.   | `InvalidRecord`      |
| The caller holds the boundary.         | `ForbiddenBoundary`  |

All five answer HTTP 400.

## Limits

| Field                         | Constraint                    |
| ----------------------------- | ----------------------------- |
| `values`                      | Exactly 1 boundary per record |
| `value` string                | Max 253 characters            |
| `boundaries` on an enrollment | Max 50                        |

## Boundaries on PDS-hosted records

A `pds`-custody post lives in a space on the user's PDS. The space URI names
the boundary, so the record needs no `boundary` field.

A PDS does not ask Stratos before it accepts a write. A boundary or a space
on a PDS-hosted record is the author's claim, not a fact. Take membership from
Stratos, never from the record. See
[Custody and Routing](/client/custody#writing-by-custody).
