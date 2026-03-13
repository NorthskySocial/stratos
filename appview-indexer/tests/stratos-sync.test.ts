import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  StratosServiceSubscription,
  StratosActorSync,
  indexStratosRecord,
  deleteStratosRecord,
} from '../src/stratos-sync.ts'
import {
  SPIKE_DID,
  FAYE_DID,
  SHINJI_DID,
  REI_DID,
  MOTOKO_DID,
  STRATOS_SERVICE_URL,
} from './helpers/mocks.ts'

// Mock partysocket
const wsInstances: Array<{
  url: string
  onmessage: ((e: { data: unknown }) => void) | null
  onerror: ((e: { error?: unknown }) => void) | null
  onclose: (() => void) | null
  onopen: (() => void) | null
  close: ReturnType<typeof vi.fn>
  addEventListener: ReturnType<typeof vi.fn>
}> = []

vi.mock('partysocket', () => {
  class MockWebSocket {
    url: string
    onmessage: ((e: { data: unknown }) => void) | null = null
    onerror: ((e: { error?: unknown }) => void) | null = null
    onclose: (() => void) | null = null
    onopen: (() => void) | null = null
    close = vi.fn()
    addEventListener = vi.fn()

    constructor(url: string) {
      this.url = url
      wsInstances.push(this)
    }
  }

  return { WebSocket: MockWebSocket }
})

const SYNC_TOKEN = 'test-sync-token-bebop'

