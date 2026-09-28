import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { createECDH, createPrivateKey, sign } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import type { AssertionResult, ScenarioSuite } from '../rules.js'

const FEEDGEN_DID = 'did:web:feedgen-e2e.atmosbox.test'
const AUTHORITY_DID = 'did:web:stratos-e2e.atmosbox.test'
const SERVICE_LXM = 'com.atproto.space.listRepos'
const SECP256K1_ORDER = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
)

export function mintListReposToken(secretHex: string, now: number): string {
  if (!/^[0-9a-fA-F]{64}$/.test(secretHex)) {
    throw new Error('Invalid sandbox feedgen signing key format')
  }
  const privateKeyBytes = Buffer.from(secretHex, 'hex')
  const curve = createECDH('secp256k1')
  curve.setPrivateKey(privateKeyBytes)
  const publicKey = curve.getPublicKey(undefined, 'uncompressed')
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'secp256k1',
      d: privateKeyBytes.toString('base64url'),
      x: publicKey.subarray(1, 33).toString('base64url'),
      y: publicKey.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  })
  const header = Buffer.from(
    JSON.stringify({ alg: 'ES256K', typ: 'JWT' }),
  ).toString('base64url')
  const claims = Buffer.from(
    JSON.stringify({
      iss: FEEDGEN_DID,
      aud: AUTHORITY_DID,
      exp: now + 60,
      lxm: SERVICE_LXM,
    }),
  ).toString('base64url')
  const signingInput = `${header}.${claims}`
  const signature = sign('sha256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363',
  })
  normalizeLowS(signature)
  return `${signingInput}.${signature.toString('base64url')}`
}

export function normalizeLowS(signature: Buffer): void {
  const s = BigInt(`0x${signature.subarray(32).toString('hex')}`)
  if (s > SECP256K1_ORDER / 2n) {
    const lowS = (SECP256K1_ORDER - s).toString(16).padStart(64, '0')
    Buffer.from(lowS, 'hex').copy(signature, 32)
  }
}

const requiredAssertions = [
  'sdk-discovers-both-custodies',
  'authority-and-host-agree',
  'selected-space-write',
  'space-write-is-private',
  'unresolved-custody-sends-no-credentials',
] as const

export const suite: ScenarioSuite = {
  id: 'client-custody',
  requiredAssertions,
  async run(context): Promise<AssertionResult[]> {
    const fromScenario = createRequire(import.meta.url)
    const fromTsx = createRequire(fromScenario.resolve('tsx'))
    const esbuild = fromTsx('esbuild') as {
      build(options: Record<string, unknown>): Promise<void>
    }
    const bundle = join(context.reportDirectory, 'client-custody-sdk.mjs')
    const source = resolve(
      fileURLToPath(
        new URL('../../../stratos-client/src/index.ts', import.meta.url),
      ),
    )
    await esbuild.build({
      entryPoints: [source],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
    })
    const script = fileURLToPath(
      new URL('./client-custody.mjs', import.meta.url),
    )
    const secretPath = join(
      context.sandboxDirectory,
      'state/apps/feedgen-ng-e2e/secret-files/feedgen-e2e-signing-key',
    )
    const secretHex = (await readFile(secretPath, 'utf8')).trim()
    const stagingDirectory = await mkdtemp(
      join(context.sandboxDirectory, 'state/client-custody-'),
    )
    const stagedBundle = join(stagingDirectory, 'client-custody-sdk.mjs')
    const stagedScript = join(stagingDirectory, 'client-custody.mjs')
    const tokenPath = join(stagingDirectory, 'service-jwt')
    let output: string
    try {
      // Docker can bind files from disposable AiaB state on this host. Keep
      // the signing key outside the mount and remove every staged file below.
      await copyFile(bundle, stagedBundle)
      await copyFile(script, stagedScript)
      await chmod(stagedBundle, 0o444)
      await chmod(stagedScript, 0o444)
      await writeFile(
        tokenPath,
        mintListReposToken(secretHex, Math.floor(Date.now() / 1000)),
        { mode: 0o444 },
      )
      output = await context.runCommand(
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
          '--entrypoint',
          'node',
          '--volume',
          `${stagedBundle}:/runner/client-custody-sdk.mjs:ro,Z`,
          '--volume',
          `${stagedScript}:/runner/client-custody.mjs:ro,Z`,
          '--volume',
          `${tokenPath}:/runner/client-custody-service-jwt:ro,Z`,
          'feedgen-e2e-browser',
          '/runner/client-custody.mjs',
        ],
        context.sandboxDirectory,
      )
    } finally {
      await rm(stagingDirectory, { recursive: true })
    }
    const line = output
      .split('\n')
      .map((item) => item.trim())
      .findLast((item) =>
        item.startsWith('{"suite":"client-custody","assertions":'),
      )
    if (!line)
      throw new Error('Client custody runner returned no assertion receipt')
    const parsed = JSON.parse(line) as {
      suite?: string
      assertions?: AssertionResult[]
    }
    if (
      parsed.suite !== 'client-custody' ||
      !Array.isArray(parsed.assertions)
    ) {
      throw new Error(
        'Client custody runner returned an invalid assertion receipt',
      )
    }
    return parsed.assertions
  },
}
