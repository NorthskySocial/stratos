# Spaces alignment sandbox gate

Local delivery runs require the candidate commit to have separate Standards and
Spec approvals from an accepted reviewer model. CI runs use the regression-only
evidence mode described below. In both modes the runner requires a clean candidate
checkout. It rejects an earlier commit's review receipt, an unknown suite, reused
report paths, skipped assertions, and any failed child command.

## Review receipt

Save a private JSON file outside the checkout after the two reviews finish:

```json
{
  "candidateSha": "<full candidate commit SHA>",
  "baseSha": "<full reviewed branch-base commit SHA>",
  "reviews": {
    "standards": {
      "model": "gpt-6.1-sol",
      "verdict": "approved",
      "reviewedSha": "<same candidate SHA>",
      "sessionId": "<Standards review session ID>",
      "evidenceRef": "<private path or review ID>",
      "unresolvedBlockingFindings": 0
    },
    "spec": {
      "model": "gpt-6.1-sol",
      "verdict": "approved",
      "reviewedSha": "<same candidate SHA>",
      "sessionId": "<different Spec review session ID>",
      "evidenceRef": "<private path or review ID>",
      "unresolvedBlockingFindings": 0
    }
  }
}
```

Accepted reviewer models are GPT-5.6 Terra and GPT-6.1 Sol. Record the actual
model used for both independent reviews; do not substitute or relabel one.

Write this file from the actual reviewer results. The evidence references identify their full private findings. Do not copy those findings into this receipt. The runner checks the receipt shape and SHA pair; it cannot attest that a named session occurred. Keep the full reviewer records for audit.
The base must be an existing ancestor commit of the candidate; a reviewed
multi-commit branch uses its fixed base, not necessarily the candidate's
immediate parent.

For example, write the receipt to a new private file with `umask 077` and an editor, then run:

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir /home/evelyn/git/northsky/ops/sandbox/atmosphereinabox \
  --source "$(git rev-parse --show-toplevel)" \
  --suite baseline \
  --review-receipt /tmp/private-standards-and-spec.json \
  --report-dir /tmp/new-spaces-report
