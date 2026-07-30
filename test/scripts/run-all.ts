#!/usr/bin/env -S deno run -A
// Run all E2E test phases sequentially.
// Usage: deno run -A test/scripts/run-all.ts [--direct] [--postgres] [--appview]
//
// Options:
//   --direct   Bypass OAuth and enroll users directly in the database
//   --postgres Use PostgreSQL storage backend instead of SQLite
//   --appview  Bring up the AppView stack and run the service-auth subscription
//              feed phase. Implies --direct and the PostgreSQL backend.
//
// Phases:
//   1. setup — create PDS accounts, start Stratos
//   2. enrollment — OAuth enrollment via Playwright (or direct DB enrollment with --direct)
//   3. boundaries — configure per-user boundaries
//   4. posts — post CRUD + boundary access control
//   4b. spaces — space credentials, credential-authed read/sync, revocation
//   5. teardown — stop Stratos, clean up

import { fail, info, pass, section, summary } from './lib/log.ts'

const SCRIPTS_DIR = new URL('.', import.meta.url).pathname

// Parse command line args
const appviewMode = Deno.args.includes('--appview')
const directMode = appviewMode || Deno.args.includes('--direct')
const preserve = Deno.args.includes('--preserve')
const postgresMode = appviewMode || Deno.args.includes('--postgres')

if (postgresMode) {
  Deno.env.set('STRATOS_E2E_BACKEND', 'postgres')
}
if (appviewMode) {
  Deno.env.set('STRATOS_E2E_APPVIEW', 'true')
}
if (directMode) {
  // The admin-API phase needs a real OAuth login + a target with a live OAuth
  // session (for the PDS enrollment-record rewrite). Direct enrollment provides
  // neither, so the phase reads this flag and skips cleanly.
  Deno.env.set('STRATOS_E2E_DIRECT', 'true')
}

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
  { name: 'Multi-Enrollment Verify', script: 'test-multi-enrollment.ts' },
  { name: 'OAuth Login: Invalid Password', script: 'test-auth-failures.ts' },
  { name: 'Configure Boundaries', script: 'configure-boundaries.ts' },
  { name: 'Post CRUD & Boundaries', script: 'test-posts.ts' },
  { name: 'Spaces: Credentials & Sync', script: 'test-spaces.ts' },
  ...(appviewMode
    ? [{ name: 'AppView Service-Auth Feed', script: 'test-appview-feed.ts' }]
    : []),
  { name: 'Admin API: Boundary Management', script: 'test-admin-api.ts' },
  { name: 'Admin UI: SPA Smoke Tests', script: 'test-admin-ui.ts' },
  { name: 'Unenrollment', script: 'test-unenrollment.ts' },
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
  if (postgresMode) {
    info('Running with POSTGRESQL storage backend')
  }
  if (appviewMode) {
    info('Running AppView service-auth subscription E2E (Stratos + AppView)')
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
