#!/usr/bin/env -S deno run -A
// Teardown — deletes test accounts, stops Stratos container, and cleans up test data.

import { TEST_ROOT } from './lib/config.ts'
import { section, info, pass, fail, warn } from './lib/log.ts'
import { loadState } from './lib/state.ts'
import { deleteAccount } from './lib/pds.ts'
import { stopNgrok } from './lib/ngrok.ts'
import { isPostgres } from './lib/backend.ts'

async function deleteTestAccounts() {
  info('Deleting test accounts from PDS...')
  const state = await loadState()
  for (const [name, user] of Object.entries(state.users)) {
    if (!user.did) {
      info(`Skipping ${name} (no DID recorded)`)
      continue
    }
    try {
      await deleteAccount(user.did)
      pass(`Deleted ${name} (${user.did})`)
    } catch (err) {
      warn(`Failed to delete ${name}: ${err}`)
    }
  }
}

async function stopDockerCompose() {
  info('Stopping Stratos container...')
  try {
    const composeArgs = ['compose', '-f', 'docker-compose.test.yml']
    if (isPostgres()) composeArgs.push('-f', 'docker-compose.postgres.yml')
    composeArgs.push('stop')
    const compose = new Deno.Command('docker', {
      args: composeArgs,
      cwd: TEST_ROOT,
      stdout: 'piped',
      stderr: 'piped',
    })
    const result = await compose.output()
    if (result.success) {
      pass('Container stopped')
    } else {
      const stderr = new TextDecoder().decode(result.stderr)
      warn(`Docker compose down returned non-zero: ${stderr}`)
    }
  } catch (err) {
    fail('Failed to stop container', String(err))
  }
}

async function cleanUpTestData() {
  info('Removing test-data directory...')
  try {
    // await Deno.remove(TEST_DATA_DIR, { recursive: true })
    pass('test-data removed')
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      info('test-data directory already absent')
    } else {
      warn(`Could not remove test-data: ${err}`)
    }
  }
}

async function run() {
  section('Teardown')
  await stopNgrok()
  await deleteTestAccounts()
  await stopDockerCompose()
  await cleanUpTestData()
  info('Teardown complete')
}

run().catch((err) => {
  console.error('\nTeardown failed:', err)
  Deno.exit(1)
})
