# Glossary

This glossary defines key terms and concepts used across the Stratos project.

## Core Concepts

### Boundary

A service-qualified identifier in `{serviceDid}/{name}` format (e.g., `did:web:stratos.example.com/engineering`). Records in Stratos have boundaries, and a viewer must be enrolled in at least one of those boundaries to access the record.

### Enrollment

The process by which a user registers with a Stratos service via OAuth. This results in an enrollment record being published to the user's PDS, which downstream services use for discovery and verification.

### Hydration

The process where a client or AppView fetches the full content of a Stratos-backed record. Because Stratos records are private and live only in the user's per-actor repo on Stratos, hydration resolves a record reference into its full content after verifying access controls, returning it with a `source` field.

### Source Field

A field returned on a hydrated record that specifies where the full record is located. It includes the `uri` of the record in Stratos, the `cid` for verification, and the `service` DID of the Stratos instance. Stratos does not write per-record stubs to the user's PDS; the `source` field is attached at hydration time.

## Technical Terms

### Actor Store

The per-user storage within Stratos that holds records, blobs, and repository metadata for a specific DID.

### MST (Merkle Search Tree)

A data structure used by AT Protocol to represent a repository's state. Stratos uses MSTs to maintain per-actor repositories that are compatible with AT Protocol's sync primitives.

### Service DID

The decentralized identifier for the Stratos service itself (e.g., `did:web:stratos.actor`). It is used to sign enrollment attestations and as the `source.service` reference on hydrated records.

### subscribeRecords

A WebSocket sync stream provided by Stratos (and the PDS) that allows indexers to receive real-time updates about record creations, updates, and deletions.

### XRPC

The AT Protocol's remote procedure call mechanism used for communication between clients, PDSs, and services like Stratos.
