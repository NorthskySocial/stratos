# Outbound request security disclosure

## Summary

Stratos accepted user-controlled identifiers in several server-side outbound request paths. Before remediation, these paths could resolve or request private network destinations, follow redirects, or consume unbounded decoded response bodies. This created server-side request forgery (SSRF) risk.

This disclosure describes code-level exposure. It does not establish that a deployed service was exploited or that internal data was reached.

## References

The following upstream pull requests identify the vulnerability classes addressed by this disclosure. They define the scope of the affected request, redirect, identity-resolution, and response-handling paths. They are references, not verification criteria for this implementation.

- [5501: protect PDS service clients](https://github.com/bluesky-social/atproto/pull/5501)
- [5502: bound decoded HTTP bodies](https://github.com/bluesky-social/atproto/pull/5502)
- [5503: validate redirect hops](https://github.com/bluesky-social/atproto/pull/5503)
- [5504: secure identity defaults](https://github.com/bluesky-social/atproto/pull/5504)

## Affected paths

| Component | Exposure | Remediation |
| --- | --- | --- |
| `stratos-service` identity resolution | Unverified JWT issuers and OAuth identifiers could trigger `did:web` or HTTP handle resolution. Resolution did not filter private IP addresses, and HTTP handles followed redirects. | Route resolution through a shared public-address transport. Reject encoded DID authority delimiters and invalid handles. |
| `stratos-service` OAuth | The supplied OAuth fetch could request private addresses during discovery, token exchange, and authenticated PDS operations. | Use the shared protected transport for enrollment and admin OAuth clients. |
| `stratos-service` client metadata and JWKS | Literal-host checks and redirect rejection did not protect hostnames that resolved to private addresses. | Validate every resolved address when opening a socket, including `jwks_uri` requests. |
| `PdsTokenVerifier` | Its metadata reader used unrestricted fetch. | Protect its transport so future production callers inherit the same policy. |
| `stratos-feedgen` | Unverified JWT issuers, member DIDs, and commit-key DIDs could trigger private-network requests. Space host reads omitted reserved ranges and some IPv6 forms. | Protect identity and commit-key resolution. Share the complete address classifier with space host reads. |
| `stratos-indexer` | User-controlled DIDs from indexed records reached the upstream identity resolver. | Use the shared protected resolver with the existing cache. |
| Configured upstream HTTP clients | Feedgen upstream calls, indexer backfill, and PLC handle fallback could follow redirects beyond the configured destination or path. | Reject redirects while allowing operator-configured internal origins. |
| Identity, OAuth, and metadata responses | Request paths could accept oversized decoded response bodies and did not consistently release rejected response bodies. | Limit decoded response bytes and request duration. Cancel rejected response bodies. |
| Non-XRPC JSON request parsing | Oversized decoded request bodies produced HTTP 500 instead of HTTP 413. | Return HTTP 413 for `entity.too.large` errors. |

## Security controls

`stratos-core/network` is a server-only entry point for Node and Deno's Node compatibility layer. Its transport requires HTTPS without URL credentials and rejects every redirect, including same-origin redirects. DID and handle resolution retain fixed well-known paths.

The Undici socket lookup validates every resolved address and supplies the validated addresses to the connection. This prevents a validation lookup followed by an unchecked second lookup. Literal addresses are checked separately because sockets can bypass DNS for them. An injected dispatcher cannot replace the protected dispatcher.

The indexer runs in Deno, whose native fetch ignores Node's `dispatcher` option. Its default transport uses Undici fetch so that the socket policy applies on Deno as well.

The address classifier rejects non-unicast IPv4 ranges. It accepts only global-unicast IPv6 addresses outside reserved ranges. It rejects IPv4-mapped and transition addresses, site-local IPv6, loopback, private, link-local, multicast, and benchmark destinations. Space sync DNS pinning uses the same classifier.

The general HTTP transport permits public HTTPS literal addresses and custom ports where a caller's URL schema permits them. It enforces the public-address requirement at the socket and rejects all redirects. It does not adopt upstream's domain-name denylist.

DID web authorities permit ports only on the exact `localhost` hostname, following the [AT Protocol DID rules](https://atproto.com/specs/did#didweb-in-at-protocol). This syntax rule does not bypass the public-address transport. Malformed percent escapes, invalid URL authorities, and encoded whitespace raise `PoorlyFormattedDidError` before a fetch.

The shared transport limits decoded responses to 512 KiB and applies a 10-second timeout. Caller cancellation and shorter timeouts remain effective. OAuth client metadata retains its 64 KiB limit. DID, handle, JWKS, and metadata readers cancel rejected response bodies.

The configured PLC resolver uses the bounded transport. DID web resolution uses identity's fetch injection option and cleans up error bodies after DID authority validation. HTTP handles use the fixed well-known path and protected transport.

## Dependency updates

The lockfiles resolve the security releases listed below.

| Dependency | Version | Purpose |
| --- | --- | --- |
| `@atproto/identity` | 0.5.13 | Protected defaults, HTTP handle timeout, fetch injection, and body cleanup |
| `@atproto/oauth-provider` | 0.22.8 | Decoded request-body limits in the upstream HTTP parser |
| `@atproto/oauth-client-node` | 0.5.7 | Updated OAuth client dependency chain |
| `@atproto-labs/fetch-node` | 0.4.0 | URL policy checks at dispatch for redirect hops |
| `@atproto-labs/fetch` | 0.3.6 | Bounded-response processor and URL policy helpers |
| `@atproto/bsky` | 0.0.280 | Updated indexer SDK and protected identity dependency |
| `@atproto/syntax` in the indexer | 0.7.6 | Matches the updated SDK `AtUri` API |
| Direct `undici` dependencies | 7.29.1 | Node 24-compatible protected transport |
| Direct `ipaddr.js` dependency | 2.5.0 | Address classifier |

The pnpm release-age exceptions name exact verified ATProto releases and their dependencies. Deno lock generation uses a one-time publication cutoff after these releases. Neither configuration disables the default release-age policy globally.

## Excluded paths

`zone.stratos.sync.getRepo` reads local repository blocks and requires the repository owner. It does not fetch or proxy an upstream repository. Stratos has no server-side implementation of the `atproto-proxy` request header; browser clients send it to their PDS.

Indexer and feedgen WebSockets use operator-configured endpoints. Enrollment records do not select WebSocket destinations. The feedgen `ws` client disables redirects by default. Membership remains the source of repositories to sync. Boundary derivation and custody behavior are unchanged.

Database, blob-storage, telemetry, and external allow-list endpoints are operator configuration, not request-supplied destinations. Browser applications make HTTP requests on the client. Server applications that embed `stratos-client` must supply a protected fetch or authenticated handler when they accept untrusted destinations.

## Deployment and compatibility

Rebuild and restart `stratos-service`, `stratos-feedgen`, and `stratos-indexer` to deploy these changes.

User-discovered DID, PDS, OAuth, and client-metadata hosts must resolve to public HTTPS destinations. `STRATOS_DEV_MODE` does not bypass this rule. Local OAuth development requires a public HTTPS endpoint. The explicit loopback exception for space host sync remains limited to configured origins.

Configured PLC, Stratos upstream, and indexer repo-provider URLs may use internal addresses. These clients reject redirects. Configure their final endpoint directly.

No Stratos data migration is required. The indexer SDK upgrade requires compatible AppView migrations before an updated indexer starts. Stratos's schema initializer does not apply AppView migrations.
