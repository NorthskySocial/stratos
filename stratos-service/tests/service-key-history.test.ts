import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  Secp256k1Keypair,
  verifySignature,
  type ExportableKeypair,
} from '@atproto/crypto'
import { rotateServiceKey } from '../src/infra/signing/rotate-service-key.js'
import { openServiceSigningIdentity } from '../src/infra/signing/service-identity.js'
import { registerIdentityHandlers } from '../src/features/identity/handler.js'
import {
  DefaultLexiconProvider,
  createAttestationPayload,
} from '@northskysocial/stratos-core'
import { verifyEnrollmentAttestation } from '@northskysocial/stratos-client'
import type { Server } from '@atproto/xrpc-server'

const directories: string[] = []
const did = 'did:web:nerv.example'
async function directory() {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'stratos-nerv-history-'))
  directories.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  )
})

describe('durable service signing identity', () => {
  it('retains exclusive ownership across helper exit and releases it after an abrupt owner crash', async () => {
    const dir = await directory()
    const moduleUrl = new URL(
      '../src/infra/signing/service-identity.ts',
      import.meta.url,
    ).href
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `
      import {openServiceSigningIdentity} from ${JSON.stringify(moduleUrl)};
      const identity = await openServiceSigningIdentity(${JSON.stringify(dir)}, ${JSON.stringify(did)});
      process.send(identity.keyHistory);
      setInterval(() => {}, 1000);
    `,
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    )
    const exit = once(child, 'exit')
    try {
      const [history] = await once(child, 'message', {
        signal: AbortSignal.timeout(5000),
      })
      await expect(openServiceSigningIdentity(dir, did)).rejects.toThrow(
        'flock',
      )
      const lockInode = (
        await fs.stat(path.join(dir, 'service-signing-identity.lock'))
      ).ino
      child.kill('SIGKILL')
      await exit
      const recovered = await openServiceSigningIdentity(dir, did)
      expect(recovered.keyHistory).toEqual(history)
      await recovered.close()
      expect(
        (await fs.stat(path.join(dir, 'service-signing-identity.lock'))).ino,
      ).toBe(lockInode)
    } finally {
      child.kill('SIGKILL')
      await exit
    }
  })
  it('creates a private atomic identity, publishes only history and preserves identity on restart', async () => {
    const dir = await directory()
    const identity = await openServiceSigningIdentity(dir, did)
    const key = identity.signingKey.did()
    const history = identity.keyHistory
    expect(history.serviceDid).toBe(did)
    expect(history.entries).toHaveLength(1)
    expect(history.entries[0].key).toBe(key)
    expect(
      (await fs.stat(path.join(dir, 'service-signing-identity.json'))).mode &
        0o777,
    ).toBe(0o600)
    expect((await fs.stat(path.join(dir, 'signing_key'))).mode & 0o777).toBe(
      0o600,
    )
    expect(
      (await fs.stat(path.join(dir, 'service-signing-identity.lock'))).mode &
        0o777,
    ).toBe(0o600)
    const method = vi.fn()
    registerIdentityHandlers({ method } as unknown as Server, {
      keyHistory: history,
    })
    expect(method).toHaveBeenCalledWith('zone.stratos.identity.getKeyHistory', {
      type: 'query',
      handler: expect.any(Function),
    })
    const response = method.mock.calls[0][1].handler()
    expect(response).toEqual({ encoding: 'application/json', body: history })
    expect(JSON.stringify(response)).not.toContain('privateKey')
    const lexicon = new DefaultLexiconProvider().get(
      'zone.stratos.identity.getKeyHistory',
    )
    expect(lexicon?.defs.main.type).toBe('query')
    await identity.close()
    const restarted = await openServiceSigningIdentity(dir, did)
    expect(restarted.signingKey.did()).toBe(key)
    expect(restarted.keyHistory).toEqual(history)
    expect((await fs.readdir(dir)).some((file) => file.endsWith('.tmp'))).toBe(
      false,
    )
    await restarted.close()
  })
  it('imports the existing service key without rotating it', async () => {
    const dir = await directory()
    const shinji = await Secp256k1Keypair.create({ exportable: true })
    const bytes = await (shinji as ExportableKeypair).export()
    await fs.writeFile(path.join(dir, 'signing_key'), bytes)
    const identity = await openServiceSigningIdentity(dir, did)
    expect(identity.signingKey.did()).toBe(shinji.did())
    expect(await fs.readFile(path.join(dir, 'signing_key'))).toEqual(
      Buffer.from(bytes),
    )
    await identity.close()
  })
  it('records successive rotations without rewriting earlier entries and reloads the active key', async () => {
    const dir = await directory()
    const identity = await openServiceSigningIdentity(dir, did)
    const genesis = identity.keyHistory.entries[0]
    const rei = await Secp256k1Keypair.create({ exportable: true })
    const asuka = await Secp256k1Keypair.create({ exportable: true })
    const timestamp = Date.parse(genesis.validFrom)
    await identity.rotate(rei, new Date(timestamp + 1000).toISOString())
    expect(identity.signingKey.did()).toBe(rei.did())
    expect(identity.keyHistory.entries).toHaveLength(2)
    await identity.rotate(asuka, new Date(timestamp + 2000).toISOString())
    expect(identity.keyHistory.entries[0]).toEqual(genesis)
    await identity.close()
    const restarted = await openServiceSigningIdentity(dir, did)
    expect(restarted.keyHistory.entries).toHaveLength(3)
    expect(restarted.signingKey.did()).toBe(asuka.did())
    expect(
      await verifySignature(
        asuka.did(),
        new Uint8Array([1]),
        await restarted.signingKey.sign(new Uint8Array([1])),
      ),
    ).toBe(true)
    await restarted.close()
  })
  it('rejects concurrent use and rotation without losing history', async () => {
    const dir = await directory()
    const identity = await openServiceSigningIdentity(dir, did)
    await expect(openServiceSigningIdentity(dir, did)).rejects.toThrow('flock')
    const rei = await Secp256k1Keypair.create({ exportable: true })
    const time = new Date(
      Date.parse(identity.keyHistory.entries[0].validFrom) + 1000,
    ).toISOString()
    const rotation = identity.rotate(rei, time)
    await expect(identity.close()).rejects.toThrow(
      'during a signing key rotation',
    )
    await expect(identity.rotate(rei, time)).rejects.toThrow(
      'already in progress',
    )
    await rotation
    expect(identity.keyHistory.entries).toHaveLength(2)
    await identity.close()
    await expect(identity.rotate(rei, time)).rejects.toThrow(
      'identity is closed',
    )
  })
  it('keeps the prior identity after invalid rotations and permits a subsequent valid rotation', async () => {
    const dir = await directory()
    const identity = await openServiceSigningIdentity(dir, did)
    const before = await fs.readFile(
      path.join(dir, 'service-signing-identity.json'),
    )
    const rei = await Secp256k1Keypair.create({ exportable: true })
    await expect(
      identity.rotate(rei, identity.keyHistory.entries[0].validFrom),
    ).rejects.toThrow('timestamps must increase')
    expect(
      await fs.readFile(path.join(dir, 'service-signing-identity.json')),
    ).toEqual(before)
    await identity.rotate(
      rei,
      new Date(
        Date.parse(identity.keyHistory.entries[0].validFrom) + 1,
      ).toISOString(),
    )
    await identity.close()
  })
  it.each(['broken JSON', '{}'])(
    'fails closed on corrupt identity storage and releases the lock',
    async (body) => {
      const dir = await directory()
      await fs.writeFile(path.join(dir, 'service-signing-identity.json'), body)
      await expect(openServiceSigningIdentity(dir, did)).rejects.toThrow()
      expect(
        await fs.readFile(
          path.join(dir, 'service-signing-identity.json'),
          'utf8',
        ),
      ).toBe(body)
      await fs.rm(path.join(dir, 'service-signing-identity.json'))
      const recovered = await openServiceSigningIdentity(dir, did)
      await recovered.close()
    },
  )
  it('rejects an unlogged key replacement and a changed service DID', async () => {
    const dir = await directory()
    const identity = await openServiceSigningIdentity(dir, did)
    await identity.close()
    await expect(
      openServiceSigningIdentity(dir, 'did:web:seele.example'),
    ).rejects.toThrow('Invalid service key history')
    const file = path.join(dir, 'service-signing-identity.json')
    const stored = JSON.parse(await fs.readFile(file, 'utf8'))
    const kaworu = await Secp256k1Keypair.create({ exportable: true })
    stored.privateKey = Buffer.from(
      await (kaworu as ExportableKeypair).export(),
    ).toString('base64')
    await fs.writeFile(file, JSON.stringify(stored))
    await expect(openServiceSigningIdentity(dir, did)).rejects.toThrow(
      'current DID key',
    )
  })
  it('fails closed on malformed legacy key bytes', async () => {
    const dir = await directory()
    await fs.writeFile(path.join(dir, 'signing_key'), 'broken')
    await expect(openServiceSigningIdentity(dir, did)).rejects.toThrow()
    expect(await fs.readdir(dir)).toEqual([
      'service-signing-identity.lock',
      'signing_key',
    ])
  })
  it('agrees with the client on the signed issuedAt payload', async () => {
    const dir = await directory()
    const identity = await openServiceSigningIdentity(dir, did)
    const userDid = 'did:plc:shinji'
    const issuedAt = new Date().toISOString()
    const signingKey = 'did:key:zActor'
    const boundaries = [`${did}/nerv`]
    const sig = await identity.signingKey.sign(
      createAttestationPayload(userDid, boundaries, signingKey, issuedAt),
    )
    const record = {
      signingKey,
      boundaries: boundaries.map((value) => ({ value })),
      attestation: { sig, signingKey: identity.signingKey.did(), issuedAt },
    }
    const fetchFn: typeof fetch = async () =>
      Response.json({
        id: did,
        verificationMethod: [
          {
            id: `${did}#atproto`,
            controller: did,
            type: 'Multikey',
            publicKeyMultibase: identity.signingKey.did().slice(8),
          },
        ],
      })
    expect(
      (
        await verifyEnrollmentAttestation(record, userDid, {
          serviceDid: did,
          fetchFn,
        })
      ).valid,
    ).toBe(true)
    await identity.close()
  })
})

