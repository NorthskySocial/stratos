# Standard space authority contract

Status: proposed design. This document does not enable the standard authority role.
Stratos remains a mixed-custody service with custom `zone.stratos.*` methods.

## Reference boundary

| Source                                                                                                                                         | Pinned revision                            | Use                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| [Permissioned data proposal](https://github.com/bluesky-social/proposals/tree/119fa6b63476d30c2516846c714319046e0422f3/0016-permissioned-data) | `119fa6b63476d30c2516846c714319046e0422f3` | Role, delegation, commit, and sync rules                                             |
| [Permissioned-data PR source](https://github.com/bluesky-social/atproto/tree/787a730fcd22ed7791e2636beb509a943017ba1c)                         | `787a730fcd22ed7791e2636beb509a943017ba1c` | Proposed lexicons and reference handlers                                             |
| [Alpha PDS source](https://github.com/bluesky-social/atproto/tree/de009e6e83faea80d92d2fc32a8ad07863586b50)                                    | `de009e6e83faea80d92d2fc32a8ad07863586b50` | Sandbox wire behavior; image provenance is recorded separately by the sandbox runner |

The five alpha lexicons below match the pinned PR lexicons. The alpha
`registerNotify` handler changes endpoint-resolution details from the PR source;
the wire schema does not change. Recheck both pins before implementation.

## Discovery and method matrix

The [proposal's space-authority rule](https://github.com/bluesky-social/proposals/blob/119fa6b63476d30c2516846c714319046e0422f3/0016-permissioned-data/README.md#space-authority)
resolves `#atproto_space` for credential signatures and `#atproto_space_host`
(`AtprotoSpaceHost`) for the host. Each absent entry falls back to `#atproto`
or `#atproto_pds`, respectively. A malformed present entry must fail instead
of falling back. Stratos currently publishes the fallback `#atproto` signing
method and a `#stratos` service entry in `stratos-service/src/index.ts`. It
publishes neither dedicated space role entry in the sandbox configuration.
It must not add the host entry until the full role and its discovery tests pass.

| Method and pinned schema                                                                                                                                                             | Wire input and output                                                                                                                                               | Auth and errors                                                                                                                                                                                                                                                                 | Current Stratos result                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`com.atproto.space.getSpaceCredential`](https://github.com/bluesky-social/atproto/blob/de009e6e83faea80d92d2fc32a8ad07863586b50/lexicons/com/atproto/space/getSpaceCredential.json) | `POST` JSON `{space, clientAttestation?}`; JSON `{credential}`. The authority signs a credential with `cnf.jkt`.                                                    | Single-use delegation in `Authorization: Bearer`, fresh DPoP proof without `ath`; attestation when app-gated. Declared errors: `SpaceNotFound`, `SpaceDeleted`, `UserNotAuthorized`, `AppNotAuthorized`, `NotAuthorized`, `InvalidDelegationToken`, `InvalidClientAttestation`. | `zone.stratos.space.getSpaceCredential` has the delegation and DPoP path, but a different NSID, extra optional legacy body token, and `{credential, expiresAt}` output. |
| [`com.atproto.space.listRepos`](https://github.com/bluesky-social/atproto/blob/de009e6e83faea80d92d2fc32a8ad07863586b50/lexicons/com/atproto/space/listRepos.json)                   | `GET` with `space`, `limit` 1–1000 (default 100), `cursor?`; JSON `{repos: [{did, rev, hash}], cursor?}`. `rev` is a TID and `hash` is 32 digest bytes.             | Space credential with matching space and DPoP proof with `ath`; `SpaceNotFound`. The writer set is a sync hint, never a reader list.                                                                                                                                            | `zone.stratos.space.listRepos` lists active boundary enrollments with `custody`, optional `rev`, and optional host metadata. It has no standard LtHash `hash`.          |
| [`com.atproto.space.registerNotify`](https://github.com/bluesky-social/atproto/blob/de009e6e83faea80d92d2fc32a8ad07863586b50/lexicons/com/atproto/space/registerNotify.json)         | `POST` JSON `{space, service}` where `service` is a resolvable DID with optional service fragment; JSON `{expiresAt}`. Re-registration replaces and extends expiry. | Space credential and DPoP; `SpaceNotFound`, `ServiceNotResolvable`.                                                                                                                                                                                                             | No standard registration or durable recipient store.                                                                                                                    |
| [`com.atproto.space.unregisterNotify`](https://github.com/bluesky-social/atproto/blob/de009e6e83faea80d92d2fc32a8ad07863586b50/lexicons/com/atproto/space/unregisterNotify.json)     | `POST` JSON `{space, service}`; empty successful response. Withdrawal is idempotent.                                                                                | Space credential and DPoP; `SpaceNotFound`.                                                                                                                                                                                                                                     | No standard withdrawal handler or expiry lifecycle.                                                                                                                     |
| [`com.atproto.space.notifyWrite`](https://github.com/bluesky-social/atproto/blob/de009e6e83faea80d92d2fc32a8ad07863586b50/lexicons/com/atproto/space/notifyWrite.json)               | `POST` JSON `{space, repo, rev, hash}`; empty successful response. It is best effort.                                                                               | Service auth: `iss` must equal `repo`, `aud` must equal the space authority DID. The authority then applies its write policy and forwards to registered syncers.                                                                                                                | No standard inbound handler or forwarder. The Rust syncer polls authority-listed members; it must never discover writers from notifications.                            |

The alpha handlers for [credential exchange](https://github.com/bluesky-social/atproto/blob/de009e6e83faea80d92d2fc32a8ad07863586b50/packages/pds/src/api/com/atproto/space/getSpaceCredential.ts),
[writer listing](https://github.com/bluesky-social/atproto/blob/de009e6e83faea80d92d2fc32a8ad07863586b50/packages/pds/src/api/com/atproto/space/listRepos.ts),
[registration](https://github.com/bluesky-social/atproto/blob/de009e6e83faea80d92d2fc32a8ad07863586b50/packages/pds/src/api/com/atproto/space/registerNotify.ts),
[withdrawal](https://github.com/bluesky-social/atproto/blob/de009e6e83faea80d92d2fc32a8ad07863586b50/packages/pds/src/api/com/atproto/space/unregisterNotify.ts), and
[write notification](https://github.com/bluesky-social/atproto/blob/de009e6e83faea80d92d2fc32a8ad07863586b50/packages/pds/src/api/com/atproto/space/notifyWrite.ts)
show the corresponding authorization checks. Generic missing-auth, malformed
input, and DPoP errors also apply; the table names lexicon-declared errors.

## Custody and the writer set

The [standard signed commit](https://github.com/bluesky-social/atproto/blob/de009e6e83faea80d92d2fc32a8ad07863586b50/lexicons/com/atproto/space/defs.json)
contains `ver`, `rev`, `hash`, `ikm`, `sig`, and `mac`. Its `hash` is SHA-256 of
the 2048-byte LtHash state over that writer's records in one space. A Stratos
custody repo instead has an MST root signed by Stratos with an actor key. That
root is neither the writer's LtHash digest nor a user-signed standard commit.
Converting its CID or MST root bytes into `hash` would fabricate evidence.

The sandbox-only adapter therefore admits a PDS-custody writer only after it
has an actual upstream signed head and active Stratos membership for the space.
It excludes Stratos-custody writers from any **standard** `listRepos` view. It
keeps them on the existing Stratos sync path. It never migrates their custody
or signs for them. Whether a PDS-only standard writer set is useful enough to
advertise as a complete role remains unresolved. An empty or partial writer set
cannot silently claim complete space sync.

Member admission remains authority-controlled. The source of truth is active
enrollment plus the space boundary. A `notifyWrite` from any other repo is
rejected, even when its service signature is valid. A notification can update
only the verified `rev` and `hash` of an already admitted writer. It cannot add
writers, reactivate enrollment, assign boundaries, or override the repo host.
Stratos re-derives boundaries for PDS-custody records during ingest.

## Sandbox adapter and probes

`test/spaces-alignment/scenarios/authority-contract.*` is a disposable probe.
It does not register production XRPC routes or modify DID discovery. Its fixture
adapter accepts only an active member with a verified PDS signed head. It
refuses an MST-only head and an unsolicited notification. This is an executable
model for the planned standard boundary, not a deployed authority.

The live scenario checks the published DID document and standard route absence
on the candidate service. It samples the custom `listRepos` mixed-custody
response and proves it lacks required standard hashes. It reuses the
delegation-transport OAuth fixture to exercise a real PDS delegation, DPoP
credential exchange, foreign PDS read, and a cryptographically verified PDS
signed head. It probes standard registration and
withdrawal routes as **unsupported** on Stratos, then verifies an unsolicited
notification cannot add a writer. These negative probes do not count as a
successful standard registration or a production interoperability claim.

The scenario checks actual wire shapes before it records assertions. A wrong
DPoP key must fail; the existing delegation-transport scenario covers replay
and missing-authentication cases. A standard `listRepos` row cannot be
synthesized from Stratos membership. The
official sandbox runner records the exact alpha image ID and source revision;
this document pins source behavior, not an image digest.

## Decision and alternatives

We will keep the current custom role while we implement and validate the
standard role in bounded slices. This preserves both custody classes and keeps
discovery truthful.

| Option                                                                       | Compatibility cost                                                                                                                                                   | Decision                                   |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Publish `#atproto_space_host` now and alias custom handlers                  | Standard clients expect required hashes, registration, forwarding, and exact auth/error schemas. An alias would advertise behavior we cannot serve.                  | Reject.                                    |
| Add a separate standard adapter for PDS custody                              | It can use real PDS signed heads, but mixed spaces would expose only some writers. It also needs durable notification state and a policy for excluded Stratos repos. | Investigate behind sandbox-only discovery. |
| Preserve custom methods until all repos have a valid standard representation | Standard clients cannot discover Stratos as a space host yet. Existing Stratos clients keep working.                                                                 | Current production choice.                 |

The following decisions are open: whether mixed spaces may expose a PDS-only
standard writer set; how Stratos-custody records could acquire user-signed
LtHash commits without a custody migration; whether notification delivery is
queued or retried; how registration expiry and endpoint changes are persisted;
how the standard read/write policy maps to enrollment and `appAccess`; and how
to handle a present but malformed DID role entry. Resolve these before role
publication. The authorization server may be Entryway while the DID names a
different PDS resource host; do not add an issuer-equals-PDS requirement.

## Bounded follow-up slices

| Slice               | Scope and dependency                                                                                                                               | Acceptance tests                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authority model     | Define a standard writer-head port and policy mapping. Depends on this ADR and an explicit mixed-custody representation decision.                  | Reject MST CIDs as LtHash hashes; accept only verified user-signed PDS heads; inactive members never appear.                                      |
| Credential endpoint | Add the standard NSID and lexicon adapter behind a non-discoverable gate. Depends on the authority model and current delegation/DPoP verification. | Exact request/response/error schema, `cnf.jkt`, replay and app-axis tests against the pinned alpha PDS.                                           |
| Writer listing      | Persist trusted PDS head updates and paginate a complete standard writer set. Depends on the authority model and a decision for Stratos custody.   | Every row has DID, TID rev, 32-byte LtHash digest from a verified head; compare against repo host; never invent missing heads.                    |
| Notifications       | Implement registration expiry, withdrawal, bounded delivery, and authenticated inbound writes. Depends on writer listing.                          | Resolve service identifiers; renew and remove idempotently; reject wrong `iss`/`aud` and nonmembers; reconcile lost notifications from listRepos. |
| Discovery           | Publish `#atproto_space_host` only after the preceding slices and mixed-custody behavior pass. Depends on exact reviewed sandbox evidence.         | Standard client discovery, credential exchange, full sync, revocation, and negative authorization pass on an immutable candidate.                 |

Each slice needs its own focused tests and reviewed sandbox receipt. None
authorizes a production role entry before discovery validation.
