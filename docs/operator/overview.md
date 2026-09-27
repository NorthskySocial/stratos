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

## Next Steps

- [Architecture](/operator/architecture) — system components, MST repos, storage layout
- [Deployment](/operator/deployment) — step-by-step production setup
- [Configuration](/operator/configuration) — all environment variables explained
