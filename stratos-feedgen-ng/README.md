# Stratos Feedgen NG

This is the beginning of the Rust Feedgen migration. It currently implements
only the fail-closed readiness gate and the public discovery/health HTTP
surface. It has no post store, feed XRPC handler, Stratos subscription, blob
cache, credential verification, or production deployment path.

That boundary is deliberate: Rust must consume a sanitized conformance corpus
and the approved Canadian storage/key lifecycle before it can serve private
feed data. The existing TypeScript Feedgen remains authoritative.

Run the current contract tests with:

```sh
cargo test --manifest-path stratos-feedgen-ng/Cargo.toml
```

For a local discovery-only process, set `FEEDGEN_SERVICE_DID`,
`FEEDGEN_PUBLIC_URL`, and `FEEDGEN_PUBLIC_KEY_MULTIBASE`; `/health` remains
`503` until a future, verified stream/reconciliation implementation opens it.
