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

The report directory must not exist. The runner exports the pinned AiaB source and the exact candidate into a unique private directory. It overlays only reviewed templates from this checkout, creates one ordinary PDS with two synthetic users, builds the reference PDS from source only for a suite that needs it (see Reference PDS suites), runs the selected suite, and removes its unique Compose project and volumes. It never modifies the supplied AiaB checkout. The output `receipt.json` contains source pins, image ID, evidence mode, review references when present, commands, and assertion counts. Archive files and image metadata stay private with the report.
Each run uses a disposable private Docker client config and clears inherited
`COMPOSE_*` overrides. Browser and cleanup commands select the generated
`compose.yaml` explicitly. The successful receipt records a passed cleanup.
On failure, `failure.json` names the failed phase, completed phases, and cleanup
status without copying child stderr, account passwords, or environment values.
If cleanup fails, the gate fails and preserves the private generated Compose
file at the recorded recovery path rather than deleting the only recovery config.

The AiaB checkout must be clean at v0.7.2 (`6e9a39a94c102e4d42fa5868bd90b881bb5be695`). If absent, the runner clones, fetches, and checks out that exact SHA. Repo-owned `atmosphere/` assets are installed only in the disposable export. The baseline uses AiaB's digest-pinned `pds-space1`, alongside ordinary `pds1`; it does not build a primary PDS. The suites that need the reference PDS build it as a separate image and the receipt records, and the runner cleans up, that image.

The integration is one generic application with native Compose build arguments. Its identity Dockerfile/script and browser Dockerfile originated at historical AiaB commit `ecf52fac4abaa681717f2ed2ce2afc2253d1a366`; the stack and browser driver incorporate the reviewed Stratos templates. The Stratos space lexicon fixture and authority definition are retained as readable assets. The reference PDS template is `templates/reference-pds.yaml` with `templates/reference-pds.definition.json`.

The runner writes each AiaB phase and command to standard output. It prints bounded, sanitized output for install, create, check, the local tools-image prebuild, and up, including a failed command's stdout and stderr. Before `up`, it builds AiaB's local `runner` image because dependent Dockerfiles use it as their base image. After an `up` failure, it replays only the generated Compose build with plain progress and reports Compose status. Seed command output remains suppressed because it can contain generated account credentials. The receipt or failure artifact remains the only uploaded report and does not contain command output.

The pinned AiaB creates `atmosbox.test` for the private PLC and PDS handles.
Its explicit application routes also serve Stratos and Clubhouse OAuth at
`atmosbox.internal`: the alpha PDS accepts `.test` handles but rejects `.test`
OAuth client IDs. The runner checks the primary domain before starting the
stack. Private transport grants name only these sandbox origins, and
`STRATOS_DEV_MODE` remains false. The lexicon is published by AiaB's
`schemas.authority.atmosbox.test` account, which the baseline queries through
the private authority PDS.

## Suites

| Suite                                                                                                               | Needs                                                                               | Runs today                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ordinary-custody`                                                                                                  | The ordinary PDS only; runs without the baseline before it                          | Nothing blocks it. No run is recorded                                                                                  |
| `baseline`                                                                                                          | A spaces PDS that accepts the `at:space/` spelling and a declaration without `name` | No. The pinned spaces PDS refuses both; a run is a diagnostic                                                          |
| `delegation-transport`, `credential-lifetime`, `client-custody`, `space-delete`, `feed-errors`, `service-admission` | The baseline's stack; the runner runs the baseline first                            | No, for the baseline's reason                                                                                          |
| `standard-credential-transport`, `rust-production-interop`                                                          | The baseline's stack and the reference PDS built from the November manifest         | No. The manifest is not ready, so the runner refuses to build the reference PDS                                        |
| `november-interop`                                                                                                  | A ready November manifest and `--pds-image-digest`                                  | Prepared, never run: it refuses without the option naming a PDS image digest and again while the manifest is not ready |

Nothing here has run against a host that accepts the new spelling. The person
who runs a suite on the day one exists follows `november/INTEROP.md`.

## Baseline and ordinary custody

The baseline needs a spaces PDS that accepts the `at:space/` URI spelling and a
space-type declaration without `name`. The PDS images the sandbox pins are
older: they refuse the new spelling and require `name` in a declaration, so on
this branch the baseline cannot pass against them. Eight of its ten assertions
touch PDS custody. Do not read a failed baseline run as a regression in the
driver. The run prints each assertion name as the step that proves it ends, and
`failure.json` lists the names reached (`assertionsReached`, by suite).

The sandbox declaration fixture carries `name` and `title` with the same text
and the same collections as `lexicons-spaces/zone/stratos/space/feed.json`,
because those pinned hosts refuse a declaration without `name`.

`ordinary-custody` is the one suite the runner runs without the baseline before
it (`STANDALONE_SUITE_IDS` in `rules.ts`). It signs one user of the ordinary PDS
(`pds1`) in through the enrollment flow, posts through the service as a
Stratos-custody member, requires that post in the feed from the Rust feed
generator, checks that a user of another boundary gets an empty or refused feed,
then deletes the post and requires it gone. Its receipt says it covers ordinary
custody only. It does not replace the baseline and shares no assertion name
with it. The sandbox still creates the spaces PDS and Clubhouse resolves handles
through it, so the stack must start, but no account, scope or record of that PDS
is part of the journey.

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir /home/evelyn/git/northsky/ops/sandbox/atmosphereinabox \
  --source "$(git rev-parse --show-toplevel)" \
  --suite ordinary-custody \
  --review-receipt /tmp/private-standards-and-spec.json \
  --report-dir /tmp/new-ordinary-custody-report
```

