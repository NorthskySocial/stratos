# Spaces alignment sandbox gate

Run this gate only after the candidate commit has separate Standards and Spec approvals from an accepted reviewer model. The runner requires a clean candidate checkout. It rejects an earlier commit's review receipt, an unknown suite, reused report paths, skipped assertions, and any failed child command.

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

The report directory must not exist. The runner exports the pinned AiaB source and the exact candidate into a unique private directory. It overlays only reviewed templates from this checkout, builds the pinned alpha PDS from source, creates one ordinary PDS with two synthetic users, runs the selected suite, and removes its unique Compose project and volumes. It never modifies the supplied AiaB checkout. The output `receipt.json` contains source pins, image ID, review references, commands, and assertion counts. Archive files and image metadata stay private with the report.
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
