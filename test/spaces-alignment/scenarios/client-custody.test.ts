import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createECDH, createPublicKey, verify } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { mintListReposToken, normalizeLowS, suite } from './client-custody.js'
import { verifyServiceAuth } from '../../../stratos-service/src/infra/auth/verifier.js'

const TEST_KEY = '01'.repeat(32)

async function seedFeedgenKey(directory: string): Promise<void> {
  const keyDirectory = join(directory, 'state/apps/feedgen-ng-e2e/secret-files')
  await mkdir(keyDirectory, { recursive: true })
  await writeFile(
    join(keyDirectory, 'feedgen-e2e-signing-key'),
    `${TEST_KEY}\n`,
  )
}

describe('client custody sandbox suite', () => {
  it('bundles the actual SDK and invokes the private browser container', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'client-custody-scenario-'))
    await seedFeedgenKey(directory)
    const assertions = suite.requiredAssertions.map((id) => ({
      id,
      status: 'passed',
    }))
    let mountedTokenPath = ''
    const runCommand = vi.fn(
      async (file: string, args: string[], cwd: string) => {
        expect(file).toBe('docker')
        expect(cwd).toBe(directory)
        const tokenMount = args.at(-3)
        expect(tokenMount).toMatch(
          /^\/tmp\/stratos-custody-token-[^:]+\/service-jwt:\/runner\/client-custody-service-jwt:ro$/,
        )
        mountedTokenPath = tokenMount!.split(':')[0]
        expect((await stat(mountedTokenPath)).mode & 0o777).toBe(0o444)
        const jwt = await readFile(mountedTokenPath, 'utf8')
        const [header, claims, signature] = jwt.split('.')
        expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual(
          {
            alg: 'ES256K',
            typ: 'JWT',
          },
        )
        const payload = JSON.parse(Buffer.from(claims, 'base64url').toString())
        expect(payload).toEqual({
          iss: 'did:web:feedgen-e2e.atmosbox.test',
          aud: 'did:web:stratos-e2e.atmosbox.test',
          exp: expect.any(Number),
          lxm: 'com.atproto.space.listRepos',
        })
        const now = Math.floor(Date.now() / 1000)
        expect(payload.exp).toBeGreaterThan(now)
        expect(payload.exp).toBeLessThanOrEqual(now + 60)
        const curve = createECDH('secp256k1')
        curve.setPrivateKey(Buffer.from(TEST_KEY, 'hex'))
        const publicBytes = curve.getPublicKey(undefined, 'uncompressed')
        const publicKey = createPublicKey({
          key: {
            kty: 'EC',
            crv: 'secp256k1',
            x: publicBytes.subarray(1, 33).toString('base64url'),
            y: publicBytes.subarray(33, 65).toString('base64url'),
          },
          format: 'jwk',
        })
        expect(
          verify(
            'sha256',
            Buffer.from(`${header}.${claims}`),
            { key: publicKey, dsaEncoding: 'ieee-p1363' },
            Buffer.from(signature, 'base64url'),
          ),
        ).toBe(true)
        expect(args).toEqual([
          'compose',
          '--project-name',
          'stratos-test',
          '--project-directory',
          directory,
          'run',
          '--rm',
          '--no-deps',
          '--entrypoint',
          'node',
          '--volume',
          `${join(directory, 'client-custody-sdk.mjs')}:/runner/client-custody-sdk.mjs:ro`,
          '--volume',
          `${fileURLToPath(new URL('./client-custody.mjs', import.meta.url))}:/runner/client-custody.mjs:ro`,
          '--volume',
          tokenMount,
          'feedgen-e2e-browser',
          '/runner/client-custody.mjs',
        ])
        return `Container ready\n  ${JSON.stringify({ suite: 'client-custody', assertions })}\n`
      },
    )
    try {
      const results = await suite.run({
        sandboxDirectory: directory,
        reportDirectory: directory,
        projectName: 'stratos-test',
        runCommand,
      })
      expect(results).toEqual(assertions)
      expect(
        await readFile(join(directory, 'client-custody-sdk.mjs'), 'utf8'),
      ).toContain('resolveRepositoryTarget')
      const sdk = await import(
        pathToFileURL(join(directory, 'client-custody-sdk.mjs')).href
      )
      expect(typeof sdk.resolveRepositoryTarget).toBe('function')
      expect(suite.id).toBe('client-custody')
      expect(runCommand).toHaveBeenCalledOnce()
      await expect(readFile(mountedTokenPath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    [
      'missing receipt',
      'no receipt',
      'Client custody runner returned no assertion receipt',
    ],
    [
      'wrong suite',
      '{"suite":"client-custody","assertions":[],"suite":"other"}',
      'Client custody runner returned an invalid assertion receipt',
    ],
    [
      'invalid assertions',
      JSON.stringify({ suite: 'client-custody', assertions: {} }),
      'Client custody runner returned an invalid assertion receipt',
    ],
  ])('rejects %s', async (_name, output, expectedError) => {
    const directory = await mkdtemp(join(tmpdir(), 'client-custody-scenario-'))
    await seedFeedgenKey(directory)
    try {
      await expect(
        suite.run({
          sandboxDirectory: directory,
          reportDirectory: directory,
          projectName: 'stratos-test',
          runCommand: async () => output,
        }),
      ).rejects.toThrow(expectedError)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects an invalid feedgen key without launching the browser', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'client-custody-scenario-'))
    const runCommand = vi.fn()
    try {
      await seedFeedgenKey(directory)
      await writeFile(
        join(
          directory,
          'state/apps/feedgen-ng-e2e/secret-files/feedgen-e2e-signing-key',
        ),
        'invalid',
      )
      await expect(
        suite.run({
          sandboxDirectory: directory,
          reportDirectory: directory,
          projectName: 'stratos-test',
          runCommand,
        }),
      ).rejects.toThrow('Invalid sandbox feedgen signing key format')
      expect(runCommand).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('mints a 60-second listRepos token', () => {
    const token = mintListReposToken(TEST_KEY, 1_000)
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString(),
    )
    expect(claims.exp).toBe(1_060)
    expect(() => mintListReposToken(`x${TEST_KEY}`, 1_000)).toThrow(
      'Invalid sandbox feedgen signing key format',
    )
    expect(() => mintListReposToken(`${TEST_KEY}x`, 1_000)).toThrow(
      'Invalid sandbox feedgen signing key format',
    )
  })

  it('passes the authority service-auth verifier', async () => {
    const fromService = createRequire(
      fileURLToPath(
        new URL('../../../stratos-service/package.json', import.meta.url),
      ),
    )
    const { Secp256k1Keypair } = fromService('@atproto/crypto') as {
      Secp256k1Keypair: {
        import(secret: string): Promise<{ did(): string }>
      }
    }
    const keypair = await Secp256k1Keypair.import(TEST_KEY)
    const issuer = 'did:web:feedgen-e2e.atmosbox.test'
    const idResolver = {
      did: {
        resolve: async (did: string) => {
          expect(did).toBe(issuer)
          return {
            id: issuer,
            verificationMethod: [
              {
                id: `${issuer}#atproto`,
                type: 'Multikey',
                controller: issuer,
                publicKeyMultibase: keypair.did().slice('did:key:'.length),
              },
            ],
          }
        },
      },
    }
    const token = mintListReposToken(TEST_KEY, Math.floor(Date.now() / 1000))
    const verified = await verifyServiceAuth(
      `Bearer ${token}`,
      'did:web:stratos-e2e.atmosbox.test',
      'com.atproto.space.listRepos',
      idResolver as unknown as Parameters<typeof verifyServiceAuth>[3],
    )
    expect(verified.iss).toBe(issuer)
  })

  it('normalizes high-S signatures without changing low-S signatures', () => {
    const order = BigInt(
      '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
    )
    const high = Buffer.alloc(64)
    Buffer.from((order - 1n).toString(16).padStart(64, '0'), 'hex').copy(
      high,
      32,
    )
    normalizeLowS(high)
    expect(high.subarray(32)).toEqual(
      Buffer.from(`${'00'.repeat(31)}01`, 'hex'),
    )

    const low = Buffer.alloc(64)
    low[63] = 2
    normalizeLowS(low)
    expect(low[63]).toBe(2)
  })
})
