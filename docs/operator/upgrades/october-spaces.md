---
audience: Operators
type: Upgrade procedure
prerequisites: A running Stratos service, the Rust feed generator, and members on a spaces PDS
status: current
---

# October spaces rollout

The October profile adds the standard space credential transport. It is
additive. Stratos keeps legacy `cnf.jkt` credentials and their DPoP
presentation. Ordinary OAuth DPoP does not change.

[Spaces: current contract](/architecture/spaces-alignment) has the protocol
detail and the pinned upstream revisions.

## What changes

| Credential                | Bound by  | TTL setting                                                                                             | Default      | Limit        |
| ------------------------- | --------- | ------------------------------------------------------------------------------------------------------- | ------------ | ------------ |
| Legacy, DPoP presentation | `cnf.jkt` | [`STRATOS_SPACE_CREDENTIAL_TTL_SECONDS`](/reference/env#stratos_space_credential_ttl_seconds)           | 7200 seconds |              |
| Standard, HTTP signature  | `cnf.kid` | [`STRATOS_SPACE_HTTP_CREDENTIAL_TTL_SECONDS`](/reference/env#stratos_space_http_credential_ttl_seconds) | 600 seconds  | 3600 seconds |

The standard TTL must be a positive integer.

Standard exchange signs Bearer delegation authorization with a fresh P-256
`did:key`. Reads use `Atproto-Space` authorization. They sign the
authorization, then `Atproto-Space-Audience`. Use the repo owner DID for repo
reads. Use the bare authority DID for membership listing.

Same-audience signatures are reusable until expiry. They do not bind the
method, the URL, or the body.

::: warning Proxies and CORS
Preserve the `Signature`, `Signature-Input`, and `Atproto-Space-Audience`
headers through every proxy. Allow them in the browser CORS preflight.
:::

## Upgrade

1. Record the source revision and immutable image identity of each PDS.
   Rehearse the candidate with `october-interop` and the separate regression
   suites in the repository's `test/spaces-alignment/README.md`.
2. Stop ingestion during the coordinated upgrade of the receiver, the Rust
   client, and the PDS. Do not deploy mixed halves. The Rust client has no
   legacy fallback. October PDS hosts do not accept legacy DPoP space
   credentials.
3. Restart clients to discard cached grants. Reacquire each credential with
   its new grant-owned key. Never pair a cached credential with another key.
   Never reinterpret `cnf.jkt` as `cnf.kid`. An expiry refresh must replace
   the credential and the key together.
4. Before you resume ingestion, verify seeded publication, feed delivery,
   owner-audience denial, and credential renewal. Keep the OAuth nonce-retry
   checks.

## Roll back

1. Stop ingestion.
2. Restore the previously rehearsed receiver, client, and compatible PDS image
   set together.
3. Clear grant caches and reacquire credentials.

Do not downgrade an October PDS alone. Do not expect the deprecated
TypeScript client to read an October PDS with legacy DPoP.

Keep the previous deployment artifacts and normal data backups. This
procedure does not migrate production data or roll back repository state.

## Limits

- Member removal blocks renewal. It does not end every credential already
  held by a foreign host.
- Early revocation fanout is optional. Removal does not trigger it.
- A local boundary revision change does not revoke a credential on a foreign
  PDS.
- The custom `zone.stratos.space.listRepos` membership selection stays
  separate from upstream writer metadata.
- This rollout does not add full standard authority discovery or enumeration.
