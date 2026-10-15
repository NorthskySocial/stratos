# ADR 019: Stratos request-proof foundation, version 1

- Status: proposed protocol; tested foundation helpers and injected admission only; no production enforcement.
- Decision date: 2026-10-15.
- Source baseline: `e8c39163fd14fe52bfe4d00eadd10d068983b917`.
- Scope: Plan 019 foundation. Production integration requires later reviewed work.

## Context and decision

Define an additional `Stratos-Request-Proof` compact JWS for designated
credential-authenticated Stratos reads. It proves possession of the ephemeral
P-256 private key bound by the validated credential's `cnf.kid`.
It does not require a registered client DID.

This is a Stratos extension, not an AT Protocol requirement. Preserve standard
Spaces HTTP Message Signatures and credential transport byte-for-byte. The
extension neither replaces those signatures nor changes their covered components.
Do not send it to foreign PDS hosts as a required authentication mechanism.
OAuth tokens, OAuth DPoP, enrollment, and admin authentication remain unchanged.

Possession is not permission, live member identity, or evidence of human consent.
Keep credential scope, current authority policy, boundary revision checks, and
per-record boundary filtering. Keep custody-specific membership controls.

### Observed baseline, not the proposed wire contract

The current `space-credential-verifier.ts` accepts local authority-signed
credentials with `cnf.jkt`, presented with DPoP. It has no `cnf.kid` path.
`verifiers.ts` composes credential, OAuth, and service verifiers on read routes.
Its DPoP replay consumption precedes the later active-boundary admission check.
Do not describe that ordering as the proposed ordering below.

`ReplayStore.consumeOnce(kind, jti, ttlSeconds)` uses a single atomic
`setNxEx` operation. It returns false for both duplicates and storage failures.
A missing compatible cache produces no replay store. It does not provide atomic
pair consumption or durable exactly-once operations.

`verifier.ts` resolves service DID documents and tests published multibase
verification methods. Its current service JWT path does not enforce all version 1
header, algorithm, key-selection, or time requirements. Reuse its resolution and
signature seams, not its permissive parsing as a complete extension verifier.

## Version 1 request proof

All limits below are inclusive. Count bytes, not JavaScript string code units.
Reject over-limit values before expensive decoding, resolution, or hashing.

### Transport and encoding

Send exactly one `Stratos-Request-Proof` field containing only the compact JWS.
HTTP field names are case-insensitive. Reject duplicate field lines, arrays,
comma-joined values, empty values, and embedded whitespace. HTTP framing removes
outer optional whitespace; no additional token trimming or rewriting is allowed.
Inspect raw field occurrences before middleware combines duplicate fields.
Apply the same singleton rule to the credential-bearing field and the optional
identity assertion. Retain standard Spaces signature field grammar unchanged.

Use three nonempty unpadded base64url segments, separated by two periods.
Only `A-Z`, `a-z`, `0-9`, `-`, and `_` are allowed inside segments. Decode strictly
and require encode-after-decode equality, including unused trailing bits.
Header and payload are UTF-8 JSON objects without a BOM. Reject malformed UTF-8,
duplicate member names after JSON escape decoding, arrays, null, unknown fields,
and wrong field types. Do not coerce values.

The signing input is the ASCII first segment, a period, and the ASCII second
segment, exactly as received. JSON member order and insignificant whitespace
need not match a canonical serializer. Never reserialize to verify a signature.
JWS JSON serialization, detached payloads, and unencoded payloads are forbidden.

### Protected header

Require exactly these three protected members:

| Member | Required value                              |
| ------ | ------------------------------------------- |
| `typ`  | `stratos-request-proof-v1+jwt`              |
| `alg`  | `ES256`                                     |
| `kid`  | Exact validated credential `cnf.kid` string |

