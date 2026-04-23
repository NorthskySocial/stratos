import { CID, Cid } from '@atproto/lex-data'
import { sha256 } from 'multiformats/hashes/sha2'
import { ENROLLMENT_MODE } from '@northskysocial/stratos-core'
import { StratosServiceConfig } from '../../src/index.js'

/**
 * Create a deterministic CID from data
 */
export const createCid = async (data: string | Uint8Array): Promise<Cid> => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const hash = await sha256.digest(bytes)
  return CID.createV1(0x55, hash)
}

/**
 * CBOR decoder mock (just JSON for testing)
 */
export function cborToRecord(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes))
}

/**
 * Create a minimal test config
 */
export function createTestConfig(dataDir: string): StratosServiceConfig {
  return {
    service: {
      did: 'did:web:stratos.test',
      serviceFragment: 'atproto_pns',
      port: 3100,
      publicUrl: 'https://stratos.test',
      repoUrl: 'https://github.com/NorthskySocial/stratos',
    },
    storage: {
      backend: 'sqlite',
      dataDir,
    },
    blobstore: {
      provider: 'disk',
      location: `${dataDir}/blobs`,
    },
    stratos: {
      serviceDid: 'did:web:nerv.tokyo.jp',
      allowedDomains: [
        'did:web:nerv.tokyo.jp/engineering',
        'did:web:nerv.tokyo.jp/design',
      ],
      retentionDays: 30,
      importMaxBytes: 256 * 1024 * 1024,
      writeRateLimit: {
        maxWrites: 300,
        windowMs: 60_000,
        cooldownMs: 10_000,
        cooldownJitterMs: 1_000,
      },
    },
    enrollment: {
      mode: ENROLLMENT_MODE.OPEN,
      allowedDids: [],
      allowedPdsEndpoints: [],
    },
    identity: {
      plcUrl: 'https://plc.directory',
    },
    oauth: {},
    logging: {
      level: 'info',
    },
    dpop: {
      requireNonce: false,
    },
    userAgent: {
      repoUrl: 'https://github.com/NorthskySocial/stratos',
    },
  } as any
}
