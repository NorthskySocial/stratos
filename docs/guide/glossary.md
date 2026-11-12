# Glossary

Short definitions of the terminology used across the Stratos documentation.
[Core Concepts](/guide/concepts) explains how they fit together.

## Core concepts

### Boundary

A named group whose members can read each other's posts. Its full identifier
is `{serviceDid}/{name}`, for example
`did:web:stratos.example.com/engineering`. A record belongs to exactly one
boundary.

### Reserved boundary

The boundary every member of a service holds. It is named `general` by
default. Use it for posts meant for the whole community.

### Enrollment

A user's membership of a Stratos service, established through OAuth. Stratos
stores the user's boundaries and publishes an enrollment record to the user's
PDS.

### Enrollment record

The public `zone.stratos.actor.enrollment` record on a user's PDS. Apps read
it to find the user's Stratos service, custody, and boundaries. It carries a
service attestation.

### Attestation

The Stratos service's signature inside the enrollment record. It binds the
user's DID, boundaries, and signing key. It proves enrollment; it does not
grant access.

### Custody

Which party keeps a user's private records. `stratos` custody: Stratos hosts
the repository and signs with a per-user key. `pds` custody: the user's own
spaces-capable PDS hosts the repository and signs with the account key.

### Space

The AT Protocol's name for a membership-gated container of records. Every
Stratos boundary is a space. See
[Permissioned Spaces](/architecture/permissioned-spaces).

### Space authority

The service that decides who belongs to a space. For a Stratos boundary, the
authority is always the Stratos service.

### Repo host

The service that stores a member's records for a space: Stratos, or the
member's PDS, depending on custody.

### Space credential

A short-lived, key-bound token that Stratos issues to a current member, or
to a service acting for one. It grants read access to one space.

### Feed generator

The service that collects posts from the members of a boundary and serves
them as a timeline to viewers who hold that boundary.

### Hydration

Fetching the full content of Stratos-hosted records in a batch
(`zone.stratos.repo.hydrateRecords`). Stratos returns only the records the
caller may read.

## Technical terms

### Actor store

Stratos storage for one `stratos`-custody user: their repository, records,
and blobs. A `pds`-custody user has no actor store on Stratos.

### MST (Merkle Search Tree)

The data structure the AT Protocol uses for a repository. Stratos keeps one
signed MST repository per `stratos`-custody user.

### Record URI

The `at://` address of a record. A Stratos-hosted record has three segments:
`at://{authorDid}/{collection}/{rkey}`. A space record on a PDS has seven,
starting with the authority:
`at://{authorityDid}/space/{type}/{name}/{authorDid}/{collection}/{rkey}`.

### Service DID

The identifier of the Stratos service itself, for example
`did:web:stratos.example.com`. It prefixes every boundary identifier, and
its key signs attestations and space credentials.

### Service enrollment

An operator-configured identity for another service, such as the feed
generator. It lets that service read the boundaries the operator grants it.
A service enrollment cannot write records.

### subscribeRecords

`zone.stratos.sync.subscribeRecords`: a per-user WebSocket stream of
Stratos-hosted record changes, for enrolled services such as the feed
generator.

### Pull sync

`zone.stratos.sync.listRepoOps` and `listRecordPaths`: the request/response
way to follow a repository, for services that do not hold a stream open.

### DPoP

Demonstrating Proof of Possession. Every user request to Stratos carries an
access token and a fresh proof signed by the session key. A plain `Bearer`
token is not accepted.

### XRPC

The AT Protocol's remote procedure call mechanism, used between clients,
PDSs, and services like Stratos.
