# Introduction

Stratos is a private permissioned data layer for ATprotocol. It keeps private records out of public
purview, publishes enrollment metadata back to the PDS for discovery, and lets downstream apps serve
boundary-filtered content without inventing a separate identity model.

## What Problem Does It Solve?

ATprotocol is designed for open, public social data. Every record on a PDS is visible to anyone who
knows the AT-URI. Stratos adds a permissioned layer on top: users can create posts that are only
visible to members of specific communities, without leaving the AT Protocol identity and tooling
ecosystem.

## How It Works

<script setup>
</script>

<DataFlowAnimation />

1. _A user enrolls_ with a Stratos service via OAuth. The service writes a
   `zone.stratos.actor.enrollment` record to the user's PDS.
2. _The user creates private records_ within an authorized boundary. Stratos
   hosts the repo for users whose PDS lacks spaces support; a spaces-capable PDS
   hosts its own repo while Stratos remains the space authority.
3. _Feedgen NG_ subscribes to Stratos-custody actors and polls only
   authority-listed PDS-custody space members. It verifies foreign commits
   before adding records to its encrypted local projection.
4. _A viewer requests a feed_ using a service-auth JWT. Feedgen NG resolves the
   viewer's Stratos enrollment and serves only posts matching its boundaries.

## Repository Packages

| Package              | Description                                                                 |
| -------------------- | --------------------------------------------------------------------------- |
| `stratos-core`       | Domain logic, storage interfaces, schema, validation, MST commit builder    |
| `stratos-service`    | HTTP/XRPC service, OAuth enrollment, repo CRUD, sync export, adapters       |
| `stratos-client`     | Discovery, routing, verification, and OAuth scope helpers                   |
| `stratos-feedgen-ng` | Rust feed service with encrypted local projection and boundary-scoped reads |
| `webapp`             | [Svelte demo client](/guide/webapp) for enrollment and private posting      |
| `lexicons`           | JSON-based lexicon definitions                                              |

The TypeScript feedgen and AppView indexer remain in the repository for
rollback or historical reference but are deprecated.

## Architecture

For a deeper dive into the technical details of Stratos, see the following documentation:

- [**Hydration Architecture**](/architecture/hydration) — How Stratos uses the source field pattern to keep data private.
- [**Feedgen NG**](/operator/feedgen-ng) — Current feed ingestion, encrypted projection, and request authorization.
- [**Enrollment Signing**](/architecture/enrollment-signing) — How user keys and boundary attestations are managed.
- [**Multi-Domain Enrollment**](/architecture/multi-domain-enrollment) — How users can enroll in multiple boundaries across different services.

## Next Steps

- Read the [Glossary](/guide/glossary) for key terms and concepts.
- Follow the [First Post Tutorial](/guide/first-post) to get started as a user.
- Follow the [Client Integration Guide](/client/getting-started) to add Stratos to your app.
- See the [Operator Guide](/operator/overview) to deploy a Stratos service.
- Explore the [Architecture](/architecture/hydration) for deep technical detail.
