---
audience: Operators and maintainers
type: Explanation
status: current
---

# Multi-Domain Enrollment

A Stratos service has several boundaries, also called domains. Every member
holds the reserved boundary. Some boundaries are granted to every new member.
Others are granted only when a member asks or an operator adds them. This
page explains which boundaries a new member receives
and how that changes later.

## Concepts

| Term                 | Description                                                                   |
| -------------------- | ----------------------------------------------------------------------------- |
| Boundary list        | Every boundary the service knows, kept in the service database                |
| Reserved boundary    | The all-members boundary. Every enrollment includes it                        |
| Automatic enrollment | A per-boundary setting. New members receive every boundary that has it on     |
| Member boundaries    | The boundaries one member holds. They decide what the member writes and reads |

A boundary identifier is `{serviceDid}/{name}`, for example
`did:web:stratos.example.com/bees`.

## Where the settings live

Admins manage boundaries in the admin interface. Each boundary has its own
settings, including automatic enrollment and whether people may join. See
[Manage boundaries](/operator/boundaries).

Two environment variables seed the database on the first start only:

| Variable                      | Effect on the first start                                      |
| ----------------------------- | -------------------------------------------------------------- |
| `STRATOS_ALLOWED_DOMAINS`     | Creates one boundary for each name                             |
| `STRATOS_AUTO_ENROLL_DOMAINS` | Turns automatic enrollment on for these names. Empty means all |

Later restarts ignore both. A boundary created in the admin interface starts
with automatic enrollment off.

## What a new member receives

Stratos decides at the OAuth callback:

```text
if the person joined through a listed room:
    boundaries = that room's boundary + the reserved boundary
else:
    boundaries = every active boundary with automatic enrollment on
```

The reserved boundary always has automatic enrollment on. Stratos reads the
current boundary list before it decides, so an admin change applies to the
next enrollment.

Stratos then signs an attestation over those boundaries, stores the
enrollment, and publishes the enrollment record to the member's PDS.

## Example

A service has three boundaries besides `general`. Only `posters-madness` has
automatic enrollment on.

| Boundary          | Automatic enrollment |
| ----------------- | -------------------- |
| `general`         | On (reserved)        |
| `posters-madness` | On                   |
| `bees`            | Off                  |
| `plants`          | Off                  |

- A new member receives `general` and `posters-madness`.
- `bees` and `plants` stay valid. Their members keep access, and their posts
  stay readable.
- A member can post to `bees` only after they hold the `bees` boundary.

## Writing a record

A record carries exactly one boundary. Stratos checks each write:

```text
Record creation (zone.stratos.feed.post)
    ├── exactly one boundary        → else InvalidDomainCount
    ├── boundary of this service    → else ServiceMismatch
    └── author holds the boundary   → else ForbiddenBoundary
```

A member who holds three boundaries chooses one for each post. To reach two
boundaries, the member writes two posts.

## Changing a member's boundaries later

Automatic enrollment runs only at the first enrollment. After that, an admin
changes a member's boundaries in the **Enrollments** tab or the **Members** tab
of a boundary.

The admin interface calls these XRPC methods. Each one requires an admin
session:

| Method                               | Purpose                                        |
| ------------------------------------ | ---------------------------------------------- |
| `zone.stratos.admin.listEnrollments` | Lists enrollments                              |
| `zone.stratos.admin.addBoundary`     | Adds one boundary to a member                  |
| `zone.stratos.admin.removeBoundary`  | Removes one boundary from a member             |
| `zone.stratos.admin.setBoundaries`   | Replaces a member's boundaries                 |
| `zone.stratos.admin.setActive`       | Activates or deactivates a member's enrollment |

Deactivation is reversible and keeps the member's boundaries.

Each change queues an update of the member's PDS record, announces the
change on the sync stream, and is written to the
[signed boundary history](/operator/boundary-history).

## Checking a member

A signed-in member reads their own state from `GET /oauth/status`:

```json
{
  "did": "did:plc:alice",
  "enrolled": true,
  "enrolledAt": "2026-03-12T00:00:00.000Z",
  "boundaries": [
    { "value": "did:web:stratos.example.com/general" },
    { "value": "did:web:stratos.example.com/posters-madness" }
  ]
}
```

Anyone can ask `zone.stratos.enrollment.status` whether a DID is enrolled.
Boundaries are returned only to an authenticated caller.