```

## CI evidence mode

`.github/workflows/e2e.yml` runs the same real sandbox on pull requests, pushes
to `main`, and manual dispatch. A CI run has no reviewer, so it uses
`--ci-evidence` instead of a review receipt. The flag is accepted only when
`GITHUB_ACTIONS=true` and is mutually exclusive with `--review-receipt`.

CI mode still requires a clean candidate and a valid ancestor base. It records
the base from `GITHUB_BASE_SHA` (the PR base SHA), or `HEAD^` on pushes and manual
runs. The receipt records `"evidenceMode": "ci"` and no `reviews` object.

CI evidence is regression evidence only. It cannot approve a PR, satisfy either
independent review, or be copied into a local review receipt. Local and delivery
runs must keep using the approved review receipt above.

The CI job uploads only `receipt.json` and, on failure, `failure.json`. It does
not upload sandbox state, Compose files, browser traces, logs, or account data.
The runner performs its own project-scoped cleanup. The job has a 60-minute
budget; do not extend it by weakening assertions or skipping the real sandbox.

The report directory must not exist. The runner exports the pinned AiaB source and the exact candidate into a unique private directory. It overlays only reviewed templates from this checkout, builds the pinned alpha PDS from source, creates one ordinary PDS with two synthetic users, runs the selected suite, and removes its unique Compose project and volumes. It never modifies the supplied AiaB checkout. The output `receipt.json` contains source pins, image ID, evidence mode, review references when present, commands, and assertion counts. Archive files and image metadata stay private with the report.
Each run uses a disposable private Docker client config and clears inherited
`COMPOSE_*` overrides. Browser and cleanup commands select the generated
`compose.yaml` explicitly. The successful receipt records a passed cleanup.
On failure, `failure.json` names the failed phase, completed phases, and cleanup
status without copying child stderr, account passwords, or environment values.
If cleanup fails, the gate fails and preserves the private generated Compose
file at the recorded recovery path rather than deleting the only recovery config.

The AiaB checkout must be clean at the SHA in `sources.json`. If the path is absent, the runner clones the pinned source into a disposable directory. The PDS source build always uses the pinned source revision. Do not replace it with an unproven public image digest.

The pinned AiaB creates `atmosbox.test` for the private PLC and PDS handles.
Its explicit application routes also serve Stratos and Clubhouse OAuth at
`atmosbox.internal`: the alpha PDS accepts `.test` handles but rejects `.test`
OAuth client IDs. The runner checks the primary domain before starting the
stack. Private transport grants name only these sandbox origins, and
`STRATOS_DEV_MODE` remains false. The lexicon is published by AiaB's
`schemas.authority.atmosbox.test` account, which the baseline queries through
the private authority PDS.

## October primary PDS

The primary spaces PDS is pinned to `79d6307e19908f3af406838ea0e5fae42847f182`.
The builder checks the upstream Dockerfile and lockfile hashes in `sources.json`
before pulling base images. Source identity does not attest a running image;
the build receipt records the immutable image ID separately.

Select `--suite rust-production-interop` for the mandatory ten-assertion baseline
followed by the same real OAuth, PDS publication, and Rust feed delivery checks
with Batou as a second owner on the same host. Both runs require the exact new
post URI and text in a successful feed HTTP response, not just a rendered page.
The suite also reuses the October OAuth driver with an in-memory Rust
probe built in the browser image from the pinned Rust builder and linked to the actual feedgen library. It requires Rust-signed exchange,
seeded-record reads for two owners, wrong-owner/key denial, identical-header
reuse, fresh-key renewal, and renewal denial after member removal. The probe
receives tokens through pipes, not command arguments or files. Browser OAuth
obtains delegation; Rust constructs every exchange and presentation signature.
The Rust suite configures a ten-second standard credential lifetime. Its probe also
uses the production HTTP issuer and credential manager with the existing sandbox
service identity, verifies cached-key reuse, waits for real expiry, and requires a
rotated key and a successful foreign-PDS read. No test clock or explicit cache
invalidation triggers this refresh. The runtime scheduler itself is unchanged. The separate `standard-credential-transport` suite retains its
TypeScript transport assertions. Neither suite is certified until its reviewed
sandbox run passes.

## Combined October cutover gate

Select `--suite october-interop` for the mandatory baseline followed by all 15
standard transport assertions and all 11 Rust assertions. Standard fixtures use
Faye and Edward; Rust fixtures use Rustfaye and Rustedward on the same October
host. The runner executes the ten mandatory baseline assertions once with Motoko.
The Rust ingestion check deliberately reuses that driver with Batou on the primary
PDS. This is a distinct second-owner scope, not another mandatory baseline receipt:
it requires Batou's own new post URI and text in the Rust feed response before
emitting `rust-second-owner-ingestion`. The combined suite then calls the separate
Rust signing probe, not the standalone Rust suite. Both combined and standalone
runs preserve the Batou check. These accounts are distinct because the standard
scenario removes its first member.

The combined suite first checks the default 600-second standard lifetime.
It then recreates only the disposable authority with a ten-second TTL and waits
for it to become healthy before the Rust expiry-refresh checks. It does not
weaken or replace either suite's assertions. Both source-built PDS identities,
the Rust probe build, private TLS, and cleanup remain required.

After exact-candidate independent Standards and Spec approvals, use a new
private receipt and a nonexistent report path for each run:

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir /home/evelyn/git/northsky/ops/sandbox/atmosphereinabox \
  --source "$(git rev-parse --show-toplevel)" \
  --suite october-interop \
  --review-receipt "$REVIEW_RECEIPT" \
  --report-dir "$NEW_REPORT_DIR"
```

Repeat `delegation-transport`, `credential-lifetime`, `client-custody`,
`space-delete`, `feed-errors`, and `baseline` as separate sandbox runs. Each run
has fresh accounts and its own new report directory. Do not combine their
shared Motoko fixtures after a removal or OAuth revocation. Delegated transport
and the foreign lifetime checks now use standard HTTP signatures against the
October primary PDS. The authority lifetime checks retain legacy compatibility
coverage. OAuth browser proofs are unchanged. Unit-test receipts are not runtime
acceptance, and predecessor receipts do not certify this combined candidate.

