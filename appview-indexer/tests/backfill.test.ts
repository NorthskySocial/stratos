import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { backfillRepos } from '../src/backfill.ts'
import {
  createMockIndexingService,
  createMockEnrollmentCallback,
  createEnrollmentRecord,
  SPIKE_DID,
  FAYE_DID,
  JET_DID,
  USAGI_DID,
  SHINJI_DID,
  BEBOP_PDS,
  STRATOS_SERVICE_URL,
} from './helpers/mocks.ts'
import { CID } from 'multiformats/cid'

// Valid CID for test data
const TEST_CID = 'bafkreie7q3iidccmpvszul7kudcvvuavuo7u6gzlbobczuk5nqk3b4akba'

// Mock pds-subscription utilities so parseCid doesn't reject test CIDs
vi.mock('../src/pds-subscription.ts', () => ({
  parseCid: vi.fn().mockImplementation((cid: string) => CID.parse(cid)),
  jsonToLex: vi.fn().mockImplementation((val: unknown) => val),
}))

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('Backfill', () => {
  let indexingService: ReturnType<typeof createMockIndexingService>
  let enrollmentCallback: ReturnType<typeof createMockEnrollmentCallback>
  let onError: ReturnType<typeof vi.fn>
  let onProgress: ReturnType<typeof vi.fn>

  beforeEach(() => {
    indexingService = createMockIndexingService()
    enrollmentCallback = createMockEnrollmentCallback()
    onError = vi.fn()
    onProgress = vi.fn()
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('backfillRepos', () => {
    it('should enumerate repos from listRepos and process each', async () => {
      // Mock listRepos — single page with 3 repos
      mockFetch.mockImplementation(async (url: string | URL) => {
        const urlStr = url.toString()

        if (urlStr.includes('com.atproto.sync.listRepos')) {
          return new Response(
            JSON.stringify({
              repos: [{ did: SPIKE_DID }, { did: FAYE_DID }, { did: JET_DID }],
            }),
            { status: 200 },
          )
        }

        if (urlStr.includes('com.atproto.repo.listRecords')) {
          return new Response(JSON.stringify({ records: [] }), { status: 200 })
        }

        return new Response(null, { status: 404 })
      })

      const processed = await backfillRepos({
        repoProvider: BEBOP_PDS,
        indexingService: indexingService as never,
        enrollmentCallback,
        onError,
        onProgress,
      })

      expect(processed).toBe(3)
      expect(onProgress).toHaveBeenCalled()
    })

    it('should handle paginated listRepos', async () => {
      let callCount = 0

      mockFetch.mockImplementation(async (url: string | URL) => {
        const urlStr = url.toString()

        if (urlStr.includes('com.atproto.sync.listRepos')) {
          callCount++
          if (callCount === 1) {
            return new Response(
              JSON.stringify({
                repos: [{ did: SPIKE_DID }, { did: FAYE_DID }],
                cursor: 'page2',
              }),
              { status: 200 },
            )
          }
          return new Response(
            JSON.stringify({
              repos: [{ did: JET_DID }],
            }),
            { status: 200 },
          )
        }

        if (urlStr.includes('com.atproto.repo.listRecords')) {
          return new Response(JSON.stringify({ records: [] }), { status: 200 })
        }

        return new Response(null, { status: 404 })
      })

      const processed = await backfillRepos({
        repoProvider: BEBOP_PDS,
        indexingService: indexingService as never,
        enrollmentCallback,
        onError,
        onProgress,
      })

      expect(processed).toBe(3)
    })

    it('should discover enrollments during backfill', async () => {
      mockFetch.mockImplementation(async (url: string | URL) => {
        const urlStr = url.toString()

        if (urlStr.includes('com.atproto.sync.listRepos')) {
          return new Response(
            JSON.stringify({
              repos: [{ did: USAGI_DID }],
            }),
            { status: 200 },
          )
        }

        if (urlStr.includes('com.atproto.repo.listRecords')) {
          return new Response(
            JSON.stringify({
              records: [
                {
                  uri: `at://${USAGI_DID}/zone.stratos.actor.enrollment/self`,
                  cid: TEST_CID,
                  value: createEnrollmentRecord(STRATOS_SERVICE_URL, [
                    'moonkingdom',
                  ]),
                },
                {
                  uri: `at://${USAGI_DID}/app.bsky.feed.post/abc123`,
                  cid: TEST_CID,
                  value: {
                    text: 'Moon prism power!',
                    createdAt: new Date().toISOString(),
                  },
                },
              ],
            }),
            { status: 200 },
          )
        }

        return new Response(null, { status: 404 })
      })

      await backfillRepos({
        repoProvider: BEBOP_PDS,
        indexingService: indexingService as never,
        enrollmentCallback,
        onError,
        onProgress,
      })

      expect(enrollmentCallback.onEnrollmentDiscovered).toHaveBeenCalledWith(
        USAGI_DID,
        STRATOS_SERVICE_URL,
        ['moonkingdom'],
      )
    })

    it('should index standard records through IndexingService', async () => {
      mockFetch.mockImplementation(async (url: string | URL) => {
        const urlStr = url.toString()

        if (urlStr.includes('com.atproto.sync.listRepos')) {
          return new Response(
            JSON.stringify({
              repos: [{ did: SHINJI_DID }],
            }),
            { status: 200 },
          )
        }

        if (urlStr.includes('com.atproto.repo.listRecords')) {
          return new Response(
            JSON.stringify({
              records: [
                {
                  uri: `at://${SHINJI_DID}/app.bsky.feed.post/eva01`,
                  cid: TEST_CID,
                  value: {
                    text: "I mustn't run away",
                    createdAt: '2026-01-15T00:00:00.000Z',
                  },
                },
              ],
            }),
            { status: 200 },
          )
        }

        return new Response(null, { status: 404 })
      })

      await backfillRepos({
        repoProvider: BEBOP_PDS,
        indexingService: indexingService as never,
        enrollmentCallback,
        onError,
        onProgress,
      })

      expect(indexingService.indexRecord).toHaveBeenCalled()
    })

    it('should report errors for individual repos without stopping', async () => {
      mockFetch.mockImplementation(async (url: string | URL) => {
        const urlStr = url.toString()

        if (urlStr.includes('com.atproto.sync.listRepos')) {
          return new Response(
            JSON.stringify({
              repos: [{ did: SPIKE_DID }, { did: FAYE_DID }],
            }),
            { status: 200 },
          )
        }

        if (urlStr.includes('com.atproto.repo.listRecords')) {
          if (
            urlStr.includes(`repo=${SPIKE_DID}`) ||
            urlStr.includes(`repo=${encodeURIComponent(SPIKE_DID)}`)
          ) {
            throw new Error('network timeout from the Bebop')
          }
          return new Response(JSON.stringify({ records: [] }), { status: 200 })
        }

        return new Response(null, { status: 404 })
      })

      const processed = await backfillRepos({
        repoProvider: BEBOP_PDS,
        indexingService: indexingService as never,
        enrollmentCallback,
        onError,
        onProgress,
      })

      // Spike's repo fails, Faye's succeeds
      expect(onError).toHaveBeenCalled()
      expect(processed).toBeGreaterThanOrEqual(1)
    })

    it('should handle empty PDS with no repos', async () => {
      mockFetch.mockImplementation(async (url: string | URL) => {
        const urlStr = url.toString()

        if (urlStr.includes('com.atproto.sync.listRepos')) {
          return new Response(JSON.stringify({ repos: [] }), { status: 200 })
        }

        return new Response(null, { status: 404 })
      })

      const processed = await backfillRepos({
        repoProvider: BEBOP_PDS,
        indexingService: indexingService as never,
        enrollmentCallback,
        onError,
        onProgress,
      })

      expect(processed).toBe(0)
      expect(indexingService.indexRecord).not.toHaveBeenCalled()
    })

    it('should handle listRepos API failure gracefully', async () => {
      mockFetch.mockImplementation(async () => {
        return new Response(null, { status: 500 })
      })

      const processed = await backfillRepos({
        repoProvider: BEBOP_PDS,
        indexingService: indexingService as never,
        enrollmentCallback,
        onError,
        onProgress,
      })

      expect(processed).toBe(0)
    })
  })
})
