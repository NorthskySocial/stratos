# Multi-Domain Enrollment

This document explains how Stratos handles multiple domain boundaries and selective auto-enrollment.

## Concepts

| Term | Description |
|------|-------------|
| **Allowed Domains** | The full set of domains the service accepts. Users can create posts with any of these domains as boundaries. |
| **Auto-Enroll Domains** | The subset of domains assigned to new users during OAuth enrollment. |
| **User Boundaries** | The specific domains stored per-user in the enrollment store. Determines which posts they can create and (on the AppView side) which posts they can view. |

## How It Works

Stratos separates two concerns:

1. **What domains can posts reference?** → Controlled by `STRATOS_ALLOWED_DOMAINS`.
2. **What domains do new users get?** → Controlled by `STRATOS_AUTO_ENROLL_DOMAINS`.

When a user enrolls via OAuth, the service assigns them boundaries based on this logic:

```
if autoEnrollDomains is set and non-empty:
    enroll user with autoEnrollDomains
else:
    enroll user with all allowedDomains (backward-compatible default)
```

This is implemented in `selectEnrollBoundaries()` in `stratos-service/src/oauth/routes.ts`.

### Example

Given the existing domain `atverkackt.de`, adding three new domains where only
`posters-madness` is auto-enrolled:

```
STRATOS_ALLOWED_DOMAINS=atverkackt.de,posters-madness,bees,plants
STRATOS_AUTO_ENROLL_DOMAINS=posters-madness
```

- `atverkackt.de` remains a valid domain — existing users keep their enrollment and existing posts stay accessible.
- A **new** user enrolling via OAuth gets **only** the `posters-madness` boundary.
- Posts can be created with **any** of the four domains as boundaries (provided the author is enrolled in that domain).
- The user can only create posts within their enrolled boundaries (enforced by `assertCallerCanWriteDomains` in the record handler).
- Additional boundaries (`bees`, `plants`, `atverkackt.de`) can be assigned to users later via admin tools or direct store operations.

### Backward Compatibility

If `STRATOS_AUTO_ENROLL_DOMAINS` is not set or empty, enrollment falls back to assigning **all** allowed domains — matching the previous behavior where every user got every domain.

## Configuration

### Environment Variables

| Variable | Required | Format | Description |
|----------|----------|--------|-------------|
| `STRATOS_ALLOWED_DOMAINS` | Yes | Comma-separated | All domains the service recognizes. Records are validated against this list. |
| `STRATOS_AUTO_ENROLL_DOMAINS` | No | Comma-separated | Domains assigned to new users on enrollment. Defaults to all allowed domains. |

### Infrastructure (CDK)

In `ops/infra/conf/config.ts`:

```typescript
stratos: {
  serviceDid: 'did:web:stratos.atverkackt.de',
  publicUrl: 'https://stratos.atverkackt.de',
  allowedDomains: 'atverkackt.de,posters-madness,bees,plants',
  autoEnrollDomains: 'posters-madness',
  enrollmentMode: 'open',
}
```

`atverkackt.de` is the original domain and stays in `allowedDomains` so existing
data and enrollments continue to work. New users only get `posters-madness`.

Both values are passed as environment variables to the ECS task definition in `ops/infra/src/stratos-service-stack.ts`.

## Data Flow

```
OAuth Enrollment
    ├── selectEnrollBoundaries(autoEnrollDomains, allowedDomains)
    │       → determines which boundaries the user gets
    ├── createAttestation(did, enrollBoundaries, signingKey)
    ├── PDS record write (boundaries in enrollment record)
    ├── enrollmentStore.enroll({boundaries: enrollBoundaries, ...})
    │       → persists to enrollment + enrollment_boundary tables
    └── log: "user enrolled via OAuth"

GET /oauth/status
    ├── enrollmentStore.getEnrollment(did)
    ├── enrollmentStore.getBoundaries(did)
    │       → reads per-user boundaries from DB
    └── returns {enrolled, boundaries: [{value: "posters-madness"}]}

Record Creation (zone.stratos.feed.post)
    ├── assertCallerCanWriteDomains(callerBoundaries, recordBoundaries)
    │       → rejects if post domain ∉ user's enrolled boundaries
    └── validates record domains ∈ STRATOS_ALLOWED_DOMAINS
```

## Assigning Additional Domains

Auto-enrollment only applies at initial OAuth enrollment. To grant a user access to additional domains after enrollment, use the enrollment store directly:

```typescript
// Via the enrollment store (e.g., in an admin handler)
await enrollmentStore.addBoundary(did, 'bees')
await enrollmentStore.addBoundary(did, 'plants')
```

A dedicated admin API for boundary management is planned as future work.
