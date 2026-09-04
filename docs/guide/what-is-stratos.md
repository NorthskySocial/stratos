<script setup>
import BoundaryAccessDiagram from '../.vitepress/theme/components/BoundaryAccessDiagram.vue'
import StratosFlowDiagram from '../.vitepress/theme/components/StratosFlowDiagram.vue'
import TrustFlowDiagram from '../.vitepress/theme/components/TrustFlowDiagram.vue'
</script>

# What Is Stratos?

Stratos is a private, permissioned data layer for AT Protocol. It stores private records outside the public PDS network while preserving AT Protocol identity, repository semantics, and record verification.

## The problem: public records have no audience boundary

Think of the public PDS network as a house party with one public room. A client that knows a record AT URI can read the record. This model works for public conversation, but it cannot limit a record to a team, community, or other authorized group.

Private groups need more than a hidden user-interface element. The record content, blobs, and its existence must remain outside the public repository. The access decision must also remain with a service that knows the viewer's current membership.

## The Stratos answer

Stratos adds private rooms to that house party. Each room is a boundary. The service assigns users to boundaries, stores private records in a service-managed actor repository, and returns a record only when the viewer and record share a current boundary.

The PDS still provides the user identity and public enrollment record. Stratos does not replace the PDS or create a second account. It adds a private record path that clients can discover through the existing DID and OAuth identity.

## Shared private data

Stratos separates public discovery data from private record data.

| Surface                  | Contains                                                       | Visibility                                         |
| ------------------------ | -------------------------------------------------------------- | -------------------------------------------------- |
| User PDS                 | The public `zone.stratos.actor.enrollment` record.             | Public discovery and verification metadata.        |
| Stratos actor repository | Private records, signed commits, blobs, and boundary metadata. | Callers that pass the current boundary check only. |

The PDS enrollment record identifies the Stratos service, assigned boundaries, user signing key, and service attestation. It does not contain a private-record copy, stub, preview, or blob reference.

## Boundary access control

A boundary is a service-DID-qualified access scope, such as `did:web:stratos.example.com/engineering`. A private record can carry one or more boundary values. A viewer can read the record only when current membership shares at least one value.

<BoundaryAccessDiagram />

The service performs the check. A client can show boundary state, but its user interface cannot authorize a read. An unauthorized read returns not found so the response does not confirm that a record exists.

## Enrollment publishes discovery data

The user begins enrollment with Stratos through AT Protocol OAuth. The service initializes an empty signed actor repository, creates or obtains the user record-signing key, signs an enrollment attestation, and writes `zone.stratos.actor.enrollment` to the user PDS.

<TrustFlowDiagram />

The enrollment record lets a client discover the service. The attestation lets a verifier confirm the service endorsement of the user DID, boundary set, and signing key. Neither is an access grant. Private content still requires a live membership check.

## Private records keep AT Protocol properties

The client writes a private post as a `zone.stratos.feed.post` record in the Stratos actor repository. The write produces an AT URI, CID, signed commit, and Merkle Search Tree path. The repository can return inclusion proofs and export a CAR file without publishing record content through the PDS.

<StratosFlowDiagram />

Hydration returns a record with a `source` field that identifies the authoritative Stratos subject:

```json
{
  "$type": "zone.stratos.feed.post",
  "source": {
    "vary": "authenticated",
    "subject": {
      "uri": "at://did:plc:example/zone.stratos.feed.post/3kq...",
      "cid": "bafyre..."
    },
    "service": "did:web:stratos.example.com#atproto_pns"
  }
}
```

The source identifies where the record is held. It does not authorize the caller. A consumer calls the service with an authenticated identity and accepts the result of the current boundary check.

## Shared views and verification

A feed generator maintains a local projection from the Stratos subscription stream and serves hydrated, boundary-scoped feed results. An AppView can use the same hydration interfaces in its deployment. These consumers apply Stratos authorization semantics. The service remains the authority for private-record access.

To verify a returned record, recompute the CID from the record data. To verify authorship, combine the signed commit, MST inclusion proof, and the user signing key from the service attestation. This verifies an enrollment statement and a record history. It does not replace a current access decision.

The included `webapp` package demonstrates enrollment, private-post creation, and a unified public/private view. It is a reference implementation, not the protocol contract.
