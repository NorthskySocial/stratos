# Glossary

This glossary defines key terms and concepts used across the Stratos project.

## Core Concepts

### Boundary

A service-qualified identifier in `{serviceDid}/{name}` format (e.g., `did:web:stratos.example.com/engineering`). Records in Stratos have boundaries, and a viewer must be enrolled in at least one of those boundaries to access the record.

### Enrollment

The process by which a user registers with a Stratos service via OAuth. This results in an enrollment record being published to the user's PDS, which downstream services use for discovery and verification.

### Hydration

The process where a client or AppView fetches the full content of a Stratos-backed record. Because Stratos records are private, only "stub" records exist on the PDS. Hydration resolves these stubs into full records after verifying access controls.

### Stub Record

A lightweight record stored on a user's PDS that points to the full record in Stratos. It contains a `source` field with the URI and CID of the actual content, allowing for discovery and integrity verification.

### Source Field

A field within a stub record that specifies where the full record is located. It includes the `uri` of the record in Stratos, the `cid` for verification, and the `service` DID of the Stratos instance.

## Technical Terms

### Actor Store

The per-user storage within Stratos that holds records, blobs, and repository metadata for a specific DID.

### MST (Merkle Search Tree)

A data structure used by AT Protocol to represent a repository's state. Stratos uses MSTs to maintain per-actor repositories that are compatible with AT Protocol's sync primitives.

### Service DID

The decentralized identifier for the Stratos service itself (e.g., `did:web:stratos.actor`). It is used to sign enrollment attestations and as a reference in stub records.

### subscribeRecords

A WebSocket sync stream provided by Stratos (and the PDS) that allows indexers to receive real-time updates about record creations, updates, and deletions.

### XRPC

The AT Protocol's remote procedure call mechanism used for communication between clients, PDSs, and services like Stratos.
