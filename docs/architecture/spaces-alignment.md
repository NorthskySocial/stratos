---
audience: Protocol implementers and maintainers
type: Decision record
status: partial
---

# Spaces: current contract <Badge type="warning" text="partial" />

[Permissioned Spaces](./permissioned-spaces.md) tells the story of how Stratos
aligns with the AT Protocol spaces proposal. This page is the fine print: what
ships today, what each party is trusted for, and what is deliberately not
claimed. Read the story first.

## Status at a glance

| Area                                                            | Status                                      | Today                                                                                                          |
| --------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [Custody](#custody)                                             | <Badge type="tip" text="shipped" />         | Stratos is the authority for both custody classes. The repo host is Stratos or the member's spaces PDS.        |
| [Record addresses](#record-addresses-and-boundary-claims)       | <Badge type="tip" text="shipped" />         | Space record URIs start with the authority. The feed generator re-derives each boundary from enrollment.       |
| [Authority endpoints](#endpoints)                               | <Badge type="tip" text="shipped" />         | `zone.stratos.space.*`. The upstream `#atproto_space_host` role is not advertised.                             |
| [Membership listing](#membership-listing)                       | <Badge type="info" text="custom" />         | A custom `listRepos` snapshot of active enrollments. A standard writer listing is proposed.                    |
| [Standard credentials](#credential-transport)                   | <Badge type="tip" text="shipped" />         | `cnf.kid`, 600 seconds by default, 3,600 seconds at most. Legacy `cnf.jkt` is kept.                            |
| [Remote revocation](#credential-transport)                      | <Badge type="danger" text="not included" /> | A credential stays valid on a foreign PDS until it expires.                                                    |
| [In-flight ingest fence](#in-flight-work-at-the-feed-generator) | <Badge type="warning" text="required" />    | A membership generation must fence staged foreign commits after removal. Without it, an exposure window stays. |
| [Full-content proof](#what-a-signature-proves)                  | <Badge type="danger" text="not included" /> | A signature covers the served view, not every permitted record.                                                |
| [`space-ref` validation](#lexicon-validation)                   | <Badge type="warning" text="workaround" />  | The installed validator accepts bad values. Runtime `parseSpaceUri` rejects them.                              |
| [Upstream pins](#pinned-upstream-revisions)                     | <Badge type="info" text="pinned" />         | Tests target fixed upstream revisions. A pin is not a deployed version.                                        |

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

Space record URIs have the form
`at://{authorityDid}/space/{type}/{skey}/{authorDid}/{collection}/{rkey}`.
The authority DID is first; the author DID is not.

A PDS can store a record claiming any Stratos boundary, so the Feedgen
re-derives that boundary from authority enrollment before admitting it.
Membership selects repositories to read; it does not prevent a removed member
from writing on their own PDS. See the
[three custody rules](/operator/architecture#three-rules).

:::

## Endpoints

::: details Detail

Stratos currently exposes `zone.stratos.space.*` authority endpoints,
including `getSpaceCredential`, `getRecord`, `listBlobs`, and `listRepos`,
plus `zone.stratos.sync.*` pull reads. These are deliberately separate from the
upstream `com.atproto.space.*` namespace. The alpha PDS hosts member
repositories using upstream `com.atproto.space.*` methods.

Stratos's custom credential mint accepts a PDS-issued delegation as
`Authorization: Bearer` with a standalone DPoP proof and a JSON `space` body;
the internal body-delegation transport remains supported.

Stratos does not advertise the upstream `#atproto_space_host` role or claim
complete upstream authority discovery.

:::

## Membership listing

::: details Detail

The custom `zone.stratos.space.listRepos` enumerates active boundary
enrollments, not standard writer updates. Its cursor is a member DID and
appears only for full pages. The Rust membership reconciler completes that
snapshot before replacement.

Standard `com.atproto.space.listRepos` uses exclusive space-revision cursors,
permits repeated writers, and requires continuation until an empty page. Never
use a writer delta to revoke omitted members. See the proposed
[October writer sync contract](./october-writer-sync-contract.md); no standard
writer handlers are enabled by that design.

:::

## Credential transport

::: details Detail

The standard receiver coexists with legacy OAuth/DPoP clients. The Rust
Feedgen exchanges its existing service delegation in Bearer Authorization with
an HTTP signature and a JSON `space` body.

| Property           | Standard credential                                                      |
| ------------------ | ------------------------------------------------------------------------ |
| Binding            | `cnf.kid`, a fresh grant-owned P-256 `did:key`                           |
| Lifetime           | 600 seconds by default, never more than 3,600 seconds                    |
| Signed headers     | `Authorization` and `Atproto-Space-Audience`                             |
| Read audience      | The repo owner DID for repo operations, the authority DID for membership |
| Signature reuse    | Allowed for that audience until expiry                                   |
| Not read audiences | Methods, URLs, hosts, and service fragments                              |

Legacy credentials retain their separate `cnf.jkt`/DPoP transport.

A credential's space scope maps to one Stratos boundary; it is not the
original member's live identity.

| Event                                      | Effect on Stratos endpoints                          | Effect on a foreign PDS                 |
| ------------------------------------------ | ---------------------------------------------------- | --------------------------------------- |
| Member removed                             | No new credentials; enrollment-checked requests fail | An issued credential reads until expiry |
| Wrong-key proof or expired credential      | Rejected                                             | Rejected                                |
| Local boundary deletion or revision change | Credentials bound to the old revision fail           | No effect                               |

Foreign PDS hosts do not understand Stratos's private boundary revision claim,
so local revision invalidation is not a universal remote revocation signal.

:::

## In-flight work at the feed generator

::: details Detail

For the Feedgen, authority membership must also fence work already in flight:
a generation change must prevent staged foreign commits from being promoted
after removal and must survive restart. This is a separate ingestion control,
not credential revocation.

Deployments without that generation fence retain an in-flight exposure window.
Outstanding foreign-host credentials remain bounded by their expiry unless the
foreign host provides an independent revocation mechanism.

:::

## What a signature proves

::: details Detail

Signing has two different meanings here. Stratos-custody MST commits and
PDS-custody account commits can authenticate a signer and the relevant
committed state.

The current cross-host space proof uses a signature/MAC over a served view; it
does not establish a durable, independently verifiable full-content proof for
every historical record. Do not equate a valid credential or signed response
with proof that the host returned all permitted content.

The remaining work is interoperable authority discovery, foreign-host
revocation, and a complete content-proof contract.

:::

## Not included

::: details Detail

- Early revocation fanout is optional. It is not an automatic consequence of
  member removal.
- Custom membership enumeration selects repositories independently of upstream
  writer metadata. It does not establish full standard authority support.

The operator procedure is in
[October spaces rollout](/operator/upgrades/october-spaces).

:::

## Lexicon validation

::: details Detail

No production package, Clubhouse, or test sends
`com.atproto.space.listSpaces` or `com.atproto.space.createSpace`. No
request-field rename or dependency upgrade is needed. Internal space types and
OAuth scope syntax remain unchanged.

The installed service validator, `@atproto/lexicon` 0.7.11, accepts a
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

| Component                    | Revision                                   |
| ---------------------------- | ------------------------------------------ |
| Reference implementation     | `5b95b2f2723a2882824fbb0b819fd6aad884ef20` |
| Alpha PDS (sandbox and AiaB) | `79d6307e19908f3af406838ea0e5fae42847f182` |

The sandbox pins the alpha PDS source and checks its Dockerfile and lockfile
hashes before building. These are separate snapshots. The deployed PDS image
must also be traced to its source revision and immutable image digest; a
source checkout alone does not prove what is running.

The October client contract is pinned to the reference implementation above.
This is not a deployed-version attestation. The Rust client has no legacy
fallback; coordinate receiver/client restart and discard old grants.

:::

## Test suites

::: details Detail

| Suite                           | What it adds                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| Mandatory baseline              | Ten assertions every suite runs first                                                      |
| `rust-production-interop`       | A second owner's publication and Rust ingestion on the same primary PDS                    |
| `standard-credential-transport` | Transport denial and signature reuse checks                                                |
| `october-interop`               | All fifteen standard assertions and eleven Rust assertions, with distinct fixture accounts |

`october-interop` first verifies the default 600-second lifetime. It then
recreates only the disposable authority with a ten-second lifetime, for an
actual Rust expiry refresh. Separate regression runs use fresh sandbox
accounts. Runtime acceptance requires separate reviews and a clean candidate
commit.

:::

## Source reference

- The standard receiver was introduced by Plan 014, PR #218.
- Plan 016 produced the caller inventory behind
  [Lexicon validation](#lexicon-validation).
- Plan 017 is not included or deployed by this contract. This repository is
  not evidence of any production deployment.
- The independent DPoP ADR in PR #217 is not required for this transport.