`kid` is a canonical P-256 `did:key` controller identifier, without a fragment,
query, or path. Decode its multicodec and compressed point, validate the curve
point, then require canonical re-encoding equality. Reject other curves and key
sources, including `jwk`, `jku`, `x5c`, and `crit` headers.
Never resolve an arbitrary proof-supplied key before validating credential binding.

The credential issuer signs this binding. The client generates the ephemeral key
with a CSPRNG and keeps its private material local. It is not an account key,
client registration, or a new DID-document key purpose. Credential migration from
`cnf.jkt` to `cnf.kid` is a prerequisite, not an implicit conversion.

ES256 means ECDSA P-256 with SHA-256. The signature is exactly 64 octets of
JOSE `R || S`, each a 32-octet unsigned big-endian integer. Reject DER and invalid
scalar ranges. Accept either valid S representative for JWS verification.
Do not import standard HTTP-signature high-S rules into this JWT profile.
Do not change low-S rules for repository commits or global crypto helpers.

### Claims

Require exactly these eight payload members:

| Claim       | Type and meaning                                                           |
| ----------- | -------------------------------------------------------------------------- |
| `aud`       | String: exact receiving Stratos authority DID from trusted configuration   |
| `htm`       | String: exact uppercase HTTP method; version 1 adoption permits `GET` only |
| `target`    | String: exact raw origin-form path and optional query                      |
| `ath`       | String: base64url SHA-256 of exact presented credential token bytes        |
| `body_hash` | String: base64url SHA-256 of exact request body bytes                      |
| `iat`       | Nonnegative safe integer NumericDate in seconds                            |
| `exp`       | Nonnegative safe integer NumericDate in seconds                            |
| `jti`       | String: base64url of exactly 16 independently CSPRNG-generated octets      |

Both digest claims encode exactly 32 octets as 43 base64url characters.
`jti` encodes exactly 128 random bits as 22 characters. Never derive it from time,
a counter, a request digest, or a signature. There is no `iss`, `sub`, `nbf`,
challenge nonce, or array-valued audience in this profile.

The credential bytes for `ath` are the ASCII compact credential token extracted
by the standard transport adapter. Exclude the authentication scheme, field
whitespace, and surrounding signature metadata. Do not decode and re-encode its
JWT or hash a parsed claims object. Credentials are limited to 16,384 token bytes.

Require `0 < exp - iat <= 60`. Let `now` be the current integer Unix second.
Require `iat <= now + 5` and `now < exp + 5`. Five seconds is the only proof clock
tolerance. Credential validity is checked independently; a proof cannot extend it.

### Limits

| Input                                 | Maximum bytes     |
| ------------------------------------- | ----------------- |
| Compact request proof field value     | 8,192             |
| Decoded protected header              | 512               |
| Decoded request-proof payload         | 4,096             |
| `kid`                                 | 256 ASCII bytes   |
| `aud`                                 | 256 ASCII bytes   |
| `htm`                                 | 16 ASCII bytes    |
| `target`                              | 2,048 ASCII bytes |
| Credential token hashed by `ath`      | 16,384            |
| Request body in initial route profile | 0                 |

Validate DID syntax as well as its size. Do not use the audience as a URL or
infer it from `Host`, forwarded headers, or the credential's untrusted claims.

## Raw target and body contract

Capture the origin-form target before URL parsing, routing, decoding, or query
normalization. For HTTP/2, capture the original `:path` equivalent. It must start
with `/`, but not `//`, and contain an absolute path with an optional `?query`.
Reject absolute-form URLs, authority-form, `*`, literal fragments (`#`), spaces,
controls (`0x00`–`0x20` and `0x7f`), non-ASCII bytes, backslashes, and malformed
percent escapes. Each `%` must be followed by two ASCII hexadecimal digits.
Use valid URI path/query characters; a literal `?` after the first belongs to
the query. Percent-encoded bytes stay encoded, including `%23` and `%2F`.

