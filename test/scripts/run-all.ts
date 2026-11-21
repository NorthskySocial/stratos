#!/usr/bin/env -S deno run -A
// Run all E2E test phases sequentially.
// Usage: deno run -A test/scripts/run-all.ts [--postgres] [--appview] [--spaces-pds]
//
// Options:
//   --postgres   Use PostgreSQL storage backend instead of SQLite
//   --appview    Bring up the AppView stack and run the service-auth subscription
//                feed phase. Implies the PostgreSQL backend.
//   --spaces-pds Also start the pinned spaces PDS image, create its fixture
//                accounts and run the two PDS-custody phases. That image
//                refuses the current space URI spelling, so those phases
//                cannot pass against it.
//
import {
  fail,
  failureCount,
  finish,
  info,
  pass,
  section,
  skip,
} from './lib/log.ts'
import {
  exportSpacesPdsChoice,
  parseRunOptions,
  type Phase,
  phasesFor,
} from './lib/phases.ts'

const SCRIPTS_DIR = new URL('.', import.meta.url).pathname

// Parse command line args
const runOptions = parseRunOptions(Deno.args)
const appviewMode = runOptions.appview
const preserve = Deno.args.includes('--preserve')
const postgresMode = appviewMode || Deno.args.includes('--postgres')

if (postgresMode) {
  Deno.env.set('STRATOS_E2E_BACKEND', 'postgres')
}
if (appviewMode) {
  Deno.env.set('STRATOS_E2E_APPVIEW', 'true')
}
exportSpacesPdsChoice(runOptions)

const phases = phasesFor(runOptions)

async function runPhase(phase: Phase): Promise<void> {
  section(`▶ ${phase.name}`)

  const cmd = new Deno.Command('deno', {
    args: ['run', '-A', `${SCRIPTS_DIR}${phase.script}`],
    stdout: 'inherit',
    stderr: 'inherit',
  })

  const result = await cmd.output()

  if (result.success) {
    pass(`Phase "${phase.name}" completed`)
  } else {
    fail(`Phase "${phase.name}" failed (exit code ${result.code})`)
  }
}

async function run() {
  console.log('\n╔══════════════════════════════════════════╗')
  console.log('║   Stratos E2E Test Suite                 ║')
  console.log('╚══════════════════════════════════════════╝\n')

  if (postgresMode) {
    info('Running with POSTGRESQL storage backend')
  }
  if (appviewMode) {
    info('Running AppView service-auth subscription E2E (Stratos + AppView)')
  }

  for (const phase of phases) {
    if (phase.name === 'Teardown' && preserve) {
      skip(`Phase "${phase.name}"`, '--preserve flag')
      continue
    }
    if (failureCount() > 0 && !phase.always) {
      skip(`Phase "${phase.name}"`, 'prior phase failed')
      continue
    }
    if (failureCount() > 0) {
      // Keep test-data (screenshots, logs) for debugging a failed run.
      // Teardown reads this and skips the test-data removal.
      Deno.env.set('STRATOS_E2E_KEEP_ARTIFACTS', 'true')
    }

    await runPhase(phase)
  }

  console.log('\n╔══════════════════════════════════════════╗')
  console.log('║   Final Summary                          ║')
  console.log('╚══════════════════════════════════════════╝')
  finish()
}

run()
