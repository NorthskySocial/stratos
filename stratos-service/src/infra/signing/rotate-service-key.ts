import * as fs from 'node:fs/promises'
import { Secp256k1Keypair } from '@atproto/crypto'
import { openServiceSigningIdentity } from './service-identity.js'

export async function rotateServiceKey(args: string[]): Promise<void> {
  const [dataDir, serviceDid, nextKeyFile] = args
  if (args.length !== 3 || !dataDir || !serviceDid || !nextKeyFile) {
    throw new Error(
      'Usage: stratos-rotate-service-key DATA_DIR SERVICE_DID NEXT_PRIVATE_KEY_FILE; stop Stratos first',
    )
  }
  const nextKey = await Secp256k1Keypair.import(
    await fs.readFile(nextKeyFile),
    { exportable: true },
  )
  const identity = await openServiceSigningIdentity(dataDir, serviceDid)
  try {
    const lastTime = Date.parse(identity.keyHistory.entries.at(-1)!.validFrom)
    const validFrom = new Date(Math.max(Date.now(), lastTime + 1)).toISOString()
    await identity.rotate(nextKey, validFrom)
  } finally {
    await identity.close()
  }
}
