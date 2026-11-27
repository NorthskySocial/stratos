---
audience: Protocol implementers and maintainers
type: Explanation
status: current
---

# Repo-Host Discovery

Stratos knows who belongs to a boundary. For members who keep their own
records, it also has to know where those records are hosted. Before anyone can read or sync a
PDS-custody member's posts, something must answer one question: which host
holds this member's repository?

This page describes how Stratos answers it.

## Why this is Stratos's convention, not upstream's

The upstream spaces methods report who wrote into a space. They do not say
where each writer's repository is hosted. Upstream uses the fragment
`#atproto_pds` of the space authority's DID as the audience of credentials and
delegations (`spaceHostAud` in `packages/space/src/credential.ts` at the
reference revision). Stratos fills the gap for repo hosts with its own rule.

## The convention

1. The host Stratos recorded for this member, if it holds one.
2. Otherwise the `#atproto_pds` service endpoint in the member's DID document.

The recorded host wins unconditionally. Once it resolves, the DID document is
never consulted.

The recorded host is the `repoHost` field of the member's enrollment. Stratos
writes it at OAuth enrollment, and again at re-authentication, from the PDS
endpoint it resolved for the member. It is not a separately curated table,
and there is no operator write path for it. An operator can read what Stratos
resolves for a member with the admin query `zone.stratos.admin.getRepoHost`.

A member that cannot be resolved yields `undefined`. This covers no recorded
host, no PDS endpoint in the DID document, and a failed lookup. The resolver
never throws. One member with a momentarily unreachable DID document must not
halt a sync pass across the rest of a space's membership.

## Where consumers see it

`zone.stratos.space.listRepos` lists the members of a space. Stratos runs the
resolver for `pds`-custody members only, and returns the result as `host` and
`hostSource` beside each member. A Stratos-custody member needs no host: their
repository is on Stratos.

The [feed generator](./feed-generator.md) takes the host from that listing.
It does not resolve a member's host itself. It does read the member's DID
document to find the `#atproto_kem` key that authenticates the host's answers.

The DID-document lookup refuses private and local `did:web` hosts.

::: warning A published `repoHost` is a hint
The same `repoHost` value also appears in the member's public enrollment
record. The account that owns the record can rewrite the public copy. Clients
must not send credentials to a host only because the public record names it.
See [Client Integration](/client/getting-started).
:::

## Implementation

The resolver lives in `stratos-core/src/spaces/host-discovery.ts` as a pure
function, `resolveRepoHost(spaceUri, memberDid, deps)`. Both dependencies are
injected ports (`HostOverrideReader`, `DidPdsReader`), so the resolution logic
is unit-testable without network access:

```ts
export interface HostOverrideReader {
  get(spaceUri: string, memberDid: string): Promise<string | undefined>
}

export interface DidPdsReader {
  getPdsEndpoint(memberDid: string): Promise<string | undefined>
}
```

`resolveRepoHost` returns `{ host, source }`, where `source` is
`'authority-override'` or `'did-document'`. The source is surfaced so an
operator debugging a bad route can see which arm answered. The "never throws"
guarantee is enforced once inside the resolver (`settleToUndefined`). It is
not left to every future reader implementation.

## Tests

`stratos-core/tests/host-discovery.test.ts` covers both arms, the order of the
two, and the rule that an unresolvable member yields `undefined`. The tests
run without a PDS.