describe('Stratos Sync', () => {
  describe('StratosServiceSubscription', () => {
    let callbacks: {
      onEnroll: ReturnType<typeof vi.fn>
      onUnenroll: ReturnType<typeof vi.fn>
    }
    let onError: ReturnType<typeof vi.fn>

    beforeEach(() => {
      callbacks = {
        onEnroll: vi.fn(),
        onUnenroll: vi.fn(),
      }
      onError = vi.fn()
    })

    it('should call onEnroll when receiving an enrollment message', async () => {
      const sub = new StratosServiceSubscription(
        {
          stratosServiceUrl: STRATOS_SERVICE_URL,
          syncToken: SYNC_TOKEN,
        },
        callbacks,
        onError,
      )

      sub.start()

      // Simulate receiving an enrollment message
      const handleMessage = (
        sub as unknown as {
          handleMessage: (data: unknown) => Promise<void>
        }
      ).handleMessage.bind(sub)

      await handleMessage(
        JSON.stringify({
          $type: '#enrollment',
          did: SPIKE_DID,
          action: 'enroll',
          boundaries: ['engineering', 'bounty-hunters'],
          time: new Date().toISOString(),
        }),
      )

      expect(callbacks.onEnroll).toHaveBeenCalledWith(SPIKE_DID, [
        'engineering',
        'bounty-hunters',
      ])

      sub.stop()
    })

    it('should call onUnenroll when receiving an unenroll message', async () => {
      const sub = new StratosServiceSubscription(
        {
          stratosServiceUrl: STRATOS_SERVICE_URL,
          syncToken: SYNC_TOKEN,
        },
        callbacks,
        onError,
      )

      sub.start()

      const handleMessage = (
        sub as unknown as {
          handleMessage: (data: unknown) => Promise<void>
        }
      ).handleMessage.bind(sub)

      await handleMessage(
        JSON.stringify({
          $type: '#enrollment',
          did: FAYE_DID,
          action: 'unenroll',
          time: new Date().toISOString(),
        }),
      )

      expect(callbacks.onUnenroll).toHaveBeenCalledWith(FAYE_DID)

      sub.stop()
    })

    it('should handle full $type format for enrollment messages', async () => {
      const sub = new StratosServiceSubscription(
        {
          stratosServiceUrl: STRATOS_SERVICE_URL,
          syncToken: SYNC_TOKEN,
        },
        callbacks,
        onError,
      )

      sub.start()

      const handleMessage = (
        sub as unknown as {
          handleMessage: (data: unknown) => Promise<void>
        }
      ).handleMessage.bind(sub)

      await handleMessage(
        JSON.stringify({
          $type: 'zone.stratos.sync.subscribeRecords#enrollment',
          did: SHINJI_DID,
          action: 'enroll',
          boundaries: ['nerv'],
          time: new Date().toISOString(),
        }),
      )

      expect(callbacks.onEnroll).toHaveBeenCalledWith(SHINJI_DID, ['nerv'])

      sub.stop()
    })

    it('should default boundaries to empty array when not provided', async () => {
      const sub = new StratosServiceSubscription(
        {
          stratosServiceUrl: STRATOS_SERVICE_URL,
          syncToken: SYNC_TOKEN,
        },
        callbacks,
        onError,
      )

      sub.start()

      const handleMessage = (
        sub as unknown as {
          handleMessage: (data: unknown) => Promise<void>
        }
      ).handleMessage.bind(sub)

      await handleMessage(
        JSON.stringify({
          $type: '#enrollment',
          did: REI_DID,
          action: 'enroll',
          time: new Date().toISOString(),
        }),
      )

      expect(callbacks.onEnroll).toHaveBeenCalledWith(REI_DID, [])

      sub.stop()
    })

    it('should call onError for malformed messages', async () => {
      const sub = new StratosServiceSubscription(
        {
          stratosServiceUrl: STRATOS_SERVICE_URL,
          syncToken: SYNC_TOKEN,
        },
        callbacks,
        onError,
      )

      sub.start()

      const handleMessage = (
        sub as unknown as {
          handleMessage: (data: unknown) => Promise<void>
        }
      ).handleMessage.bind(sub)

      await handleMessage('not valid json {{{')

      expect(onError).toHaveBeenCalled()
      expect(callbacks.onEnroll).not.toHaveBeenCalled()

      sub.stop()
    })
  })

  describe('StratosActorSync', () => {
    it('should track active actors', () => {
      const sync = new StratosActorSync({} as never, {
        stratosServiceUrl: STRATOS_SERVICE_URL,
        syncToken: SYNC_TOKEN,
      })

      sync.start()
      expect(sync.getActiveActors()).toEqual([])

      sync.stop()
    })

    it('should remove an actor', () => {
      const sync = new StratosActorSync({} as never, {
        stratosServiceUrl: STRATOS_SERVICE_URL,
        syncToken: SYNC_TOKEN,
      })

      sync.start()
      sync.addActor(MOTOKO_DID)

      expect(sync.getActiveActors()).toContain(MOTOKO_DID)

      sync.removeActor(MOTOKO_DID)
      expect(sync.getActiveActors()).not.toContain(MOTOKO_DID)

      sync.stop()
    })

    it('should not duplicate actors on repeated addActor calls', () => {
      const sync = new StratosActorSync({} as never, {
        stratosServiceUrl: STRATOS_SERVICE_URL,
        syncToken: SYNC_TOKEN,
      })

      sync.start()
      sync.addActor(SPIKE_DID)
      sync.addActor(SPIKE_DID)

      const actors = sync.getActiveActors().filter((d) => d === SPIKE_DID)
      expect(actors).toHaveLength(1)

      sync.stop()
    })
  })

  describe('indexStratosRecord', () => {
    it('should extract fields from a stratos post record', async () => {
      const mockTx = {
        insertInto: vi.fn().mockReturnThis(),
        values: vi.fn().mockReturnThis(),
        onConflict: vi.fn().mockReturnThis(),
        column: vi.fn().mockReturnThis(),
        doUpdateSet: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue(undefined),
        deleteFrom: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
      }

      const mockDb = {
        transaction: vi.fn().mockReturnValue({
          execute: vi
            .fn()
            .mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
              await fn(mockTx)
            }),
        }),
      }

      await indexStratosRecord(
        mockDb as never,
        `at://${SPIKE_DID}/zone.stratos.feed.post/abc123`,
        'bafyreiabc123',
        {
          text: 'See you space cowboy...',
          boundary: { values: [{ value: 'bebop-crew' }] },
          createdAt: '2026-01-01T00:00:00.000Z',
          reply: {
            root: {
              uri: `at://${FAYE_DID}/zone.stratos.feed.post/root1`,
              cid: 'rootcid',
            },
            parent: {
              uri: `at://${FAYE_DID}/zone.stratos.feed.post/parent1`,
              cid: 'parentcid',
            },
          },
          langs: ['en', 'ja'],
          tags: ['farewell'],
        },
        '2026-01-01T00:00:00.000Z',
      )

      expect(mockDb.transaction).toHaveBeenCalled()
      expect(mockTx.insertInto).toHaveBeenCalled()
    })
  })

  describe('deleteStratosRecord', () => {
    it('should delete from both stratos_post and stratos_post_boundary', async () => {
      const deleteCalls: string[] = []
      const mockTx = {
        deleteFrom: vi.fn().mockImplementation((table: string) => {
          deleteCalls.push(table)
          return {
            where: vi.fn().mockReturnValue({
              execute: vi.fn().mockResolvedValue(undefined),
            }),
          }
        }),
      }

      const mockDb = {
        transaction: vi.fn().mockReturnValue({
          execute: vi
            .fn()
            .mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
              await fn(mockTx)
            }),
        }),
      }

      await deleteStratosRecord(
        mockDb as never,
        `at://${SPIKE_DID}/zone.stratos.feed.post/abc123`,
      )

      expect(mockDb.transaction).toHaveBeenCalled()
      expect(deleteCalls).toContain('stratos_post_boundary')
      expect(deleteCalls).toContain('stratos_post')
    })
  })
})
