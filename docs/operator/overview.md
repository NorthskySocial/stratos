# Overview

<script setup>
import DataFlowAnimation from '../.vitepress/theme/components/DataFlowAnimation.vue'
</script>

Stratos lets AT Protocol communities share posts with approved members. A
**boundary** is an access group: a viewer must belong to a post's boundary to
read it. People keep their existing AT Protocol accounts.

As the operator, you run the service that keeps the member list. You decide
which boundaries exist and who may join them.

## Key concepts

| Concept              | Description                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Boundary**         | A service-qualified identifier in `{serviceDid}/{name}` format. A record carries exactly one boundary.                                       |
| **Enrollment**       | A person's registration with a Stratos service through OAuth. It holds their boundaries.                                                     |
| **Service DID**      | The decentralized identifier of the Stratos service itself.                                                                                  |
| **Custody**          | Which party holds a member's records: Stratos, or the member's own PDS. See [Mixed-mode custody](/operator/architecture#mixed-mode-custody). |
| **Space**            | The AT Protocol name for a boundary. Stratos is the authority for each one.                                                                  |
| **subscribeRecords** | The WebSocket sync stream that keeps the feed generator current.                                                                             |

## Use cases

- **Community-private feeds.** Fandom and community social feeds.
- **Gated communities.** Content visible only to approved members.
- **Multi-community platforms.** Apps with separate data for each community.

## Service components

| Component            | Description                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `stratos-service`    | XRPC and HTTP service: enrollment, boundaries, record storage, sync stream, admin interface |
| `stratos-feedgen-ng` | Rust feed generator: stores private posts locally and serves feeds by current membership    |

The TypeScript feed generator and the standalone indexer are deprecated. See
[Feed Generator](/operator/feedgen-ng) for the current feed architecture.

## Request flow

<DataFlowAnimation />

A member enrolls with Stratos, and Stratos publishes their enrollment record to
their PDS. The member writes posts. The feed generator collects the posts it
may read, from Stratos and from members' own PDS hosts. A client app asks the
feed generator for a feed and receives only the posts its viewer may read.

## Next steps

- [Architecture](/operator/architecture): components, custody, storage layout
- [Deployment](/operator/deployment): step-by-step production setup
- [Configuration](/operator/configuration): every environment variable
- [Manage boundaries](/operator/boundaries): the admin interface
- [Operations](/operator/operations): monitoring, backup, scaling
