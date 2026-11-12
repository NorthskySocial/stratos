# Permissioned Spaces

<script setup>
import SpaceCredentialFlowAnimation from '../.vitepress/theme/components/SpaceCredentialFlowAnimation.vue'
import SpaceDataResidencyAnimation from '../.vitepress/theme/components/SpaceDataResidencyAnimation.vue'
</script>

Stratos started with a simple idea: a _boundary_ is a room, and only the
people let into the room can read what is posted there. While Stratos was
building rooms, the AT Protocol community was drawing up its own floor plan.
The permissioned data proposal
([proposal 0016](https://github.com/bluesky-social/proposals/blob/main/0016-permissioned-data/README.md))
calls the room a _space_: a named, membership-gated container of records,
addressed by an `at://` URI and governed by a _space authority_ that decides
who may read from it.

The two ideas turned out to be the same idea. So Stratos adopted the
proposal's vocabulary and wire shapes. Every Stratos boundary is a space,
Stratos is the authority for it, and the service exposes spec-shaped
endpoints under `zone.stratos.space.*`.

This page tells that story in order: how a boundary becomes a space, who
keeps the records, how a reader proves they belong, and where Stratos still
goes its own way. The exact contract we test against, including the pinned
upstream revisions, lives in [Spaces alignment: current contract](./spaces-alignment.md).

## Why align with the spaces proposal

Stratos and the proposal solve the same problem: records in the atproto
identity and repository model that only an authorized group may read. Stratos
shipped first. We did not wait for `com.atproto.space.*` to settle; we mirror
its shapes under our own namespace and move with it.

Alignment pays off in two places:

- **A user's own PDS can keep their private posts.** When a PDS supports
  spaces, the records stay there, and Stratos only decides who belongs. This
  works today against the upstream alpha PDS.
- **The data model needs no rework.** Space URIs, sender-bound credentials,
  and reads that never leak existence all carry over as the proposal moves.

Alignment does not make Stratos part of the open network. Access stays gated
by enrollment and, where an operator configures one, an app allow-list.

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

The literal `space` segment sits where a collection NSID appears in a public
`at://` URI. An NSID always contains at least two dots and can never be the
bare word `space`, so the two URI shapes cannot collide. Parsing is strict:
canonical form is byte equality, with no case folding and no normalization.
The space key (`skey`) uses atproto record-key syntax and must be 1 to 512
UTF-8 bytes. Domain names already satisfy that syntax, so every existing
boundary name is a valid skey.

The single source of truth for this grammar is
`stratos-core/src/spaces/domain.ts`. `stratos-client` does not re-export the
parser yet, so client code that needs it imports it from core.

### Two record addresses

A record inside a space has a longer URI. It appends the author, the
collection, and the record key:

```text
at://did:web:stratos.example.com/space/zone.stratos.space.feed/engineering/did:plc:ewvi7nxzyoun6zhxrhs64oiz/zone.stratos.feed.post/3jt6walwmos2y
```

That is seven segments, and the first one is the **authority**, not the
author. This is the address of a record that lives in a space repository on a
member's PDS.

A record that Stratos hosts keeps the familiar three-segment address:

```text
at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/zone.stratos.feed.post/3jt6walwmos2y
```

Code that takes the first segment of a URI as the author is wrong for a space
record. Parse the URI; do not split it by hand.

### One record, one space

A record belongs to exactly one space. The Stratos write path rejects a
record with no boundary and a record with several (`InvalidDomainCount`). The
record's single boundary is its space assignment. There is no placement
record and no fanout layer.

Editing the boundary moves the record between spaces. Sync consumers see a
removal in the old space and a create in the new one. A consumer scoped to
the old space watches the record leave; it does not keep a stale copy.

The "visible to every member" case is a reserved space of the same type. Its
skey is `general` by default (`STRATOS_RESERVED_DOMAIN`), and every
enrollment includes it. Clients target the reserved space explicitly, so
access checks need no special case for it.

### The space type declaration

`spaceType` is an NSID that points at a lexicon of `"type": "space"`. The
lexicon declares what the space contains. Stratos ships one, in
`lexicons-spaces/zone/stratos/space/feed.json`:

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

`"key": "any"` means any valid skey names an instance of this space type.
That is what lets every boundary name become a space without registration.

::: warning Keep the space type published
A spaces-capable PDS resolves `zone.stratos.space.feed` as a
`com.atproto.lexicon.schema` record before it grants a space scope. If the
record is missing, authorization fails with `invalid_scope`, and nothing in
the Stratos logs explains why.
:::

## Who keeps the records: custody

Here the story splits in two. Stratos is always the authority: it owns the
space and decides who is a member. But the authority does not have to be the
place where the records sit. We call the answer to "who holds this user's
records" their **custody**.

| User's PDS     | Custody   | Repo host          | Who signs                    | Record URI     |
| -------------- | --------- | ------------------ | ---------------------------- | -------------- |
| non-spaces     | `stratos` | Stratos            | Stratos, per-actor P-256 key | three segments |
| spaces-capable | `pds`     | the user's own PDS | the user's account key       | seven segments |

Custody is decided once, at enrollment. The enrollment OAuth flow always asks
the user's authorization server for a space scope on
`zone.stratos.space.feed`. If the grant comes back allowing both read and
create in that space, the PDS can host it, and custody is `pds`. If not,
custody is `stratos`. Logging in again never changes it.

**Stratos custody.** Stratos creates a repository for the user: IPLD blocks
under a Merkle Search Tree, each commit signed by a per-actor P-256 key.
Stratos mints that key at enrollment and holds it in an isolated signer. The
key never enters the user's DID document. The enrollment record binds it to
the user with a `signingKey` field and a service-signed attestation. The
user's PDS holds only that enrollment record.

**PDS custody.** Stratos creates no repository. The user's client writes
posts into the space on the user's own PDS, and the PDS signs them with the
account key. The enrollment record carries `custody: "pds"` and a `repoHost`
pointing at that PDS. Stratos write endpoints refuse these users with
`PdsCustodyWriteForbidden`; their records are not Stratos's to write.

Both custody classes publish the same public pointer,
`zone.stratos.actor.enrollment`, with `boundaries`, `signingKey`,
`attestation`, `custody`, and `repoHost`.

<SpaceDataResidencyAnimation />

### What an authority cannot do

PDS custody comes with a hard lesson. We proved each part against the alpha
PDS; none of it is read from the spec alone.

**A repo host does not ask the authority before it accepts a write.** Any
account can write a record into a Stratos-owned space URI in its own
repository. So a boundary on a PDS-custody record is a claim made by the
writer, not a fact. Consumers never trust it. The
[feed generator](./feed-generator.md) re-derives the boundary from Stratos
enrollment before it admits a post.

**Membership controls reading, not writing.** Removing a member does not stop
them writing on their own PDS. It stops everyone else reading it: the syncer
walks the authority's member list and only fetches those repositories. That
list is the one write-side control that exists.

**A removed member's credential lives until it expires.** Stratos can refuse
a credential on its own endpoints at once. A foreign PDS cannot be told. See
[Credential revocation contract](./credential-revocation-contract.md).

## How access works

Access to a space follows three stages: membership, credential, read.

### Membership

A user enrolls with a Stratos service through OAuth. The service records
which boundaries the user belongs to. Boundary membership _is_ space
membership; there is no second membership store. Stratos checks it live, at
the moment it matters, against the enrollment store.

### Credential

A member, or a service acting for one, calls
`zone.stratos.space.getSpaceCredential` with the space URI. Stratos checks
that the space is one of its own, that the boundary is active, and that the
caller has an active enrollment carrying that boundary. Then it mints a space
credential. Decoded, it looks like this:

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
  "jti": "8e0d2a4f-6a5c-4b1e-9f3a-2c7d1e5b8a90",
  "cnf": { "jkt": "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I" }
}
```

Three details matter.

**No `aud` claim.** The credential names its authority in `iss` and its space
in `sub`, and nothing else. It works against any repo host that serves the
space: Stratos itself, or a member's PDS.

**Signed by the authority's own key.** The Stratos DID document publishes the
`#atproto` key, so a member's PDS verifies the credential without calling
Stratos. Stratos, as the authority, checks its own credentials against its
local key.

**Bound to the holder.** A credential is not a bearer token. The `cnf` claim
names a key, and every request must prove possession of that key. A stolen
credential is useless without it. Outside dev mode Stratos refuses to mint an
unbound credential (`ProofRequired`) and refuses a plain `Bearer`
presentation.

When the operator manages boundaries through the boundary catalog, the
credential also carries the boundary's revision. More on that under
[when access ends](#when-access-ends).

#### Two ways to bind a credential

Stratos speaks two binding profiles. They exist because two kinds of caller
arrive with two kinds of key.

| Profile        | Bound by                     | Default lifetime                   | Presented as                                                                    | Typical caller                |
| -------------- | ---------------------------- | ---------------------------------- | ------------------------------------------------------------------------------- | ----------------------------- |
| DPoP           | `cnf.jkt`, a DPoP key        | 2 hours                            | `Authorization: DPoP <credential>` and a fresh `DPoP` proof                     | OAuth clients                 |
| HTTP signature | `cnf.kid`, a P-256 `did:key` | 10 minutes, never more than 1 hour | `Authorization: Atproto-Space <credential>` and an RFC 9421 request `Signature` | Services, such as the feedgen |

A **DPoP** proof is made per request. It carries the method, the URL, and a
hash of the credential, and Stratos accepts each proof once.

An **HTTP signature** covers the `Authorization` header and an
`Atproto-Space-Audience` header. The audience is the DID the caller means to
read from: the repo owner for record and sync reads, the authority for a
membership listing. A signature stays valid for that audience until the
credential expires. This is the transport of the October upstream contract.

A request that mixes the two proof families is rejected.

The lifetimes come from `STRATOS_SPACE_CREDENTIAL_TTL_SECONDS` and
`STRATOS_SPACE_HTTP_CREDENTIAL_TTL_SECONDS`.

::: tip Replay protection needs Redis
Single-use proofs and tokens are tracked in a replay store. Outside dev mode,
minting and DPoP presentation fail closed when no replay store is configured.
:::

#### Who is asking

The caller's identity reaches the mint in one of two ways.

- **An OAuth session.** A member's own client calls with its DPoP-bound
  session. The credential binds to that session's DPoP key.
- **A delegation token.** A service obtains a credential on a member's
  behalf. The token is a short-lived `atproto-space-delegation+jwt`, signed
  with the issuer's `#atproto` key, valid for at most five minutes, and
  usable once. The caller sends it as `Authorization: Bearer` (or, on the
  older internal transport, in the request body; never both) together with a
  DPoP proof or an HTTP signature made by the key the credential will bind
  to.

A space can also be gated to approved apps. The allow-list comes from the
boundary catalog, with `STRATOS_SPACE_APP_ACCESS` as the fallback. A caller
to a gated space presents a single-use **client attestation**; the attested
`client_id` must be on the list. Spaces with no allow-list ignore
attestations.

Failures are explicit:

| Error                 | Meaning                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `AuthRequired`        | No session and no delegation token                               |
| `InvalidToken`        | The delegation token or attestation did not verify               |
| `ProofRequired`       | No key proof to bind the credential to                           |
| `UnknownSpace`        | Not a space of this service, or the boundary is not active       |
| `NotEnrolled`         | No active enrollment carrying the space's boundary               |
| `AttestationRequired` | The space has an app allow-list and no attestation was presented |
| `ClientNotAllowed`    | The attested client is not on the allow-list                     |

### Read

`zone.stratos.space.getRecord` returns a single record from a space. It
accepts a member's OAuth session or a space credential for that space. The
record must belong to the requested space. A record outside it resolves to
`RecordNotFound`, the same answer as a record that does not exist. Callers
cannot use the endpoint to probe for data they are not entitled to.

A credential admits its holder to exactly one space. It is not the member's
identity: Stratos treats the caller as an anonymous viewer whose only
property is that one boundary.

`getRecord` on Stratos answers for Stratos-hosted repositories. For a
PDS-custody member the records are on their PDS, and Stratos answers
`RecordNotFound`. The reader takes the same credential to the member's PDS.

<SpaceCredentialFlowAnimation />

### When access ends

There is no revocation list. Access ends in one of three ways.

1. **The credential expires.** Two hours, or ten minutes, depending on the
   profile.
2. **The member is removed from the boundary.** No new credential is minted
   for them, and the feed generator stops reading their repository.
3. **The boundary is deactivated or its revision changes.** Stratos refuses
   every credential minted for the old revision, at once, on its own
   endpoints.

The third way does not reach a foreign PDS. A member's PDS does not know the
Stratos revision claim, so a credential already issued keeps working there
until it expires. That is the reason the service profile lives ten minutes.

## Where the data lives

| Custody   | Post content                       | On the user's PDS                          |
| --------- | ---------------------------------- | ------------------------------------------ |
| `stratos` | Per-actor repository on Stratos    | The enrollment record only                 |
| `pds`     | Space repository on the user's PDS | The enrollment record and the space itself |

On Stratos, each repository is a SQLite database per actor, or a Postgres
schema per actor, depending on the backend.

In neither case does a private post reach the public firehose. A space
repository on a PDS is not part of the public repository.

Space membership is the deliberate exception. The enrollment record is a
public record, and it lists the spaces the user belongs to. Space names ride
the public firehose. Treat them as public metadata when you choose them.

Reads reach the data over these paths. All of them are boundary-gated.

| Path                                              | Consumer           | Auth                                                 |
| ------------------------------------------------- | ------------------ | ---------------------------------------------------- |
| Record CRUD (`com.atproto.repo.*`)                | The owning user    | OAuth and DPoP; Stratos custody only                 |
| Hydration (`zone.stratos.repo.hydrateRecord(s)`)  | Clients            | OAuth session, space credential, or anonymous        |
| Space read (`space.getRecord`, `space.listBlobs`) | Clients, services  | OAuth session or space credential                    |
| Membership (`space.listRepos`)                    | Services           | Service JWT or space credential                      |
| Pull sync (`sync.listRepoOps`, `listRecordPaths`) | Feedgens, services | Service JWT or space credential                      |
| Stream (`sync.subscribeRecords`)                  | Feedgens           | Service JWT                                          |
| A member's PDS (`com.atproto.space.*`)            | Feedgens, clients  | Space credential minted by Stratos; PDS custody only |

An anonymous hydration request gets only what an anonymous viewer may see,
which for a boundary-gated record is nothing.

The [feed generator](./feed-generator.md) is the reference consumer. It
subscribes to Stratos-custody members, polls PDS-custody members, and serves
both back as one timeline.

### Finding a member's repository

`zone.stratos.space.listRepos` is how a service learns whose repositories
make up a space. It pages through the active enrollments for the boundary
and returns, for each member, their `custody`. For a PDS-custody member it
also returns the `host` to read from. The host comes from the enrollment's
`repoHost` first, and from the `#atproto_pds` entry of the member's DID
document otherwise. See [Repo-host discovery](./repo-host-discovery.md).

This listing is the member list of the previous section. The syncer reads
the repositories it names and no others.

## Compatibility notes

The `zone.stratos.space.*` methods are shaped as mirrors of the proposal, in
a separate namespace:

| Stratos NSID                            | Proposal counterpart               | Status                               |
| --------------------------------------- | ---------------------------------- | ------------------------------------ |
| `zone.stratos.space.feed`               | Space type declaration             | Standard `type: space` lexicon       |
| `zone.stratos.space.getSpaceCredential` | Space credential issuance          | Mirror; both binding profiles        |
| `zone.stratos.space.getRecord`          | `com.atproto.space.getRecord`      | Mirror; Stratos-hosted records only  |
| `zone.stratos.space.listBlobs`          | `com.atproto.space.listBlobs`      | Mirror                               |
| `zone.stratos.space.listRepos`          | `com.atproto.space.listRepos`      | Diverged: lists members, not writers |
| `zone.stratos.sync.listRepoOps`         | `com.atproto.space.listRepoOps`    | Diverged; see below                  |
| `zone.stratos.sync.listRecordPaths`     | `getRepo` / `listRecords` recovery | Diverged; see below                  |
| `zone.stratos.repo.hydrateRecord(s)`    | none                               | Stratos-specific                     |
| `zone.stratos.sync.subscribeRecords`    | none                               | Stratos-specific                     |

Some caveats, stated plainly:

- **The proposal is not final.** We pin the upstream revisions we test
  against and record them in the
  [current contract](./spaces-alignment.md). The mirrored NSIDs give us room
  to follow upstream without breaking deployed clients.
- **Stratos is an authority, not a complete upstream one.** It does not
  advertise the upstream `#atproto_space_host` role and does not claim
  upstream authority discovery. A generic spaces client cannot walk up to a
  Stratos service and read.
- **`listRepos` answers a different question.** The Stratos method lists the
  active members of a boundary. The upstream method reports writers, with
  space-revision cursors. A writer delta must never be used to revoke a
  member. See the
  [October writer-sync contract](./october-writer-sync-contract.md).
- **Pull sync diverges on recovery.** Stratos reports a cursor it can no
  longer serve as `OplogTruncated`, and recovery goes through
  `listRecordPaths`.
- **Commit verification depends on custody.** A Stratos-custody commit
  verifies against the per-actor key in the enrollment record. A PDS-custody
  commit verifies against the account key in the author's DID document.
- **The Stratos repo format is MST with durable signed commits.** The format
  sits behind an internal seam, so a later change is one controlled cutover.
- **A valid credential is not a completeness proof.** A signed response
  shows who served it. It does not show that the host returned every record
  the caller may read.
- **Records are access-controlled, not end-to-end encrypted.** The service
  and its authorized consumers handle plaintext by design.
- **Hydration predates the proposal and stays.** See below.

## Design decisions Stratos keeps, and why

Alignment did not mean adopting the proposal wholesale. Several Stratos
decisions predate it and stay in place on purpose.

**Boundaries remain the internal model.** Records carry a `boundary` field
(`{serviceDid}/{name}`), and the space URI is derived from it, not stored
beside it. The mapping is mechanical and lossless in both directions
(`boundaryToSpaceUri` / `spaceUriToBoundary`). Deployed records need no
rewrite as the proposal moves. If the addressing changes shape again, only
the derivation function changes.

**Membership lives in the enrollment store, checked live.** The proposal
leans toward membership as records. An organization-operated authority needs
something faster: an operator adds or removes a member, and the change takes
effect at the next check. Short credential lifetimes bound the window between
removal and loss of access, with no revocation list for every host to
consult.

**Hydration stays alongside spec-shaped reads.** `space.getRecord` answers
one record for one caller. It cannot build a timeline. Clients that show
private posts beside public ones need batch, boundary-filtered reads. That
is what [hydration](./hydration.md) provides.

**Signed per-actor repositories, even when Stratos hosts.** Plain database
rows would be cheaper. We pay for MST commits and per-actor keys because
verifiable export, host-independent CIDs, and block-by-block checks all
follow from that structure. One honest limit: Stratos mints and holds the
per-actor key. A commit signature proves the repository is intact and
attributable to the key the enrollment record names. It does not prove the
user authorized each commit independently of Stratos.

**Actor-scoped sync, not a global firehose.** A service-wide firehose would
leak activity across boundaries to any subscriber. `subscribeRecords` is
scoped per actor, and pull sync is boundary-gated to the caller. A consumer
only observes the slice of the write stream it may read. This fans out more
slowly than one firehose. We accept that cost.

**Custody follows the user's PDS.** We do not force every member onto
Stratos hosting, and we do not wait for every PDS to support spaces. A
community can hold both kinds of member in the same boundary. Moving a
member from one custody class to the other is a migration; it does not
happen by itself.

## Data portability

A Stratos-custody repository is a standard atproto repository: IPLD blocks,
an MST, and a signed commit. The owner exports it as a CAR file. The endpoint
takes the owner's OAuth session, which is DPoP-bound; a `Bearer` header is
rejected.

```bash
curl -H "Authorization: DPoP $ACCESS_TOKEN" \
  -H "DPoP: $DPOP_PROOF" \
  "https://stratos.example.com/xrpc/zone.stratos.sync.getRepo?did=did:plc:ewvi7nxzyoun6zhxrhs64oiz" \
  -o repo.car
```

The CAR contains every record block, every MST node, and the signed commit.
Anyone holding it verifies the repository against the per-actor key named in
the enrollment record. They depend on the exporting host for the bytes, not
for their integrity.

::: warning Import is not available yet
The `zone.stratos.repo.importRepo` lexicon defines the reverse call. The
service does not register a handler for it. Export works today; import does
not.
:::

A PDS-custody member needs none of this. Their records already live on their
own PDS.

### Staying current: pull sync

Services that follow a repository use pull sync.
`zone.stratos.sync.listRepoOps` returns the operations after a known
revision, boundary-gated to the caller, with current values inlined. The
response is `{ ops, cursor?, commit? }`:

- A `cursor` means there is more. Call again with it.
- No `cursor` means the caller reached the head. The response then carries
  the current signed commit. A repository with no root yet has no commit to
  return.
- A write that lands while the head is being read returns a cursor and no
  commit. The page may be empty and the cursor unchanged. Poll again; an
  unchanged cursor is not a stall.

If Stratos cannot serve the requested position, it answers `OplogTruncated`.
This covers a revision older than retained history, and also any cursor it
cannot place. The caller then falls back to
`zone.stratos.sync.listRecordPaths`: list paths and CIDs, compare with local
state, fetch what is missing.