it.each(
  [
    [],
    ['data'],
    ['data', did],
    ['data', did, 'key', 'extra'],
    ['', did, 'key'],
    ['data', '', 'key'],
    ['data', did, ''],
  ].map((args) => [args]),
)('rejects incomplete rotation arguments %j', async (args) => {
  await expect(rotateServiceKey(args)).rejects.toThrow(
    'Usage: stratos-rotate-service-key',
  )
})

it('rotates through the supported local command and releases its lock after a rejected rotation', async () => {
  const dir = await directory()
  const rei = await Secp256k1Keypair.create({ exportable: true })
  const keyFile = path.join(dir, 'rei-key')
  await fs.writeFile(keyFile, await (rei as ExportableKeypair).export(), {
    mode: 0o600,
  })
  await rotateServiceKey([dir, did, keyFile])
  const identity = await openServiceSigningIdentity(dir, did)
  expect(identity.signingKey.did()).toBe(rei.did())
  expect(identity.keyHistory.entries).toHaveLength(2)
  expect(Date.parse(identity.keyHistory.entries[1].validFrom)).toBeGreaterThan(
    Date.parse(identity.keyHistory.entries[0].validFrom),
  )
  await identity.close()
  await expect(rotateServiceKey([dir, did, keyFile])).rejects.toThrow(
    'Invalid key history entry',
  )
  const restarted = await openServiceSigningIdentity(dir, did)
  expect(restarted.keyHistory.entries).toHaveLength(2)
  await restarted.close()
})

