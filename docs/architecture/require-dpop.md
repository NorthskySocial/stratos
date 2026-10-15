# Require DPoP for designated private reads

## Decision

We choose DPoP (RFC 9449), not a new Stratos request-proof protocol.
Require a caller-held proof key for the designated client private reads below.
Keep identity authentication, enrollment, and boundary authorization separate from proof verification.

This decision supersedes the abandoned design in [PR216](https://github.com/NorthskySocial/stratos/pull/216).
Do not introduce `Stratos-Request-Proof` or a proof-bound service assertion.
Reuse standard DPoP proofs and maintained libraries.

Status: decision recorded; implementation and rollout are pending.
The supplemental Spaces migration profile remains unresolved.
This documentation change implements no runtime behavior and claims no Atmosphere-in-a-Box (AiaB) runtime verification.

## Rationale

A stolen credential must not be sufficient for private reads on the designated client surface.
DPoP binds a request to a caller-held key and the presented token.
A separate Stratos proof format would duplicate validation, interoperability, and security work.

DPoP does not identify an actor or authorize a record.
An attacker holding both the token and its proof key can still act as that holder.
TLS, safe key storage, enrollment checks, and boundary checks remain necessary.

## Route and authentication scope

Every route below is under `/xrpc/` at a Stratos endpoint.
The matrix is exhaustive for this decision, not for all Stratos private APIs.
“Spaces profile” means the unresolved supplemental migration profile, not today's credential transport.

| Method and route                        | Current accepted authentication    | Decision for the designated client path                                               |
| --------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| GET `zone.stratos.repo.hydrateRecord`   | Optional OAuth or space credential | Keep OAuth DPoP; require the Spaces profile for migrated credential reads             |
| POST `zone.stratos.repo.hydrateRecords` | Optional OAuth or space credential | Same; DPoP does not sign this read procedure's body                                   |
| GET `zone.stratos.space.getRecord`      | OAuth or space credential          | Keep OAuth DPoP; require the Spaces profile for migrated credential reads             |
| GET `zone.stratos.space.listBlobs`      | OAuth or space credential          | Same; do not add service-auth admission                                               |
| GET `zone.stratos.space.listRepos`      | Service auth or space credential   | Require the Spaces profile on migrated credential reads; leave service auth unchanged |
| GET `zone.stratos.sync.listRepoOps`     | Service auth or space credential   | Same; do not add OAuth admission                                                      |
| GET `zone.stratos.sync.listRecordPaths` | Service auth or space credential   | Same; do not add OAuth admission                                                      |
| GET `zone.stratos.sync.getBlob`         | Optional OAuth                     | Keep OAuth DPoP; do not add space-credential admission                                |
| GET `com.atproto.sync.getBlob`          | Optional OAuth                     | Same; this alias is served by Stratos, not a foreign PDS                              |

Keep existing anonymous behavior on optional-auth routes for public content only.
An invalid supplied proof must not become an anonymous private read.
Public discovery, health, lexicon, and identity endpoints do not acquire a DPoP requirement.

All other routes are excluded, including writes, credential minting, repository export, and WebSocket subscriptions.
Admin cookies, CSRF checks, OAuth flows, and foreign PDS requests remain unchanged.
Feedgen viewer service authentication is not migrated by this decision.
Service callers keep independently authenticated DIDs and existing service JWT policy.
This unchanged service-auth alternative means the decision does not sender-constrain every private read.
Adding routes or changing another authentication class requires a separately reviewed decision.

## Identity and key separation

Actor authentication independently establishes the account's `did:plc` or `did:web` identity.
Enrollment and current boundary policy determine access, regardless of custody.
The caller's client or session owns the proof key.
That key is not Stratos's per-actor custody signer or the authority's credential signing key.
Do not expose custody signing material or use it to produce caller proofs.

A space credential grants access to one space, not the originating member's live identity.
Credential expiry, boundary revision checks, and per-record filtering still apply.
DPoP neither restores revoked enrollment nor supplies universal revocation at foreign hosts.
See [the current spaces contract](./spaces-alignment.md) for those limits.

## Protocol boundaries

Use [RFC 9449](https://datatracker.ietf.org/doc/html/rfc9449#section-4.3) for proof syntax, validation, token binding, and URI normalization.
Do not invent another claim set or canonicalization algorithm.
Validate tokens independently; a self-signed proof does not establish trusted identity or credential binding.
Library selection and adapter review must verify those contracts rather than assume defaults satisfy them.

RFC 9449 makes resource-server nonces optional.
The [ATProto OAuth profile](https://atproto.com/specs/oauth) requires server-issued nonces; keep that policy unchanged.
The supplemental Spaces nonce policy remains a follow-on design question, not an OAuth policy change.

DPoP excludes query strings and does not sign request bodies.
A captured proof can race another query or batch body on the same method and path.
Atomic replay consumption permits one admission; it does not guarantee the intended request wins.
Authorize every requested record independently and rely on TLS for request integrity.
Do not claim general message signing or extend this decision to writes.

Validate authentication, credential binding, proof, route scope, and authorization before atomic replay consumption.
Consume before releasing private content; failed validation or authorization must not burn the proof identifier.
Replay protection must cover all serving instances and fail closed when protection cannot be guaranteed.
Retries need fresh proofs; replay-resistant admission is not exactly-once execution or delivery.

## Supplemental Spaces migration

Selecting DPoP does not define an interoperable Spaces credential profile.
Today Stratos uses custom credentials through `Authorization: DPoP`, with `cnf.jkt` and a nonce-free proof.
Do not silently reinterpret those credentials as the upstream Spaces contract.

Preserve upstream `Authorization: Atproto-Space`, `Signature-Input`, `Signature`, and `Atproto-Space-Audience` semantics and signature coverage.
A supplemental DPoP header must not replace standard Spaces signatures or authentication schemes.
Migrated reads must pass both the standard checks and supplemental proof checks, not either one.
Do not fall back to weaker credential authentication when supplemental proof verification fails.

The migration design must resolve upstream `cnf.kid` key binding, credential binding, issuance, and explicit profile selection.
A credential confirmation key is not an actor DID.
This decision does not settle that profile or claim current foreign-PDS interoperability.

## Consequences and required follow-on work

Clients must retain their proof keys and sign designated authenticated requests.
The supplemental profile adds verification work and shared replay-store availability costs.
We reject bespoke request proofs and proof-bound service assertions because they create additional security contracts.
Keep Spaces signatures for interoperability; do not treat them as a substitute for the selected supplemental proof.
Service-auth access remains an explicit exception, not a DPoP fallback.

Before rollout, complete and review these designs and their verification evidence:

- Migration: define capability discovery, credential issuance, key and token binding, profile selection, client cutover, and legacy retirement.
  Preserve authentication schemes and prevent downgrade during migration and rollback.
- Error policy: define supplemental errors, OAuth nonce handling, browser CORS, retry behavior, and private-response caching policy.
  Do not label supplemental failures as RFC-defined OAuth errors.
- Replay protection: define freshness, identifier scope, retention, atomic admission, outage handling, and restart fencing across instances.
  Prove authorization-before-consumption and denial when replay protection is unavailable or uncertain.
- Interoperability: pin libraries and upstream revisions; test proof validation, URI normalization, proxy handling, and standard Spaces signatures.
  Verify independent authentication, enrollment, boundary checks, query/body limitations, concurrent replay, and browser behavior.
  Run focused contracts and the relevant Spaces interop suite against the pinned deployment.

These gates remain unresolved; selecting DPoP does not satisfy them.
Rollback must disable affected private reads rather than accept unproven credentials.

## Evidence boundary

The route matrix reflects Stratos baseline `e8c39163fd14fe52bfe4d00eadd10d068983b917`:
`features/hydration/handler.ts`, `features/space-read/handler.ts`, `features/pull-sync/handler.ts`, and `features/sync/handler.ts`, under `stratos-service/src/`.
Existing DPoP and replay adapters are reuse candidates, not evidence that the target validation order is implemented.

The upstream Spaces reference is `bluesky-social/atproto` at `5b95b2f2723a2882824fbb0b819fd6aad884ef20`:
`packages/space/src/credential.ts`, `packages/space/src/http-signature.ts`, and `packages/pds/src/auth-verifier.ts`.
Source inspection establishes contracts and wiring only, not deployed interoperability or completed runtime gates.
