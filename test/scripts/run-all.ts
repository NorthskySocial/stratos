#!/usr/bin/env -S deno run -A
// Run all E2E test phases sequentially.
// Usage: deno run -A test/scripts/run-all.ts [--postgres] [--appview]
//
// Options:
//   --postgres Use PostgreSQL storage backend instead of SQLite
//   --appview  Bring up the AppView stack and run the service-auth subscription
//              feed phase. Implies the PostgreSQL backend.
//
// Phases:
//   1. setup — create PDS accounts, start Stratos
//   2. enrollment — OAuth enrollment via Playwright
//   3. boundaries — configure per-user boundaries via the admin API
//   4. posts — post CRUD + boundary access control
//   4b. dpop — record CRUD through the production DPoP auth path
//   4c. blobs — blob upload and boundary-scoped getBlob access
//   4d. spaces — space credentials, credential-authed read/sync, revocation
//   4e. sync-stream — subscribeRecords consumer over the actor stream
//   4f. feedgen — describeFeed/getFeed against a live feedgen instance
//   5. teardown — stop Stratos, clean up

import {
  fail,
  failureCount,
  finish,
  info,
  pass,
  section,
  skip,
} from './lib/log.ts'

const SCRIPTS_DIR = new URL('.', import.meta.url).pathname

// Parse command line args
const appviewMode = Deno.args.includes('--appview')
const preserve = Deno.args.includes('--preserve')
const postgresMode = appviewMode || Deno.args.includes('--postgres')

if (postgresMode) {
  Deno.env.set('STRATOS_E2E_BACKEND', 'postgres')
}
if (appviewMode) {
  Deno.env.set('STRATOS_E2E_APPVIEW', 'true')
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
  { name: 'OAuth Enrollment', script: 'test-enrollment.ts' },
  { name: 'Multi-Enrollment Verify', script: 'test-multi-enrollment.ts' },
  { name: 'OAuth Login: Invalid Password', script: 'test-auth-failures.ts' },
  { name: 'Configure Boundaries', script: 'configure-boundaries.ts' },
  { name: 'Post CRUD & Boundaries', script: 'test-posts.ts' },
  { name: 'DPoP CRUD (production auth)', script: 'test-dpop-crud.ts' },
  { name: 'Blobs: Upload & Access', script: 'test-blobs.ts' },
  { name: 'Spaces: Credentials & Sync', script: 'test-spaces.ts' },
  { name: 'Sync Stream: subscribeRecords', script: 'test-sync-stream.ts' },
  { name: 'Feedgen: describeFeed & getFeed', script: 'test-feedgen.ts' },
  ...(appviewMode
    ? [{ name: 'AppView Service-Auth Feed', script: 'test-appview-feed.ts' }]
    : []),
  { name: 'Admin API: Boundary Management', script: 'test-admin-api.ts' },
  { name: 'Admin UI: SPA Smoke Tests', script: 'test-admin-ui.ts' },
  { name: 'Unenrollment', script: 'test-unenrollment.ts' },
  { name: 'Teardown', script: 'teardown.ts', always: true },
]

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

    await runPhase(phase)
  }

  console.log('\n╔══════════════════════════════════════════╗')
  console.log('║   Final Summary                          ║')
  console.log('╚══════════════════════════════════════════╝')
  finish()
}

run()