it('runs the local rotation binary with positional arguments and prints no private data', async () => {
  const dir = await directory()
  const rei = await Secp256k1Keypair.create({ exportable: true })
  const keyFile = path.join(dir, 'rei-key')
  await fs.writeFile(keyFile, await (rei as ExportableKeypair).export(), {
    mode: 0o600,
  })
  const originalArgv = process.argv
  const output = vi.spyOn(console, 'info').mockImplementation(() => {})
  try {
    process.argv = [
      process.execPath,
      'stratos-rotate-service-key',
      dir,
      did,
      keyFile,
    ]
    vi.resetModules()
    await import('../src/bin/rotate-service-key.js')
    expect(output).toHaveBeenCalledExactlyOnceWith(
      'Service signing key rotation recorded. Start Stratos with the same data directory.',
    )
    const identity = await openServiceSigningIdentity(dir, did)
    expect(identity.signingKey.did()).toBe(rei.did())
    expect(identity.keyHistory.entries).toHaveLength(2)
    await identity.close()
  } finally {
    process.argv = originalArgv
    output.mockRestore()
  }
})

it('advances the history time by one millisecond when the wall clock has not advanced', async () => {
  const fixed = Date.parse('1995-10-04T12:00:00.000Z')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(fixed)
  try {
    const dir = await directory()
    const key = await Secp256k1Keypair.create({ exportable: true })
    const file = path.join(dir, 'rei-key')
    await fs.writeFile(file, await (key as ExportableKeypair).export())
    await rotateServiceKey([dir, did, file])
    const identity = await openServiceSigningIdentity(dir, did)
    expect(identity.keyHistory.entries[1].validFrom).toBe(
      '1995-10-04T12:00:00.001Z',
    )
    await identity.close()
  } finally {
    vi.useRealTimers()
  }
})
