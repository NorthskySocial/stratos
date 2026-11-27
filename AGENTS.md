# Stratos Project - Copilot Instructions

## Project Overview

Stratos is a **standalone private permissioned data service** for ATProtocol. It provides
domain-scoped private data storage with boundary-based access control. Users enroll via OAuth, their
enrollment is published to their PDS, and downstream indexers or AppViews discover that enrollment
through `zone.stratos.actor.enrollment` records.

## Architecture

### Key Concepts

| Concept            | Description                                                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Boundary**       | Access control scope (e.g., "engineering", "leadership"). Records have boundaries; viewers must share at least one.                                                                             |
| **Enrollment**     | User registration with a Stratos service via OAuth. Creates profile record on user's PDS.                                                                                                       |
| **Hydration**      | Clients or AppViews fetch Stratos-backed records and filter by viewer boundaries.                                                                                                               |
| **Profile Record** | `zone.stratos.actor.enrollment` - published to user's PDS for endpoint discovery and enrollment verification.                                                                                   |
| **Sync Stream**    | `zone.stratos.sync.subscribeRecords` - WebSocket stream with service-level enrollment and actor-level record modes, consumed by `stratos-feedgen-ng`.                                           |
| **Custody**        | Which party holds a user's records. `stratos` = Stratos hosts the repo and signs. `pds` = the user's own spaces-capable PDS hosts the repo and the user signs.                                  |
| **Space**          | An upstream permissioned-data container (proposal 0016). Stratos is always the space **authority**. For a `pds`-custody user it is only the authority, and the user's PDS is the repo **host**. |

### Mixed-mode custody

Stratos supports two custody classes at once. Read the class before you change
any write, sync, or boundary code.

| User's PDS     | Custody   | Repo host          | Who signs                    |
| -------------- | --------- | ------------------ | ---------------------------- |
| non-spaces     | `stratos` | Stratos            | Stratos, per-actor P-256 key |
| spaces-capable | `pds`     | the user's own PDS | the user                     |

Three rules follow. They are load-bearing. The first two rest on an August
probe of an earlier upstream alpha PDS, not on the spec: an account wrote into
a space whose authority could not be resolved, and the write succeeded. The
repository keeps the probe's commit message, not its output or the build it ran
against, and the probe's first version did not ensure the writer was a second,
unrelated account. At the November reference revision,
`com.atproto.space.createRecord` checks the caller's own repo and OAuth grant,
not the space authority or membership. No November host has been asked. The
third is the URI grammar of the combined URI syntax proposal that Stratos
targets. The upstream packages at the pinned release still use the earlier
spelling, and no host has accepted the new one; Stratos's own parsers and a
hand-written corpus check it.

1. **Never trust a boundary on a `pds`-custody record.** A repo host does not
   authorize writes against the space authority. A repo host may accept records written into a Stratos-owned space URI in the writer’s own repo. A boundary on such a record is
   a user-supplied claim. Always re-derive the boundary from Stratos enrollment
   state. The Rust feed generator reads these records in
   `stratos-feedgen-ng/src/pds_space_sync.rs`, and its store writes each post
   under the member's boundary, never the record's
   (`stratos-feedgen-ng/src/store/space_verification.rs`).
2. **Membership decides whose repo the syncer reads.** It is the only write-side
   control that exists. Removing a member does not stop them writing; it stops us
   reading. The syncer iterates the member list. Do not add writer discovery.
3. **A space record URI has six parts after `at:space/` and starts with the authority**:
   `at:space/{authorityDid}/{type}/{skey}/{authorDid}/{collection}/{rkey}`.
   Nothing recognises the legacy `at://{authorityDid}/space/...` spelling.
   A custody record keeps the familiar `at://{authorDid}/{collection}/{rkey}`.
   Code that takes the first part as the author is wrong for a space record.

`zone.stratos.space.feed` must stay published as a `com.atproto.lexicon.schema`
record with `defs.main.type` of `space`. A user's PDS resolves that NSID before
it grants a space scope. If the record is missing, authorization fails with
`invalid_scope`, and nothing in the Stratos logs explains why.

The interop checklist is `test/spaces-alignment/november/INTEROP.md`. Work through
it when you change credentials, host discovery, or ingest.

### Packages and detailed guidance

- [Core domain and ports](stratos-core/README.md)
- [Service, adapters, storage and authorization](stratos-service/README.md)
- [Client library](stratos-client/README.md)
- [Rust feed generator](stratos-feedgen-ng/README.md)
- [Lexicons and code generation](lexicons/README.md)
- [Testing and mutation testing](test/README.md)

