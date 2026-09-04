#!/usr/bin/env -S deno run -A
// Setup script — creates PDS accounts, starts Stratos via Docker Compose, waits for health.

import {
  ADMIN_OPERATOR_KEY,
  CLOUDFLARE_TUNNEL_URL,
  TEST_DATA_DIR,
  TEST_ROOT,
  TEST_USERS,
  USE_CLOUDFLARE_TUNNEL,
} from './lib/config.ts'
import { accountExists, createAccount, createInviteCode } from './lib/pds.ts'
import { waitForHealthy } from './lib/stratos.ts'
import { loadState, saveState, type TestState } from './lib/state.ts'
import { error, fail, info, pass, section, warn } from './lib/log.ts'
import { isAppview, isPostgres } from './lib/backend.ts'
import {
  createPdsAccount,
  waitForPdsSpacesReady,
} from './lib/mixed-mode-pds.ts'

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
  const pdsSpacesDataDir = `${TEST_DATA_DIR}/pds-spaces`
  await Deno.mkdir(pdsSpacesDataDir, { recursive: true })

  const chmod = new Deno.Command('chmod', {
    args: ['777', TEST_DATA_DIR, pdsSpacesDataDir],
  })
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

async function createMixedModeAccounts(state: TestState) {
  section('Creating spaces PDS accounts')
  const accounts = [
    {
      key: 'member' as const,
      handle: 'motoko.spike.test',
      email: 'motoko@example.com',
      password: 'test-motoko-spaces-2026!',
    },
    {
      key: 'hostile' as const,
      handle: 'batou.spike.test',
      email: 'batou@example.com',
      password: 'test-batou-spaces-2026!',
    },
  ]
  const created = await Promise.all(
    accounts.map(async ({ key, handle, email, password }) => {
      const account = await createPdsAccount(handle, email, password)
      return [
        key,
        {
          did: account.did,
          handle: account.handle,
          password: account.password,
          enrolled: false,
          records: {},
        },
      ] as const
    }),
  )
  state.mixedMode = {
    member: created.find(([key]) => key === 'member')![1],
    hostile: created.find(([key]) => key === 'hostile')![1],
  }
  pass('Created spaces PDS member fixtures')
}

function getEnvVars(state: TestState): Record<string, string> {
  const envVars: Record<string, string> = {}
  if (CLOUDFLARE_TUNNEL_URL) {
    info(`Using tunnel URL: ${CLOUDFLARE_TUNNEL_URL}`)
    envVars['STRATOS_PUBLIC_URL'] = CLOUDFLARE_TUNNEL_URL
    envVars['STRATOS_SERVICE_DID'] =
      `did:web:${CLOUDFLARE_TUNNEL_URL.replace(/^https?:\/\//, '')}`
    envVars['STRATOS_OAUTH_CLIENT_ID'] =
      `${CLOUDFLARE_TUNNEL_URL}/client-metadata.json`
    envVars['STRATOS_OAUTH_CLIENT_URI'] = CLOUDFLARE_TUNNEL_URL
    envVars['STRATOS_OAUTH_REDIRECT_URI'] =
      `${CLOUDFLARE_TUNNEL_URL}/oauth/callback`
  } else if (USE_CLOUDFLARE_TUNNEL) {
    throw new Error(
      'No Cloudflare Tunnel URL found in state, but USE_CLOUDFLARE_TUNNEL=true',
    )
  } else {
    envVars['STRATOS_PUBLIC_URL'] = 'http://127.0.0.1:3100'
    envVars['STRATOS_SERVICE_DID'] = 'did:web:127.0.0.1%3A3100'
    envVars['STRATOS_OAUTH_CLIENT_ID'] =
      'http://127.0.0.1:3100/client-metadata.json'
    envVars['STRATOS_OAUTH_CLIENT_URI'] = 'http://127.0.0.1:3100'
    envVars['STRATOS_OAUTH_REDIRECT_URI'] =
      'http://127.0.0.1:3100/oauth/callback'
  }

  const operatorDid = state.users[ADMIN_OPERATOR_KEY]?.did
  if (operatorDid) {
    info(`Designating admin operator: ${operatorDid}`)
    envVars['STRATOS_ADMIN_DIDS'] = operatorDid
  } else {
    warn(
      `Admin operator "${ADMIN_OPERATOR_KEY}" has no DID in state — admin-API phase will be unable to authorize`,
    )
  }

  return envVars
}

async function startStratos(envVars: Record<string, string>) {
  section('Starting Stratos')
  info('Building and starting container...')

  const composeArgs = ['-f', 'docker-compose.test.yml']
  if (isAppview()) {
    composeArgs.push('-f', 'docker-compose.e2e.yml')
    info('Using AppView E2E stack (Stratos + AppView + PostgreSQL)')
  } else if (isPostgres()) {
    composeArgs.push('-f', 'docker-compose.postgres.yml')
    info('Using PostgreSQL storage backend')
  }
  composeArgs.push('up', '-d', '--build', '--force-recreate')
  if (isAppview()) {
    composeArgs.push('--wait', 'postgres', 'stratos', 'pds-spaces', 'appview')
  } else if (isPostgres()) {
    composeArgs.push('postgres', 'stratos', 'pds-spaces')
  } else {
    composeArgs.push('stratos', 'pds-spaces')
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

  info('Waiting for spaces PDS to become ready...')
  await waitForPdsSpacesReady()
  pass('Spaces PDS is ready')

  await createMixedModeAccounts(state)

  state.stratosRunning = true
  await saveState(state)
  pass('Setup complete')
}

run().catch((err) => {
  console.error('\nSetup failed:', err)
  Deno.exit(1)
})