## Writer-sync design probe

Select `--suite writer-sync-contract` after exact-candidate independent review.
The mandatory baseline runs first. The suite provisions a disposable upstream
simplespace authority on the pinned October Spaces alpha PDS, using Faye and
Edward's real accounts. It checks actual commit `rev`, standard writer metadata,
short-page cursors, exclusive/opaque cursor behavior, repeated writers, equal and
older update idempotence, issuer/audience/future-revision denial, current write
policy removal, and Stratos's unsupported standard routes. This is real upstream
authority behavior, not Stratos standard-authority support. No fake authority
server substitutes for the PDS.

`writer-sync-contract.model.test.ts` separately exercises a synthetic reference
model for durable-processing crash boundaries, coalescing, ordering and bounded
backoff. Those tests do not prove actual storage atomicity, retry durability,
forwarding delivery, or generation fencing. The live probe explicitly delivers
the real signed head through real service authentication to avoid depending on
immediate automatic-notification timing. It does not certify the retry worker or
notification fanout. See the [design and follow-ups](../../docs/architecture/october-writer-sync-contract.md).
A reviewed clean-candidate runtime receipt remains required; unit tests alone
are not acceptance.

## Suite API

Each tracked `scenarios/<suite>.ts` exports `suite: ScenarioSuite` with `id`, nonempty `requiredAssertions`, and an async `run(context)` returning one result for each named assertion. Import `ScenarioSuite` from `../rules.js`. The runner discovers modules from the candidate checkout and runs `baseline` before any additional suite. A missing, skipped, failed, or duplicate assertion fails the gate. Add a new suite in its own scenario module. Suites that need the additional October
PDS must be named in the runner's October capability set. Both standard transport
and Rust production interoperability provision that PDS and its explicit identity
origins, and record and clean up both source-built PDS images.

Mock child processes only in runner unit tests. Acceptance requires the real private sandbox with production authorization gates and the complete baseline assertion receipt. A health check or zero-test filter is not acceptance evidence.

The baseline checks the authority's space lexicon record separately from the
alpha PDS grant: successful PDS-custody enrollment and a space-scoped PDS write
show that the PDS resolved the space type during OAuth and enforced the grant.
It also enrolls a second actor in `other` (plus reserved `all`), verifies that
actor lacks `general`, and queries the `general` feed through the PDS proxy to
require an empty or `BoundaryMismatch` result. The pinned alpha PDS cannot
strictly validate the Stratos-specific post record type: its record validator
only knows built-in lexicons. The blob fixture therefore uses the PDS's default
best-effort validation path, without disabling validation, and verifies that
the scoped record write and private blob retrieval both succeed.

## Credential revocation design probe

Select `--suite credential-revocation-contract` for the mandatory baseline and
13 assertions against the actual pinned October Spaces alpha PDS receiver and unchanged Stratos
unsupported route. This is not the future Stratos `credential-revocation`
enforcement suite. See [the revocation contract](../../docs/architecture/credential-revocation-contract.md#bounded-design-probe)
for every required assertion and exact typed denial.

The probe uses Faye's real OAuth/exchange fixture, two distinct grants, the
seeded record, and the existing disposable authority identity loader. A private
peer signs notifications without exporting its key. Grants and presentation
headers travel through pipes between Compose peers; only the final assertion
receipt reaches the report. Restart targets only `feedgen-e2e-pds-october` and
waits for its health check. Every Compose operation selects the generated file.
No new authority server, production endpoint, migration, or enforcement is added.

Cross-space isolation revokes B's ID in `other` and reads `general`. Duplicate
coverage observes successful retries and unchanged read outcomes, not database
row counts or expiry extension. Retained inactive-account behavior, a separately
controlled foreign issuer, concurrency, storage failure, and full 3,610-second
cleanup retention remain unverified future gates. The design probe neither
silently skips them nor claims complete Stratos enforcement coverage.

The clean-candidate and independent-review receipt gates still apply. Unit tests
and source inspection are not runtime acceptance, and no predecessor receipt
certifies a new candidate.
