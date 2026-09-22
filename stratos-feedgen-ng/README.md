# Stratos Feedgen NG

Feedgen NG is the Rust implementation of Stratos Feedgen. It maintains an
encrypted, bounded local projection, serves authenticated boundary-scoped
feeds, and stays closed until the authority stream has reconciled.

It also refreshes authority-derived PDS-space membership and synchronizes only
those targets. Pages are staged locally and become visible only after their
terminal commit verifies. Requests use `STRATOS_SERVICE_URL` for network
reachability; `STRATOS_PUBLIC_URL`, when set, is used solely as the public DPoP
proof target.

Run the current contract tests with:

```sh
cargo test --manifest-path stratos-feedgen-ng/Cargo.toml
```

For a process, set `FEEDGEN_SERVICE_DID`, `FEEDGEN_PUBLIC_URL`,
`FEEDGEN_PUBLIC_KEY_MULTIBASE`, `FEEDGEN_SIGNING_KEY`,
`STRATOS_SERVICE_URL`, and `STRATOS_SERVICE_DID`. Set `STRATOS_PUBLIC_URL`
when the authority's public endpoint differs from its private service URL.
