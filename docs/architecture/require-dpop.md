# Negotiate DPoP for designated private reads

## Decision

Stratos will support two Spaces credential profiles on the designated read routes:

| Profile  | Required checks                                                         |
| -------- | ----------------------------------------------------------------------- |
| Standard | Upstream Spaces credential, audience, and HTTP signature checks         |
| Enhanced | All standard checks plus supplemental DPoP and shared replay protection |

Without negotiation, select standard only when authority policy permits it.
Capable clients prefer enhanced. Explicit failed negotiation never silently falls back to standard.
Bind the selected profile to the credential and its Stratos resource/route scope through authenticated state or a signed extension.
The binding format and handshake remain unresolved; an omitted request header cannot change the bound profile.
Authentication and enrollment/boundary authorization remain separate from proof verification.

Status: decision recorded; implementation and rollout pending.
This ADR is for client implementers, Stratos maintainers, and operators choosing space access policy.
It supersedes the earlier version's unconditional supplemental-DPoP migration requirement.
It retains the rejection of bespoke proofs in [PR216](https://github.com/NorthskySocial/stratos/pull/216).
Use DPoP (RFC 9449) and maintained libraries, not `Stratos-Request-Proof` or proof-bound service assertions.
This documentation change implements no runtime behavior and claims no Atmosphere-in-a-Box (AiaB) runtime verification.

## Why two profiles

Standard preserves upstream interoperability without requiring every client or foreign PDS to implement a Stratos extension.
Its HTTP signature proves possession of the credential key but is reusable for the same credential and audience.
It does not provide per-request method, path, or freshness binding.
Enhanced adds that request binding and replay-resistant admission on designated Stratos paths.
The cost is client proof generation, additional verification, and dependence on a shared replay store.

Neither profile identifies an actor or authorizes a record by itself.
DPoP does not protect a client whose credential and proof key are both stolen.
TLS, safe key storage, enrollment checks, and boundary checks remain necessary.
Response MAC checks remain independent: they neither replace supplemental DPoP nor become unnecessary when it succeeds.

## Route and authentication scope

Every route below is under `/xrpc/` at a Stratos endpoint.
The matrix is exhaustive for this decision, not for all Stratos private APIs.
“Selected profile” means standard or enhanced, bound at issuance/selection and enforced on the credential path only.

| Method and route                        | Current accepted authentication    | Decision for the designated client path                                              |
| --------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| GET `zone.stratos.repo.hydrateRecord`   | Optional OAuth or space credential | Keep OAuth DPoP; enforce selected profile for migrated credential reads              |
| POST `zone.stratos.repo.hydrateRecords` | Optional OAuth or space credential | Same; DPoP does not sign this read procedure's body                                  |
| GET `zone.stratos.space.getRecord`      | OAuth or space credential          | Keep OAuth DPoP; enforce selected profile for migrated credential reads              |
| GET `zone.stratos.space.listBlobs`      | OAuth or space credential          | Same; do not add service-auth admission                                              |
| GET `zone.stratos.space.listRepos`      | Service auth or space credential   | Enforce selected profile for migrated credential reads; leave service auth unchanged |
| GET `zone.stratos.sync.listRepoOps`     | Service auth or space credential   | Same; do not add OAuth admission                                                     |
| GET `zone.stratos.sync.listRecordPaths` | Service auth or space credential   | Same; do not add OAuth admission                                                     |
| GET `zone.stratos.sync.getBlob`         | Optional OAuth                     | Keep OAuth DPoP; do not add space-credential admission                               |
| GET `com.atproto.sync.getBlob`          | Optional OAuth                     | Same; this alias is served by Stratos, not a foreign PDS                             |

Keep existing anonymous behavior on optional-auth routes for public content only.
Invalid supplied credentials or proofs must not become anonymous private reads.
Public discovery, health, lexicon, and identity endpoints do not acquire a DPoP requirement.

All other routes are excluded, including writes, credential minting, repository export, and WebSocket subscriptions.
Issuance negotiation is a separate control-plane operation, not a new supplemental-DPoP gate on minting.
Admin cookies, CSRF checks, OAuth flows, and foreign PDS requests remain unchanged.
Never require foreign hosts to enforce the Stratos profile extension.
Feedgen viewer service authentication is not migrated by this decision.
Service callers keep independently authenticated DIDs and existing service JWT policy.
Issuer policy below covers the credential path, not every authentication class.
The service-auth alternative means this decision does not sender-constrain every private read.
Adding routes or changing another authentication class requires a separately reviewed decision.

## Per-space client policy

Model policy after `appAccess`, with two independent decisions:

- Client admission: may this client obtain a credential for this space?
- Proof requirement: must this client's credential use enhanced on designated Stratos reads?

Here, “issuer” means the **verified client-attestation `iss`**, which identifies the client.
It does not mean the space-credential issuer (the authority) or delegation-token issuer (the user).
Match the validated issuer identity exactly; do not infer it from an unverified claim or another token class.
Admission does not waive proof requirements, and a valid DPoP proof does not grant admission.

A space relying on issuer-specific admission or proof rules must require client attestation.
Without that assertion, deny issuance/selection rather than classify the caller as a generic client.
Always reject an invalid supplied attestation, even where attestation is optional.
Attestation may be omitted only when the space's policy does not require it.
A global or space-wide enhanced requirement may be added as a policy floor; no configuration API is settled here.

Evaluate admission and proof policy during issuance/selection, then bind the resulting profile and Stratos scope to the credential.
Do not decide the profile anew from the presence of a `DPoP` header on each read.
A client-selected enhanced requirement is a minimum, not permission for the server to return standard.

### Policy changes and credential lifetime

Existing standard credentials may remain valid until expiry after policy tightens.
Immediate enforcement would require implemented live policy or policy-revision checks; this ADR does not claim those checks exist.
Existing enrollment, boundary revision, expiry, and per-record checks still apply independently.
Relaxing policy never downgrades an enhanced credential.

Renewal reevaluates current admission and proof policy without silently lowering the client's selected requirement.
After using enhanced, a client must make an explicit choice to obtain a fresh standard grant, subject to current policy.
That is a new selection, not a transparent retry after failed negotiation, proof validation, or replay-store failure.

## Standard Spaces wire contract

Use the October 22 upstream contract referenced below, not the earlier `Atproto-Space` scheme.
For resource requests, preserve:

- `Authorization: Atproto-Space-Credential <credential>` and `Atproto-Space-Audience`.
- `Signature-Input` and `Signature`, with signature label and required tag `atproto-space-credential`.
- Signature coverage of exactly `authorization` followed by `atproto-space-audience`, in that order.

The standard signature is reusable for the same credential and audience.
Do not add method, path, freshness, or DPoP to its covered components and call that standard Spaces.
Enhanced adds a separate `DPoP` header; both standard and supplemental checks must pass.

Credential issuance uses POST `com.atproto.space.getSpaceCredential` with a JSON body.
`space` and `credentialKid` are required; `delegationToken` and `clientAttestation` are optional upstream, subject to authority policy.
Issuance does not send delegation in `Authorization` or require the resource-request HTTP signature.
Do not invent negotiation fields inside that standard lexicon as a settled API.

### Key and credential binding

Reuse the credential's ephemeral P-256 key for the supplemental proof.
The credential's `cnf.kid` is a P-256 `did:key`; verify that the DPoP JWK represents that same key.
Bind `ath` to the hash of the presented credential, not a delegation token or client attestation.
This is a supplemental Spaces profile, not standard OAuth access-token transport; its exact wire definition remains pending.

Actor authentication independently establishes the account's `did:plc` or `did:web` identity.
A credential confirmation key is not an actor DID.
The client/session proof key is neither Stratos's per-actor custody signer nor the authority's credential signing key.
Do not expose custody signing material or use it to produce caller proofs.
A space credential grants access to one space, not the originating member's live identity.
DPoP neither restores revoked enrollment nor supplies universal revocation at foreign hosts.
See [the current spaces contract](./spaces-alignment.md) for those limits.

## Concrete flows and failure behavior

### Standard read without negotiation

1. The client requests a credential with its ephemeral `credentialKid` and any policy-required assertions.
2. The authority validates the request and policy. If standard is allowed, it issues/selects a standard grant.
3. The client sends the standard Spaces authorization, audience, and HTTP signature to a designated Stratos route.
4. Stratos validates the bound profile, standard authentication, and authorization before releasing permitted content.

### Enhanced read

1. A capable client discovers support and explicitly selects enhanced through the future authenticated negotiation mechanism.
   It proves possession of the credential key; a client-name header is not a handshake or trusted client identity.
2. The authority validates admission, proof policy, and the handshake, then binds enhanced and the Stratos scope to the credential.
   The client verifies that selection before reading; missing capability metadata or a standard response cannot silently lower its requirement.
3. The client sends the unchanged standard Spaces headers plus a fresh DPoP proof signed by the credential key.
4. Stratos validates authentication, binding, proof, route scope, and authorization, then atomically consumes the replay identifier.
5. Only after successful consumption does Stratos release private content. A retry needs a fresh proof.

The handshake syntax and error codes are unresolved; the outcomes below are decisions, not new wire APIs.

| Condition                                                                  | Required outcome                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| No negotiation; policy permits standard                                    | Select standard; apply all standard checks and authorization       |
| No negotiation; policy requires enhanced                                   | Deny standard selection; require explicit enhanced selection       |
| Explicit enhanced negotiation fails                                        | Stop; do not silently request or accept standard                   |
| Negotiation metadata or DPoP header stripped from a bound enhanced request | Retain enhanced requirement; deny if it cannot be satisfied        |
| Missing, invalid, expired, wrong-key, or wrong-credential enhanced proof   | Deny; no retry as standard or anonymous private read               |
| Replayed enhanced proof or unavailable/uncertain replay protection         | Deny; never bypass replay protection or retry as standard          |
| Client issuer not admitted, or required attestation omitted                | Deny issuance/selection; no generic-client escape                  |
| Invalid supplied client attestation                                        | Reject, even if attestation was optional                           |
| Credential/delegation issuer substituted for client-attestation issuer     | Reject that policy identity; it cannot satisfy client issuer rules |
| Standard checks or record authorization fail                               | Deny in either profile; supplemental proof cannot override them    |
| Policy tightens or relaxes                                                 | Apply the lifetime rules above; never silently downgrade enhanced  |
| Response MAC validation fails                                              | Reject the response independently of request-proof success         |

Service auth remains an independently authenticated alternative only where the route already accepts it, not a proof-failure fallback.
Rollback must stop affected enhanced reads rather than reinterpret enhanced grants as standard.

## DPoP validation and limits

Use [RFC 9449](https://datatracker.ietf.org/doc/html/rfc9449#section-4.3) for proof syntax, validation, token binding, and URI normalization.
Do not invent another claim set or canonicalization algorithm.
Validate credentials independently; a self-signed proof does not establish trusted identity or credential binding.
Library selection and adapter review must verify these contracts rather than assume defaults satisfy them.

RFC 9449 makes resource-server nonces optional.
The [ATProto OAuth profile](https://atproto.com/specs/oauth) requires server-issued nonces; keep mandatory OAuth DPoP and nonce policy unchanged.
Supplemental Spaces freshness windows and nonce policy remain unresolved.

DPoP excludes query strings and does not sign request bodies.
A captured proof can race another query or batch body on the same method and path.
Atomic replay consumption permits one admission; it does not guarantee the intended request wins.
Authorize every requested record independently and rely on TLS for request integrity.
Do not claim general message signing or extend this decision to writes.

Validate authentication, credential binding, proof, route scope, and authorization before atomic replay consumption.
Failed validation or authorization must not burn the proof identifier.
Consume before releasing private content, across all serving instances; fail closed when protection cannot be guaranteed.
Retries need fresh proofs; replay-resistant admission is not exactly-once execution or delivery.

## Unresolved design and rollout gates

Before implementation rollout, review and settle:

- Protocol metadata, capability discovery, authenticated handshake, profile versioning, and credential/resource/route binding format.
  Define authenticated state or signed extensions without changing standard signature coverage or assuming foreign-host support.
- Policy and selection storage, client preference persistence, renewal, expiry, and any live revision enforcement.
  Define legacy credential migration and retirement without silently reinterpreting current custom credentials as upstream credentials.
- Supplemental errors, browser CORS headers, retry behavior, and private-response caching policy.
  Do not label supplemental failures as RFC-defined OAuth errors.
- Freshness, nonce policy, replay identifier scope, retention, atomic shared storage, outage handling, and restart fencing.
- Maintained library versions, URI/proxy handling, and independent response MAC verification.

Required tests before rollout:

- No-negotiation standard success where allowed; successful enhanced selection and reads; explicit negotiation failure without fallback.
- Missing/invalid/wrong-key/wrong-credential proofs, concurrent replay, and replay outages deny enhanced reads.
  Prove authorization-before-consumption and consumption-before-release across instances.
- Stripped negotiation metadata or proof headers cannot downgrade bound enhanced credentials.
- Issuer allowlists and issuer-required enhancement; omitted/invalid attestations; authority/user issuers cannot satisfy client issuer rules.
- Policy tightening, expiry, renewal, relaxation, and explicit fresh standard selection preserve the lifecycle rules.
- Standard foreign-PDS interoperability without the extension; unchanged standard signature coverage and issuance semantics.
- Independent MAC checks, enrollment/boundary authorization, optional public-only anonymous access, and service-auth exceptions.
- Query/body limitations, URI normalization, proxy handling, OAuth nonce behavior, and browser CORS.

Run focused contracts and the relevant Spaces interop suite against a pinned deployment.
These gates remain unresolved; recording the decision does not satisfy them.

## Evidence boundary and references

The route matrix reflects Stratos baseline `e8c39163fd14fe52bfe4d00eadd10d068983b917`:
`features/hydration/handler.ts`, `features/space-read/handler.ts`, `features/pull-sync/handler.ts`, and `features/sync/handler.ts`, under `stratos-service/src/`.
Existing DPoP and replay adapters are reuse candidates, not evidence that the selected profiles or validation order are implemented.

The authoritative migration reference is the [October 22 upstream prompt](https://github.com/bluesky-social/atproto/blob/permissioned-data/alpha-migrations/prompt-10-22-26.md).
The implementation reference is `bluesky-social/atproto` commit `ac0c9f15392f6f0298d71dc52aa88c05036150be`, snapshot `0.0.0-spaces-alpha-20261022141228`:

- [HTTP signatures](https://github.com/bluesky-social/atproto/blob/ac0c9f15392f6f0298d71dc52aa88c05036150be/packages/space/src/http-signature.ts): scheme, label, required tag, and exact ordered coverage.
- [Credentials](https://github.com/bluesky-social/atproto/blob/ac0c9f15392f6f0298d71dc52aa88c05036150be/packages/space/src/credential.ts): credential confirmation-key contract.

Source inspection establishes contracts and wiring only, not deployed interoperability or completed runtime gates.