Compare the complete target byte-for-byte. Do not sort query parameters, merge
repeated names, decode escapes, change hex case, remove dot segments, collapse
slashes, or remove an empty trailing `?`. Routing must not reinterpret an admitted
target into a different authorized operation. Reject ambiguous routing forms
rather than repair them. The producer must sign the target actually transmitted,
not a pre-normalization URL that Fetch or another HTTP client later changes.

Version 1 deployment requires a byte-preserving public path/query contract.
The signed target includes any public prefix. Proxies must pass that target
unchanged to the verifier. Prefix stripping, query rewriting, and decoded path
forwarding are unsupported. Do not reconstruct a target from attacker-controlled
`X-Forwarded-*` or `X-Original-URL` fields. A deployment needing rewrites must stop
integration until a separately reviewed trusted-ingress contract exists.

Hash entity body bytes after HTTP transfer framing removal and before JSON
parsing or other transformations. Do not hash chunks, framing, parsed JSON, or
reserialized JSON. Reject `Content-Encoding` other than absent or `identity`;
no decompression is part of this profile. Empty means exactly zero octets.
Its SHA-256 base64url value is
`47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU`.

Initial reads require an empty request body, including when transfer framing
would otherwise permit a body. Reject nonempty bodies before replay consumption.
The route adapter must prove emptiness within bounded transport handling.
Do not install global raw-body buffering, especially on blob uploads.
Future body-bearing routes need explicit byte limits and retry/idempotency design.

## Feedgen service identity assertion

Where policy requires Feedgen identity, require both the credential-key proof
and a separate singleton `Stratos-Service-Assertion` compact JWS. Do not accept an
unrelated service JWT merely because it appears beside a valid proof.

The assertion follows the strict compact encoding and duplicate JSON rules above.
Its protected header contains exactly `typ`, `alg`, and `kid`:

- `typ`: `stratos-service-assertion-v1+jwt`.
- `alg`: `ES256` or `ES256K`, matching the resolved signing key curve.
- `kid`: full verification-method DID URL from the issuer's resolved DID document.

Its payload contains exactly `iss`, `aud`, `iat`, `exp`, `lxm`, and `proof_hash`.
`iss` is the Feedgen service DID. `aud` is the same authority DID as the proof.
`lxm` is the exact route NSID. `iat` and `exp` equal the request proof's values
and pass the same time checks. `proof_hash` is base64url SHA-256 of the exact ASCII
compact `Stratos-Request-Proof` value, including all three segments.
Thus the assertion binds the same credential, target, method, body, and lifetime.

Limit the compact assertion to 4,096 bytes, its decoded header to 1,024 bytes,
and its decoded payload to 2,048 bytes. Limit `iss` to 256, `kid` to 512, and
`lxm` to 256 ASCII bytes. Require valid DID, DID URL, and NSID syntax respectively.
`proof_hash` encodes exactly 32 octets. Signatures use 64-byte JOSE `R || S`.

Resolve `iss` using the existing trusted DID resolver. Require `kid` to select a
published method controlled by `iss`, with supported ATProto verification
material and the matching curve. Use the existing service-signature primitives
with strict profile validation. Do not invent a mandatory new DID key purpose,
self-published CA, certificate chain, or Feedgen registration protocol.

### Resolver and rotation contract

The foundation adapter calls the injected trusted DID resolver with
`resolve(issuer, true)` on every assertion. It adds no key cache and never serves
stale keys on resolution failure. The production resolver must honor forced
refresh, validate the DID document, and bound outbound resolution by its existing
network timeout and response limits. Do not wrap it in an unbounded or stale-on-error
cache. If these bounds cannot be established, stop production integration.

Require document `id` equal to `iss`, exactly one published method with `id` equal
to the full `kid`, and that method's `controller` equal to `iss`. Version 1 uses
an issuer DID plus a nonempty fragment, not relative IDs or unrelated controllers.
Convert supported ATProto multibase material with the existing identity primitive;
match its curve to `alg` before verifying JOSE bytes. Do not require an additional
DID key purpose. Reuse existing service policy independently of key possession.

