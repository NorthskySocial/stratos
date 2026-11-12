# Mutation Testing

A smoke detector that never beeps tells you nothing until you hold a match
under it. Mutation testing is the match. It breaks the code on purpose, in
small ways, and checks that a test notices.

Stratos uses [StrykerJS](https://stryker-mutator.io/) for this. Each small
break is a mutant. A mutant that no test catches has survived. A survivor
means a behaviour changed and the test suite stayed green.

## Why it exists

Mutation testing is the main gate for trusting AI-generated code and the tests
written with it. A green test suite is necessary and not sufficient. A test
can pass while asserting nothing.

It is a local step. CI does not run it. Whoever makes a change that adds or
runs tests runs mutation testing on that change.

## Where it is configured

Each TypeScript package has a `mutation` script (`stryker run`) and its own
`stryker.config.json`:

- `stratos-core/stryker.config.json`
- `stratos-service/stryker.config.json`
- `stratos-client/stryker.config.json`
- `stratos-browser/stryker.config.json`
- `stratos-indexer/stryker.config.json`
- `stratos-feedgen/stryker.config.json`
- `webapp/stryker.config.json`

Each config uses the vitest runner with the package's `vitest.config.ts`. The
`mutate` list names the source globs to mutate. In `stratos-service` it covers
authentication, enrollment, boundaries, hydration, sync, signing, space
credentials, OAuth handlers, and record handlers.

The Rust feed generator is not covered. These instructions apply to
TypeScript source only.

## Run it on the files you changed

Do not run a whole package. A full `stratos-service` run is more than 5,600
mutants and takes about three hours. It mostly reports on code you did not
touch.

Scope the run to your changed files with one `--mutate` flag:

```bash
cd stratos-service
rm -f reports/stryker-incremental.json
pnpm exec stryker run --mutate 'src/a/changed.ts,src/b/changed.ts' \
  > /tmp/mut.log 2>&1
```

Let the command return its own exit status. Do not append `; echo exit=$?`.
That reports the status of `echo`, which always succeeds.

## Four traps

A scoped run can report a healthy score for the wrong files. Check each of
these.

1. **Repeated `--mutate` flags do not add up.** The last flag wins.
   `--mutate 'a.ts' --mutate 'b.ts'` mutates only `b.ts`. Use one flag with a
   comma-separated list. Then confirm that every expected file name appears in
   the results table.
2. **`--mutate` replaces the configured list, exclusions included.** The
   config excludes `src/**/index.ts` and `src/**/*.d.ts`. A command-line list
   drops those exclusions. Name only the source files you mean to mutate.
3. **Stryker rewrites your sources while it runs.** The configs set
   `inPlace: true`. Never pipe the output into `head` or `grep`. A closed pipe
   kills the run and leaves mutated files on disk. Redirect to a file.
4. **A stale incremental file serves old results.** The configs set
   `incremental: true`. Delete `<package>/reports/stryker-incremental.json`
   before a run with a different scope.

If a run is interrupted, check `git status` for mutated source files before
you continue.

## Reading the report

Each run writes two reports:

- **clear-text**: a terminal summary that lists surviving mutants with file
  and line. With the command above it is in `/tmp/mut.log`.
- **html**: a browsable report at `reports/mutation/mutation.html`. It shows
  each mutant inline with its status: killed, survived, no coverage, or
  timeout.

Judge survivors on the lines your change touched. A file that enters the
`mutate` scope for the first time also shows its older survivors. Those are not
yours to fix, and they are not a reason to skip the gate.

## What to do with a survivor

- **Strengthen the test.** A survivor in changed code means the test does not
  pin that behaviour down.
- **Or improve the code.** When a mutant cannot be killed because the branch
  is unreachable, delete the branch.
- **Never lower a threshold** to make a run pass.

## New files

Check whether the `mutate` globs in `stryker.config.json` already cover a file
you added. A broad glob such as `src/features/enrollment/**/*.ts` usually does.
Add an entry only when none matches.

## Thresholds

Each `stryker.config.json` sets the same values:

| Threshold | Value | Meaning                                          |
| --------- | ----- | ------------------------------------------------ |
| `high`    | 80    | At or above this score the result is good        |
| `low`     | 60    | Below this score the result is a concern         |
| `break`   | 60    | Below this score the run fails with an exit code |

The package-wide score of `stratos-service` is currently below its `break`
value. A failing full-package run is therefore not evidence that your change
broke anything. Judge the scoped run.

## Full runs

Full runs exist for a deliberate sweep, not for daily work:

```bash
# Every package that has a mutation script
pnpm mutation

# One package
pnpm --filter @northskysocial/stratos-core mutation
pnpm --filter @northskysocial/stratos-service mutation

# Through nx, from the workspace root
nx run stratos:mutation
```
