# Introduction

Stratos lets AT Protocol communities share posts with approved members. People
keep their existing identities. A small enrollment record on each user's PDS
helps apps find the service; private posts are not published in the public feed.

## How It Works

<script setup>
</script>

<DataFlowAnimation />

1. _A user enrolls_ with a Stratos service via OAuth. The service writes a
   `zone.stratos.actor.enrollment` record to the user's PDS.
2. _The user creates a private post_ for a boundary. Stratos stores it for
   users whose PDS does not support spaces. Otherwise, the user's PDS stores it
   in a protected space, with Stratos managing membership.
3. _The feed generator collects posts_ from Stratos and from PDS users whom
   Stratos lists as members. It verifies PDS updates before saving posts in its
   encrypted local database.
4. _A viewer requests a feed_ with a signed service token. The feed generator
   checks the viewer's current Stratos membership and returns only posts they
   are allowed to read.

## Repository Packages

| Package              | Description                                                              |
| -------------------- | ------------------------------------------------------------------------ |
| `stratos-core`       | Domain logic, storage interfaces, schema, validation, MST commit builder |
| `stratos-service`    | HTTP/XRPC service, OAuth enrollment, repo CRUD, sync export, adapters    |
| `stratos-client`     | Discovery, routing, verification, and OAuth scope helpers                |
| `stratos-feedgen-ng` | Feed generator with encrypted local storage and membership-checked feeds |
| `webapp`             | [Svelte demo client](/guide/webapp) for enrollment and private posting   |
| `lexicons`           | JSON-based lexicon definitions                                           |

The TypeScript feedgen and AppView indexer remain in the repository for
rollback or historical reference but are deprecated.

## Architecture

For a deeper dive into the technical details of Stratos, see the following documentation:

- [**Reading Private Records**](/architecture/hydration) — How apps fetch full private records after an access check.
- [**Feed Generator**](/operator/feedgen-ng) — How posts enter the encrypted local database and how access is checked.
- [**Enrollment Signing**](/architecture/enrollment-signing) — How user keys and boundary attestations are managed.
- [**Multi-Domain Enrollment**](/architecture/multi-domain-enrollment) — How users can enroll in multiple boundaries across different services.

## Next Steps

- Read the [Glossary](/guide/glossary) for key terms and concepts.
- Follow the [First Post Tutorial](/guide/first-post) to get started as a user.
- Follow the [Client Integration Guide](/client/getting-started) to add Stratos to your app.
- See the [Operator Guide](/operator/overview) to deploy a Stratos service.
- Explore the [Architecture](/architecture/hydration) for deep technical detail.
