# Clubhouse public-alpha room catalogue

This document defines the operator configuration boundary for Plan 024's
one-feed-per-room public alpha. A room is represented by one Feedgen feed ID
and one canonical Stratos enrollment boundary. The room ID is a client-facing
contract; the boundary is an authorization value. They must not be exchanged
or chosen by the browser.

In the service protocol, this authorization value is a **boundary**. The
browser's room terminology remains presentation vocabulary: it labels and
navigates configured feeds, but does not define or select authorization scope.

## One source of truth

The production catalogue is operator-approved external configuration. Mount one
YAML or JSON artifact read-only into both Feedgen and Stratos. Feedgen reads it
through `FEEDGEN_FEEDS_FILE` (not a second inline `FEEDGEN_FEEDS_JSON` or
`FEEDGEN_FEEDS_YAML` value), and Stratos reads that same artifact through
`STRATOS_ROOM_CATALOG_FILE`. Every entry must contain:

```yaml
feeds:
  - id: approved-room-id
    boundary: <canonical-stratos-boundary>
    displayName: <operator-approved room name>
    description: <operator-approved room description>
    # Optional; defaults to true. False prevents new membership while retaining the feed.
    available: true
```

Feed IDs and boundaries must map one-to-one. Do not configure two rooms with
the same boundary, and do not publish a room without a corresponding feed.
Display names and descriptions are presentation data only; they never grant
access.

`STRATOS_ALLOWED_DOMAINS`, `STRATOS_AUTO_ENROLL_DOMAINS`, and
`STRATOS_RESERVED_DOMAIN` all take bare names. The service qualifies those
names with its configured service DID. Catalogue boundaries, by contrast, are
canonical qualified values. Validation therefore compares each catalogue
boundary with the service-qualified result of `STRATOS_ALLOWED_DOMAINS`; do
not put a prequalified boundary in that environment variable.

Review the catalogue and the allow-list together. Set
`STRATOS_AUTO_ENROLL_DOMAINS` explicitly to a non-empty list containing only
the bare reserved all-members name, normally `general` (or the configured
`STRATOS_RESERVED_DOMAIN` value). Do not include any room boundary in this
list: a user joins a room through the explicit enrollment flow.

Leaving `STRATOS_AUTO_ENROLL_DOMAINS` unset or empty is unsafe for this
public-alpha policy. The service treats an empty auto-enrollment list as “all
allowed domains,” which would pregrant every room boundary in
`STRATOS_ALLOWED_DOMAINS`. The explicit reserved-only baseline is required even
though the reserved boundary is force-included in enrollments independently.

Do not add production IDs, boundaries, or credentials to this repository. The
checked-in `stratos-feedgen/feeds.local.yaml` remains a local development
fixture, not the production catalogue.

## Compose overlay wiring

The Feedgen overlay mounts the selected catalogue read-only at
`/app/config/feeds.yaml` in both services and sets:

```yaml
FEEDGEN_FEEDS_FILE: /app/config/feeds.yaml
STRATOS_ROOM_CATALOG_FILE: /app/config/feeds.yaml
```

The checked-in host-side mount points at the local fixture for development. A
production deployment must replace that host-side mount with its reviewed
external catalogue in both service definitions; the two containers must receive
the same read-only artifact in the same deployment change.

## Deployment order

1. Review the catalogue and the Stratos enrollment allow-list as one change.
   Confirm every room has exactly one feed ID and canonical boundary.
2. Mount the reviewed external catalogue read-only into both Feedgen and
   Stratos. Set `FEEDGEN_FEEDS_FILE` and `STRATOS_ROOM_CATALOG_FILE` to the
   matching container path; do not introduce a second source.
3. Start Stratos and wait for its health check.
4. Start Feedgen with `FEEDGEN_FEEDS_FILE` set to the mounted file. Feedgen
   rejects duplicate IDs at startup and derives its subscription scope from the
   configured boundaries.
5. Confirm the Feedgen catalog at
   `/xrpc/zone.stratos.feedgen.describeFeed`; compare IDs and display metadata
   with the reviewed file. Treat the returned boundary as diagnostic metadata,
   never as browser authority.
6. Only after catalogue and enrollment configuration agree should a browser
   deployment expose the room IDs.

Do not make a room visible in the browser before Feedgen has restarted with the
catalogue and its indexing/reconciliation path is ready. A newly joined room
may remain pending while enrollment and Feedgen boundary state converge.

## Step 5 production safeguards

Configure the public browser origin in `STRATOS_ALLOWED_REDIRECT_ORIGINS` for
the alpha deployment. OAuth also accepts a redirect target declared by the
client's metadata; the selected-room flow uses that existing generic validation
rather than adding a second room-specific rule. Never treat a callback query
parameter as a redirect authority.
Request only the OAuth scopes needed for the existing
`zone.stratos.feed.post` write path, the required space collection, and
`zone.stratos.feedgen.getFeed`; do not use a wildcard to simplify the client.

Before production traffic, verify the Feedgen `did:web` identity document,
signing key, upstream Stratos URL, and upstream Stratos DID are the production
values. Staging must use different feed IDs and boundaries from production and
must never point its browser, memberships, or catalogue at production state.

## Validation

From the repository root, inspect the merged configuration without starting
services:

```sh
docker compose -f docker-compose.yml -f docker-compose.feedgen.yml config
```

Verify both portions of the rendered configuration: the `feedgen` and `stratos`
services must mount the reviewed catalogue read-only, with
`FEEDGEN_FEEDS_FILE` and `STRATOS_ROOM_CATALOG_FILE` pointing to the matching
container path. The browser falls back to a same-origin `/oauth/boundaries` request
when its Stratos service URL is not configured; do not rely on that fallback
for a separate public deployment. Configure the public entrance with the
correct Stratos URL and deploy it only after this wiring is true.

With staging credentials and an operator-supplied catalogue, verify:

- Feedgen rejects duplicate IDs and each ID resolves to one boundary.
- A member receives only the matching room feed.
- A non-member receives `BoundaryMismatch` without a post query.
- An unknown feed receives `UnknownFeed` without boundary disclosure.
- No room boundary is included in auto-enrollment defaults.
- The public catalog and enrollment allow-list have identical room coverage.
- Rooms are open-membership areas, not confidential spaces; documentation and
  UI copy must not promise confidentiality.

For Steps 1 and 5 this is configuration/deployment validation; it does not
replace the complete custody, OAuth, browser, and readiness matrix in Plan 024
Step 6.
