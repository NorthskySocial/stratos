#!/usr/bin/env -S deno run -A
// Setup script — creates PDS accounts, starts Stratos via Docker Compose, waits for health.

import { TEST_USERS, PROJECT_ROOT, TEST_DATA_DIR } from './lib/config.ts'
import { createInviteCode, createAccount, accountExists } from './lib/pds.ts'
import { waitForHealthy } from './lib/stratos.ts'
import { saveState, loadState, type TestState } from './lib/state.ts'
import { section, info, pass, fail, warn, error } from './lib/log.ts'

async function run() {
  section('Phase 1: Setup')

  // 1. Ensure the test-data directory exists and is writable by the container (uid 1000)
  info('Preparing test-data directory...')
  try {
    await Deno.remove(TEST_DATA_DIR, { recursive: true })
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      error('Failed to remove existing test-data directory (may not exist)', {
        error: String(err),
      })
    } else {
      info('test-data directory already absent')
    }
  }
  await Deno.mkdir(TEST_DATA_DIR, { recursive: true })

  const chmod = new Deno.Command('chmod', { args: ['777', TEST_DATA_DIR] })
  await chmod.output()

  // 2. Create PDS accounts
  section('Creating PDS accounts')
  const state: TestState = await loadState()

  for (const [key, user] of Object.entries(TEST_USERS)) {
    info(`Checking account: ${user.handle}`)

    // Check if the account already exists
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

  const envVars: Record<string, string> = {}
  if (state.ngrokUrl) {
    info(`Using ngrok URL: ${state.ngrokUrl}`)
    envVars['STRATOS_PUBLIC_URL'] = state.ngrokUrl
    envVars['STRATOS_SERVICE_DID'] =
      `did:web:${state.ngrokUrl.replace(/^https?:\/\//, '')}`
    envVars['STRATOS_OAUTH_CLIENT_ID'] =
      `${state.ngrokUrl}/client-metadata.json`
    envVars['STRATOS_OAUTH_CLIENT_URI'] = state.ngrokUrl
    envVars['STRATOS_OAUTH_REDIRECT_URI'] = `${state.ngrokUrl}/oauth/callback`
  } else if (Deno.env.get('USE_NGROK') === 'true') {
    throw new Error('No ngrok URL found in state, but USE_NGROK=true')
  } else {
    // When not using ngrok, we must satisfy strict OAuth library requirements (RFC 8252):
    // 1. redirect_uris must use loopback IP (127.0.0.1) instead of 'localhost'
    // 2. client_id must be a valid URL. If it's http, some libraries (atproto)
    //    forbid using an IP address in the hostname.
    // 3. For local testing, using 'localhost' for client_id and '127.0.0.1' for redirect_uri
    //    is the standard way to bypass these restrictions.

    envVars['STRATOS_PUBLIC_URL'] = 'http://127.0.0.1:3100'
    envVars['STRATOS_SERVICE_DID'] = 'did:web:127.0.0.1%3A3100'
    envVars['STRATOS_OAUTH_CLIENT_ID'] =
      'http://127.0.0.1:3100/client-metadata.json'
    envVars['STRATOS_OAUTH_CLIENT_URI'] = 'http://127.0.0.1:3100'
    envVars['STRATOS_OAUTH_REDIRECT_URI'] =
      'http://127.0.0.1:3100/oauth/callback'
  }

  const compose = new Deno.Command('docker-compose', {
    args: [
      '-f',
      'docker-compose.test.yml',
      'up',
      '-d',
      '--build',
      '--force-recreate',
      'stratos',
    ],
    cwd: PROJECT_ROOT,
    stdout: 'piped',
    stderr: 'piped',
    env: {
      ...Deno.env.toObject(),
      ...envVars,
    },
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
