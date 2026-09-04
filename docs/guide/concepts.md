# Core Concepts

## Boundary

A **boundary** is an access-control scope. Records carry one or more boundary values. A viewer must share at least one boundary with a record to read it.

Boundary values are globally qualified with the service DID:

```text
did:web:stratos.example.com/general
did:web:stratos.example.com/writers
```

Operators configure local boundary names. Stratos qualifies each name with its service DID. Clients must send the fully qualified value when they create a record.

## Space

A **space** is a permissioned group addressed by an AT URI. Stratos maps boundaries to space URIs so a deployment can describe membership, custody, and client-attestation rules in AT Protocol terms. A space does not weaken the live boundary check on a private record.

## Enrollment

**Enrollment** registers a user with a Stratos service through OAuth. A successful enrollment initializes the actor repository, creates a service attestation, and publishes a `zone.stratos.actor.enrollment` record to the user PDS.

| Field         | Purpose                                          |
| ------------- | ------------------------------------------------ |
| `service`     | Stratos service URL for request routing.         |
| `boundaries`  | Current service-DID-qualified access scopes.     |
| `signingKey`  | User P-256 public key for repository commits.    |
| `attestation` | Service signature over the enrollment statement. |
| `createdAt`   | Enrollment creation time.                        |

## Source field

Stratos does not publish a PDS stub for each private record. A hydrated record carries a `source` field with the Stratos service identity and record subject. This lets a consumer discover and verify the authoritative record location while keeping authorization on the service path.

## Synchronization

`zone.stratos.sync.subscribeRecords` emits repository commit events. The stream is actor-scoped and protected by service authentication. Consumers retain a cursor, resume after disconnects, and reconcile authorization changes before they serve a derived projection.

## Actor repository

Each enrolled actor receives an AT Protocol-compatible Merkle Search Tree repository. Each write creates a signed commit. The repository supports inclusion proofs through `com.atproto.sync.getRecord`, CAR export through `zone.stratos.sync.getRepo`, and controlled import through `zone.stratos.repo.importRepo`.

## Trust model

The service is the authority for current access. It evaluates the caller identity and current boundary membership for every private read.

The enrollment attestation is a separate verification mechanism. It lets a consumer verify that the service endorsed a DID, boundary set, and user signing key at a point in time. Use it with a signed commit and inclusion proof when you need to verify record authorship. Do not use it as a substitute for current authorization.
