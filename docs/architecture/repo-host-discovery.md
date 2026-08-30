# Repo-Host Discovery

Given a permissioned space and one of its members, Stratos must find the host
that holds that member's repo before it can read or sync that member's
records.

## Why this is Stratos's convention, not upstream's

`com.atproto.space.listRepos` returns only `{did, rev, hash}` for each writer.
No space lexicon or table upstream carries a host field. The only convention
in the tree is bare DID → `#atproto_pds`, and upstream applies that to notify
targets, not to repo hosts. Stratos fills the gap with its own rule.

## The convention

1. An authority-recorded override, if Stratos holds one for this member.
2. Otherwise the `#atproto_pds` service endpoint in the member's DID document.

The override exists so an operator can correct a member whose repo does not
live on the PDS named in their DID document. It wins unconditionally: once an
override resolves, the DID document is never consulted.

An unresolvable member — no override, no DID-document PDS endpoint, or either
lookup failing — resolves to `undefined`. It never throws. One member with a
momentarily unreachable DID document (or override store) must not halt a sync
pass across the rest of a space's membership.

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
`'authority-override'` or `'did-document'` — surfaced so an operator debugging
a bad route can see which arm answered. The "never throws" guarantee is
enforced once inside the resolver (`settleToUndefined`), rather than trusted
to every future `HostOverrideReader`/`DidPdsReader` implementation.

The override store is the `repoHost` field already written onto an
`Enrollment` at OAuth enrollment or re-authentication time
(`stratos-service/src/oauth/handlers/callback.ts`) — populated from the
resolved PDS endpoint for `pds`-custody members. It is not a separately
curated table.

## Prototype

Proven first against the live alpha PDS in
`test/spike/spaces/a4-host-discovery.ts` (Spike A4): both arms resolve, and an
unresolvable member yields `undefined`.
