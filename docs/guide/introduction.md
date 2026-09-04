<script setup>
import StratosFlowDiagram from '../.vitepress/theme/components/StratosFlowDiagram.vue'
</script>

# Introduction

Stratos is a private, permissioned data layer for AT Protocol. It keeps private record content out of public PDS repositories while retaining the user DID, OAuth identity, and AT Protocol repository model.

## The public-data constraint

A record in a standard PDS repository is addressable by its AT URI and available to public consumers. Stratos adds a separate service-managed repository for record collections that require authorization. It does not replace the PDS. The PDS remains the user's identity anchor and the place where Stratos publishes public enrollment metadata.

## The system

<StratosFlowDiagram />

1. A user enrolls with a Stratos service through AT Protocol OAuth.
2. Stratos creates a per-actor repository and writes an enrollment record to the user PDS.
3. The client routes private record operations to Stratos with DPoP-bound requests.
4. A feed generator or an AppView consumes authorized Stratos data and serves boundary-filtered views.

The full private record never becomes a PDS stub. The PDS enrollment record contains discovery and verification metadata, not post content.

## Repository packages

| Package           | Responsibility                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `stratos-core`    | Domain rules, storage ports, schema, validation, and the MST commit builder.                     |
| `stratos-service` | OAuth enrollment, repository operations, hydration, sync, and access enforcement.                |
| `stratos-client`  | Enrollment discovery, service routing, verification, and scope helpers.                          |
| `stratos-feedgen` | Boundary-scoped feed delivery from a local projection.                                           |
| `webapp`          | A Svelte 5 example implementation for OAuth enrollment, private posting, and client integration. |
| `lexicons`        | Stratos record and XRPC lexicon definitions.                                                     |

The WebApp is an example client, not a required deployment component. Use it to examine an end-to-end client integration while you design your own client.

## Continue

- Read [Shared Private Data](/guide/what-is-stratos) for the record model and access path.
- Read [Core Concepts](/guide/concepts) for boundaries, enrollment, synchronization, and proofs.
- Read [Client Integration](/client/getting-started) to route OAuth requests correctly.
- Read the [Operator Guide](/operator/overview) to deploy a service and feed generator.