A removed or rotated-away method fails the next forced resolution. There is no
historical-key fallback, stale-key grace, or signature-triggered retry. Trusted
resolver upstream freshness still bounds rotation visibility; force refresh does
not promise instantaneous global DID propagation. Any later caching design must
specify a finite maximum age, capacity, refresh/invalidation behavior, and rotation
visibility window through separate review. No such production cache is added here.

An assertion authenticates a service; existing Stratos service policy must still
authorize that service for the operation. It does not replace viewer authorization
or grant a broader boundary. An identity-required route cannot silently downgrade
to client-only presentation. There is no assertion `jti` or second replay store
consumption. Any future independently consumed assertion requires atomic pair
consumption; the current replay seam cannot supply that guarantee.

## Admission and replay ordering

The planned adapter performs these steps, without accessing protected record data:

1. Enforce route, transport, header, target, and body bounds.
2. Validate standard credential transport, signature, scope, expiry, and `cnf.kid`.
3. Validate request-proof structure, key binding, signature, claims, and time.
4. Validate the bound service assertion and service policy where required.
5. Complete admission checks, including current boundary revision, operation scope,
   enrollment checks required by policy, and any pre-access rate limits.
6. Recheck time and atomically consume the single request-proof replay identity.
7. Read protected data with the existing per-record boundary gates.

Invalid, unauthorized, or pre-admission rate-limited requests never consume a
valid proof ID. This does not promise that post-admission read failures can reuse
that proof. No data response precedes successful consumption.

Define `B(x)` as unpadded base64url and `H(x)` as SHA-256. Use UTF-8 JSON arrays
without whitespace for replay-key preimages, in the exact element order below:

- Credential-bound principal:
  `principal = B(H(UTF8(JSON.stringify([aud, kid, ath]))))`.
- Replay identity:
  `replayId = B(H(UTF8(JSON.stringify([principal, jti]))))`.
- Store call:
  `consumeOnce('stratos-request-proof-v1', replayId, ttlSeconds)`.

At consumption, let `nowSeconds` be wall-clock Unix seconds, including fractions.
Recheck `nowSeconds < exp + 5`; set
`ttlSeconds = max(1, ceil(exp + 5 - nowSeconds))`.
All instances use the same replay namespace and shared atomic backing store.
There is one consumed identity regardless of ECDSA S representation or service
assertion. Concurrent duplicates admit at most one caller within retained state.

Missing storage, unavailable storage, or a false consumption result denies
access. Do not fall back to local memory or an unprotected authentication path.
Retain keys without eviction or loss through the acceptance window. Redis loss,
flush, failover rollback, or premature eviction weakens replay guarantees;
there is no replay protection for consumed identities after shared state is lost.
Operational durability must be established before claiming replay protection.

A replay rejection means at-most-once proof acceptance, not exactly-once data
access or operations. After timeout or failure, retry with a new proof and random
`jti`, plus a new bound assertion when required. No challenge exchange is needed.

### Planned error mapping

At enabled routes, malformed request targets or duplicate authentication fields
map to HTTP 400 `InvalidRequest`. Body and token size violations map to HTTP 413
`RequestTooLarge`. An ingress may reject oversized aggregate headers with 431
before XRPC handling; deployment limits must support legitimate profile values.

Missing required proofs, bad signatures, unsupported versions, credential/key
mismatch, invalid claims, expired proofs, replay, and unavailable replay storage
map to HTTP 401 `AuthRequired`, with the generic message `Authorization failed`.
The current replay seam cannot distinguish duplicate from outage to the adapter.
Existing post-auth scope denials retain their existing error mapping.
Do not return validation details or a nonce challenge. Record bounded reason codes
without tokens, signatures, raw targets, credential hashes, or private key material.

