# Glossary

This glossary defines key terms and concepts used across the Stratos project.

## Core Concepts

### Boundary

A service-qualified identifier in `{serviceDid}/{name}` format (e.g., `did:web:stratos.example.com/engineering`). Records in Stratos have boundaries, and a viewer must be enrolled in at least one of those boundaries to access the record.

### Enrollment

The process by which a user registers with a Stratos service via OAuth. This results in an enrollment record being published to the user's PDS, which downstream services use for discovery and verification.

### Hydration

Fetching the full content of a private record after checking access. For
Stratos-hosted records, the response includes a `source` field identifying
the service that supplied it.

### Source Field

A field on a fetched Stratos-hosted record that identifies its record URI,
content ID (`cid`), and Stratos service DID. Apps use it to verify where the
record came from. It is added when the record is fetched, not published as a
separate public post.

## Technical Terms

### Actor Store

Stratos storage for one user. Users whose PDS supports protected spaces keep
their private record repository on their PDS instead.

### MST (Merkle Search Tree)

A data structure used by AT Protocol to represent a repository's state. Stratos uses MSTs to maintain per-actor repositories that are compatible with AT Protocol's sync primitives.

### Service DID

The decentralized identifier for the Stratos service itself (e.g., `did:web:stratos.actor`). It is used to sign enrollment attestations and as the `source.service` reference on hydrated records.

### subscribeRecords

A WebSocket stream that sends Stratos record changes to authorized services
such as the feed generator.

### XRPC

The AT Protocol's remote procedure call mechanism used for communication between clients, PDSs, and services like Stratos.
