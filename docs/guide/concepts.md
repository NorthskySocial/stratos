# Core Concepts

<script setup>
import TrustChainAnimation from '../.vitepress/theme/components/TrustChainAnimation.vue'
</script>

## Boundary

A **boundary** is a named group whose members can read each other's
posts.

Each boundary has a full identifier, made from the Stratos service DID and a
short name (`{serviceDid}/{name}`):

```text
did:web:stratos.example.com/general
did:web:stratos.example.com/writers
```

Three rules hold everywhere.

- **A post belongs to exactly one boundary.** A post for two groups is two
  posts.
- **Apps use the full identifier** when they create a record. A bare name
  such as `writers` is not accepted.
- **Every member is in the reserved boundary.** It is named `general` by
  default, and it is the boundary for the whole community.

Operators create and retire boundaries in the admin interface. See
[Manage Boundaries](/operator/boundaries).

## Enrollment

**Enrollment** is how a user joins a Stratos service. A user signs in to a Stratos
service with their AT Protocol account, through OAuth. Stratos records the
boundaries they hold and publishes a `zone.stratos.actor.enrollment` record
to their PDS.

The enrollment record is public. It is how an app finds the right Stratos
service for a user, and it lists the boundaries the user belongs to. Boundary
names are therefore public. Post content is not.

| Field         | Description                                                    |
| ------------- | -------------------------------------------------------------- |
| `service`     | The Stratos service endpoint                                   |
| `boundaries`  | The boundaries the user holds                                  |
| `custody`     | Who keeps the user's private posts: `stratos` or `pds`         |
| `repoHost`    | For `pds` custody, a hint to where the posts are kept          |
| `signingKey`  | The public key that signs the user's private posts             |
| `attestation` | The service's signature over the fields above, with `issuedAt` |
| `createdAt`   | Enrollment timestamp                                           |

The record is a signpost, not a key. Reading it grants nothing. Access
depends on the user's current membership, which only Stratos knows.

## Custody

**Custody** answers one question: who keeps this user's private posts?

| The user's PDS          | Custody   | Posts are kept         | Posts are signed by                       |
| ----------------------- | --------- | ---------------------- | ----------------------------------------- |
| does not support spaces | `stratos` | on the Stratos service | a key Stratos holds for that user (P-256) |
| supports spaces         | `pds`     | on the user's own PDS  | the user's account key                    |

Stratos decides custody once, at enrollment, from what the user's PDS can
do. Both kinds of member share the same boundaries and the same feeds.

Custody changes two things an app must handle.

- **Where to write.** A `stratos`-custody user writes to the Stratos service.
  A `pds`-custody user writes to their own PDS.
- **What a record address looks like.** The two custody classes use
  different `at://` URI shapes. See [Space](#space) below.

It never changes who decides membership. That is always Stratos.

## Space

The AT Protocol has a proposal for private data, called _permissioned
spaces_. A **space** is the protocol's name for a boundary, and the service that
controls its membership is the space **authority**.

Every Stratos boundary is a space, and Stratos is its authority:

```text
boundary  did:web:stratos.example.com/writers
space     at://did:web:stratos.example.com/space/zone.stratos.space.feed/writers
```

A record kept on a user's PDS has a space record address. It has seven
segments, and it starts with the authority, not the author:

```text
at://{authorityDid}/space/{type}/{name}/{authorDid}/{collection}/{rkey}
```

A record kept by Stratos has the familiar three-segment address:

```text
at://{authorDid}/{collection}/{rkey}
```

[Permissioned Spaces](/architecture/permissioned-spaces) tells the full
story.

## Space credential

A **space credential** is a short-lived pass for one space. Stratos issues
it to a current member, or to a service acting for one. The holder shows it
to whoever keeps the records: Stratos, or a member's PDS.

A credential is bound to a key. Every request must prove possession of that
key, so a copied credential is useless by itself.

## Feed generator

The **feed generator** turns boundaries into timelines. It follows the
members Stratos lists, collects their posts from Stratos and from their
PDSs, and keeps a bounded, encrypted copy. When a viewer opens a feed, it
checks the viewer's current membership and returns only what they may read.

See [Feed Generator](/architecture/feed-generator).

## Sync stream

`zone.stratos.sync.subscribeRecords` is a WebSocket that carries changes to
Stratos-hosted records. It is for services, not for end-user apps: the
caller must be a service the operator has enrolled. Each stream covers one
user, and Stratos filters it to the boundaries the calling service holds.

There is no service-wide firehose. A single stream of everything would leak
activity across boundaries.

## Repository

Private posts are stored the way public posts are: in an AT Protocol
repository, a Merkle Search Tree (MST) of records with a signed commit on
top.

For a `stratos`-custody user, Stratos hosts that repository. The owner can
export all of it as a CAR file with `zone.stratos.sync.getRepo` and verify
it against the `signingKey` in their enrollment record.

For a `pds`-custody user, the repository is a space on their own PDS.

## Trust model

Who has to trust whom?

**Readers trust Stratos for membership.** Before any private content is
returned, the caller's current membership is checked. Stratos does it for
its own endpoints. The feed generator does it before it serves a feed.

**Nobody trusts a boundary written inside a PDS-hosted post.** A PDS does
not ask Stratos before it accepts a write. Anyone can write a record that
claims to belong to a boundary. Readers ignore the claim and ask Stratos who
the members are.

**Removing a member stops reading, not writing.** A removed member can still
write on their own PDS. Nobody collects it.

**The attestation proves enrollment, not access.** The enrollment record
carries a signature from the Stratos service key over the user's DID,
boundaries, and signing key. Any app can check it and confirm that this
Stratos service enrolled this user.

<TrustChainAnimation />

The attestation shows that Stratos approved the enrollment at the time it
was signed. It is not a grant to read posts. Access to feeds and records
depends on current membership.

**Posts are access-controlled, not end-to-end encrypted.** The Stratos
service and the feed generator handle plaintext. Members trust their
operator the way they trust a PDS host.
