# Permissioned spaces: current contract

Checked 2026-09-29 against the [proposal at 119fa6b](https://github.com/bluesky-social/proposals/tree/119fa6b63476d30c2516846c714319046e0422f3), [reference implementation at 787a730](https://github.com/bluesky-social/atproto/tree/787a730fcd22ed7791e2636beb509a943017ba1c), and [alpha PDS at de009e6](https://github.com/bluesky-social/atproto/tree/de009e6e83faea80d92d2fc32a8ad07863586b50). These are separate snapshots. The deployed PDS image must also be traced to its source revision and immutable image digest; a source checkout alone does not prove what is running.

| Concern              | Stratos custody                                                           | PDS custody                                                                    |
| -------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Space authority      | Stratos                                                                   | Stratos                                                                        |
| Repository host      | Stratos                                                                   | Member's spaces-capable PDS                                                    |
| Commit signer        | Stratos's per-actor P-256 key, attested by Stratos enrollment             | Account key held by the member's PDS                                           |
| Authorization server | The issuer accepted by the OAuth flow; it need not be the repository host | The issuer accepted by the OAuth flow; it need not be the repository host      |
| Record source        | Stratos's signed MST repository                                           | Member's upstream space repository                                             |
| Membership decision  | Current Stratos enrollment                                                | Current Stratos enrollment selects which member repositories the Feedgen reads |

Space record URIs have the form `at://{authorityDid}/space/{type}/{skey}/{authorDid}/{collection}/{rkey}`. The authority DID is first; the author DID is not. A PDS can store a record claiming any Stratos boundary, so the Feedgen re-derives that boundary from authority enrollment before admitting it. Membership selects repositories to read; it does not prevent a removed member from writing on their own PDS.

Stratos currently exposes `zone.stratos.space.*` authority endpoints, including `getSpaceCredential`, `getRecord`, `listBlobs`, and `listRepos`, plus `zone.stratos.sync.*` pull reads. These are deliberately separate from the upstream `com.atproto.space.*` namespace. The alpha PDS hosts member repositories using upstream `com.atproto.space.*` methods. Stratos's custom credential mint accepts a PDS-issued delegation as `Authorization: Bearer` with a standalone DPoP proof and a JSON `space` body; the internal body-delegation transport remains supported. Stratos does not advertise the upstream `#atproto_space_host` role or claim complete upstream authority discovery.

Credentials are multi-use capabilities for a whole space until their configured expiry, normally two hours. Production presentation is bound to `cnf.jkt` and requires a fresh, replay-protected DPoP proof. A credential's space scope maps to one Stratos boundary; it is not the original member's live identity. Removing that member prevents new credentials and service-member requests that consult current enrollment, but an already-issued credential can still read that space until expiry. Wrong-key proofs and expired credentials fail. A local catalog boundary deletion or revision change invalidates credentials bound to the old revision on Stratos endpoints. Foreign PDS hosts do not understand Stratos's private boundary revision claim, so local revision invalidation is not a universal remote revocation signal.

For the Feedgen, authority membership must also fence work already in flight: a generation change must prevent staged foreign commits from being promoted after removal and must survive restart. This is a separate ingestion control, not credential revocation. Deployments without that generation fence retain an in-flight exposure window. Outstanding foreign-host credentials remain bounded by their expiry unless the foreign host provides an independent revocation mechanism.

## Proposed Stratos request-proof extension

[ADR 019](stratos-request-proofs.md) defines a proposed extension with tested pure
request-proof/service-assertion helpers and unregistered injected admission code.
No production route enables it. It does not replace or alter standard Spaces HTTP
Message Signatures, OAuth DPoP, or existing `cnf.jkt` credentials. Migration to
standard credential transport and validated `cnf.kid` belongs to later work.

Keep three audiences distinct: standard delegation targets
`authorityDid#atproto_space_host`; standard credential presentation targets the
repository owner or authority as required by the operation; the extension targets
the receiving Stratos authority DID without a fragment. Do not require the Stratos
extension on a foreign PDS.

The client uses an ephemeral P-256 credential-bound key, not a registered client
DID. Where policy requires service identity, a published issuer-controlled DID
method signs a separate assertion bound to the exact client proof digest. No new
key purpose is introduced. Complete credential, client, service, and authorization
checks precede one atomic replay consumption; the assertion has no second replay
identity. The injected resolver forces refresh and adds no stale-key fallback.

Chromium vectors now execute without Node globals. Shared Redis probing, reviewed
production ingress and caller integration, scoped mutation, independent reviews,
and source-bound AiaB remain outstanding. Lost shared replay state means no replay
protection for consumed identities inside the remaining acceptance window. A stolen
unused delegation can still win credential issuance; the PDS remains trusted for
hosting and account keys. Proof possession does not grant permission, establish
response completeness, or prove human consent.

Signing has two different meanings here. Stratos-custody MST commits and PDS-custody account commits can authenticate a signer and the relevant committed state. The current cross-host space proof uses a signature/MAC over a served view; it does not establish a durable, independently verifiable full-content proof for every historical record. Do not equate a valid credential or signed response with proof that the host returned all permitted content. The remaining work is interoperable authority discovery, foreign-host revocation, and a complete content-proof contract.
