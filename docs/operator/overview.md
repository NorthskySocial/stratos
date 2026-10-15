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

## Request proofs are not enabled

No production route enables the proposed `Stratos-Request-Proof` or
`Stratos-Service-Assertion` headers. Current OAuth, service JWT, and
`cnf.jkt`/DPoP paths are unchanged. Standard Spaces signatures remain separate.
There is no request-proof deployment step in this guide.

Before enabling a route in later integration work, operators must establish:

- **Byte-preserving ingress:** retain the public raw path and query unchanged,
  prove bounded empty-body handling, and review route policy and credential migration.
- **Bounded identity resolution:** verify network limits and freshness. The
  foundation forces fresh resolution without a stale-key cache or rotation grace.
- **Durable replay retention:** share atomic state across instances and retain it
  through expiry plus clock skew. Missing or unavailable storage denies admission.
  Flush, eviction, or failover rollback removes protection for consumed identities
  still inside their acceptance window. Establish recovery and retention guarantees
  before making at-most-once claims.

The foundation admission code validates credentials, the client proof, and any
required bound service assertion, then completes authorization before consuming one
proof identity. Protected data access follows consumption. Production callers must
still integrate these checks; possession alone does not grant access.

A stolen unused delegation can still race credential issuance. The extension does
not remove PDS trust or prove user consent. Read
[ADR 019](../architecture/stratos-request-proofs.md) for the decision and rollout
conditions, or the [wire reference](../architecture/stratos-request-proof-reference.md)
for exact limits and admission requirements.

## Next Steps

- [Architecture](/operator/architecture) — system components, MST repos, storage layout
- [Deployment](/operator/deployment) — step-by-step production setup
- [Configuration](/operator/configuration) — all environment variables explained
