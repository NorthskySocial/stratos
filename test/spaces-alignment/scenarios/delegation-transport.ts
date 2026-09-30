import assert from 'node:assert/strict'
import { chmod, copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { AssertionResult, ScenarioSuite } from '../rules.js'

const requiredAssertions = [
  'oauth-space-session',
  'authorization-server-pds-separation',
  'pds-issued-delegation',
  'header-exchange',
  'foreign-repo-read',
  'wrong-delegation-type-denied',
  'wrong-delegation-issuer-denied',
  'wrong-delegation-signature-denied',
  'wrong-delegation-space-denied',
  'wrong-delegation-audience-denied',
  'expired-delegation-denied',
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
// This runs in the disposable Feedgen identity container. Its signing key and
// service JWTs remain in that container; only the assertion receipt is printed.
const checkServiceBearer = String.raw`
import { Secp256k1Keypair, verifySignature } from '@atproto/crypto'
import { Buffer } from 'node:buffer'

function requireEqual(actual, expected) {
  if (actual !== expected) throw Error('AssertionError')
}

async function serviceJwt(keypair, issuer, audience, method) {
  const now = Math.floor(Date.now() / 1000)
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = encode({ typ: 'JWT', alg: keypair.jwtAlg })
  const jti = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const payload = encode({ iat: now, iss: issuer, aud: audience, exp: now + 60, lxm: method, jti })
  const message = header + '.' + payload
  const signature = await keypair.sign(new TextEncoder().encode(message))
  requireEqual(JSON.parse(Buffer.from(header, 'base64url').toString()).typ, 'JWT')
  requireEqual(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, 'ES256K')
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
  requireEqual(claims.iss, issuer)
  requireEqual(claims.aud, audience)
  requireEqual(claims.lxm, method)
  requireEqual(await verifySignature(keypair.did(), new TextEncoder().encode(message), signature), true)
  return message + '.' + Buffer.from(signature).toString('base64url')
}

try {
  const domain = Deno.env.get('SANDBOX_DOMAIN')
  if (!domain || !/^[a-z0-9.-]+$/.test(domain)) throw Error('InvalidDomain')
  const authorityDid = 'did:web:stratos-e2e.' + domain
  const issuerDid = 'did:web:feedgen-e2e.' + domain
  const space = 'at://' + authorityDid + '/space/zone.stratos.space.feed/general'
  const signingKey = (await Deno.readTextFile('/run/sandbox-secrets/feedgen-signing-key')).trim()
  const keypair = await Secp256k1Keypair.import(signingKey)
  const admittedToken = await serviceJwt(keypair, issuerDid, authorityDid, 'zone.stratos.space.listRepos')
  const admittedResponse = await fetch('http://feedgen-e2e-stratos:3100/xrpc/zone.stratos.space.listRepos?space=' + encodeURIComponent(space), {
    headers: { authorization: 'Bearer ' + admittedToken },
  })
  requireEqual(admittedResponse.status, 200)

  const mintToken = await serviceJwt(keypair, issuerDid, authorityDid, 'zone.stratos.space.getSpaceCredential')
  const response = await fetch('http://feedgen-e2e-stratos:3100/xrpc/zone.stratos.space.getSpaceCredential', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + mintToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ space }),
  })
  requireEqual(response.status, 400)
  const body = await response.json()
  requireEqual(body.error, 'InvalidToken')
  Deno.stdout.writeSync(new TextEncoder().encode(JSON.stringify({
    suite: 'delegation-service-bearer',
    assertions: [{ id: 'ordinary-bearer-denied', status: 'passed' }],
  }) + '\n'))
} catch (error) {
  const kind = error instanceof Error ? error.name : 'UnknownError'
  Deno.stderr.writeSync(new TextEncoder().encode('Service Bearer check failed: ' + kind + '\n'))
  Deno.exit(1)
}
`

async function prepareBrowserRunner(reportDirectory: string): Promise<string> {
  const browserAssets = join(reportDirectory, 'browser-assets')
  await rm(browserAssets, { recursive: true, force: true })
  await mkdir(browserAssets)
  await chmod(browserAssets, 0o755)
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
      outDir: browserAssets,
      lib: {
        entry: join(scenarioDirectory, 'delegation-transport.browser.mjs'),
        name: 'DelegationScenarioAuth',
        formats: ['iife'],
        fileName: () => 'auth-client.iife.js',
      },
    },
  })
  const driverPath = join(browserAssets, 'driver.mjs')
  await copyFile(
    join(scenarioDirectory, 'delegation-transport.driver.mjs'),
    driverPath,
  )
  await Promise.all([
    chmod(join(browserAssets, 'auth-client.iife.js'), 0o644),
    chmod(driverPath, 0o644),
  ])
  return browserAssets
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
  const output = await context.runCommand(
    'docker',
    [
      ...compose,
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'deno',
      'feedgen-e2e-identity',
      'run',
      '--config=/app/deno.json',
      '--cached-only',
      '--allow-env=SANDBOX_DOMAIN',
      '--allow-read=/run/sandbox-secrets/feedgen-signing-key',
      '--allow-net=feedgen-e2e-stratos:3100',
      `data:application/javascript,${encodeURIComponent(checkServiceBearer)}`,
    ],
    context.sandboxDirectory,
  )
  const lines = output.split('\n').map((line) => line.trim())
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
    const browserAssets = await prepareBrowserRunner(context.reportDirectory)
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
        `${browserAssets}:/scenario:ro,z`,
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
