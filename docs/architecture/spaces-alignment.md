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

## Proposed extension: request proofs

[ADR 019](stratos-request-proofs.md) proposes a credential-bound request proof
and, where policy requires it, a separate service identity assertion. Tested pure
helpers and injected admission code exist. No production route enables them.
Existing `cnf.jkt`/DPoP credentials, OAuth DPoP, and standard Spaces HTTP Message
Signatures are unchanged. Standard transport and validated `cnf.kid` migration
remain prerequisites.

### Keep the audiences separate

| Artifact                            | Audience                                                    |
| ----------------------------------- | ----------------------------------------------------------- |
| Standard delegation                 | `authorityDid#atproto_space_host`                           |
| Standard credential presentation    | Repository owner or authority, as required by the operation |
| Request proof and service assertion | Receiving Stratos authority DID, without a fragment         |

Do not require this Stratos extension on a foreign PDS.

### What the extension establishes

The caller signs the request proof with a caller-held credential-bound ephemeral
P-256 key. No additional app/client DID registration is needed. The authenticated
enrolled actor's `did:plc` or `did:web` is separate from this proof key. Auth policy
checks actor identity and enrollment independently; neither the space credential
nor its request proof establishes that actor identity.

For Stratos custody, Stratos holds the actor's custody P-256 private key and signs
the hosted repository's commits. That key is not a client proof-of-possession key
and is separate from the caller-held ephemeral key.

A required service assertion uses a published,
issuer-controlled DID method to bind the exact proof digest. No new key purpose
is required. The injected resolver forces refresh without stale-key fallback.
Complete credential, client, service, and authorization checks precede one atomic
replay consumption. The assertion has no second replay identity.

Neither possession nor identity grants permission, proves human consent, or
establishes response completeness. A stolen unused delegation can still win
credential issuance. The PDS remains trusted for hosting and account keys. Lost
shared replay state removes protection for consumed identities during their
remaining acceptance window.

Foundation validation covers Chromium vectors without Node globals, shared Redis
replay tests, scoped mutation testing, Terra Standards and Spec reviews,
AtmosphereInABox baseline and alignment scenarios, and docs CI. It does not prove
production-route enforcement or an exact-SHA AtmosphereInABox run of this prose
overlay. Rust vector consumption belongs to Plan 015. See the ADR's
[foundation status](stratos-request-proofs.md#foundation-status) and
[production prerequisites](stratos-request-proofs.md#production-prerequisites)
for the remaining ingress, caller integration, and rollout evidence.

## Signing and response completeness

Signing has two different meanings here. Stratos-custody MST commits and PDS-custody account commits can authenticate a signer and the relevant committed state. The current cross-host space proof uses a signature/MAC over a served view; it does not establish a durable, independently verifiable full-content proof for every historical record. Do not equate a valid credential or signed response with proof that the host returned all permitted content. The remaining work is interoperable authority discovery, foreign-host revocation, and a complete content-proof contract.
