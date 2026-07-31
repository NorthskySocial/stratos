# Permissioned Spaces

<script setup>
import SpaceCredentialFlowAnimation from '../.vitepress/theme/components/SpaceCredentialFlowAnimation.vue'
import SpaceDataResidencyAnimation from '../.vitepress/theme/components/SpaceDataResidencyAnimation.vue'
</script>

The AT Protocol permissioned data proposal
([proposal 0016](https://github.com/bluesky-social/proposals/blob/main/0016-permissioned-data/README.md),
with a work-in-progress implementation branch at
[bluesky-social/atproto#5187](https://github.com/bluesky-social/atproto/pull/5187))
defines a standard model for private records: a _space_ is a named,
membership-gated container of records, addressed by an `at://` URI and served
by a _space authority_ that decides who may read from it. Stratos implements
this model. Every Stratos boundary is served as a permissioned space, and the
service exposes spec-shaped endpoints under `zone.stratos.space.*` that mirror
the proposed `com.atproto.space.*` methods.

This page explains why Stratos aligns with the proposal, how the mapping
works, where the data physically lives, which of its own design decisions
Stratos keeps and why, and what happens to that data when PDS
implementations ship native spaces support.

## Why align with the spaces proposal

Stratos and the spaces proposal solve the same problem: records in the
atproto identity and repository model that only an authorized group may
read. Stratos shipped first, so rather than wait for `com.atproto.space.*`
to finalize, it mirrors the spec shapes under its own namespace. The
concepts carry over unchanged: space URIs, offline-verifiable credentials,
no-existence-leak reads. What alignment buys is mostly outbound. A Stratos
deployment already speaks the dialect it will need to consume spaces
hosted elsewhere once the spec ships, and its data model needs no rework
to get there. It does not make Stratos part of the open network; access
stays gated by enrollment and, where configured, an app allow-list.

## The model: boundaries as spaces

A Stratos boundary is a qualified string, `{serviceDid}/{domainName}`. A
space URI is:

```text
at://{spaceDid}/space/{spaceType}/{skey}
```

The two map onto each other field by field:

| Boundary component | Space component | Example                       |
| ------------------ | --------------- | ----------------------------- |
| `serviceDid`       | `spaceDid`      | `did:web:stratos.example.com` |
| `domainName`       | `skey`          | `engineering`                 |
| (implied)          | `spaceType`     | `zone.stratos.space.feed`     |

So the boundary `did:web:stratos.example.com/engineering` is the space:

```text
at://did:web:stratos.example.com/space/zone.stratos.space.feed/engineering
```

A record inside a space gets a longer URI that appends the author, the
collection, and the record key:

```text
at://did:web:stratos.example.com/space/zone.stratos.space.feed/engineering/did:plc:ewvi7nxzyoun6zhxrhs64oiz/zone.stratos.feed.post/3jt6walwmos2y
```

The literal `space` segment sits where a collection NSID appears in a public
`at://` URI. An NSID always contains at least two dots and can never be the
bare word `space`, so the two URI shapes cannot collide. Parsing is strict:
canonical form is byte equality, with no case folding and no normalization.
The single source of truth for this grammar is
`stratos-core/src/spaces/domain.ts`, and `stratos-client` re-exports the same
parser so clients never hand-roll it.

The space key (`skey`) uses atproto record-key syntax and must be 1 to 512
UTF-8 bytes. Since domain names already satisfy record-key syntax, every
existing boundary name is a valid skey.

### One record, one space

A record belongs to exactly one space. The write path rejects zero
boundaries and multiple boundaries, so the record's single boundary field
is its space assignment; there is no placement record and no fanout layer.
Editing the boundary moves the record between spaces, and the move
surfaces to sync consumers as a removal in the old space plus a create in
the new one, so a consumer scoped only to the old space observes the
disappearance rather than keeping a stale copy.

The "visible to every member" case is served by a reserved space of the
same feed type, skey `general` by default, force-included in every
enrollment. Writes with an empty boundary are rejected; clients target the
reserved space explicitly, and access checks need no special case for it.

### The space type declaration

`spaceType` is an NSID pointing at a lexicon of `"type": "space"` that
declares what the space contains. Stratos ships one:

```json
{
  "lexicon": 1,
  "id": "zone.stratos.space.feed",
  "defs": {
    "main": {
      "type": "space",
      "description": "A members-only Stratos post feed",
      "key": "any",
      "name": "Stratos Feed",
      "collections": ["zone.stratos.feed.post"]
    }
  }
}
```

`"key": "any"` means any valid skey names an instance of this space type,
which is what lets every boundary name become a space without registration.

## How access works

Access to a space follows three stages: membership, credential, read.

**Membership.** A user enrolls with a Stratos service via OAuth. The service
records which boundaries the user belongs to, and a
`zone.stratos.actor.enrollment` record is written to the user's PDS so that
clients and AppViews can discover the service. In space terms, boundary
membership _is_ space membership; there is no separate membership store.

**Credential.** A member (or a service acting for one) calls
`zone.stratos.space.getSpaceCredential` with the space URI. The service
checks membership live against the enrollment store and mints a space
credential. Decoded, the credential looks like this:

```json
// header
{
  "typ": "atproto-space-credential+jwt",
  "alg": "ES256K",
  "kid": "#atproto"
}
// payload
{
  "iss": "did:web:stratos.example.com",
  "sub": "at://did:web:stratos.example.com/space/zone.stratos.space.feed/engineering",
  "iat": 1753948800,
  "exp": 1753956000,
  "jti": "8e0d2a4f-6a5c-4b1e-9f3a-2c7d1e5b8a90"
}
```

Two details matter. The credential carries no `aud` claim, which is what
makes it multi-use: it works against any repo host serving the space, not one
predetermined audience. And it is signed by the space authority's own signing
key (`kid: #atproto`, resolvable from the authority's DID document), so a
host can verify it without ever contacting the authority. The default
lifetime is two hours.

Credential issuance supports two optional inputs:

- A **delegation token**, a space-delegation JWT whose target space must
  match the request. When present, the caller's identity comes from the token
  instead of the DPoP session, which lets services obtain credentials on a
  member's behalf.
- A **client attestation**, required only for spaces configured with an app
  allow-list. The attested `client_id` is checked against the list; spaces
  without an allow-list ignore attestations entirely.

Failure modes are explicit: `NotEnrolled`, `InvalidToken`, `UnknownSpace`,
`AttestationRequired`, and `ClientNotAllowed`.

**Read.** `zone.stratos.space.getRecord` returns a single record from a
space. It accepts either standard user auth (the caller must be a member) or
a space credential for that space. The record must actually belong to the
requested space. A record outside it, including a record with no space at
all, resolves to `RecordNotFound`, the same answer as a record that does not
exist. Callers cannot use the endpoint to probe for the existence of data
they are not entitled to.

<SpaceCredentialFlowAnimation />

## Where the data lives

The full record never touches the user's PDS. When a user writes a
`zone.stratos.feed.post`, the record is stored in a per-actor repository on
the Stratos service: IPLD blocks under a Merkle Search Tree, with each
commit signed by a per-actor P-256 key. Stratos mints that key at
enrollment and holds it in an isolated signer; it never enters the user's
DID document. The binding between key and user is published in the
enrollment record instead, a `signingKey` field plus a service-signed
attestation, and that is what verifiers resolve to check commit
signatures. Signing with the account's own `#atproto` identity key is the
stated long-term aim, but that key lives with the user's PDS and cannot
sign on Stratos's serve path today. On disk each repo is a SQLite database
per actor, or a Postgres schema per actor, depending on the backend.

The user's PDS holds exactly one thing on the happy path: the
`zone.stratos.actor.enrollment` record, a public pointer that says "this DID
has private data at this service." The PDS operator, the relay, and the
public firehose see that pointer and nothing else. Post content, boundary
names, and even the number of records in a space are not visible outside the
Stratos service and its authorized consumers.

Reads reach the data over four paths, all boundary-gated:

| Path                                      | Consumer            | Auth                          |
| ----------------------------------------- | ------------------- | ----------------------------- |
| Record CRUD (`zone.stratos.repo.*`)       | The owning user     | OAuth + DPoP                  |
| Hydration (`hydrateRecord(s)`)            | AppViews, clients   | Service JWT / user auth       |
| Spec-shaped read (`space.getRecord`)      | Spec clients, hosts | User auth or space credential |
| Sync (`sync.subscribeRecords`, pull sync) | Indexers, feedgens  | Service JWT                   |

The [feed generator](./feed-generator.md) is the reference consumer of the
sync and hydration paths: it indexes boundary-scoped posts from the sync
stream and serves them back to viewers as hydrated timelines.

<SpaceDataResidencyAnimation />

## Compatibility notes

The `zone.stratos.space.*` methods are deliberately shaped as mirrors, not
approximations:

| Stratos NSID                                        | Proposal counterpart          | Status                         |
| --------------------------------------------------- | ----------------------------- | ------------------------------ |
| `zone.stratos.space.getRecord`                      | `com.atproto.space.getRecord` | Spec-shaped mirror             |
| `zone.stratos.space.getSpaceCredential`             | Space credential issuance     | Spec-shaped mirror             |
| `zone.stratos.space.feed`                           | Space type declaration        | Standard `type: space` lexicon |
| `zone.stratos.repo.hydrateRecord(s)`                | none                          | Stratos-specific               |
| `zone.stratos.sync.subscribeRecords`                | none                          | Stratos-specific               |
| `zone.stratos.sync.listRepoOps` / `listRecordPaths` | none                          | Stratos-specific pull sync     |

On the wire, the credential format follows the spec exactly: the
`atproto-space-credential+jwt` type header, `ES256K` or `ES256` signing, and
the `kid` fallback rule. The proposal permits either `#atproto_space` or
`#atproto` as the key id; Stratos always emits `#atproto`, so verifiers that
implement the fallback accept its credentials without a dedicated space key
in the DID document.

Some caveats worth stating plainly:

- The proposal text still describes itself as not final. If
  `com.atproto.space.*` changes shape before a release, the
  `zone.stratos.space.*` mirrors will track it, and the mirrored NSIDs give
  us room to version that transition without breaking deployed clients.
- Compatibility is mostly outbound. Stratos can consume spec-hosted spaces
  once they exist; a generic spec client cannot read Stratos data, because
  access is app-gated and commit verification resolves keys through the
  enrollment record rather than the author's DID document.
- The repo format is MST with durable signed commits. The proposal's
  current draft specifies an LtHash set digest with commits minted at serve
  time. Stratos launches on MST because it is proven and already built, and
  keeps the format behind an internal seam so a later cutover is one
  controlled change rather than a permanent dual format.
- `getRecord` is the only spec-shaped read today. Listing records within a
  space and subscribing to a space use Stratos-specific endpoints until the
  proposal settles their shapes.
- The enrollment record on the user's PDS publishes which spaces the user
  belongs to. The proposal never enumerates membership at protocol level,
  so Stratos is more visible than spec-default on exactly this axis. Treat
  space names as public metadata when choosing them.
- Records are access-controlled, not end-to-end encrypted. The service and
  its authorized consumers handle plaintext by design.
- Hydration (the `source` field pattern described in
  [Hydration Architecture](./hydration.md)) predates the proposal and remains
  the way AppViews present Stratos records inside public timelines. The two
  access paths coexist and serve different consumers.

## Design decisions Stratos keeps, and why

Alignment did not mean adopting the proposal wholesale. Several Stratos
design decisions predate it and stay in place deliberately, not as legacy.

**Boundaries remain the internal model.** Records carry a `boundary` field
(`{serviceDid}/{name}`), and the space URI is derived from it, not stored
alongside it. The mapping is mechanical and lossless in both directions
(`boundaryToSpaceUri` / `spaceUriToBoundary`), so deployed records need no
rewrite as the proposal evolves, and a boundary string is self-describing: it
names the authority DID that governs access right in the value. If the
proposal's addressing changes shape again before finalizing, only the
derivation function changes.

**Membership lives in the enrollment store, checked live.** The spec
direction leans toward membership as records. Stratos keeps membership as
service-side state established through OAuth enrollment because that is what
an organization-operated authority needs: an operator can add or remove a
member, and the change takes effect at the next credential mint rather than
after a record propagates. Combined with the two-hour credential TTL, the
window between revocation and loss of access is bounded without maintaining
revocation lists that every host would have to consult.

**Hydration stays alongside spec-shaped reads.** `space.getRecord` answers
one record for one caller. It cannot build a timeline. AppViews and the
[feed generator](./feed-generator.md) interleaving private posts into feeds
need batch, boundary-filtered hydration with the `source` field for
verification, which is what [hydration](./hydration.md) provides. The two
paths serve different consumers and neither substitutes for the other.

**Per-actor repos with signed commits, even though the org hosts.** The
cheaper design would be plain database rows. Stratos pays for MST commits
and per-actor keys because every property the portability section relies
on, verifiable CAR export, host-independent CIDs, imports a receiving host
can check block by block, follows from that structure. One honest limit:
the per-actor key is minted and held by Stratos, so a commit signature
proves the repo is intact and attributable to the key the enrollment
record names. It does not prove the user authorized each commit
independently of Stratos, which is the same trust position the proposal
gives any repo host that signs at serve time.

**Actor-scoped sync instead of a global firehose.** A service-wide firehose
in the public atproto style would leak activity across boundaries to any
subscriber. `subscribeRecords` is scoped per actor, and pull sync is
boundary-gated to the caller, so a consumer only ever observes the slice of
the write stream it is entitled to read. This is slower to fan out than a
single firehose and that cost is accepted.

## When PDSs host spaces natively

The proposal's default topology puts each per-user space repo on that
user's own PDS. Stratos deliberately does not adopt it: Stratos remains
the repo host for the spaces it owns, permanently. The spec allows this
and names the category directly, a space hosted on a bespoke space service
rather than on the PDS. There is no planned handoff of Stratos-hosted
repos to user PDSs.

What changes when PDS implementations ship `com.atproto.space.*` is the
other direction. Stratos and its consumers can read spaces hosted
elsewhere, because they already speak the credential and addressing model
those hosts will use. A space credential names its authority in `iss` and
its space in `sub`, and any host verifies it against the authority's DID
document; that verification is the same operation whether the blocks come
from a Stratos instance or a PDS.

The reverse does not hold, and that is by design. A generic spaces client
cannot walk up to a Stratos service and read: access is gated by
enrollment and, where configured, an app allow-list, and commit
verification resolves the signing key from the enrollment record rather
than the author's DID document. A PDS-hosted space puts the authority in
the account owner's hands, the right default for personal use. A Stratos
service is an organization-operated authority: membership is controlled by
the operator, spaces can be gated to approved client apps, and the
indexing and feed infrastructure (indexer, feed generator, AppView
integration) lives in one administrative domain. The two topologies serve
different deployments and coexist.

## Data portability

Stratos stores each actor's data as a standard atproto repository: IPLD
blocks, an MST, and a signed commit. Portability falls out of that choice.

A user (or a tool acting for them) exports the full repo as a CAR file:

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" \
  "https://stratos.example.com/xrpc/zone.stratos.sync.getRepo?did=did:plc:ewvi7nxzyoun6zhxrhs64oiz" \
  -o repo.car
```

The CAR contains every record block, every MST node, and the signed commit.
Importing it into another Stratos instance restores the repo:

```bash
curl -X POST \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/vnd.ipld.car" \
  --data-binary @repo.car \
  "https://stratos-two.example.net/xrpc/zone.stratos.repo.importRepo"
```

Because commits are signed, the importing host verifies the repo against
the per-actor key named in the enrollment record; it depends on the
exporting host for the bytes, not for their integrity. The residual trust
is in the enrollment binding itself, which the exporting authority
attested. Content addresses do not change in transit, so a record's CID is
the same on both hosts.

Services that need to stay current rather than move data use pull sync.
`zone.stratos.sync.listRepoOps` returns the operation log after a known
revision, boundary-gated to the caller and with current values inlined; when
the caller reaches the head it receives `caughtUp: true` along with the
current signed commit. If the requested revision predates retained history,
the endpoint returns `OplogTruncated` and the caller falls back to
`zone.stratos.sync.listRecordPaths`: enumerate paths and CIDs, diff against
local state, fetch what is missing.

Portability here means movement between Stratos instances, not a handoff
to a PDS; the spaces Stratos owns stay Stratos-hosted, as covered above.
Within that scope the blocks, the signatures, and the space URIs are all
host-independent, so moving an actor's data is moving a CAR file and
updating the discovery pointer, not rewriting records.