Use `--suite baseline` for the baseline diagnostic. Both runs need rootless
Docker, a clean candidate checkout at a committed SHA, a new report directory,
and either the two-review receipt or GitHub Actions with `--ci-evidence`.

## Reference PDS suites

`standard-credential-transport`, `rust-production-interop` and `november-interop`
need a reference PDS that the runner builds from the upstream repository root
`Dockerfile`. The revision comes from `november/sources.json`
(`reference.revision`) and the file hashes from its `referenceHost.sha256`. The
runner refuses to build while the manifest does not record cutover evidence,
while either hash is empty, and when the revision is on the manifest's
legacy-only list or is the revision the October `sources.json` pins. The builder
checks the Dockerfile and lockfile hashes before pulling base images. The build
receipt records the immutable image ID; source identity does not attest a
running image.

`standard-credential-transport` exchanges and presents credentials in the
tagged HTTP-signature form against that host and the service. `rust-production-interop`
repeats the real OAuth, publication and Rust feed delivery checks with a second
owner on the same host, then drives an in-memory Rust probe, built in the
browser image from the pinned Rust builder and linked to the feed generator
library, through the production credential issuer and manager with a ten-second
credential lifetime. Both require the exact post URI and text in a successful
feed HTTP response, not just a rendered page. Neither is certified until a run
passes on a host that accepts the new spelling.

`november-interop` is prepared and never runs by default. The runner starts it
only with `--pds-image-digest sha256:<digest>`, only when the manifest records
complete cutover evidence including that digest, and fails if the built image
differs. Its assertions are the journeys in `november/interop-journeys.ts`, each
naming the acceptance row it closes. It has no driver for some journeys yet. The
workflow that runs on every pull request does not name it.

`november/assertion-manifest.json` maps every assertion of every suite that
existed when the series began to `retained`, `renamed`, `superseded` or
`uncovered`. `uncovered` means no current test proves it and only a journey of
the prepared suite carries it; `november/INTEROP.md` lists those. Every named
test carries a `proves` sentence that says what its body establishes.
`november/assertion-manifest.test.ts` fails when an assertion has no entry, a
named test does not exist or has no `proves` sentence, or an uncovered entry
names a test. Whether a named test proves the same thing as the assertion it
replaces is a reviewer's judgement; the test cannot check it.

## Running the other suites

Run `delegation-transport`, `credential-lifetime`, `client-custody`,
`space-delete`, `feed-errors`, `standard-credential-transport`,
`rust-production-interop` and `baseline` as separate sandbox runs. Each run
has fresh accounts and its own new report directory. Do not combine their
shared Motoko fixtures after a removal or OAuth revocation. Unit-test receipts
are not runtime acceptance, and predecessor receipts do not certify this
combined candidate.

## Suite API

Each tracked `scenarios/<suite>.ts` exports `suite: ScenarioSuite` with `id`, nonempty `requiredAssertions`, and an async `run(context)` returning one result for each named assertion. Import `ScenarioSuite` from `../rules.js`. The runner discovers modules from the candidate checkout and runs `baseline` before any additional suite, except a standalone suite named in `rules.ts`. A missing, skipped, failed, or duplicate assertion fails the gate. Add a new suite in its own scenario module. Suites that need the reference PDS must be named in the runner's
`referencePdsSuites` set; the runner then provisions that PDS and its explicit
identity origins, and records and cleans up its image. A suite that must never
run by default is also named in `PREPARED_SUITE_IDS`.

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