## Design and coding conventions

Keep features cohesive: domain rules and ports belong in core; adapters and HTTP handlers belong in the service. The Rust feed generator separates domain rules from network and storage adapters. Use simple designs, descriptive names, explanatory variables and explicit boundary conditions. Keep configuration at composition boundaries. Avoid boolean flag arguments; expose separate operations instead.

Use strict TypeScript, named exports, explicit type exports, interfaces for public APIs, and `unknown` instead of `any`. Use kebab-case filenames, PascalCase types and interfaces, camelCase functions and SCREAMING_SNAKE_CASE constants. Use domain-specific errors extending `StratosError`. Comment why, not what; avoid commented-out code, redundant JSDoc, divider comments and TODOs without issue references.

### Two compilers

The workspace installs two TypeScript compilers. `package.json` cannot hold
comments, so the arrangement is recorded here.

| Binary | Compiler                                      | Used by              |
| ------ | --------------------------------------------- | -------------------- |
| `tsc`  | TypeScript 7.0 (Go), the `typescript-7` alias | `build`, `typecheck` |
| `tsc6` | TypeScript 6.0, the `typescript` alias        | typescript-eslint    |

typescript-eslint does not support the TypeScript 7 API. The `typescript` name
therefore stays aliased to `@typescript/typescript6`, which installs its binary
as `tsc6`. The names do not collide, so a plain `tsc` in a script is TypeScript 7.

The type-aware ESLint rules read TypeScript 6 semantics while the build reads
TypeScript 7 semantics. The two compilers can narrow a type differently. Trust
`pnpm run typecheck` when a lint result and a build result disagree.

Remove the `typescript` alias and use one compiler when typescript-eslint
supports TypeScript 7.

## Testing

Run `pnpm exec vitest run` for TypeScript tests. For Rust feedgen changes, run `cargo fmt --all --check`, `cargo clippy --locked -p stratos-feedgen-ng --all-targets -- -D warnings`, and `cargo test --locked -p stratos-feedgen-ng`. Use `test/feedgen-harness/` for privacy, recovery and parity contracts. When creating mock data, use names and places from popular 90s anime. For behavioral TypeScript changes requiring tests, follow the scoped mutation-testing gate in [test/README.md](test/README.md#mutation-testing-for-typescript-changes).

## Commit and Pull Request Guidelines

**Do not copy the tone of the existing git history.** An agent wrote much of it.
It is not a sample of the maintainer's voice.

Write in the maintainer's voice, inside the Simplified Technical English rules.
The two fit together like this.

The rules, which are not negotiable: imperative mood, present tense, one idea per
sentence, 20 words or fewer per sentence, the same word for the same thing every
time, no idiom and no metaphor.

The voice, which comes from how the maintainer writes:

- Say the decision flatly. "Error ordering is fine for beta." Not "it may be
  worth considering whether error ordering is acceptable".
- Give the reason in the same breath, and keep it to one short sentence. State a
  general principle when there is one.
- Use "we" for a product or team decision. Use the imperative for an instruction.
- Use plain domain words: boundary, custody, spaces PDS, feedgen, sync, enroll,
  flow. Do not reach for a longer word.
- No hedging, no pleasantries, no emphasis markup, no filler.
- Name the concrete thing that changed. Do not restate the diff.

Mechanics:

- Subject line: sentence case. Use a `fix:`, `chore:`, or `ci:` prefix for
  infrastructure. Use a plain imperative for a behaviour change.
- Add a body only when the reason is not evident from the subject.
- **Do not add a `Co-Authored-By` trailer.**

Stack dependent pull requests with the `gh-stack` extension. Open the stack once
the work is complete, not one PR at a time.

---

## Logging Guidelines

Use structured logging: `logger.level({ contextObj }, 'message')`. Log request completion with
duration, business events, and failures with IDs. Never log tokens, passwords, PII, or record
contents. Don't log per-iteration in loops.

---

## References

- [Hydration Architecture](docs/architecture/hydration.md)
- [Operator Guide](docs/operator/overview.md)
- [Client Integration Guide](stratos-client/README.md)
- [Client Guide](docs/client/getting-started.md)
- [ATProto Documentation](https://atproto.com/docs)

### External Repository Research

- `github.com/bluesky-social/atproto` — AT Protocol reference implementation, lexicons, XRPC
- `github.com/bluesky-social/social-app` — Bluesky app patterns, API usage examples
- `github.com/bluesky-social/proposals` — AT Protocol proposals and specifications
- `github.com/DavidBuchanan314/atmst` — MST implementation in Python (@atcute/mst is derived from
  this)
