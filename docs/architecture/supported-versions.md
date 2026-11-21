---
audience: Operators, protocol implementers and maintainers
type: Reference
status: partial
---

# Supported versions <Badge type="warning" text="partial" />

This page says what Stratos implements itself, what it consumes from a
member's PDS, what it does not implement, and which gaps are known. It also
says how far each consumed interface has been shown to work.

## How far each interface has been shown to work

No part of this contract has run against a real PDS. Two terms carry the
evidence in this page.

- **Proven at package level.** A test shows it with a real store, a real
  verifier or a real route in process, and test keys. Some tests compare with
  the pinned upstream package. That package makes an oracle vector, or judges a
  value that Stratos made. The pins are in
  [Spaces alignment](./spaces-alignment.md#pinned-upstream-revisions).
- **Pending a host that accepts the new spelling.** A real host would have to
  accept the `at:space/` space spelling. The upstream reference at the pinned
  revision accepts only the earlier `at://` spelling in space parameters, and
  the spaces PDS images that the sandbox pins are from October and refuse the
  new spelling. Until a host accepts it, nothing below passes at host level.

"The November release" of a PDS means a PDS built from the pinned reference
revision `b5fd12fa57b10cf068efa879812f558780f37109` or later. The two October
sources that the repository pins both require a `name` member in a space type
declaration. A PDS built between those two was not examined.

## What Stratos implements itself

| Interface                                                     | What it does                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `zone.stratos.space.getSpaceCredential`                       | Mints a space credential for a member or a service acting for one            |
| `zone.stratos.space.getRecord`, `listBlobs`                   | Read a record or list blobs that Stratos hosts, for one space                |
| `zone.stratos.space.listRepos`                                | Lists the active members of a boundary, with custody and host                |
| `zone.stratos.sync.listRepoOps`, `listRecordPaths`, `getRepo` | Pull sync and export of a repository that Stratos hosts                      |
| `zone.stratos.sync.subscribeRecords`                          | Actor-scoped stream of Stratos-hosted record changes                         |
| `zone.stratos.repo.hydrateRecord`, `hydrateRecords`           | Boundary-filtered reads                                                      |
| Space URI grammar                                             | `at:space/` URIs, and the mapping between a boundary and a space URI         |
| Credential, delegation and attestation verification           | The signed presentation, the DPoP form, and the audience `<did>#atproto_pds` |

Each of these is a Stratos method. None is a mirror of an upstream method. The
lexicons say so. All of it is proven at package level and pending a host that
accepts the new spelling where a host is involved.

## What Stratos consumes from a member's PDS

For a member whose records are on their own PDS, the feed generator, the webapp
and Clubhouse use these interfaces.

| Interface                                                                        | Used by                 | Proven at package level by                                                                                                                  | Pending a host that accepts the new spelling                                                                            |
| -------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `com.atproto.space.listRepoOps` with `space`, `repo`, `limit`, `since`, `cursor` | Feed generator          | Oracle op-page vectors, and an in-process host that proves the flow                                                                         | A real host's `since` and cursor behaviour, and a real multi-page answer                                                |
| `com.atproto.space.getRepo` as an archive                                        | Feed generator          | An oracle archive and refused edits of it, edge tables, and a counting allocator that shows a declared oversize length is refused           | A real archive. The pinned package validates the archive's `space` with a format that accepts only the earlier spelling |
| Response MAC derived from HPKE and the member's `#atproto_kem` key               | Feed generator          | RFC 9180 vectors, upstream vectors, and a cross-check in which the pinned package answers a Rust request and Rust verifies the answer       | A real PDS's MAC response                                                                                               |
| `#atproto_kem` and `#atproto_pds` entries of the member's DID document           | Feed generator, Stratos | Key-form vectors and resolver tests over a document source                                                                                  | A live DID document or PLC entry that holds a KEM key                                                                   |
| `Authorization: Atproto-Space-Credential` read by the PDS                        | Feed generator          | 15 oracle vectors in the service verifiers, and an oracle that accepts a Rust-signed presentation                                           | A reference host that reads a Rust-signed presentation                                                                  |
| A delegation issued by the PDS, with audience `<authority did>#atproto_pds`      | Callers of the mint     | An oracle delegation accepted by the real service verifiers under a frozen clock                                                            | A PDS-issued delegation that reaches the mint                                                                           |
| The `space:` OAuth scope and the space type declaration                          | Enrollment              | Every scope string pinned byte for byte, and each parsed by the pinned scope library; the declaration compared with the pinned schema rules | Consent on a real PDS, and the declaration published as a schema record                                                 |
| `com.atproto.space.createRecord`, `deleteRecord`                                 | Webapp, Clubhouse       | Component and flow tests that record each request                                                                                           | A real PDS                                                                                                              |
| `com.atproto.space.getRecord` on the member's own PDS                            | Webapp inspector        | Component tests that record each request                                                                                                    | A real PDS, in a real browser                                                                                           |

## What Stratos does not implement

- Handlers for upstream `com.atproto.space.*` methods. Stratos is the authority
  for its boundaries but does not serve the upstream space-host methods,
  including `authorizeSpaceSync`, `listWriters` and `notifyRepoUpdate`. It
  answers each as an unknown method.
- A `#atproto_pds` service entry in the Stratos DID document. A generic spaces
  client cannot discover Stratos as an authority.
- Writer discovery. Membership comes from enrollment.
- Revocation of a credential on a foreign PDS. Stratos does not send
  `com.atproto.space.notifyCredentialsRevoked`, the notice a space host sends a
  repo host to revoke a credential.
- A full-content proof. A signature or MAC covers the answer, not every record
  the caller may read.
- End-to-end encryption. Records are access-controlled, not encrypted against
  the operator.
- `zone.stratos.repo.importRepo`. The lexicon exists and the service registers
  no handler for it.

## Known gaps

- **Cached posts of a taken-down host account stay served.** When a member's
  host answers `RepoTakendown`, `RepoSuspended` or `RepoDeactivated`, the feed
  generator fails that member's sync and deletes nothing. Upstream gives no
  guidance to drop an account's data on those answers. A takedown that reaches
  the feed generator through the moderation label log is a separate path and
  does remove posts.
- **A credential outlives a hold until it expires.** A credential minted before
  an operator hold or an account takedown stays accepted on a Stratos read route
  until `exp`. Stratos does not tell a foreign PDS. The lifetime is 600 seconds
  by default for a service credential, never more than 3,600, and 7,200 seconds
  for a DPoP-bound credential.
- **A declaration without `name` is refused by a PDS older than the November
  release.** A member on such a host cannot grant the space scope, and
  enrollment ends with `invalid_scope`. The November release accepts `name`
  beside `title` and ignores it. See
  [the space type declaration](/operator/november-upgrade#the-space-type-declaration).
- **`RepoNotFound` carries no MAC.** The pinned TLS connection to the host that
  Stratos named is the only protection. A stale enrollment that points at a host
  that deleted a migrated account clears that member's posts in the space.
- **`getRepo` is not a snapshot.** A write during the stream gives an archive
  whose set hash does not equal the commit's `data`. The member then fails as
  `digest` and gets no whole-repo read for 10 minutes, so a first sync can take
  that long. This is read from the upstream source, not observed.
- **Custody likes of purged space posts do not return.** See
  [the upgrade](/operator/november-upgrade#the-feed-generator-database).
