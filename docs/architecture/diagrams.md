<script setup>
import BoundaryAccessDiagram from '../.vitepress/theme/components/BoundaryAccessDiagram.vue'
import FeedgenArchitectureDiagram from '../.vitepress/theme/components/FeedgenArchitectureDiagram.vue'
import MixedModeDiagram from '../.vitepress/theme/components/MixedModeDiagram.vue'
import StratosFlowDiagram from '../.vitepress/theme/components/StratosFlowDiagram.vue'
import TrustFlowDiagram from '../.vitepress/theme/components/TrustFlowDiagram.vue'
</script>

# Architecture Overview

Stratos is a private data layer for AT Protocol. It keeps the user's AT Protocol
identity and enrollment discoverable through their PDS, while keeping private
records and their access rules out of the public graph.

The system deliberately separates three responsibilities:

| Responsibility                  | Component | Why it is separate                                                           |
| ------------------------------- | --------- | ---------------------------------------------------------------------------- |
| Identity and user authorization | User PDS  | A user keeps their existing DID, OAuth session, and PDS routing.             |
| Authority                       | Stratos   | Stratos records enrollment, membership, boundary meaning, and credentials.   |
| Feed delivery                   | Feedgen   | Feedgen builds a derived view that can serve an authorized feed efficiently. |

The PDS is not a copy of the private record store. Depending on the user's PDS
capabilities, a private repository is either hosted by Stratos or by the user's
own space-aware PDS. This is the mixed-mode layer described below.

## Feed generator

<FeedgenArchitectureDiagram />

Feedgen is a separate, deployable read service. It is configured with feeds and
their boundaries; it does not discover arbitrary repositories or make up a
membership list. It builds a projection from records that Stratos has authorized
it to read, then returns a complete feed view to an authenticated viewer.

On a feed request, the viewer's PDS proxies a service-authenticated request to
Feedgen. Feedgen verifies the request, resolves the viewer's enrolled
boundaries, and checks that the viewer can use the requested feed before it
queries the projection. A readiness gate keeps the feed unavailable while the
authoritative subscription or reconciliation state is incomplete, rather than
serving a potentially stale authorization decision.

The record projection is ephemeral by default: private records and sync cursors
are kept in memory and are rebuilt after a restart. Feedgen retains a separate,
durable membership/control snapshot so it can reconcile membership safely. An
operator may choose durable projection storage, but that is an explicit decision
to retain private record content.

## Mixed-mode custody: one authority, two repository paths

<MixedModeDiagram />

**Custody** is an enrollment property. It answers two operational questions:
where does this actor's private repository live, and which party signs its
writes? It does **not** change who defines membership. Stratos is the authority
for the boundary in both modes.

|                    | Non-spaces mode                      | Spaces mode                        |
| ------------------ | ------------------------------------ | ---------------------------------- |
| PDS capability     | Does not implement spaces            | Implements the spaces protocol     |
| Enrollment custody | `stratos`                            | `pds`                              |
| Repository host    | Stratos actor repository             | Member's own PDS                   |
| Record signer      | Stratos's per-actor signing key      | The member through their PDS       |
| Write path         | Normal Stratos record APIs           | The PDS space-repository APIs      |
| Feedgen ingest     | `zone.stratos.sync.subscribeRecords` | Credentialed `listRepoOps` polling |

For a spaces member, the boundary maps to a space URI such as:

```text
at://{authorityDid}/space/{spaceType}/{skey}
```

Records in that space include the authority and author in their URI:

```text
at://{authorityDid}/space/{spaceType}/{skey}/{authorDid}/{collection}/{rkey}
```

That leading authority is important. A space record is not a normal
`at://{authorDid}/{collection}/{rkey}` repository record, so readers must parse
it as a space URI rather than assuming the first segment identifies the author.

### How the spaces arm reaches Feedgen

For every configured boundary, Feedgen asks Stratos for the current members and
the repository host of each `pds`-custody member. Stratos admits that request
only for a service or a credential scoped to that space. Feedgen then uses a
short-lived, DPoP-bound space credential to pull operations from the member's
PDS. It polls members listed by Stratos; it does not scan PDSs looking for
writes.

The member PDS is a remote peer, not an authority. Feedgen constrains requests,
validates operation paths and record sizes, and verifies the terminal signed
space commit before it promotes a staged update. If a complete membership pass
shows that a member has left, Feedgen stops polling that repository and purges
the affected projection rows.

Most importantly, a boundary inside a PDS-hosted record is only a claim from the
repository host. Feedgen assigns the boundary from the trusted poll target — the
authority's current member list — instead of copying a boundary value from the
record. This is what makes records from a member-owned PDS safe to combine with
the Stratos-hosted subscription path.

## Record storage and direct hydration

<StratosFlowDiagram />

Direct hydration remains the right choice when an application has a record
reference and needs the authoritative record now. Stratos resolves the caller
from their credential, loads their current boundaries, and returns the record
only when the caller is the owner or shares a boundary with it.

The batch endpoint reports three distinct outcomes: delivered records, blocked
subjects, and missing subjects. That distinction lets an integrator handle a
mixed set of references without exposing record content to an unauthorized
caller. A space credential is scoped to one space boundary; it does not bypass
the same per-record check.

## Boundary evaluation

<BoundaryAccessDiagram />

The service compares the viewer's current boundary memberships with the record
boundaries for each private read. A match permits delivery. No match returns a
blocked or not-found result, depending on the API. A client or a derived
projection cannot replace this decision with local filtering.

## Enrollment trust and live authorization

<TrustFlowDiagram />

The enrollment record and attestation let a client discover and verify an
enrollment without calling Stratos on every display. They are not permission
grants. A private read always requires a current boundary check by Stratos or
Feedgen's verified projection path.
