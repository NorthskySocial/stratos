# Outbound request security review

Review scope: the SSRF notice concerning DID resolution, redirects, proxy headers, and repository sync, including upstream PRs 5501–5504.

## Findings

| Component                               | Exposure before this patch                                                                                                                                                                                           | Change                                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `stratos-service`                       | Unverified JWT issuers and OAuth identifiers can trigger `did:web` or HTTP handle resolution. Identity resolution lacked IP filtering; HTTP handles followed redirects.                                              | Route both resolution paths through a shared public-address transport. Reject encoded DID authority delimiters and invalid handles. |
| `stratos-service` OAuth                 | The supplied OAuth fetch was unrestricted. Discovery, token requests, and authenticated PDS operations could reach private addresses.                                                                                | Protect the fetch passed to both enrollment and admin OAuth clients.                                                                |
| `stratos-service` client metadata/JWKS  | Redirect rejection and literal-host checks did not cover hostnames resolving to private addresses.                                                                                                                   | Check resolved addresses when opening the socket, including `jwks_uri` fetches.                                                     |
| `PdsTokenVerifier`                      | Its metadata reader used unrestricted fetch. This class currently has no production caller in the service.                                                                                                           | Secure its transport so future callers inherit the same policy.                                                                     |
| `stratos-feedgen`                       | Unverified JWT issuers, member DIDs, and commit-key DIDs could cause private-network requests. The space host client already pinned DNS and rejected redirects, but omitted reserved ranges and expanded IPv6 forms. | Protect identity and commit-key resolution. Share the complete address classifier with space host reads.                            |
| `stratos-indexer`                       | User-controlled DIDs from indexed records reached the upstream identity resolver.                                                                                                                                    | Update the SDK and use the shared protected resolver with the existing cache.                                                       |
| Configured upstream HTTP clients        | Feedgen upstream calls, indexer backfill, and PLC handle fallback followed redirects beyond their configured destination or path.                                                                                    | Reject redirects. Keep operator-configured internal origins usable.                                                                 |
| Identity, OAuth, and metadata responses | The first patch blocked private destinations but did not bound all response streams or release all rejected bodies.                                                                                                  | Limit decoded response bytes and request duration. Cancel rejected response bodies.                                                 |
| Non-XRPC JSON request parsing           | Express already limited decoded bodies to 100 KiB, but the error handler converted oversized-body errors to HTTP 500.                                                                                                | Return HTTP 413 for `entity.too.large` errors.                                                                                      |

These are code-level SSRF findings. This review does not establish that a deployed service was exploited or held reachable internal data.

## Upstream comparison