## Initial scope and security limits

The first production integration candidate is the credential-authenticated `GET`
branch of `zone.stratos.space.getRecord`, at
`/xrpc/zone.stratos.space.getRecord`. No route is enabled by this document.
Additional bounded reads require an explicit reviewed route allowlist.
Blob streams, WebSockets, credential minting, mutations, and foreign PDS requests
are outside initial adoption. Preserve other authentication branches until an
explicit migration decision changes them; do not claim they receive this protection.

Keep these three audiences distinct:

| Artifact                                    | Intended audience                                           |
| ------------------------------------------- | ----------------------------------------------------------- |
| Standard delegation                         | `authorityDid#atproto_space_host`                           |
| Standard credential presentation            | Repository owner or authority, as required by the operation |
| Stratos request proof and service assertion | Receiving Stratos authority DID, without a fragment         |

A stolen unused delegation can still win the credential-mint race. A later proof
cannot retroactively protect delegation redemption. An attacker holding both
credential and ephemeral private key can create fresh proofs. A stolen complete
unused request can race the legitimate sender. TLS and secure local key handling
remain necessary.

A spaces PDS remains trusted for its hosting and account-key responsibilities.
This extension does not make its boundary claims authoritative, guarantee response
completeness, revoke foreign-host credentials, or prove user consent. Membership
still decides whose repositories the syncer reads.

## Test vectors and implementation dependencies

A later code batch must add portable fixtures with fixed test-only keys, clock,
credential bytes, raw target bytes, body bytes, header/payload UTF-8 bytes,
compact segments, signing input, and expected digests. Store fixed valid signatures
for verification vectors; randomized ECDSA signing need not reproduce them.
Cross-check SHA-256 and ES256 with WebCrypto and an independent verifier, then
consume the same vectors in Rust. Never commit operational private keys.

Include empty-body and percent-escape vectors; query order, repeated names,
trailing `?`, target case, body, and credential changes must alter binding.
Include malformed UTF-8/JSON, duplicate and unknown members, noncanonical
base64url, wrong scalar/curve/algorithm, oversized inputs, missing fields, wrong
field types, lifetime boundaries, future issuance, expiry skew, and proxy rewrites.
Test both S representatives without changing commit verification behavior.

Test identity-assertion substitution across proofs, credentials, services,
audiences, and routes. Show that invalid assertions and admission failures do not
burn proof IDs. Use real cryptography and shared Redis to test concurrent duplicate
rejection, storage failure, expiry retention, and successful fresh-proof retries.
An in-memory seam test alone is not distributed replay evidence.

Use existing dependencies before adding packages:

- Native WebCrypto: `crypto.subtle` for SHA-256/P-256 and
  `crypto.getRandomValues` for keys/nonces as applicable. Use `TextEncoder` and
  `TextDecoder` with fatal decoding. Keep production client code browser-portable.
- Client runtime dependencies already declared and locked: `@atcute/crypto`
  `2.4.4` for P-256 did:key handling and `@atcute/multibase` `1.2.5` for encoding.
  Verify their exact JWS signature behavior before choosing wrappers.
- Existing client test dependency and service runtime dependency:
  `@atproto/crypto` `0.5.4`. Use it for independent fixtures/signature checks
  without promoting it into the client runtime dependencies.
- Service runtime `@atproto/identity` `0.5.13` and existing DID resolution seams
  for service identity; existing `ReplayStore`/`NxExStore` for single-key replay.
- Existing Vitest `4.0.18`, Stryker core/runner `9.6.1`, and Prettier `3.8.1`.
  No new JOSE package or tool installation is selected by this ADR.

These versions are manifest/lockfile evidence, not a runtime compatibility result.
The document batch had no installed dependency tree. Batch 2 installed the locked
workspace dependencies only inside the candidate using pnpm 11.23.0 and Node
24.21.0, with lifecycle scripts disabled. No dependency manifest or lockfile changed.
Runtime tests confirm `@atcute/crypto` P-256 verification accepts both S
representatives with the per-call `allowMalleableSig: true` option. No global
signature policy changes.

