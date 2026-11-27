---
audience: Protocol implementers and maintainers
type: Decision record
status: partial
---

# Spaces alignment <Badge type="warning" text="partial" />

[Permissioned Spaces](./permissioned-spaces.md) explains how Stratos aligns
with the AT Protocol spaces proposal. This page is the fine print: what
Stratos does, what each party is trusted for, and what it does not claim. Read
the explanation first.

The page is partial because no part of this contract has run against a real
PDS. Each part is proven at package level. The parts that need a host wait for
a host that accepts the `at:space/` spelling. See
[Supported versions](./supported-versions.md).

## Status at a glance

| Area                                                                 | Status                                      | Today                                                                                                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Custody](#custody)                                                  | <Badge type="tip" text="shipped" />         | Stratos is the authority for both custody classes. The repo host is Stratos or the member's spaces PDS.                                                       |
| [Record addresses](#record-addresses-and-boundary-claims)            | <Badge type="tip" text="shipped" />         | Space record URIs are `at:space/` plus six parts and start with the authority. The feed generator re-derives each boundary from enrollment.                   |
| [Authority endpoints](#endpoints)                                    | <Badge type="tip" text="shipped" />         | `zone.stratos.space.*` are Stratos methods. Delegations and attestations name `<authority did>#atproto_pds`. `notifyRepoUpdate` is accepted and acknowledged. |
| [Membership listing](#membership-listing)                            | <Badge type="info" text="custom" />         | A Stratos `listRepos` snapshot of active enrollments. Stratos serves no upstream writer route.                                                                |
| [Standard credentials](#credential-transport)                        | <Badge type="tip" text="shipped" />         | `cnf.kid`, 600 seconds by default, 3,600 seconds at most, presented as `Atproto-Space-Credential`. `cnf.jkt` is kept.                                         |
| [Remote revocation](#credential-transport)                           | <Badge type="danger" text="not included" /> | A credential stays valid on a foreign PDS until it expires.                                                                                                   |
| [Verified sync of PDS members](#verified-sync-at-the-feed-generator) | <Badge type="tip" text="shipped" />         | Each response carries a MAC and each state is promoted only when its set hash equals the commit's `data`. Nothing is staged.                                  |
| [Full-content proof](#what-a-signature-proves)                       | <Badge type="danger" text="not included" /> | A signature or MAC covers the served view, not every permitted record.                                                                                        |
| [`space-ref` validation](#lexicon-validation)                        | <Badge type="warning" text="workaround" />  | The installed validator accepts bad values. Runtime `parseSpaceUri` rejects them.                                                                             |
| [Upstream pins](#pinned-upstream-revisions)                          | <Badge type="info" text="pinned" />         | Tests target fixed upstream revisions. A pin is not a deployed version.                                                                                       |

Each row has its detail below.

## Custody

| Concern              | Stratos custody                                                           | PDS custody                                                                    |
| -------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Space authority      | Stratos                                                                   | Stratos                                                                        |
| Repository host      | Stratos                                                                   | Member's spaces-capable PDS                                                    |
| Commit signer        | Stratos's per-actor P-256 key, attested by Stratos enrollment             | Account key held by the member's PDS                                           |
| Authorization server | The issuer accepted by the OAuth flow; it need not be the repository host | The issuer accepted by the OAuth flow; it need not be the repository host      |
| Record source        | Stratos's signed MST repository                                           | Member's upstream space repository                                             |
| Membership decision  | Current Stratos enrollment                                                | Current Stratos enrollment selects which member repositories the Feedgen reads |

## Record addresses and boundary claims

::: details Detail

A space URI has the form `at:space/{authorityDid}/{type}/{skey}`. A space
record URI adds `/{authorDid}/{collection}/{rkey}`, so it is `at:space/` plus
six parts. The authority DID is first; the author DID is not. A Stratos-custody
record keeps `at://{authorDid}/{collection}/{rkey}`. A space URI is exactly
this form. Nothing accepts or converts a URI in any other form.

A PDS can store a record claiming any Stratos boundary, so the Feedgen
re-derives that boundary from authority enrollment before admitting it.
Membership selects repositories to read; it does not prevent a removed member
from writing on their own PDS. See the
[three custody rules](/operator/architecture#three-rules).

:::

## Endpoints

::: details Detail

Stratos exposes `zone.stratos.space.*` authority endpoints, including
`getSpaceCredential`, `getRecord`, `listBlobs`, and `listRepos`, plus
`zone.stratos.sync.*` pull reads. They are Stratos methods. None of them
mirrors an upstream `com.atproto.space.*` method, and each lexicon says so.
A spaces PDS hosts member repositories using upstream `com.atproto.space.*`
methods.

Stratos serves one upstream method, `com.atproto.space.notifyRepoUpdate`, which
a member's PDS sends the space host after a write. Stratos checks the token,
the space and the writer's membership, answers 200 and stores nothing; the
feed generator still polls the member's PDS. The other upstream space-host
methods, including `listWriters`, `notifyCredentialsRevoked` and
`authorizeSpaceSync`, are answered as an unknown method (501).

Stratos's credential mint accepts a PDS-issued delegation as
`Authorization: Bearer` with a standalone DPoP proof and a JSON `space` body;
the internal body-delegation transport remains supported.

A delegation and a client attestation carry the audience
`<authority did>#atproto_pds`. The Stratos DID document offers a
`#atproto_pds` service at the Stratos origin, so a member's PDS can deliver
`notifyRepoUpdate`. Stratos does not claim complete upstream authority
discovery: an upstream client that takes Stratos for a complete space host
gets 501 from every other space-host method.

:::

## Membership listing

::: details Detail

The Stratos `zone.stratos.space.listRepos` enumerates active boundary
enrollments, not writer updates. Its cursor is a member DID and appears only
for full pages. The Rust membership reconciler completes that snapshot before
replacement. At the pinned reference the upstream `listRepos` is renamed
`com.atproto.space.listWriters`. The space host serves it, and it lists each
writer's latest revision or removal, with no host. The Stratos method lists
active members with custody and host, which `listWriters` does not answer.

Membership comes from enrollment. Never use a writer list that a host reports
to revoke or admit a member.

:::

## Credential transport

::: details Detail

The HTTP-signature receiver coexists with OAuth/DPoP clients. The Rust
Feedgen exchanges its service delegation in Bearer Authorization with an HTTP
signature and a JSON `space` body. That exchange keeps its own form: a
signature labelled `atproto-space` that covers `authorization`. A credential
is presented as `Authorization: Atproto-Space-Credential <jwt>` with an
`Atproto-Space-Audience` header and one signature tagged
`atproto-space-credential` that covers `("authorization"
"atproto-space-audience")`. The label of that signature is not checked. Stratos
accepts only this scheme. On the five read routes, a request with the earlier
`Atproto-Space` scheme is not recognised and is refused with `401`. On
`zone.stratos.repo.hydrateRecord` and `hydrateRecords`, it is answered as an
anonymous request, which returns nothing private.

| Property           | Standard credential                                                      |
| ------------------ | ------------------------------------------------------------------------ |
| Binding            | `cnf.kid`, a fresh grant-owned P-256 `did:key`                           |
| Lifetime           | 600 seconds by default, never more than 3,600 seconds                    |
| Signed headers     | `Authorization` and `Atproto-Space-Audience`                             |
| Read audience      | The repo owner DID for repo operations, the authority DID for membership |
| Signature reuse    | Allowed for that audience until expiry                                   |
| Not read audiences | Methods, URLs, hosts, and service fragments                              |

Credentials bound to a DPoP key (`cnf.jkt`) keep their separate DPoP
transport and a default lifetime of 7,200 seconds.

A credential's space scope maps to one Stratos boundary; it is not the
original member's live identity.

| Event                                      | Effect on Stratos endpoints                                                           | Effect on a foreign PDS                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------- |
| Member removed                             | No new credentials; enrollment-checked requests fail                                  | An issued credential reads until expiry |
| Wrong-key proof or expired credential      | Rejected                                                                              | Rejected                                |
| Operator hold or account takedown          | No new credentials. An issued credential still reads on a read route until it expires | An issued credential reads until expiry |
| Local boundary deletion or revision change | Credentials bound to the old revision fail                                            | No effect                               |

Foreign PDS hosts do not understand Stratos's private boundary revision claim,
so local revision invalidation is not a universal remote revocation signal.

:::

## Verified sync at the feed generator

::: details Detail

For a PDS-custody member, the feed generator keeps a verified state per member
and space. Each response from the host carries a MAC. The feed generator
derives the MAC key from an HPKE secret that uses a one-time key and the
member's `#atproto_kem` key. It promotes a change only when the set hash it
computes equals the `data` of the commit. When incremental sync cannot work,
it reads the whole repo as an archive. Nothing is staged, so a membership
change has nothing in flight to fence: a read, promotion, replacement or clear
made under a membership generation that is no longer the member's current one
writes nothing.

The feed generator does not verify the account signature of a PDS-custody
commit. The MAC authenticates the host's answer, and the set hash proves the
state. A `RepoNotFound` answer at status 400 carries no MAC. Only the pinned
TLS connection to the host that the authority named protects it, so the feed
generator clears a member only after one host has given that answer for one
hour without another end of the member's cycle between and with no more than
20 minutes between two answers. An answer from another host or to a new
membership generation starts the hour again. The hour is kept in memory. The steps, limits and reason words are in
[Run the feed generator](/operator/feedgen-ng#verified-sync-of-pds-members).

:::

## What a signature proves

::: details Detail

Signing has two different meanings here. A Stratos-custody MST commit
authenticates a signer and the committed state. For a PDS-custody member the
feed generator authenticates the host's answer with a MAC and proves the state
with the set hash against the commit's `data`.

The cross-host space proof covers a served view. It does not establish a
durable, independently verifiable full-content proof for every historical
record. Do not equate a valid credential or authenticated response with proof
that the host returned all permitted content.

Interoperable authority discovery, foreign-host revocation, and a complete
content-proof contract are not part of Stratos.

:::

## Not included

::: details Detail

- Early revocation fanout is optional. It is not an automatic consequence of
  member removal.
- Custom membership enumeration selects repositories independently of upstream
  writer metadata. It does not establish full standard authority support.
- A host's takedown, suspension or deactivation of a member's account fails
  that member's sync and deletes nothing. The cached posts of that member stay
  served.

The operator procedure is in
[November upgrade and rollback](/operator/november-upgrade).

:::

## Lexicon validation

::: details Detail

No Stratos package, the webapp or Clubhouse sends
`com.atproto.space.listSpaces` or `com.atproto.space.createSpace`. Internal
space types and OAuth scope strings are unchanged by the URI spelling.

The installed service validator, `@atproto/lexicon` 0.7.22, accepts a
`space-ref` schema but also accepts an invalid space string: it does not
enforce that format. The executable
`test/spaces-alignment/scenarios/installed-validator.test.ts` regression loads
the service-installed package, checks its version, and verifies valid and
malformed strings without normalization. It also confirms that runtime
`parseSpaceUri` rejects the malformed strings.

Keep custom lexicon references as plain strings and retain runtime
`parseSpaceUri` validation. A future schema-only follow-up must first verify
malformed-value rejection in the selected validator, then update the affected
lexicons and regenerate bindings within its own scope.

:::

## Pinned upstream revisions

::: details Detail

| Component                         | Pin                                        |
| --------------------------------- | ------------------------------------------ |
| Reference implementation revision | `b5fd12fa57b10cf068efa879812f558780f37109` |
| Release anchor                    | `d4def6e9f521896ed8222f576d54923d00b5fbeb` |
| Package version                   | `0.0.0-spaces-alpha-20261117141222`        |
| Proposal revision                 | `b54ec6853bab77edd4fd373804a480633094b324` |

The pins are in `test/spaces-alignment/november/sources.json`. They fix what
the tests compare against. They are not a deployed-version attestation. A
deployed PDS image must be traced to its source revision and immutable image
digest; a source checkout alone does not prove what is running.

The reference at this revision accepts only the earlier `at://` spelling in
space parameters. The pins record that it does not support the `at:space/`
spelling (`referenceSupportsTargetUri: false`) and that no host-level evidence
exists yet (`cutoverEvidence.status: unfulfilled`). The sandbox images are
older than the November release and refuse the new spelling too.

:::

## Test suites

::: details Detail

The spaces-alignment suite (`test/spaces-alignment`) runs without a host. It
holds the oracle fixtures made by the pinned upstream package, the space URI
corpus, the applicability ledger and the contract tests that read them. These
run in the repository's test workflow.

The sandbox suites in the same folder run a real stack against pinned sandbox
images. Those images predate the November release and refuse the `at:space/`
spelling, so a sandbox suite that needs a PDS-custody member cannot pass today.
See [Supported versions](./supported-versions.md).

:::

## Where the earlier contract is described

The October contract is described in [history](/history/). No current build
implements it.
