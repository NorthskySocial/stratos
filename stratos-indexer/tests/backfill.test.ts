import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  backfillActors,
  type BackfillOptions,
  backfillRepos,
  backfillSingleActor,
} from '../src/backfill.ts'

function makeOpts(overrides?: Partial<BackfillOptions>): BackfillOptions {
  return {
    repoProvider: 'https://pds.tokyo-3.nerv.jp',
    indexingService: {
      indexRecord: vi.fn().mockResolvedValue(undefined),
    } as never,
    enrollmentCallback: {
      onEnrollmentDiscovered: vi.fn(),
      onEnrollmentRemoved: vi.fn(),
    },
    onError: vi.fn(),
    onProgress: vi.fn(),
    ...overrides,
  }
}

describe('backfillActors', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('backfills only the specified DIDs', async () => {
    const shinji = 'did:plc:shinji-ikari'
    const asuka = 'did:plc:asuka-langley'
    const rei = 'did:plc:rei-ayanami'

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: string | URL | Request) => {
        let url: string
        if (typeof input === 'string') {
          url = input
        } else if (input instanceof URL) {
          url = input.toString()
        } else {
          url = input.url
        }
        if (url.includes('listRecords')) {
          return new Response(JSON.stringify({ records: [] }), { status: 200 })
        }
        return new Response('not found', { status: 404 })
      })

    const opts = makeOpts()
    const count = await backfillActors(opts, [shinji, asuka, rei])

    expect(count).toBe(3)
    expect(opts.onProgress).toHaveBeenCalledTimes(3)

    const listRecordsCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes('listRecords'),
    )
    expect(listRecordsCalls).toHaveLength(3)

    const repos = listRecordsCalls.map(([url]) => {
      const parsed = new URL(String(url))
      return parsed.searchParams.get('repo')
    })
    expect(repos).toContain(shinji)
    expect(repos).toContain(asuka)
    expect(repos).toContain(rei)
  })

  it('does not call listRepos', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ records: [] }), { status: 200 }),
      )

    const opts = makeOpts()
    await backfillActors(opts, ['did:plc:misato-katsuragi'])

    const listReposCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes('listRepos'),
    )
    expect(listReposCalls).toHaveLength(0)
  })

  it('continues on individual actor failure', async () => {
    let callCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return new Response('server error', { status: 500 })
      }
      return new Response(JSON.stringify({ records: [] }), { status: 200 })
    })

    const opts = makeOpts()
    const count = await backfillActors(opts, [
      'did:plc:gendo-ikari',
      'did:plc:ritsuko-akagi',
    ])

    expect(count).toBe(2)
  })

  it('discovers enrollments during actor backfill', async () => {
    const validCid =
      'bafyreiadsbmmn4waznesyuz3bjgrj33xzqhxrk6mz3ksq7meugrachh3qe'

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          records: [
            {
              uri: 'at://did:plc:kaworu-nagisa/zone.stratos.actor.enrollment/self',
              cid: validCid,
              value: {
                $type: 'zone.stratos.actor.enrollment',
                service: 'https://stratos.tokyo-3.jp',
                boundary: {
                  values: [{ value: 'nerv-hq' }],
                },
              },
            },
          ],
        }),
        { status: 200 },
      )
    })

    const opts = makeOpts()
    await backfillActors(opts, ['did:plc:kaworu-nagisa'])

    expect(opts.enrollmentCallback.onEnrollmentDiscovered).toHaveBeenCalledWith(
      'did:plc:kaworu-nagisa',
      'https://stratos.tokyo-3.jp',
      ['nerv-hq'],
    )
  })
})

describe('backfillSingleActor', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('backfills a single actor', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ records: [] }), { status: 200 }),
      )

    const opts = makeOpts()
    await backfillSingleActor(opts, 'did:plc:toji-suzuhara')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const url = new URL(String(fetchSpy.mock.calls[0][0]))
    expect(url.searchParams.get('repo')).toBe('did:plc:toji-suzuhara')
  })
})

describe('backfillRepos', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('iterates all repos via listRepos', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: string | URL | Request) => {
        let url: string
        if (typeof input === 'string') {
          url = input
        } else if (input instanceof URL) {
          url = input.toString()
        } else {
          url = input.url
        }
        if (url.includes('listRepos')) {
          return new Response(
            JSON.stringify({
              repos: [
                { did: 'did:plc:hikari-horaki' },
                { did: 'did:plc:kensuke-aida' },
              ],
            }),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify({ records: [] }), { status: 200 })
      })

    const opts = makeOpts()
    const count = await backfillRepos(opts)

    expect(count).toBe(2)

    const listReposCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes('listRepos'),
    )
    expect(listReposCalls.length).toBeGreaterThan(0)
  })
})
