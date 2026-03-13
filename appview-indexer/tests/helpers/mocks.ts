import { vi } from 'vitest'
import { EventEmitter } from 'node:events'

// --- 90s Anime Character DIDs ---

export const SPIKE_DID = 'did:plc:spikespiegel'
export const FAYE_DID = 'did:plc:fayevalentine'
export const JET_DID = 'did:plc:jetblack'
export const USAGI_DID = 'did:plc:usagitsukino'
export const SHINJI_DID = 'did:plc:shinjiikari'
export const REI_DID = 'did:plc:reiayanami'
export const MOTOKO_DID = 'did:plc:motokokusanagi'
export const BATOU_DID = 'did:plc:batou'
export const VASH_DID = 'did:plc:vashthestampede'
export const KENSHIN_DID = 'did:plc:kenshinhimura'

export const BEBOP_PDS = 'https://bebop.example.com'
export const NERV_PDS = 'https://nerv.example.com'
export const SECTION9_PDS = 'https://section9.example.com'

export const STRATOS_SERVICE_URL = 'https://stratos.example.com'
export const STRATOS_SERVICE_DID = 'did:web:stratos.example.com'
export const APPVIEW_DID = 'did:web:bsky.example.com'

// --- Mock IndexingService ---

export function createMockIndexingService() {
  return {
    indexRecord: vi.fn().mockResolvedValue(undefined),
    deleteRecord: vi.fn().mockResolvedValue(undefined),
    indexHandle: vi.fn().mockResolvedValue(undefined),
    setCommitLastSeen: vi.fn().mockResolvedValue(undefined),
    deleteActor: vi.fn().mockResolvedValue(undefined),
    updateActorStatus: vi.fn().mockResolvedValue(undefined),
    findIndexerForCollection: vi.fn().mockReturnValue(null),
  }
}

// --- Mock IdResolver ---

export function createMockIdResolver(
  resolutions: Record<string, { pds: string; handle: string }> = {},
) {
  return {
    did: {
      resolve: vi.fn().mockImplementation(async (did: string) => {
        const data = resolutions[did]
        if (!data) return null
        return {
          id: did,
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: data.pds,
            },
          ],
        }
      }),
      resolveAtprotoData: vi.fn().mockImplementation(async (did: string) => {
        const data = resolutions[did]
        if (!data) throw new Error(`could not resolve ${did}`)
        return {
          did,
          pds: data.pds,
          handle: data.handle,
          signingKey: 'mock-key',
        }
      }),
    },
  }
}

// --- Mock BackgroundQueue ---

export function createMockBackgroundQueue() {
  const queue: Array<() => Promise<void>> = []
  return {
    add: vi.fn().mockImplementation((fn: () => Promise<void>) => {
      queue.push(fn)
    }),
    processAll: vi.fn().mockImplementation(async () => {
      for (const fn of queue) {
        await fn()
      }
      queue.length = 0
    }),
    _queue: queue,
  }
}

// --- Mock WebSocket ---

export class MockWebSocket extends EventEmitter {
  binaryType = 'arraybuffer'
  readyState = 1 // OPEN
  url: string

  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: ((e: { error?: unknown }) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  onopen: (() => void) | null = null

  constructor(url: string) {
    super()
    this.url = url
    setTimeout(() => {
      this.onopen?.()
      this.emit('open')
    }, 0)
  }

  close(): void {
    this.readyState = 3
    const event = { code: 1000, reason: 'closed' }
    this.onclose?.(event)
    this.emit('close', event)
  }

  send(_data: unknown): void {}

  reconnect(): void {
    this.readyState = 1
    this.onopen?.()
    this.emit('open')
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.({ data })
    this.emit('message', { data })
  }

  simulateError(error: Error): void {
    this.onerror?.({ error })
    this.emit('error', { error })
  }
}

// --- Mock Enrollment Callback ---

export function createMockEnrollmentCallback() {
  return {
    onEnrollmentDiscovered: vi.fn(),
    onEnrollmentRemoved: vi.fn(),
  }
}

// --- Mock Keypair ---

export function createMockKeypair() {
  return {
    sign: vi.fn().mockResolvedValue(new Uint8Array(64)),
    did: vi.fn().mockReturnValue(APPVIEW_DID),
    jwtAlg: 'ES256K',
  }
}

// --- Helper: Create a mock Stratos enrollment record ---

export function createEnrollmentRecord(
  serviceUrl: string,
  boundaries: string[] = [],
) {
  return {
    $type: 'zone.stratos.actor.enrollment',
    service: serviceUrl,
    boundary: {
      values: boundaries.map((b) => ({ value: b })),
    },
    createdAt: new Date().toISOString(),
  }
}

// --- Helper: Create a mock Stratos post record ---

export function createStratosPostRecord(
  text: string,
  boundaries: string[] = [],
) {
  return {
    $type: 'zone.stratos.feed.post',
    text,
    boundary: {
      values: boundaries.map((b) => ({ value: b })),
    },
    createdAt: new Date().toISOString(),
  }
}
