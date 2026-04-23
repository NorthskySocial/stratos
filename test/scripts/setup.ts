#!/usr/bin/env -S deno run -A
// Setup script — creates PDS accounts, starts Stratos via Docker Compose, waits for health.

import { TEST_DATA_DIR, TEST_ROOT, TEST_USERS } from './lib/config.ts'
import { accountExists, createAccount, createInviteCode } from './lib/pds.ts'
import { waitForHealthy } from './lib/stratos.ts'
import { loadState, saveState, type TestState } from './lib/state.ts'
import { error, fail, info, pass, section, warn } from './lib/log.ts'
import { isPostgres } from './lib/backend.ts'

async function prepareTestDataDir() {
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
}

async function createPdsAccounts(state: TestState) {
  section('Creating PDS accounts')
  for (const [key, user] of Object.entries(TEST_USERS)) {
    info(`Checking account: ${user.handle}`)

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
}

function getEnvVars(state: TestState): Record<string, string> {
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
    envVars['STRATOS_PUBLIC_URL'] = 'http://127.0.0.1:3100'
    envVars['STRATOS_SERVICE_DID'] = 'did:web:127.0.0.1%3A3100'
    envVars['STRATOS_OAUTH_CLIENT_ID'] =
      'http://127.0.0.1:3100/client-metadata.json'
    envVars['STRATOS_OAUTH_CLIENT_URI'] = 'http://127.0.0.1:3100'
    envVars['STRATOS_OAUTH_REDIRECT_URI'] =
      'http://127.0.0.1:3100/oauth/callback'
  }
  return envVars
}

async function startStratos(envVars: Record<string, string>) {
  section('Starting Stratos')
  info('Building and starting container...')

  const composeArgs = ['-f', 'docker-compose.test.yml']
  if (isPostgres()) {
    composeArgs.push('-f', 'docker-compose.postgres.yml')
    info('Using PostgreSQL storage backend')
  }
  composeArgs.push('up', '-d', '--build', '--force-recreate')
  if (isPostgres()) {
    composeArgs.push('postgres', 'stratos')
  } else {
    composeArgs.push('stratos')
  }

  const compose = new Deno.Command('docker-compose', {
    args: composeArgs,
    cwd: TEST_ROOT,
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
}

async function run() {
  section('Phase 1: Setup')

  await prepareTestDataDir()

  const state: TestState = await loadState()
  await createPdsAccounts(state)

  await saveState(state)
  info(
    `State saved — DIDs: ${Object.values(state.users)
      .map((u) => `${u.handle}=${u.did}`)
      .join(', ')}`,
  )

  const envVars = getEnvVars(state)
  await startStratos(envVars)

  info('Waiting for Stratos to become healthy...')
  try {
    await waitForHealthy(60_000)
    pass('Stratos is healthy')
  } catch (err) {
    const logArgs = ['compose', '-f', 'docker-compose.test.yml']
    if (isPostgres()) logArgs.push('-f', 'docker-compose.postgres.yml')
    logArgs.push('logs', '--tail=50')
    const logs = new Deno.Command('docker', {
      args: logArgs,
      cwd: TEST_ROOT,
      stdout: 'piped',
      stderr: 'piped',
    })
    const logsResult = await logs.output()
    console.log(new TextDecoder().decode(logsResult.stdout))
    console.log(new TextDecoder().decode(logsResult.stderr))
    fail('Stratos did not become healthy', String(err))
    throw err
  }

  state.serviceDid = envVars['STRATOS_SERVICE_DID']
  state.stratosRunning = true
  await saveState(state)
  pass('Setup complete')
}

run().catch((err) => {
  console.error('\nSetup failed:', err)
  Deno.exit(1)
})
