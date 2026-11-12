# Architecture

<script setup>
import SystemOverviewAnimation from '../.vitepress/theme/components/SystemOverviewAnimation.vue'
import EnrollmentFlow from '../.vitepress/theme/components/EnrollmentFlow.vue'
import RecordCreationAnimation from '../.vitepress/theme/components/RecordCreationAnimation.vue'
</script>

Stratos always decides who belongs to a
boundary. It stores the records for most members, and it lets a member with a
capable PDS keep their records there. This page shows each part.

## System components

<SystemOverviewAnimation />

| Component      | Role                                                                   |
| -------------- | ---------------------------------------------------------------------- |
| Stratos        | Enrollment, boundary membership, record storage, sync stream           |
| Member's PDS   | Holds the public enrollment record. Holds the records in `pds` custody |
| Feed generator | Collects posts it may read and serves feeds by current membership      |
| DID resolver   | Resolves member and service identities (PLC and `did:web`)             |
| Blob storage   | Attachments, on disk or in S3                                          |

## Data flow

### Enrollment

<EnrollmentFlow />

A person signs in through OAuth with their existing account. Stratos checks the
enrollment mode, stores the enrollment, and signs an attestation. It then
publishes a `zone.stratos.actor.enrollment` record to the person's PDS. Apps
read that record to find the Stratos service.

### Record creation

<RecordCreationAnimation />

For a member whose records Stratos hosts, a write goes only to Stratos. Stratos
validates the record, signs a commit, stores the blocks, and announces the
change on the sync stream. Nothing is written to the member's PDS.

### Private feed storage

The feed generator collects posts hosted by Stratos and protected posts from
PDS users whom Stratos lists as members. It checks each PDS user's signed
update before adding those posts to its encrypted local database. A viewer
can read posts and attachments only from boundaries they currently belong to.
See [Feed Generator](/operator/feedgen-ng) for storage, access, and startup
checks.

## Mixed-mode custody

Custody says which party holds a member's records. Stratos runs two custody
classes at once and picks the class at enrollment.

| Member's PDS   | Custody   | Records live on  | Who signs commits                    |
| -------------- | --------- | ---------------- | ------------------------------------ |
| Without spaces | `stratos` | Stratos          | Stratos, with a per-member P-256 key |
| With spaces    | `pds`     | The member's PDS | The member                           |

Stratos is the authority for every boundary in both classes. For a `pds`
member it is only the authority. It keeps the membership list and issues space
credentials. It does not store that member's posts.

Signing in again never changes custody. Moving a member from one class to the
other is a data migration, not a login.

