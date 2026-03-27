# Introduction

Stratos is a **private, boundary-aware data layer for ATProtocol**. It keeps private records off the user's PDS, publishes enrollment metadata back to the PDS for discovery, and lets downstream AppViews serve boundary-filtered content without inventing a separate identity model.

## What Problem Does It Solve?

ATProtocol is designed for open, public social data. Every record on a PDS is visible to anyone who knows the AT-URI. Stratos adds a permissioned layer on top: users can create posts that are only visible to members of specific communities, without leaving the AT Protocol identity and tooling ecosystem.

## How It Works

<script setup>
import DataFlowAnimation from '../.vitepress/theme/components/DataFlowAnimation.vue'
</script>

<DataFlowAnimation />

1. **A user enrolls** with a Stratos service via OAuth. The service writes a `zone.stratos.actor.enrollment` record to the user's PDS.
2. **The user creates private records** by calling the Stratos XRPC API. Records are stored in the user's per-actor repo on Stratos, not on the PDS. A lightweight stub record is written to the PDS with a `source` field pointing back to Stratos.
3. **A standalone indexer** subscribes to the PDS firehose (to discover enrollments) and to each user's `subscribeRecords` stream (to index records with their boundary metadata).
4. **An AppView** queries the indexed PostgreSQL tables. When a viewer requests a feed, the AppView filters posts to only those whose boundaries overlap with the viewer's enrolled boundaries.

## Repository Packages

| Package             | Description |
|---------------------|-------------|
| `stratos-core`      | Domain logic, storage interfaces, schema, validation, MST commit builder |
| `stratos-service`   | HTTP/XRPC service, OAuth enrollment, repo CRUD, sync export, adapters |
| `stratos-client`    | Discovery, routing, verification, and OAuth scope helpers |
| `stratos-indexer`   | Standalone indexer consuming PDS + Stratos streams into AppView PostgreSQL |
| `webapp`            | Svelte demo client for enrollment and private posting |

## Next Steps

- Read [Core Concepts](/guide/concepts) to understand boundaries, enrollment, and hydration.
- Follow the [Client Integration Guide](/client/getting-started) to add Stratos to your app.
- See the [Operator Guide](/operator/overview) to deploy a Stratos service.
- Explore the [Architecture](/architecture/hydration) for deep technical detail.
