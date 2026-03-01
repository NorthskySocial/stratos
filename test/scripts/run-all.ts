#!/usr/bin/env -S deno run -A
// Run all E2E test phases sequentially.
// Usage: deno run -A test/scripts/run-all.ts [--direct]
//
// Options:
//   --direct Bypass OAuth and enroll users directly in the database
//
// Phases:
//   1. setup — create PDS accounts, start Stratos
//   2. enrollment — OAuth enrollment via Playwright (or direct DB enrollment with --direct)
//   3. boundaries — configure per-user boundaries
//   4. posts — post CRUD + boundary access control
//   5. teardown — stop Stratos, clean up

import { section, info, pass, fail, summary } from './lib/log.ts'

const SCRIPTS_DIR = new URL('.', import.meta.url).pathname

// Parse command line args
const directMode = Deno.args.includes('--direct')
const preserve = Deno.args.includes('--preserve')

interface Phase {
  name: string
  script: string
  /** If true, always run (e.g. teardown) even after prior failures */
  always?: boolean
}

const phases: Phase[] = [
  { name: 'Ngrok', script: 'ngrok-setup.ts' },
  { name: 'Setup', script: 'setup.ts' },
  directMode
    ? { name: 'Direct Enrollment', script: 'direct-enroll.ts' }
    : { name: 'OAuth Enrollment', script: 'test-enrollment.ts' },
  { name: 'Auto-Enrollment', script: 'test-auto-enrollment.ts' },
  { name: 'OAuth Login: Invalid Password', script: 'test-auth-failures.ts' },
  { name: 'Configure Boundaries', script: 'configure-boundaries.ts' },
  { name: 'Post CRUD & Boundaries', script: 'test-posts.ts' },
  { name: 'Teardown', script: 'teardown.ts', always: true },
]

async function runPhase(phase: Phase): Promise<boolean> {
  section(`▶ ${phase.name}`)

  const cmd = new Deno.Command('deno', {
    args: ['run', '-A', `${SCRIPTS_DIR}${phase.script}`],
    stdout: 'inherit',
    stderr: 'inherit',
  })

  const result = await cmd.output()

  if (result.success) {
    pass(`Phase "${phase.name}" completed`)
    return true
  } else {
    fail(`Phase "${phase.name}" failed (exit code ${result.code})`)
    return false
  }
}

async function run() {
  console.log('\n╔══════════════════════════════════════════╗')
  console.log('║   Stratos E2E Test Suite                 ║')
  console.log('╚══════════════════════════════════════════╝\n')

  if (directMode) {
    info('Running in DIRECT MODE (bypassing OAuth)')
  }

  let phasesRun = 0
  let phasesPassed = 0
  let hasFailed = false

  for (const phase of phases) {
    if (phase.name === 'Teardown' && preserve) {
      info('Skipping teardown phase due to --preserve flag')
      continue
    }
    if (hasFailed && !phase.always) {
      info(`Skipping "${phase.name}" due to prior failure`)
      continue
    }

    phasesRun++
    const ok = await runPhase(phase)
    if (ok) {
      phasesPassed++
    } else {
      hasFailed = true
    }
  }

  console.log('\n╔══════════════════════════════════════════╗')
  console.log('║   Final Summary                          ║')
  console.log('╚══════════════════════════════════════════╝')
  summary(phasesPassed, phasesRun - phasesPassed)

  Deno.exit(hasFailed ? 1 : 0)
}

run()
