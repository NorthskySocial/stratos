# Outbound request security review

Review scope: the SSRF notice concerning DID resolution, redirects, proxy headers, and repository sync.

## Findings

| Component                              | Exposure before this patch                                                                                                                                                                                           | Change                                                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `stratos-service`                      | Unverified JWT issuers and OAuth identifiers can trigger `did:web` or HTTP handle resolution. Identity resolution lacked IP filtering; HTTP handles followed redirects.                                              | Route both resolution paths through a shared public-address transport. Reject encoded DID authority delimiters and invalid handles. |
| `stratos-service` OAuth                | The supplied OAuth fetch was unrestricted. Discovery, token requests, and authenticated PDS operations could reach private addresses.                                                                                | Protect the fetch passed to both enrollment and admin OAuth clients.                                                                |
| `stratos-service` client metadata/JWKS | Redirect rejection and literal-host checks did not cover hostnames resolving to private addresses.                                                                                                                   | Check resolved addresses when opening the socket, including `jwks_uri` fetches.                                                     |
| `PdsTokenVerifier`                     | Its metadata reader used unrestricted fetch. This class currently has no production caller in the service.                                                                                                           | Secure its transport so future callers inherit the same policy.                                                                     |
| `stratos-feedgen`                      | Unverified JWT issuers, member DIDs, and commit-key DIDs could cause private-network requests. The space host client already pinned DNS and rejected redirects, but omitted reserved ranges and expanded IPv6 forms. | Protect identity and commit-key resolution. Share the complete address classifier with space host reads.                            |
| `stratos-indexer`                      | User-controlled DIDs from indexed records reached the upstream identity resolver.                                                                                                                                    | Protect the existing resolver while preserving its SDK version and cache.                                                           |
| Configured upstream HTTP clients       | Feedgen upstream calls, indexer backfill, and PLC handle fallback followed redirects beyond their configured destination or path.                                                                                    | Reject redirects. Keep operator-configured internal origins usable.                                                                 |

These are code-level SSRF findings. This review does not establish that a deployed service was exploited or held reachable internal data.

## Policy

`stratos-core/network` is a server-only entry point for Node and Deno's Node compatibility layer. Its transport requires HTTPS without URL credentials and rejects redirects, including same-origin redirects. DID and handle lookups retain their fixed well-known paths.

The Undici socket lookup validates every returned address and supplies those same addresses to the connection. There is no validation lookup followed by an unchecked second lookup. Literal addresses are checked separately because sockets can bypass DNS for them. An injected dispatcher cannot replace the protected dispatcher.

The indexer container runs Deno. Its native fetch ignores Node's `dispatcher` option, so the default transport explicitly uses Undici's fetch on Deno. A regression script exercises this path under Deno and checks that private DNS and DID lookups open no internal sockets.

The classifier rejects non-unicast IPv4 ranges and restricts IPv6 to global unicast outside reserved ranges. It also rejects IPv4-mapped and transition addresses, site-local IPv6, loopback, private, link-local, multicast, and benchmark destinations. Existing space sync DNS pinning uses this same classifier.

The design follows the connection-time checks in the [upstream ATProto transport](https://github.com/bluesky-social/atproto/blob/main/packages/internal/fetch-node/src/unicast.ts). The installed `@atproto/identity` versions do not accept a fetch option; replacing their HTTP resolution methods is necessary. See the [upstream handle resolver](https://github.com/bluesky-social/atproto/blob/main/packages/identity/src/handle/index.ts).

## Other reviewed paths

`zone.stratos.sync.getRepo` reads local repository blocks and requires the repository owner. It does not fetch or proxy an upstream repository. There is no Stratos server-side implementation of the `atproto-proxy` request header; browser clients send it to their PDS.

Indexer and feedgen WebSockets use operator-configured endpoints. Enrollment records do not select new WebSocket destinations. The feedgen's `ws` client disables redirects by default. Membership remains the source of repos to sync; boundary derivation and custody behavior are unchanged.

Database, blob-storage, telemetry, and external allow-list endpoints are operator configuration, not request-supplied destinations. Browser applications run their HTTP requests on the client. Applications embedding `stratos-client` on a server must supply a protected fetch or authenticated handler when accepting untrusted destinations.

## Compatibility and deployment

User-discovered DID, PDS, OAuth, and client-metadata hosts must resolve to public HTTPS destinations. `STRATOS_DEV_MODE` does not bypass this rule. A local OAuth test server needs a public HTTPS endpoint. The existing explicit loopback exception for space host sync remains limited to its configured origins.

Configured PLC, Stratos upstream, and indexer repo-provider URLs may still use internal addresses. Those clients reject redirects. Operators must configure their final endpoint directly.

Rebuild and restart `stratos-service`, `stratos-feedgen`, and `stratos-indexer` to deploy the patch. No data migration is required.

## Verification

The final Vitest run passed 2,635 tests across 198 files, with 44 tests skipped. It covered core, service, feedgen, and indexer. Formatting and lint checks passed; lint retained warnings, including the cast needed for the indexer's different dispatcher types.

Scoped mutation testing kept the existing 60% gate:

| Scope                                                             | Score  | Notes                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared network implementation                                     | 100%   | All 115 mutants killed, including the Deno transport path.                                                                                                                                                                                                       |
| Service identity, metadata, and OAuth changes                     | 74.87% | Broader files include pre-existing survivors. A follow-up request-options run passed at 75% after strengthening header and timeout assertions. Its remaining survivor changes a duplicate redirect setting; the shared transport enforces `error` independently. |
| Feedgen identity, commit-key, host checks, and upstream redirects | 84.21% | Remaining survivors occur outside the changed behavior.                                                                                                                                                                                                          |
| Indexer resolver and both backfill redirect settings              | 100%   | All five mutants killed.                                                                                                                                                                                                                                         |

Core, service, and feedgen typechecks passed. The indexer's default NodeNext typecheck has 23 errors involving existing extensionless core imports and resulting type errors. The original revision produces the same 23 errors. The patched indexer passes with `--moduleResolution bundler --module esnext`, matching the workspace's module-resolution settings.

The Deno 2.9.2 regression passed both with pnpm's installed modules and with Deno's workspace dependency resolution. To repeat the local transport check:

```sh
deno run --no-config --node-modules-dir=manual --no-lock --sloppy-imports -A stratos-core/tests/public-fetch.deno.ts
```

The URI-shape spike completed. The host-discovery spike resolved the DID and authority override, but could not complete its capability probe because the spaces PDS at `localhost:3010` was unavailable. Live upstream spaces interoperability remains unverified in this environment.
