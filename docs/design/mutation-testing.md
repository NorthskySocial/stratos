# Mutation Testing

Stratos uses [StrykerJS](https://stryker-mutator.io/) to validate that our tests actually catch
regressions. Mutation testing introduces small faults ("mutants") into the source and checks whether
the test suite fails. A surviving mutant means a code path changed behaviour without any test
noticing — a gap in coverage that line coverage alone cannot reveal.

It is configured for `stratos-core` and `stratos-service`, scoped to the auth, enrollment,
hydration, and sync modules.

## Why it exists

Mutation testing is the primary gate for trusting AI-generated code and the tests that accompany it.
A green test suite is necessary but not sufficient: it can pass while asserting nothing meaningful.
Mutation testing forces tests to pin down behaviour.

**It is a local, agent-run verification step — it is not enforced in CI.** Whoever makes a change
that adds or runs tests is responsible for running it.

## When to run it

Run mutation testing whenever a change requires adding or running tests to validate behaviour:

1. Run it on the modules you changed and confirm surviving mutants are addressed (or explicitly
   justified).
2. If you introduced new source files/modules, extend the `mutate` globs in the relevant
   `stryker.config.json` so the new code is actually analysed.
3. Treat surviving mutants in changed code as a signal that the tests are weak — strengthen the
   tests rather than lowering the thresholds.

## Running

From the repo root:

```bash
# Both configured packages
pnpm mutation

# A single package
pnpm --filter @northskysocial/stratos-core mutation
pnpm --filter @northskysocial/stratos-service mutation

# Via nx
nx run stratos:mutation
```

## Scoping a run to one module

Mutation runs are slow, so scope them to what you changed. Pass a `--mutate` glob to override the
config for a single run:

```bash
pnpm --filter @northskysocial/stratos-core exec \
  stryker run --mutate "src/enrollment/**/*.ts"
```

Runs are incremental (`incremental: true`), so after the first full run subsequent runs only
re-test mutants affected by your changes.

## Reading the report

Each run emits:

- **clear-text** — a summary in the terminal listing surviving mutants with file and line.
- **html** — a browsable report at `reports/mutation/mutation.html`. Open it to see each mutant
  inline with its source and status (killed, survived, no coverage, timeout).

Focus on **Survived** and **No coverage** mutants in code you changed; each one is a behaviour your
tests do not pin down.

## Thresholds

Configured in each `stryker.config.json`:

| Threshold | Value | Meaning                                            |
| --------- | ----- | -------------------------------------------------- |
| `high`    | 80    | At/above this score the result is reported "good". |
| `low`     | 60    | Below this the result is reported as a concern.    |
| `break`   | 60    | A score below this fails the run (non-zero exit).  |

The `break` threshold causes a local run to fail for the targeted globs. Raise these values over
time as coverage improves; do not lower them to make a run pass.

## Configuration

- `stratos-core/stryker.config.json`
- `stratos-service/stryker.config.json`

Each uses the vitest test runner pointed at the package's `vitest.config.ts`. The `mutate` globs are
intentionally limited to the security-sensitive auth, enrollment, hydration, and sync modules. When
extending coverage to a new module, add its glob there.
