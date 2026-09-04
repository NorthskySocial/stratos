<script setup>
import TrustFlowDiagram from '../.vitepress/theme/components/TrustFlowDiagram.vue'
</script>

# Enrollment Signing

Stratos writes one `zone.stratos.actor.enrollment` record per service to the user PDS. The record provides public discovery and a signed enrollment statement.

<TrustFlowDiagram />

## Signed data

The service attestation binds these values:

```ts
{
  boundaries: ['did:web:stratos.example.com/engineering'],
  did: 'did:plc:example',
  signingKey: 'did:key:zDna...'
}
```

The service signs the canonical DAG-CBOR payload. A verifier resolves the service verification key from the attestation or service DID document, verifies the signature, and confirms the user DID and service match the expected values.

## Live access remains authoritative

An attestation records membership at signing time. It does not prove that membership is still current. Stratos checks current membership on each private read. The feed generator must reconcile enrollment changes and purge derived state when access is removed.

## Record proof

An enrolled user repository signs commits with the user signing key. Combine the enrollment attestation, a signed commit, and an MST inclusion proof to verify authorship of a record.
