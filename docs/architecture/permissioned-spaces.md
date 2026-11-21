---
audience: Protocol implementers and app developers
type: Explanation
status: current
---

# Permissioned Spaces

<script setup>
import SpaceCredentialFlowAnimation from '../.vitepress/theme/components/SpaceCredentialFlowAnimation.vue'
import SpaceDataResidencyAnimation from '../.vitepress/theme/components/SpaceDataResidencyAnimation.vue'
</script>

Stratos started with a simple idea: a _boundary_ is a named group, and only
its members can read what is posted in it. While Stratos was building
boundaries, the AT Protocol community was designing its own model. The
permissioned data proposal
([proposal 0016](https://github.com/bluesky-social/proposals/blob/main/0016-permissioned-data/README.md))
calls the group a _space_: a named, membership-gated container of records,
addressed by an `at:space/` URI and governed by a _space authority_ that
decides who may read from it.

The two ideas are the same idea. Stratos uses the proposal's vocabulary and
its credential, delegation and URI shapes. Every Stratos boundary is a space,
Stratos is the authority for it, and the service has its own methods under
`zone.stratos.space.*`.

This page tells that story in order: how a boundary becomes a space, who
keeps the records, how a reader proves they belong, and where Stratos still
goes its own way. The exact contract Stratos tests against, including the
pinned upstream revisions, lives in [Spaces alignment](./spaces-alignment.md).

## Why align with the spaces proposal

Stratos and the proposal solve the same problem: records in the atproto
identity and repository model that only an authorized group may read. The
`zone.stratos.space.*` methods are Stratos's own. They are not mirrors of the
upstream `com.atproto.space.*` methods. Only the credential, delegation and
URI shapes follow upstream.

Alignment pays off in two places:

- **A user's own PDS can keep their private posts.** When a PDS supports
  spaces, the records stay there, and Stratos only decides who belongs. No
  upstream host accepts the `at:space/` spelling yet, so this is proven at
  package level only, pending a host that accepts the new spelling. See
  [Supported versions](./supported-versions.md).
- **The data model needs no rework.** Space URIs, sender-bound credentials,
  and reads that never leak existence all carry over as the proposal moves.

Alignment does not make Stratos part of the open network. Access stays gated
by enrollment and, where an operator configures one, an app allow-list.

## The model: boundaries as spaces

A Stratos boundary is a qualified string, `{serviceDid}/{domainName}`. A
space URI is:

```text
at:space/{spaceDid}/{spaceType}/{skey}
```

The two map onto each other field by field:

| Boundary component | Space component | Example                       |
| ------------------ | --------------- | ----------------------------- |
| `serviceDid`       | `spaceDid`      | `did:web:stratos.example.com` |
| `domainName`       | `skey`          | `engineering`                 |
| (implied)          | `spaceType`     | `zone.stratos.space.feed`     |

So the boundary `did:web:stratos.example.com/engineering` is the space:

```text
at:space/did:web:stratos.example.com/zone.stratos.space.feed/engineering
```

The scheme is `at:space/`, not `at://`. A space URI is not an `at://` URI, so
it never goes to a parser for public record addresses. A space URI is exactly
the form above. Nothing accepts or converts a URI in any other form. Parsing is
strict: canonical
form is byte equality, with no case folding and no normalization.
The space key (`skey`) uses atproto record-key syntax and must be 1 to 512
UTF-8 bytes. Domain names already satisfy that syntax, so every existing
boundary name is a valid skey.

The single source of truth for this grammar is
`stratos-core/src/spaces/domain.ts`. `stratos-client` exports
`boundaryToSpaceUri`, `parseSpaceUri`, `parseSpaceRecordUri` and
`parseRecordAddress`, so client code does not import the grammar from core.

### Two record addresses

A record inside a space has a longer URI. It appends the author, the
collection, and the record key. That is `at:space/` plus six parts, and the
first part is the **authority**, not the author. This is the address of a
record that lives in a space repository on a member's PDS. A record that
Stratos hosts keeps the familiar address, `at://{author}/{collection}/{rkey}`.

<RecordUri kind="space" />

Code that takes the first part of a URI as the author is wrong for a space
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
      "title": "Stratos Feed",
      "collections": [
        "zone.stratos.feed.post",
        "app.bsky.feed.like",
        "app.bsky.feed.repost"
      ]
    }
  }
}
```

`"key": "any"` means any valid skey names an instance of this space type.
That is what lets every boundary name become a space without registration.

`title` is the display name. The upstream schema takes it as optional, 1 to 64
UTF-8 bytes when present. A PDS older than the November release requires a
`name` member instead and refuses a declaration without it. The November
release accepts a `name` beside `title` and ignores it. The file in the
repository holds `title` only. How to publish it is the operator's choice; see
[the space type declaration](/operator/november-upgrade#the-space-type-declaration).

The declaration lists three collections. A member who hosts their own repo
can write a like or repost only when the published record lists them and
their OAuth grant covers them. The Stratos enrollment client requests all
three collections. A PDS resolves the published record, not the file in the
repository, so publish the record again whenever the file changes. Until then
a PDS may return a partial grant, and the member must authorize again after
the update.

::: warning Keep the space type published
A spaces-capable PDS resolves `zone.stratos.space.feed` as a
`com.atproto.lexicon.schema` record before it grants a space scope. If the
record is missing, authorization fails with `invalid_scope`, and nothing in
the Stratos logs explains why. A declaration that the PDS refuses, such as one
without `name` on a PDS older than the November release, fails the same way.
:::

## Who keeps the records: custody

Here the story splits in two. Stratos is always the authority: it owns the
space and decides who is a member. But the authority does not have to be the
place where the records sit. We call the answer to "who holds this user's
records" their **custody**.

| User's PDS     | Custody   | Repo host          | Who signs                    | Record URI                |
| -------------- | --------- | ------------------ | ---------------------------- | ------------------------- |
| non-spaces     | `stratos` | Stratos            | Stratos, per-actor P-256 key | `at://` and three parts   |
| spaces-capable | `pds`     | the user's own PDS | the user's account key       | `at:space/` and six parts |

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