| Upstream fix                                                                             | Applicability and resolution                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [5501: protect PDS service clients](https://github.com/bluesky-social/atproto/pull/5501) | Stratos does not implement the affected push registration or report proxy routes. Protect its analogous DID-discovered OAuth, PDS, and metadata requests with the shared transport.                                        |
| [5502: bound decoded HTTP bodies](https://github.com/bluesky-social/atproto/pull/5502)   | Add decoded response limits, body cleanup, and HTTP 413 handling. Stratos uses `OAuthVerifier`, not the affected OAuth-provider HTTP parser, and has no PDS read-after-write proxy. Update the provider dependency anyway. |
| [5503: validate redirect hops](https://github.com/bluesky-social/atproto/pull/5503)      | The shared transport already rejects every redirect, including same-origin redirects. Update all `fetch-node` resolutions to 0.4.0 for upstream clients that handle redirects internally.                                  |
| [5504: secure identity defaults](https://github.com/bluesky-social/atproto/pull/5504)    | Update identity to 0.5.13 and use its new fetch injection option. Retain strict DID authority parsing, protected HTTP handles, configured PLC support, and the Deno transport.                                             |

The comparison used the merged diffs and published package contents. The first patch covered the destination and redirect vectors. Response limits, cleanup, and dependency updates were missing.

## Policy

`stratos-core/network` is a server-only entry point for Node and Deno's Node compatibility layer. Its transport requires HTTPS without URL credentials and rejects redirects, including same-origin redirects. DID and handle lookups retain their fixed well-known paths.

The Undici socket lookup validates every returned address and supplies those same addresses to the connection. There is no validation lookup followed by an unchecked second lookup. Literal addresses are checked separately because sockets can bypass DNS for them. An injected dispatcher cannot replace the protected dispatcher.

The indexer container runs Deno. Its native fetch ignores Node's `dispatcher` option, so the default transport explicitly uses Undici's fetch on Deno. A regression script exercises this path under Deno and checks that private DNS and DID lookups open no internal sockets.

The classifier rejects non-unicast IPv4 ranges and restricts IPv6 to global unicast outside reserved ranges. It also rejects IPv4-mapped and transition addresses, site-local IPv6, loopback, private, link-local, multicast, and benchmark destinations. Existing space sync DNS pinning uses this same classifier.

Stratos permits public HTTPS literal addresses and custom ports where a caller's URL schema permits them. Upstream's default identity fetch also rejects literal addresses, custom ports, and certain domain names. Stratos enforces the public-address requirement at the socket and rejects all redirects; it does not adopt that domain-name denylist.

The shared transport limits responses to 512 KiB of decoded bytes and applies a 10-second timeout. Caller cancellation and shorter timeouts remain effective. The upstream `fetchMaxSizeProcessor` counts streamed bytes after decompression, including when `Content-Length` is absent or false. Tests cover gzip, deflate, and Brotli. OAuth client metadata retains its stricter 64 KiB limit. DID, handle, JWKS, and metadata readers cancel rejected response bodies.

The configured PLC resolver also uses the bounded transport. DID web resolution uses identity's new fetch option and error-body cleanup after validating the DID authority. HTTP handles retain the fixed well-known path and protected transport.

## Dependencies

Both `pnpm-lock.yaml` and `deno.lock` resolve the security releases. No older identity, OAuth-provider, `fetch-node`, or `fetch` resolution remains.

| Dependency                       | Version | Purpose                                                                |
| -------------------------------- | ------- | ---------------------------------------------------------------------- |
| `@atproto/identity`              | 0.5.13  | Protected defaults, HTTP handle timeout, fetch injection, body cleanup |
| `@atproto/oauth-provider`        | 0.22.8  | Decoded request-body limits in the upstream HTTP parser                |
| `@atproto/oauth-client-node`     | 0.5.7   | Updated OAuth client dependency chain                                  |
| `@atproto-labs/fetch-node`       | 0.4.0   | URL policy checks at dispatch for every redirect hop                   |
| `@atproto-labs/fetch`            | 0.3.6   | Shared bounded-response processor and URL policy helpers               |
| `@atproto/bsky`                  | 0.0.280 | Updated indexer SDK and protected identity dependency                  |
| `@atproto/syntax` in the indexer | 0.7.6   | Match the updated SDK's `AtUri` API                                    |
| Direct `undici` dependencies     | 7.29.1  | Current transport on the Node 24 compatible major                      |
| Direct `ipaddr.js` dependency    | 2.5.0   | Updated address classifier                                             |

Keep the existing spaces-alpha OAuth scope pin. The pnpm release-age exceptions name exact verified ATProto releases and their dependencies. Deno lock generation used a one-time publication cutoff after these releases. Neither step disables the default release-age policy globally.

## Other reviewed paths

`zone.stratos.sync.getRepo` reads local repository blocks and requires the repository owner. It does not fetch or proxy an upstream repository. There is no Stratos server-side implementation of the `atproto-proxy` request header; browser clients send it to their PDS.

Indexer and feedgen WebSockets use operator-configured endpoints. Enrollment records do not select new WebSocket destinations. The feedgen's `ws` client disables redirects by default. Membership remains the source of repos to sync; boundary derivation and custody behavior are unchanged.

Database, blob-storage, telemetry, and external allow-list endpoints are operator configuration, not request-supplied destinations. Browser applications run their HTTP requests on the client. Applications embedding `stratos-client` on a server must supply a protected fetch or authenticated handler when accepting untrusted destinations.

## Compatibility and deployment

User-discovered DID, PDS, OAuth, and client-metadata hosts must resolve to public HTTPS destinations. `STRATOS_DEV_MODE` does not bypass this rule. A local OAuth test server needs a public HTTPS endpoint. The existing explicit loopback exception for space host sync remains limited to its configured origins.

Configured PLC, Stratos upstream, and indexer repo-provider URLs may still use internal addresses. Those clients reject redirects. Operators must configure their final endpoint directly.

Rebuild and restart `stratos-service`, `stratos-feedgen`, and `stratos-indexer` to deploy the patch. Metadata and OAuth responses exceeding the decoded size limit now fail.

No Stratos data migration is added. The indexer SDK advances from `@atproto/bsky` 0.0.214 to 0.0.280. Its AppView migrations include gallery embeds, mute scopes, thread replies, reference-list opt-outs, and notification changes. Apply compatible AppView migrations through the AppView deployment before starting the updated indexer. Stratos's schema initializer does not run those migrations. Live AppView database compatibility remains unverified here.

The updated SDK exposes its indexing service through `RepoSubscription`. Construct it without starting the subscription, and keep the existing queue limits. Node and Deno checks confirm that construction preserves the protected resolver and background context. Stratos's existing subscriptions continue to decide which repos are read.

## Verification

The final workspace Vitest run passed 2,891 tests across 223 files, with 44 tests skipped. The separate browser package passed another 15 tests across two files. Formatting and whitespace checks passed.

Verification covers the shared transport, identity factories, service metadata, OAuth, feedgen commit keys, and the actual updated indexer SDK. The compressed-response tests use local HTTP servers. The HTTP 413 regression sends a compressed JSON request whose decoded body exceeds the existing 100 KiB limit.

Scoped mutation testing after the dependency update kept the existing 60% gate:

| Scope                                        | Score  | Notes                                                                                                                                                              |
| -------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared network implementation                | 99.16% | 118 killed; one equivalent survivor removes a null-body guard inside a catch that returns the same handle-resolution fallback. Both paths are tested.              |
| Service response cleanup and HTTP 413 branch | 100%   | All 15 mutants killed. The entry-point run targets only the new error-handling branch.                                                                             |
| Feedgen commit-key resolver                  | 70.97% | 22 killed; nine survivors concern existing timeout, request options, cleanup, or diagnostic text. New HTTP-status and body-cancellation behavior has no survivors. |
| Indexer resolver and SDK construction        | 100%   | All four mutants killed. Tests use the actual SDK and verify the protected resolver, bounded queue, and absence of an extra subscription.                          |

The initial SSRF patch also passed scoped gates for service wiring (74.87%), feedgen host and upstream paths (84.21%), and indexer backfill redirects (100%). The broader scopes contained pre-existing survivors. The service request-options follow-up scored 75%; its remaining mutant changes a duplicate redirect setting enforced independently by the shared transport.

Core, service, feedgen, and client typechecks passed. The indexer's default NodeNext typecheck has 23 errors involving existing extensionless core imports and resulting type errors. The original revision produces the same 23 errors. The patched indexer passes with `--moduleResolution bundler --module esnext`, matching the workspace's module-resolution settings.

Core, service, feedgen, client, and browser production builds passed. Lint passed with its existing dispatcher-cast warning. The updated pnpm lockfile passed an offline frozen install; Deno accepted its lockfile with `--frozen`.

The Deno 2.9.2 transport and actual SDK regressions passed with Deno's workspace dependency resolution. The original transport regression also passed with pnpm's installed modules. To repeat the current checks:

```sh
deno run --frozen --cached-only --node-modules-dir=none --sloppy-imports -A stratos-core/tests/public-fetch.deno.ts
deno run --frozen --cached-only --node-modules-dir=none --sloppy-imports -A stratos-indexer/tests/indexing-service.deno.ts
```

The URI-shape spike completed. The host-discovery spike explicitly supplies native fetch for its localhost DID fixture, as required by the new identity default. It resolved the DID and authority override, but could not complete its capability probe because the spaces PDS at `localhost:3010` was unavailable. Live upstream spaces interoperability remains unverified in this environment.
