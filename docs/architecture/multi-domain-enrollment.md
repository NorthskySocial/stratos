# Multi-Domain Enrollment

Stratos separates two concerns when handling domain boundaries:

1. What domains can posts reference? — controlled by `STRATOS_ALLOWED_DOMAINS`
2. What domains do new users get? — controlled by `STRATOS_AUTO_ENROLL_DOMAINS`

## Concepts

| Term                | Description                                                                        |
| ------------------- | ---------------------------------------------------------------------------------- |
| Allowed Domains     | Full set of domains the service accepts. Posts can reference any of these.         |
| Auto-Enroll Domains | Subset assigned to new users at OAuth enrollment. Defaults to all allowed domains. |
| User Boundaries     | Per-user stored domains. Determines what posts a user can create and view.         |

## Enrollment Assignment Logic

```
if STRATOS_AUTO_ENROLL_DOMAINS is set and non-empty:
    enroll user with autoEnrollDomains
else:
    enroll user with all allowedDomains  ← backward-compatible default
```

This is implemented in `selectEnrollBoundaries()` in `stratos-service/src/oauth/routes.ts`.

## Example

```bash
STRATOS_ALLOWED_DOMAINS=posters-madness,bees,plants
STRATOS_AUTO_ENROLL_DOMAINS=posters-madness
```

- A new user enrolling via OAuth receives only the `posters-madness` boundary.
- `bees`, and `plants` remain valid — existing users keep their access, existing posts stay accessible.
- Posts can reference any of the three domains as boundaries, provided the author is enrolled in that domain.
- `assertCallerCanWriteDomains` enforces that the record's boundaries are a subset of the author's enrolled boundaries.

## Configuration

### Environment Variables

| Variable                      | Required | Description                                                          |
| ----------------------------- | -------- | -------------------------------------------------------------------- |
| `STRATOS_ALLOWED_DOMAINS`     | Yes      | Comma-separated. All domains the service recognizes.                 |
| `STRATOS_AUTO_ENROLL_DOMAINS` | No       | Comma-separated. Domains for new enrollees. Defaults to all allowed. |

## Data Flow

```
OAuth Enrollment
    ├── selectEnrollBoundaries(autoEnrollDomains, allowedDomains)
    │       → determines which boundaries the user gets
    ├── createAttestation(did, enrollBoundaries, signingKey)
    ├── PDS record write (boundaries in enrollment record)
    ├── enrollmentStore.enroll({ boundaries: enrollBoundaries, ... })
    └── log: "user enrolled via OAuth"

GET /oauth/status
    ├── enrollmentStore.getEnrollment(did)
    ├── enrollmentStore.getBoundaries(did)
    └── returns { enrolled, boundaries: [{ value: "posters-madness" }] }

Record Creation (zone.stratos.feed.post)
    ├── assertCallerCanWriteDomains(callerBoundaries, recordBoundaries)
    │       → rejects if post domain ∉ user's enrolled boundaries
    └── validates record domains ∈ STRATOS_ALLOWED_DOMAINS
```

## Backward Compatibility

If `STRATOS_AUTO_ENROLL_DOMAINS` is not set, enrollment assigns all allowed domains — identical to the original behavior. Existing deployments continue working without change.

## Assigning Additional Domains After Enrollment

Auto-enrollment only runs at initial OAuth enrollment. To grant additional domains later, use the enrollment store directly:

```typescript
await enrollmentStore.addBoundary(did, 'bees')
await enrollmentStore.addBoundary(did, 'plants')
```

A dedicated admin API for boundary management is planned as future work.
