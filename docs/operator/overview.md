# Overview

Stratos lets AT Protocol communities share posts with approved members. A
**boundary** is an access group: a viewer must belong to one of a post's
boundaries to read it. People keep their existing AT Protocol accounts.

## Key Concepts

| Concept              | Description                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Domain Boundary**  | A service-qualified boundary identifier in `{serviceDid}/{name}` format. Records are visible only to enrolled users who share that boundary. |
| **Enrollment**       | The process of a user registering with a Stratos service via OAuth.                                                                          |
| **Service DID**      | The decentralized identifier for the Stratos service itself.                                                                                 |
| **subscribeRecords** | WebSocket updates that keep the feed generator current.                                                                                      |

## Use Cases

- **Community-private feeds** — Fandom and community social feeds.
- **Gated communities** — Content visible only to verified domain members.
- **Multi-community platforms** — Apps with per-community data isolation.

## Service Components

| Component            | Description                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `stratos-service`    | XRPC/HTTP service — enrollment, record CRUD, sync export                                          |
| `stratos-feedgen-ng` | Rust feed service — stores private posts locally and serves feeds according to current membership |

The TypeScript feedgen and standalone indexer are deprecated. See
[Feed Generator](/operator/feedgen-ng) for the current feed architecture.

## Request Flow

<script setup>
</script>

<DataFlowAnimation />

## Proposed request-proof foundation

ADR 019 is foundation code and a proposed protocol, not deployed enforcement.
No production route enables `Stratos-Request-Proof` or `Stratos-Service-Assertion`.
Current OAuth, service JWT, and `cnf.jkt`/DPoP credential paths are unchanged.
Standard Spaces signatures remain separate and unchanged.

The injected admission composition validates the client proof and required bound
service assertion, awaits credential and authorization checks, then consumes one
proof identity before protected data access. Production integration must still
establish raw public path/query preservation, bounded empty-body handling, route
policy, credential migration, and trusted DID resolution limits. The foundation
resolver forces fresh DID resolution and adds no stale-key cache or rotation grace.

Replay storage must be shared, atomic, and retained through expiry plus clock
skew. Missing or unavailable storage denies admission. After shared state is lost,
there is no replay protection for consumed identities still within their acceptance
window. Flush, eviction, or failover rollback therefore invalidates at-most-once
claims. Establish recovery and retention guarantees before enabling any route.
A stolen unused delegation can still race credential issuance; this extension does
not remove PDS trust or prove user consent. See
[ADR 019](../architecture/stratos-request-proofs.md) for limits and remaining gates.

## Next Steps

- [Architecture](/operator/architecture) — system components, MST repos, storage layout
- [Deployment](/operator/deployment) — step-by-step production setup
- [Configuration](/operator/configuration) — all environment variables explained
