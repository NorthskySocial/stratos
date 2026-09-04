# Deployment

Deploy Stratos and the feed generator as separate services. Give each service its own stable HTTPS URL, DID, signing key, storage, health check, and least-privilege network policy.

## Stratos service

Configure the Stratos DID, public URL, OAuth client metadata, storage backend, signing material, and allowed boundaries. The service is the authoritative home for private repositories. Back up its storage and protect its key material.

## Feed generator

Configure `FEEDGEN_SERVICE_DID`, `FEEDGEN_SIGNING_KEY`, `STRATOS_SERVICE_URL`, `STRATOS_SERVICE_DID`, feed definitions, and its projection storage. Publish its `did:web` document at `/.well-known/did.json`; the server provides the `#stratos_feedgen` service entry.

Expose `/health` to the platform health checker. Protect `/metrics` with `FEEDGEN_METRICS_TOKEN` or an equivalent network control. Do not expose projection storage or service signing keys.

## Validate the deployment

1. Resolve both service DID documents.
2. Complete an OAuth enrollment and confirm the PDS enrollment record.
3. Create a boundary-scoped record through Stratos.
4. Confirm that the feed generator subscription ingests the record.
5. Request the feed through the PDS proxy as an enrolled viewer.
6. Remove the viewer boundary and confirm that the projection purges access.
