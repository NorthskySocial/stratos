#!/usr/bin/env -S deno run -A
// Setup script — creates PDS accounts, starts Stratos via Docker Compose, waits for health.

import { TEST_USERS, TEST_DATA_DIR, PROJECT_ROOT } from './lib/config.ts'
import { createInviteCode, createAccount, accountExists } from './lib/pds.ts'
import { waitForHealthy } from './lib/stratos.ts'
import { loadState, saveState, type TestState } from './lib/state.ts'
import { section, info, pass, fail, warn } from './lib/log.ts'
import { error } from 'node:console'

async function run() {
  section('Phase 1: Setup')

  // 1. Ensure test-data directory exists and is writable by the container (uid 1000)
  // info("Preparing test-data directory...");
  // try {
  //   await Deno.remove(TEST_DATA_DIR, { recursive: true });
  // } catch {
  //   error("Failed to remove existing test-data directory (may not exist)", { error: String(err) });
  // }
  // await Deno.mkdir(TEST_DATA_DIR, { recursive: true });

  // const chmod = new Deno.Command("chmod", { args: ["777", TEST_DATA_DIR] });
  // await chmod.output();

  // 2. Create PDS accounts
  section('Creating PDS accounts')
  const state: TestState = { users: {}, stratosRunning: false }

  for (const [key, user] of Object.entries(TEST_USERS)) {
    info(`Checking account: ${user.handle}`)

    // Check if account already exists
    const existing = await accountExists(user.handle, user.password)
    if (existing.exists && existing.did) {
      warn(`Account ${user.handle} already exists (${existing.did})`)
      state.users[key] = {
        did: existing.did,
        handle: user.handle,
        password: user.password,
        enrolled: false,
        records: {},
      }
      continue
    }

    // Create invite code then account
    try {
      info(`Creating invite code for ${user.handle}...`)
      const inviteCode = await createInviteCode()
      info(`Creating account ${user.handle}...`)
      const account = await createAccount(
        user.handle,
        user.email,
        user.password,
        inviteCode,
      )
      state.users[key] = {
        did: account.did,
        handle: user.handle,
        password: user.password,
        enrolled: false,
        records: {},
      }
      pass(`Created ${user.handle}`, account.did)
    } catch (err) {
      fail(`Failed to create ${user.handle}`, String(err))
      throw err
    }
  }

  await saveState(state)
  info(
    `State saved — DIDs: ${Object.values(state.users)
      .map((u) => `${u.handle}=${u.did}`)
      .join(', ')}`,
  )

  // 3. Start Stratos via Docker Compose
  section('Starting Stratos')
  info('Building and starting container...')

  const compose = new Deno.Command('docker-compose', {
    args: ['-f', 'docker-compose.test.yml', 'up', '-d', '--build'],
    cwd: PROJECT_ROOT,
    stdout: 'piped',
    stderr: 'piped',
  })

  const composeResult = await compose.output()

  if (!composeResult.success) {
    const stderr = new TextDecoder().decode(composeResult.stderr)
    fail('Docker compose failed', stderr)
    throw new Error('Docker compose failed')
  }
  pass('Container started')

  // 4. Wait for health
  info('Waiting for Stratos to become healthy...')
  try {
    await waitForHealthy(60_000)
    pass('Stratos is healthy')
  } catch (err) {
    // Show container logs on failure
    const logs = new Deno.Command('docker', {
      args: ['compose', '-f', 'docker-compose.test.yml', 'logs', '--tail=50'],
      cwd: PROJECT_ROOT,
      stdout: 'piped',
      stderr: 'piped',
    })
    const logsResult = await logs.output()
    console.log(new TextDecoder().decode(logsResult.stdout))
    console.log(new TextDecoder().decode(logsResult.stderr))
    fail('Stratos did not become healthy', String(err))
    throw err
  }

  state.stratosRunning = true
  await saveState(state)
  pass('Setup complete')
}

run().catch((err) => {
  console.error('\nSetup failed:', err)
  Deno.exit(1)
})