PDS custody comes with hard limits. An authority cannot control what a repo
host accepts.

<!--@include: ../.vitepress/partials/custody-rules.md-->

**A removed member's credential lives until it expires.** Stratos can refuse
a credential on its own endpoints at once. A foreign PDS cannot be told. See
[the known gaps](./supported-versions.md#known-gaps).

## How access works

Access to a space follows three stages: membership, credential, read.

### Membership

A user enrolls with a Stratos service through OAuth. The service records
which boundaries the user belongs to. Boundary membership _is_ space
membership; there is no second membership store. Stratos checks it live, at
the moment it matters, against the enrollment store.

### Credential

<SpaceCredentialFlowAnimation />

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
  "sub": "at:space/did:web:stratos.example.com/zone.stratos.space.feed/engineering",
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

| Profile        | Bound by                     | Default lifetime                   | Presented as                                                                                                          | Typical caller                |
| -------------- | ---------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| DPoP           | `cnf.jkt`, a DPoP key        | 2 hours                            | `Authorization: DPoP <credential>` and a fresh `DPoP` proof                                                           | OAuth clients                 |
| HTTP signature | `cnf.kid`, a P-256 `did:key` | 10 minutes, never more than 1 hour | `Authorization: Atproto-Space-Credential <credential>`, `Atproto-Space-Audience`, and an RFC 9421 request `Signature` | Services, such as the feedgen |

A **DPoP** proof is made per request. It carries the method, the URL, and a
hash of the credential, and Stratos accepts each proof once.

An **HTTP signature** covers the `Authorization` header and an
`Atproto-Space-Audience` header. The audience is the DID the caller means to
read from: the repo owner for record and sync reads, the authority for a
membership listing. A signature stays valid for that audience until the
credential expires. The signature is tagged `atproto-space-credential` and
covers `authorization` then `atproto-space-audience`. Stratos checks the tag
and the covered parts, not the signature label. This is the upstream
presentation. No other scheme is accepted. On the five read routes
(`zone.stratos.space.getRecord`, `zone.stratos.space.listBlobs`,
`zone.stratos.space.listRepos`, `zone.stratos.sync.listRepoOps` and
`zone.stratos.sync.listRecordPaths`), a request with the earlier
`Authorization: Atproto-Space` scheme is not recognised and is refused with
`401`. On `zone.stratos.repo.hydrateRecord` and `hydrateRecords`, such a request
is answered as an anonymous request, which returns nothing private.

The mint exchange has its own form. It is a `Bearer` delegation with one
signature labelled `atproto-space` that covers `authorization`.

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
  usable once. Its `aud` is the authority DID with the fragment
  `#atproto_pds`, for example `did:web:stratos.example.com#atproto_pds`. A
  client attestation names the same audience. The Stratos DID document offers
  no such service entry. The caller sends it as `Authorization: Bearer` (or, on the
  older internal transport, in the request body; never both) together with a
  DPoP proof or an HTTP signature made by the key the credential will bind
  to.

A space can also be gated to approved apps. The allow-list comes from the
boundary catalog, with `STRATOS_SPACE_APP_ACCESS` as the fallback. A caller
to a gated space presents a single-use **client attestation**; the attested
`client_id` must be on the list. Spaces with no allow-list ignore
attestations.

Each refusal has an error name. See
[Space credentials](/reference/errors#space-credentials) in the error
reference.

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

The `zone.stratos.space.*` and `zone.stratos.sync.*` methods are Stratos's own.
None of them mirrors an upstream method. The table says what each one is and
whether an upstream method of a similar name exists.

| Stratos NSID                            | Upstream method of a similar name      | Status                                    | Note                                                                     |
| --------------------------------------- | -------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| `zone.stratos.space.feed`               | Space type declaration                 | <Badge type="tip" text="standard" />      | A `type: space` lexicon                                                  |
| `zone.stratos.space.getSpaceCredential` | `com.atproto.space.authorizeSpaceSync` | <Badge type="info" text="Stratos only" /> | Not an alias. No notification, no writer revision. Both binding profiles |
| `zone.stratos.space.getRecord`          | `com.atproto.space.getRecord`          | <Badge type="info" text="Stratos only" /> | Stratos-hosted records only. A member's PDS is never asked               |
| `zone.stratos.space.listBlobs`          | `com.atproto.space.listBlobs`          | <Badge type="info" text="Stratos only" /> | Stratos-hosted blobs only                                                |
| `zone.stratos.space.listRepos`          | none                                   | <Badge type="info" text="Stratos only" /> | Lists the active members of a boundary                                   |
| `zone.stratos.sync.listRepoOps`         | `com.atproto.space.listRepoOps`        | <Badge type="info" text="Stratos only" /> | Takes and returns different shapes; recovery differs; see below          |
| `zone.stratos.sync.listRecordPaths`     | none                                   | <Badge type="info" text="Stratos only" /> | Full-state recovery; see below                                           |
| `zone.stratos.repo.hydrateRecord(s)`    | none                                   | <Badge type="info" text="Stratos only" /> | Batch, boundary-filtered reads                                           |
| `zone.stratos.sync.subscribeRecords`    | none                                   | <Badge type="info" text="Stratos only" /> | Actor-scoped stream                                                      |

Some caveats, stated plainly:

| Caveat                                         | What it means                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The proposal is not final                      | Stratos pins the upstream revisions it tests against in [Spaces alignment](./spaces-alignment.md). The credential, delegation and URI shapes follow upstream. The methods do not, so an upstream change to a method does not break a deployed client.                                                                            |
| Stratos is not a complete upstream authority   | It does not advertise a `#atproto_pds` service entry and does not claim upstream authority discovery. A generic spaces client cannot walk up to a Stratos service and read.                                                                                                                                                      |
| `listRepos` answers a different question       | The Stratos method lists the active members of a boundary. Upstream has no such method at the pinned reference. Never use a writer list from a host to revoke a member.                                                                                                                                                          |
| Pull sync diverges on recovery                 | Stratos reports a cursor it can no longer serve as `OplogTruncated`, and recovery goes through `listRecordPaths`.                                                                                                                                                                                                                |
| Commit verification depends on custody         | A Stratos-custody commit verifies against the per-actor key in the enrollment record. The feed generator does not check the signature of a PDS-custody commit. It authenticates each response with a MAC and promotes state only when the set hash equals the commit's `data`. See [Feed generator design](./feed-generator.md). |
| The Stratos repo format is MST                 | It has durable signed commits. The format sits behind an internal seam, so a later change is one controlled cutover.                                                                                                                                                                                                             |
| A valid credential is not a completeness proof | A signed response shows who served it. It does not show that the host returned every record the caller may read.                                                                                                                                                                                                                 |
| Records are not end-to-end encrypted           | They are access-controlled. The service and its authorized consumers handle plaintext by design.                                                                                                                                                                                                                                 |
| Hydration predates the proposal and stays      | See below.                                                                                                                                                                                                                                                                                                                       |

## Design decisions Stratos keeps, and why

Alignment did not mean adopting the proposal wholesale. Several Stratos
decisions predate it and stay in place on purpose. A dash means this page
states no upstream position.

| Decision                                       | Upstream                                                        | Stratos                                                                                                          | Why                                                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Boundaries remain the internal model           | Records are addressed by space URI                              | Records carry a `boundary` field. The space URI is derived from it (`boundaryToSpaceUri` / `spaceUriToBoundary`) | The mapping is lossless. Deployed records need no rewrite as the proposal moves. Only the derivation changes if addressing does |
| Membership lives in the enrollment store       | Leans toward membership as records                              | Checked live against the enrollment store                                                                        | An operator's change takes effect at the next check. Short credential lifetimes bound the window, with no revocation list       |
| Hydration stays beside the Stratos space reads | `com.atproto.space.getRecord` answers one record for one caller | Batch, boundary-filtered [hydration](./hydration.md)                                                             | A timeline beside public posts needs batch reads                                                                                |
| Signed per-actor repositories                  | —                                                               | MST commits and per-actor keys, even when Stratos hosts                                                          | Verifiable export, host-independent CIDs, and block-by-block checks follow from that structure                                  |
| Actor-scoped sync                              | —                                                               | `subscribeRecords` is per actor. Pull sync is boundary-gated to the caller                                       | A service-wide firehose would leak activity across boundaries. We accept the slower fan-out                                     |
| Custody follows the user's PDS                 | Spaces live on a spaces-capable PDS                             | Members of both custody classes share one boundary                                                               | We do not force every member onto Stratos hosting, and we do not wait for every PDS to support spaces                           |

Two limits come with these choices.

- Stratos mints and holds the per-actor key. A commit signature proves the
  repository is intact and attributable to the key the enrollment record
  names. It does not prove the user authorized each commit independently of
  Stratos.
- Moving a member from one custody class to the other is a migration. It does
  not happen by itself.

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
