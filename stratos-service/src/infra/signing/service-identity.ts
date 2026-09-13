import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Secp256k1Keypair, type ExportableKeypair } from '@atproto/crypto'
import { acquireIdentityLock } from './identity-lock.js'
import {
  appendServiceKeyHistory,
  verifyServiceKeyHistory,
  type ServiceKeyHistory,
} from '@northskysocial/stratos-client'

interface StoredIdentity {
  privateKey: string
  history: ServiceKeyHistory
}

export interface ServiceSigningIdentity {
  signingKey: Secp256k1Keypair
  keyHistory: ServiceKeyHistory
  close(): Promise<void>
  rotate(nextKey: Secp256k1Keypair, validFrom: string): Promise<void>
}

async function saveIdentity(
  file: string,
  identity: StoredIdentity,
): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(identity))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporary, file)
    const directory = await fs.open(path.dirname(file), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function importInitialKey(dataDir: string): Promise<Secp256k1Keypair> {
  const legacyFile = path.join(dataDir, 'signing_key')
  try {
    const key = await Secp256k1Keypair.import(await fs.readFile(legacyFile), {
      exportable: true,
    })
    await fs.chmod(legacyFile, 0o600)
    return key
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const key = await Secp256k1Keypair.create({ exportable: true })
  await fs.writeFile(legacyFile, await (key as ExportableKeypair).export(), {
    flag: 'wx',
    mode: 0o600,
  })
  return key
}

export async function openServiceSigningIdentity(
  dataDir: string,
  serviceDid: string,
): Promise<ServiceSigningIdentity> {
  const file = path.join(dataDir, 'service-signing-identity.json')
  const lock = await acquireIdentityLock(
    path.join(dataDir, 'service-signing-identity.lock'),
  )
  let closed = false
  let rotating = false
  const close = async () => {
    if (rotating) throw new Error('Cannot close during a signing key rotation')
    closed = true
    await lock.close()
  }
  try {
    let stored: StoredIdentity
    try {
      stored = JSON.parse(await fs.readFile(file, 'utf8')) as StoredIdentity
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const initialKey = await importInitialKey(dataDir)
      const history = await appendServiceKeyHistory(
        { serviceDid, entries: [] },
        initialKey,
        initialKey,
        new Date().toISOString(),
      )
      stored = {
        privateKey: Buffer.from(
          await (initialKey as ExportableKeypair).export(),
        ).toString('base64'),
        history,
      }
      await saveIdentity(file, stored)
    }
    let signingKey = await Secp256k1Keypair.import(
      Buffer.from(stored.privateKey, 'base64'),
    )
    let keyHistory = await verifyServiceKeyHistory(
      stored.history,
      serviceDid,
      signingKey.did(),
    )
    return {
      get signingKey() {
        return signingKey
      },
      get keyHistory() {
        return keyHistory
      },
      close,
      async rotate(nextKey, validFrom) {
        if (closed) throw new Error('Service signing identity is closed')
        if (rotating)
          throw new Error(
            'A service signing key rotation is already in progress',
          )
        rotating = true
        try {
          const history = await appendServiceKeyHistory(
            keyHistory,
            signingKey,
            nextKey,
            validFrom,
          )
          await saveIdentity(file, {
            privateKey: Buffer.from(
              await (nextKey as ExportableKeypair).export(),
            ).toString('base64'),
            history,
          })
          signingKey = nextKey
          keyHistory = history
        } finally {
          rotating = false
        }
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}