[Permissioned Spaces](/architecture/permissioned-spaces#who-keeps-the-records-custody)
explains the model. The rest of this section covers what changes for you.

### What changes for a `pds` member

- **Their posts are not in your backup.** They live on the member's PDS.
  Stratos holds the enrollment, the boundary memberships, and the signed
  boundary history.
- **Stratos holds no signing key for them.** The member signs their own
  commits.
- **Their PDS must be reachable.** The feed generator reads their posts from
  that PDS. An offline PDS means their new posts do not reach feeds.
- **Unenrollment does not delete their posts.** Stratos deletes what it holds.
  The records on the member's PDS stay there.

### Three rules

These rules hold for every `pds` member. Each one was proven against the
upstream alpha PDS.

1. **Never trust a boundary written on a `pds` record.** A PDS does not ask
   Stratos before it accepts a write. Any account can write a record into a
   Stratos space URI in its own repository. The boundary on that record is the
   author's claim. Stratos and the feed generator derive the boundary from
   enrollment state.
2. **Membership decides whose repository is read.** That is the only control
   on the write side. Removing a member does not stop them writing to their own
   PDS. It stops Stratos and the feed generator from reading it.
3. **A space record has a longer address.** It has seven segments and starts
   with the authority:
   `at://{authorityDid}/space/{type}/{skey}/{authorDid}/{collection}/{rkey}`.
   A Stratos-hosted record keeps the familiar
   `at://{authorDid}/{collection}/{rkey}`. In logs and tools, the first segment
   of a space record is your service DID, not the author.

### Keep the space type published

`zone.stratos.space.feed` must stay published as a
`com.atproto.lexicon.schema` record whose `defs.main.type` is `space`. A
member's PDS resolves that name before it grants a space scope.

When the record is missing, authorization fails on the PDS with
`invalid_scope`. Nothing in the Stratos logs explains why. Check this record
first when enrollment breaks for every spaces PDS at once. See
[the space type declaration](/architecture/permissioned-spaces#the-space-type-declaration).

### Find a member's custody

The admin query `zone.stratos.admin.getRepoHost` takes a member `did`. It
returns the member's `custody`, whether the enrollment is a service, and the
resolved repository host for each of the member's spaces. Use it when a
member's posts are missing from a feed.

## Repository and MST

For `stratos` custody, Stratos keeps a **Merkle Search Tree (MST)** and a
**signed commit chain** per member, in the AT Protocol repository format. Every
write produces a signed commit that updates the MST root.

| Layer                  | Contents                                                                   |
| ---------------------- | -------------------------------------------------------------------------- |
| **Signed commit (v3)** | `did`, `version: 3`, `data` (MST root CID), `rev` (TID), `sig` (signature) |
| **MST**                | Sorted tree mapping `collection/rkey` to a record CID                      |

The member's P-256 key signs each commit. The service key signs only the empty
first commit that creates the repository.

| Endpoint                            | Access                      | Description                            |
| ----------------------------------- | --------------------------- | -------------------------------------- |
| `zone.stratos.sync.getRepo`         | The repository owner        | Full repository as a CAR file          |
| `zone.stratos.sync.listRepoOps`     | Service or space credential | Signed commit log                      |
| `zone.stratos.sync.listRecordPaths` | Service or space credential | Full-state recovery for the commit log |

Stratos does not serve `com.atproto.sync.getRecord`, and it does not register
`zone.stratos.repo.importRepo`.

## Storage layout

Each member with `stratos` custody gets an isolated SQLite database or an
isolated PostgreSQL schema.

```text
{STRATOS_DATA_DIR}/
├── service-signing-identity.json   # Service key and its public history (0600)
├── service-signing-identity.lock   # Lock file. Never delete it
├── signing_key                     # First service key. Read once at migration
├── service.sqlite                  # Service database (sqlite backend)
├── assets/                         # Static files served at /assets
├── blobs/                          # Blob storage (local provider)
│   ├── {did}/{cid}
│   ├── temp/{did}/{key}
│   └── quarantine/{did}/{cid}
└── actors/                         # Member data (sqlite backend)
    └── ab/
        └── did:plc:abc123/
            ├── stratos.sqlite      # Records, repository blocks, sync events
            └── signing_key         # Member's P-256 key
```

The service database holds enrollments and their boundaries, the boundary
list, signed boundary history, OAuth sessions, admin sessions and admins, and
the PDS sync queue.

With the `postgres` backend, the service tables and one schema per member live
in PostgreSQL. Member keys live there too. The data directory still holds the
signing identity, its lock, `assets/`, and local blobs.

## Database schema

Two member tables matter most when you debug.

**stratos_record** holds record metadata:

```sql
CREATE TABLE stratos_record (
    uri         TEXT PRIMARY KEY,
    cid         TEXT NOT NULL,
    collection  TEXT NOT NULL,
    rkey        TEXT NOT NULL,
    repoRev     TEXT NOT NULL,
    indexedAt   TEXT NOT NULL,
    takedownRef TEXT
);
```

**stratos_seq** holds the events behind the sync stream:

```sql
CREATE TABLE stratos_seq (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    did         TEXT NOT NULL,
    eventType   TEXT NOT NULL,
    event       BLOB NOT NULL,              -- encoded event
    invalidated INTEGER NOT NULL DEFAULT 0,
    sequencedAt TEXT NOT NULL
);
```
