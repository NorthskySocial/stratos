# Security

## Access control

Stratos validates boundaries on write and checks current shared boundaries on private reads. The viewer DID comes from the authenticated credential. The service never accepts a caller-supplied viewer identity for authorization.

Return not-found for a record that the caller cannot access. This avoids record-existence disclosure.

## Service identities

Service identities are read-only. The feed generator needs service-auth access to its configured boundaries and subscription lexicons. Keep that grant narrow. A compromised feed generator can expose its local projection, so protect its signing key and storage as sensitive data.

## Browser clients

Allow only the required client origins. Expose `DPoP-Nonce` and `WWW-Authenticate` so a browser can complete DPoP nonce negotiation. Do not permit wildcard origins for an authenticated production client.

## Keys and secrets

Store service keys, OAuth secrets, metrics tokens, and database credentials in the platform secret store. Rotate a compromised service signing key and reissue affected enrollment attestations. Never log tokens, DPoP proofs, private record content, or raw authorization headers.
