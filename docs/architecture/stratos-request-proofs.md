# ADR 019: Bind credential reads to a request proof

Status: proposed protocol with tested foundation helpers. No production enforcement.

Decision date: 2026-10-15.

## Problem

A space credential grants access to a whole space, not a member's live identity.
For designated Stratos reads, we need proof that the caller holds the credential's
bound private key and signed the exact request. Some reads also need an authenticated
Feedgen identity. Neither check can replace authorization.

This decision covers the Plan 019 foundation. It does not enable a route or migrate
existing credentials. Implementers should use the separate
[v1 wire reference](stratos-request-proof-reference.md); client developers should use
the [client integration guidance](../client/getting-started.md#before-experimenting-with-request-proofs)
and the helper API section in `stratos-client/README.md`.

## Decision

Add a `Stratos-Request-Proof` compact JWS to designated credential-authenticated
Stratos reads. The caller signs it with a local ephemeral P-256 key bound by the
validated credential's `cnf.kid`. A registered client DID is not required.

The proof binds the exact credential token, receiving authority DID, method, raw
path and query, body digest, lifetime, and random proof ID. Where policy requires
Feedgen identity, also require a `Stratos-Service-Assertion` from a published,
issuer-controlled DID verification method. That assertion binds the exact proof
digest, route, authority, and lifetime.

Validate the credential, proof, required service identity, and complete authorization
before consuming one atomic replay identity. Recheck time at consumption. Only then
read protected data, with the existing per-record boundary checks.

This is a Stratos extension, not an AT Protocol requirement. Preserve standard
Spaces HTTP Message Signatures and credential transport byte-for-byte, including
covered components. Do not require the extension on foreign PDS hosts. OAuth tokens,
OAuth DPoP, enrollment, and admin authentication remain unchanged.

## Rationale and alternatives

| Choice                                      | Reason                                                                            |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| Bind the exact request bytes                | Normalized URLs or parsed credentials can hide changes to what the caller signed. |
| Use the credential-bound ephemeral key      | Prove possession without requiring client registration or an account key.         |
| Bind service identity to the proof          | An unrelated service JWT beside a valid proof does not authenticate that request. |
| Consume one replay identity after admission | Invalid or unauthorized requests must not consume a valid proof ID.               |
| Keep standard Spaces signatures             | This extension supplements their contract; it does not replace it.                |

We do not treat the current DPoP verifier as a complete implementation of this
profile. Its key binding and admission ordering differ. We reuse existing DID
resolution and signature primitives, not permissive service-JWT parsing. We do not
add a certificate authority, Feedgen registration protocol, or mandatory DID key purpose.

## Consequences and trust limits

Possession is not permission, live member identity, or evidence of human consent.
Keep credential scope, current authority policy, boundary revision checks,
per-record filtering, and custody-specific membership controls.

A stolen unused delegation can still win the credential-mint race. A proof cannot
retroactively protect redemption. An attacker holding the credential and private
key can create fresh proofs. A stolen complete unused request can race its sender.
TLS and secure local key handling remain necessary.

A spaces PDS remains trusted for hosting and account keys. Its boundary claims do
not become authoritative. The extension does not guarantee response completeness
or revoke foreign-host credentials. Membership still selects repositories to read.

Replay protection requires retained, shared atomic state. It does not survive loss
of consumed identities. It promises at-most-once proof acceptance within retained
state, not exactly-once data access or operations. Retry with a new proof and random
`jti`, and a new bound service assertion when required.

Byte-preserving ingress and fresh, bounded DID resolution add deployment constraints.
Read the [raw-byte contract](stratos-request-proof-reference.md#raw-target-and-body-contract)
and [resolver contract](stratos-request-proof-reference.md#resolver-and-rotation-contract)
before integration.

## Foundation status

| Available in the foundation                                                              | Still required before production enforcement                                                |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Pure client proof creation, verification, and replay-entry preparation                   | Validated `cnf.kid` credentials and standard transport integration                          |
| Pure service assertion helpers                                                           | Production resolver bounds, freshness, and service policy                                   |
| Injected service admission composition, unregistered in auth dispatch                    | Raw ingress capture, header occurrence checks, route policy, and protected-data integration |
| Fixed vectors, independent cryptographic checks, Chromium, and shared Redis replay tests | Production-route enforcement and operational retention evidence                             |

Foundation validation covers fixed vectors, independent cryptographic checks,
Chromium execution without Node globals, shared Redis replay tests, scoped mutation
testing, Terra Standards and Spec reviews, AtmosphereInABox baseline and alignment
scenarios, and docs CI. These checks validate the foundation, not production-route
enforcement or this later prose overlay as an exact-SHA AtmosphereInABox run.
Rust vector consumption belongs to Plan 015. Production integration still needs
route-level enforcement, ingress, resolver, and replay-retention evidence.

See the reference for [helper responsibilities](stratos-request-proof-reference.md#foundation-helper-responsibilities),
[current authentication seams](stratos-request-proof-reference.md#current-authentication-seams),
and [verification requirements](stratos-request-proof-reference.md#verification-requirements).

## Production prerequisites

The first integration candidate is the credential-authenticated `GET` branch of
`zone.stratos.space.getRecord`. Additional bounded reads need a reviewed allowlist.
Blob streams, WebSockets, minting, mutations, and foreign PDS requests are outside
initial adoption. Other authentication branches retain their existing coverage.

Before enabling any route:

1. Complete standard Spaces transport and validated `cnf.kid` binding. Plan 014 owns
   migration from `cnf.jkt`; there is no implicit conversion.
2. Verify raw public path/query preservation, route-to-NSID mapping, bounded empty-body
   handling, aggregate header limits, and browser CORS permission for both headers.
   Stop integration if ingress rewrites bytes without a separately reviewed contract.
3. Establish resolver network bounds and upstream freshness. Do not accept stale keys
   on error or introduce an unreviewed cache.
4. Establish shared-store retention, failover, and no-premature-eviction guarantees.
   Do not claim replay protection after state loss.
5. Review route-by-route migration, capability discovery, credential reissuance,
   client upgrade timing, and rollback. Resolve whether any legacy branch remains
   on an enforced route and document its weaker coverage. Do not add a global legacy
   bypass. A recognized extension failure must never trigger authentication fallback.
6. Validate and independently review each production integration, including tests
   that prove actual production-route enforcement. Foundation validation is not a substitute.

Do not advertise support before the implementation and callers pass review.
Incompatible wire changes require a new `typ` version, not permissive v1 parsing.