## Rollout and unresolved integration conditions

Version 1 names and validation rules above are the foundation decision for review.
Incompatible wire changes require a new `typ` version, not permissive v1 parsing.
Do not advertise support until the implementation and its callers pass review.

Before enforcement, complete standard Spaces transport and credential binding
integration. Review raw target capture, route-to-NSID mapping, empty-body handling,
proxy behavior, aggregate header limits, and browser CORS permission for both
extension headers. Do not enable a route with an unverified raw-byte contract.

Legacy `cnf.jkt`/DPoP and service-Bearer behavior remains as observed at baseline.
There is no automatic jkt-to-kid conversion and no global legacy bypass under a
new enforced policy. Later integration must specify route-by-route migration,
capability discovery, credential reissuance, client upgrade timing, and rollback.
A recognized extension failure must never trigger authentication fallback.
Whether any legacy branch remains available on an enforced route is unresolved;
resolve it explicitly before enabling that route and document its weaker coverage.

Batch 2 adds pure client creation, verification, and replay-entry preparation,
with narrow exports and client README documentation. It does not consume replay
state or validate credentials. Callers supply the exact token, trusted validated
`cnf.kid`, configured authority, raw target, empty body, and clock. A structural
replay-store interface matches the existing seam without importing service code.
The codec delegates JSON grammar to native parsing and scans only the bounded
flat scalar member grammar to detect duplicate decoded names. Maintained existing
libraries handle multibase, P-256 point import, and signature verification.

Focused tests include a fixed test-only scalar-one P-256 key and compact signature
vector, independent `@atproto/crypto` signature verification and Node SHA-256
cross-checks. Batch 3 adds Chromium execution; Rust vector consumption remains
unverified.
Batch 3 adds pure service assertion helpers and an injected service-side admission
composition. It verifies the credential through a caller-supplied validator, checks
the client proof and required bound service identity, awaits complete authorization,
then rechecks time and consumes exactly one request-proof identity. Client-only
admission rejects unsolicited assertions; service admission cannot downgrade.
Neither function is registered in production auth dispatch. Credential validation,
transport/header occurrence checks, raw ingress capture, route policy, and protected
data access remain caller responsibilities. Production still uses `cnf.jkt`/DPoP.

A bounded Chromium probe runs the fixed vector, fresh proof creation, service
assertion round trip, and raw-target tampering rejection without Node globals.
Run `node test/spaces-alignment/scenarios/request-proof-foundation.browser.mjs`.
It reuses installed Playwright and Vite without application plugins or polyfills.
This establishes Chromium execution, not every browser or Rust compatibility.
Public client/operator/alignment docs reflect this foundation status. Parent design
document updates are a reviewable candidate patch only; the parent is unchanged.
Shared Redis probing, production transport adapters, Rust vectors, mutation,
independent review and AiaB remain outstanding. No dependency versions change.

Raw ingress preservation must be proven before enforcement. Plan 014 owns the
`cnf.jkt` to `cnf.kid` migration; this foundation does not implement it. Before
production integration, review the resolver contract below. Before replay
integration, establish explicit shared-store failover and no-premature-eviction
guarantees. Do not claim unconditional at-most-once acceptance after lost state.

Plan 019 completion still requires pure helpers, focused tests, synthetic probing,
scoped mutation over changed source and only touched related tests, and independent
Terra Standards/Spec reviews. Full source-bound AtmosphereInABox runs belong at
plan end, not this document batch. Its clean-committed-SHA requirement needs
explicit commit authorization; do not fabricate a receipt from an uncommitted
candidate. Later production-route tests must prove actual enforcement rather than
reuse the synthetic foundation probe as deployment evidence.
