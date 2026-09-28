import assert from 'node:assert/strict'
import { copyFile, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { AssertionResult, ScenarioSuite } from '../rules.js'

const requiredAssertions = [
  'oauth-space-session',
  'pds-issued-delegation',
  'header-exchange',
  'foreign-repo-read',
  'wrong-key-denied',
  'delegation-replay-denied',
  'missing-proof-preserves-delegation',
  'ambiguous-transport-denied',
  'ordinary-bearer-denied',
] as const

const scenarioDirectory = dirname(fileURLToPath(import.meta.url))
const clubhousePackage = new URL(
  '../../../clubhouse/package.json',
  import.meta.url,
)
const SERVICE_BEARER_EXIT = '__delegation_service_bearer_exit__='

// This runs in the disposable Stratos container. It uses the sandbox feedgen
// key, emits only an assertion ID, and never prints the key or signed token.
const checkServiceBearer = String.raw`
import assert from 'node:assert/strict'
import { Secp256k1Keypair, verifySignature } from '@atproto/crypto'
import { createServiceJwt } from '@atproto/xrpc-server'

try {
  const domain = process.env.SANDBOX_DOMAIN
  const signingKey = process.env.DELEGATION_SIGNING_KEY
  assert.match(domain ?? '', /^[a-z0-9.-]+$/)
  assert.match(signingKey ?? '', /^[0-9a-f]{64}$/i)
  const feedgenDid = 'did:web:feedgen-e2e.' + domain
  const authorityDid = 'did:web:stratos-e2e.' + domain
  const keypair = await Secp256k1Keypair.import(signingKey)
  const token = await createServiceJwt({
    iss: feedgenDid,
    aud: authorityDid,
    lxm: 'zone.stratos.space.getSpaceCredential',
    keypair,
  })
  const [header, payload, signature] = token.split('.')
  assert.equal(await verifySignature(
    keypair.did(),
    new TextEncoder().encode(header + '.' + payload),
    Buffer.from(signature, 'base64url'),
  ), true)
  const response = await fetch('http://localhost:3100/xrpc/zone.stratos.space.getSpaceCredential', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      space: 'at://' + authorityDid + '/space/zone.stratos.space.feed/general',
    }),
  })
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.error, 'InvalidToken')
  process.stdout.write(JSON.stringify({
    suite: 'delegation-service-bearer',
    assertions: [{ id: 'ordinary-bearer-denied', status: 'passed' }],
  }) + '\n')
} catch (error) {
  process.stderr.write('Service Bearer check failed: ' + (error instanceof Error ? error.name : 'UnknownError') + '\n')
  process.exitCode = 1
}
`

async function prepareBrowserRunner(reportDirectory: string): Promise<void> {
  const clubhouse = JSON.parse(await readFile(clubhousePackage, 'utf8')) as {
    name?: string
  }
  assert.equal(clubhouse.name, '@northskysocial/clubhouse')
  const require = createRequire(clubhousePackage)
  const vitePath = require.resolve('vite')
  const { build } = (await import(
    pathToFileURL(vitePath).href
  )) as typeof import('vite')
  await build({
    configFile: false,
    build: {
      emptyOutDir: false,
      outDir: reportDirectory,
      lib: {
        entry: join(scenarioDirectory, 'delegation-transport.browser.mjs'),
        name: 'DelegationScenarioAuth',
        formats: ['iife'],
        fileName: () => 'auth-client.iife.js',
      },
    },
  })
  await copyFile(
    join(scenarioDirectory, 'delegation-transport.driver.mjs'),
    join(reportDirectory, 'driver.mjs'),
  )
}

async function assertServiceBearerDenied(
  context: Parameters<ScenarioSuite['run']>[0],
): Promise<AssertionResult> {
  const compose = [
    'compose',
    '--project-name',
    context.projectName,
    '--project-directory',
    context.sandboxDirectory,
  ]
  const signingKey = (
    await context.runCommand(
      'docker',
      [
        ...compose,
        'exec',
        '-T',
        'feedgen-e2e-rust',
        'cat',
        '/tmp/feedgen-signing-key',
      ],
      context.sandboxDirectory,
    )
  ).trim()
  if (!/^[0-9a-f]{64}$/i.test(signingKey)) {
    throw new Error('Sandbox feedgen signing key was unavailable')
  }
  const output = await context.runCommand(
    'docker',
    [
      ...compose,
      'exec',
      '-T',
      '-e',
      `DELEGATION_SIGNING_KEY=${signingKey}`,
      'feedgen-e2e-stratos',
      'sh',
      '-c',
      `node --input-type=module -e "$1" 2>&1
exit_code=$?
printf '\n${SERVICE_BEARER_EXIT}%s\n' "$exit_code"
exit 0`,
      '_',
      checkServiceBearer,
    ],
    context.sandboxDirectory,
  )
  const lines = output.split('\n').map((line) => line.trim())
  if (
    lines.findLast((line) => line.startsWith(SERVICE_BEARER_EXIT)) !==
    `${SERVICE_BEARER_EXIT}0`
  ) {
    const error =
      output.match(/\b[A-Z][A-Za-z]{0,40}Error\b/)?.[0] ?? 'UnknownError'
    throw new Error(`Service Bearer check failed: ${error}`)
  }
  const receipt = lines.findLast((line) =>
    line.startsWith('{"suite":"delegation-service-bearer","assertions":'),
  )
  if (!receipt)
    throw new Error('Service Bearer check returned no assertion receipt')
  const parsed = JSON.parse(receipt) as {
    suite?: string
    assertions?: AssertionResult[]
  }
  if (
    parsed.suite !== 'delegation-service-bearer' ||
    !Array.isArray(parsed.assertions) ||
    parsed.assertions.length !== 1 ||
    parsed.assertions[0].id !== 'ordinary-bearer-denied' ||
    parsed.assertions[0].status !== 'passed'
  ) {
    throw new Error(
      'Service Bearer check returned an invalid assertion receipt',
    )
  }
  return parsed.assertions[0]
}

export const suite: ScenarioSuite = {
  id: 'delegation-transport',
  requiredAssertions,
  async run(context): Promise<AssertionResult[]> {
    await prepareBrowserRunner(context.reportDirectory)
    const output = await context.runCommand(
      'docker',
      [
        'compose',
        '--project-name',
        context.projectName,
        '--project-directory',
        context.sandboxDirectory,
        'run',
        '--rm',
        '--no-deps',
        '--volume',
        `${context.reportDirectory}:/scenario:ro,Z`,
        '--entrypoint',
        'node',
        'feedgen-e2e-browser',
        '/scenario/driver.mjs',
      ],
      context.sandboxDirectory,
    )
    const receipt = output
      .split('\n')
      .map((line) => line.trim())
      .findLast((line) =>
        line.startsWith('{"suite":"delegation-transport","assertions":'),
      )
    if (!receipt)
      throw new Error('Delegation browser returned no assertion receipt')
    const parsed = JSON.parse(receipt) as {
      suite?: string
      assertions?: AssertionResult[]
    }
    if (
      parsed.suite !== 'delegation-transport' ||
      !Array.isArray(parsed.assertions)
    ) {
      throw new Error(
        'Delegation browser returned an invalid assertion receipt',
      )
    }
    return [...parsed.assertions, await assertServiceBearerDenied(context)]
  },
}
