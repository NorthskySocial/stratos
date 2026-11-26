import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OAuthSession } from '@atproto/oauth-client-browser'
import corpus from '../../test/spaces-alignment/november/fixtures/space-uri-conformance.json'
import {
  chooseInspectorSource,
  loadInspectorRecord,
  readOwnSpaceRecord,
  snapshotFromEntry,
  type InspectorEntry,
  type InspectorSource,
} from '../src/lib/inspector'

const SPIKE = 'did:plc:spikespiegel'
const FAYE = 'did:plc:fayevalentine'
const SPACE = 'at:space/did:web:bebop.example/zone.stratos.space.feed/crew'
const OWN_SPACE_POST = `${SPACE}/${SPIKE}/zone.stratos.feed.post/swordfish`
const OTHER_SPACE_POST = `${SPACE}/${FAYE}/zone.stratos.feed.post/hammerhead`
const LEGACY_SPACE_POST = `at://did:web:bebop.example/space/zone.stratos.space.feed/crew/${SPIKE}/zone.stratos.feed.post/swordfish`
const CUSTODY_POST = `at://${SPIKE}/zone.stratos.feed.post/swordfish`
const OWN_SPACE_REQUEST =
  '/xrpc/com.atproto.space.getRecord?space=at%3Aspace%2Fdid%3Aweb%3Abebop.example%2Fzone.stratos.space.feed%2Fcrew&repo=did%3Aplc%3Aspikespiegel&collection=zone.stratos.feed.post&rkey=swordfish'

interface Recorded {
  url: string
  method: string
}

function recordingSession(
  answer: (url: string) => Response | Promise<Response>,
): { session: OAuthSession; requests: Recorded[] } {
  const requests: Recorded[] = []
  const session = {
    sub: SPIKE,
    fetchHandler: async (url: string, init?: RequestInit) => {
      requests.push({ url, method: init?.method ?? 'GET' })
      return answer(url)
    },
  } as unknown as OAuthSession
  return { session, requests }
}

function entry(uri: string, extra: Partial<InspectorEntry> = {}) {
  return { uri, cid: 'bafy-swordfish', ...extra }
}

let fetchedUrls: string[]

beforeEach(() => {
  fetchedUrls = []
  global.fetch = vi.fn(async (input: string | URL | Request) => {
    fetchedUrls.push(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    )
    throw new Error('the network must not be used here')
  }) as unknown as typeof fetch
})

describe('chooseInspectorSource', () => {
  it.each(corpus.records.map((record) => [record.name, record] as const))(
    'a space record, author versus signed-in account: %s',
    (_name, record) => {
      expect(chooseInspectorSource(entry(record.uri), record.author)).toBe(
        'own-space',
      )
      expect(chooseInspectorSource(entry(record.uri), 'did:plc:ritsuko')).toBe(
        'feed-snapshot',
      )
    },
  )

  it('does not take the space authority for the author', () => {
    const authority = 'did:web:bebop.example'
    expect(chooseInspectorSource(entry(OTHER_SPACE_POST), authority)).toBe(
      'feed-snapshot',
    )
    expect(chooseInspectorSource(entry(OWN_SPACE_POST), authority)).toBe(
      'feed-snapshot',
    )
    expect(chooseInspectorSource(entry(OWN_SPACE_POST), SPIKE)).toBe(
      'own-space',
    )
  })

  it.each(
    corpus.repoRecords.map((record) => [record.name, record.uri] as const),
  )('a three-part custody record: %s', (_name, uri) => {
    expect(chooseInspectorSource(entry(uri), SPIKE)).toBe('custody')
    expect(chooseInspectorSource(entry(uri), FAYE)).toBe('custody')
  })

  it.each(
    corpus.invalid
      .filter((item) => item.as !== 'space')
      .map((item) => [item.name, item.input] as const),
  )('anything else is invalid: %s', (_name, uri) => {
    expect(chooseInspectorSource(entry(uri), SPIKE)).toBe('invalid')
  })

  it.each([
    ['an empty string', ''],
    ['plain text', 'the post about Bebop'],
    ['a space URI that names no record', SPACE],
    ['a handle author', 'at://spike.example/zone.stratos.feed.post/swordfish'],
    ['a query on a custody record', `${CUSTODY_POST}?x=1`],
  ])('%s is invalid', (_label, uri) => {
    expect(chooseInspectorSource(entry(uri), SPIKE)).toBe('invalid')
  })
})

describe('own space record', () => {
  it('sends exactly one request to the session PDS and returns the record', async () => {
    const { session, requests } = recordingSession(
      () =>
        new Response(
          JSON.stringify({
            uri: OWN_SPACE_POST,
            cid: 'bafy-swordfish',
            value: { text: 'See you, space cowboy.' },
          }),
          { status: 200 },
        ),
    )

    const outcome = await loadInspectorRecord(
      session,
      'https://stratos.example',
      entry(OWN_SPACE_POST),
    )

    expect(requests).toEqual([{ url: OWN_SPACE_REQUEST, method: 'GET' }])
    expect(fetchedUrls).toEqual([])
    expect(outcome).toEqual({
      source: 'own-space',
      read: {
        kind: 'found',
        uri: OWN_SPACE_POST,
        cid: 'bafy-swordfish',
        value: { text: 'See you, space cowboy.' },
      },
    })
  })

  it('names RepoNotFound', async () => {
    const { session, requests } = recordingSession(
      () =>
        new Response(
          JSON.stringify({
            error: 'RepoNotFound',
            message: 'Could not find repo for DID',
          }),
          { status: 400 },
        ),
    )
    const outcome = await loadInspectorRecord(
      session,
      'https://stratos.example',
      entry(OWN_SPACE_POST),
    )
    expect(outcome).toEqual({
      source: 'own-space',
      read: { kind: 'error', status: 400, name: 'RepoNotFound' },
    })
    expect(requests).toHaveLength(1)
  })

  it('names a 401 as unauthorized', async () => {
    const { session } = recordingSession(
      () =>
        new Response(JSON.stringify({ error: 'AuthenticationRequired' }), {
          status: 401,
        }),
    )
    expect(
      await loadInspectorRecord(
        session,
        'https://stratos.example',
        entry(OWN_SPACE_POST),
      ),
    ).toEqual({ source: 'own-space', read: { kind: 'unauthorized' } })
  })

  it.each([
    'InvalidSpaceMac',
    'RecordNotFound',
    'SpaceNotFound',
    'RepoTakendown',
    'RepoSuspended',
    'RepoDeactivated',
  ])('names %s from the lexicon', async (name) => {
    const { session } = recordingSession(
      () => new Response(JSON.stringify({ error: name }), { status: 400 }),
    )
    const { kind, ...rest } = await readOwnSpaceRecord(session, {
      kind: 'space',
      authority: 'did:web:bebop.example',
      spaceType: 'zone.stratos.space.feed',
      skey: 'crew',
      author: SPIKE,
      collection: 'zone.stratos.feed.post',
      rkey: 'swordfish',
    })
    expect(kind).toBe('error')
    expect(rest).toEqual({ status: 400, name })
  })

  it('does not name an error the lexicon does not declare', async () => {
    const { session } = recordingSession(
      () =>
        new Response(JSON.stringify({ error: 'SomethingElse' }), {
          status: 500,
        }),
    )
    expect(
      await loadInspectorRecord(
        session,
        'https://stratos.example',
        entry(OWN_SPACE_POST),
      ),
    ).toEqual({
      source: 'own-space',
      read: { kind: 'error', status: 500, name: null },
    })
  })

  it('treats an answer without a record as an error', async () => {
    const { session } = recordingSession(
      () =>
        new Response(JSON.stringify({ uri: OWN_SPACE_POST }), { status: 200 }),
    )
    expect(
      await loadInspectorRecord(
        session,
        'https://stratos.example',
        entry(OWN_SPACE_POST),
      ),
    ).toEqual({
      source: 'own-space',
      read: { kind: 'error', status: 200, name: null },
    })
  })

  it('reports an unreachable PDS', async () => {
    const session = {
      sub: SPIKE,
      fetchHandler: async () => {
        throw new TypeError('Failed to fetch')
      },
    } as unknown as OAuthSession
    expect(
      await loadInspectorRecord(
        session,
        'https://stratos.example',
        entry(OWN_SPACE_POST),
      ),
    ).toEqual({ source: 'own-space', read: { kind: 'unreachable' } })
  })
})

describe('another author space record', () => {
  const served = {
    $type: 'zone.stratos.feed.post',
    text: 'Hammerhead.',
    createdAt: '2026-09-07T08:00:00.000Z',
  }

  it('shows the copy the feed served and sends no request of any kind', async () => {
    const { session, requests } = recordingSession(() => {
      throw new Error('the session must not be used')
    })
    const outcome = await loadInspectorRecord(
      session,
      'https://stratos.example',
      entry(OTHER_SPACE_POST, {
        record: served,
        indexedAt: '2026-09-07T08:00:05.000Z',
      }),
    )
    expect(outcome).toEqual({
      source: 'feed-snapshot',
      snapshot: {
        uri: OTHER_SPACE_POST,
        cid: 'bafy-swordfish',
        record: served,
        indexedAt: '2026-09-07T08:00:05.000Z',
      },
    })
    expect(requests).toEqual([])
    expect(fetchedUrls).toEqual([])
  })

  it('builds the snapshot from the served record, never from display text', async () => {
    const { session } = recordingSession(() => new Response('{}'))
    const outcome = await loadInspectorRecord(
      session,
      'https://stratos.example',
      {
        ...entry(OTHER_SPACE_POST, { record: served }),
        text: 'Text the card shows',
      } as InspectorEntry,
    )
    expect(outcome).toMatchObject({
      snapshot: { record: served, indexedAt: null },
    })
    expect(JSON.stringify(outcome)).not.toContain('Text the card shows')
  })

  it('is unavailable when the entry holds no record, still without a request', async () => {
    const { session, requests } = recordingSession(() => new Response('{}'))
    expect(
      await loadInspectorRecord(
        session,
        'https://stratos.example',
        entry(OTHER_SPACE_POST),
      ),
    ).toEqual({ source: 'feed-snapshot', snapshot: null })
    expect(requests).toEqual([])
    expect(fetchedUrls).toEqual([])
    expect(snapshotFromEntry(entry(OTHER_SPACE_POST))).toBeNull()
  })

  it('treats a space record whose authority is the signed-in account as another author', async () => {
    const { session, requests } = recordingSession(() => new Response('{}'))
    const outcome = await loadInspectorRecord(
      session,
      'https://stratos.example',
      {
        ...entry(
          `at:space/${SPIKE}/zone.stratos.space.feed/crew/${FAYE}/zone.stratos.feed.post/hammerhead`,
        ),
      },
    )
    expect(outcome.source).toBe('feed-snapshot')
    expect(requests).toEqual([])
  })
})

describe('an invalid address', () => {
  it.each([
    ['an earlier-spelling record', LEGACY_SPACE_POST],
    ['an empty string', ''],
    ['a space URI that names no record', SPACE],
    ['plain text', 'not an address'],
  ])('returns nothing and sends nothing for %s', async (_label, uri) => {
    const { session, requests } = recordingSession(() => new Response('{}'))
    expect(
      await loadInspectorRecord(session, 'https://stratos.example', entry(uri)),
    ).toEqual({ source: 'invalid' })
    expect(requests).toEqual([])
    expect(fetchedUrls).toEqual([])
  })
})

describe('a custody record', () => {
  it('makes the two requests inspectRecord makes today', async () => {
    const stub = { value: { text: 'stub' } }
    const hydrated = { value: { text: 'hydrated' } }
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : String(input)
      fetchedUrls.push(url)
      return url.includes('plc.directory')
        ? new Response(
            JSON.stringify({
              service: [
                { id: '#atproto_pds', serviceEndpoint: 'https://pds.example' },
              ],
            }),
          )
        : new Response(JSON.stringify(stub))
    }) as unknown as typeof fetch
    const { session, requests } = recordingSession(
      () => new Response(JSON.stringify(hydrated)),
    )

    const outcome = await loadInspectorRecord(
      session,
      'https://stratos.example',
      entry(CUSTODY_POST),
    )

    expect(fetchedUrls).toEqual([
      'https://plc.directory/did%3Aplc%3Aspikespiegel',
      'https://pds.example/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Aspikespiegel&collection=zone.stratos.feed.post&rkey=swordfish',
    ])
    expect(requests).toEqual([
      {
        url: 'https://stratos.example/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Aspikespiegel&collection=zone.stratos.feed.post&rkey=swordfish',
        method: 'GET',
      },
    ])
    expect(outcome).toMatchObject({
      source: 'custody',
      result: { stub, record: hydrated },
    })
  })
})

describe('sources are exhaustive', () => {
  it('names exactly the four sources', () => {
    const sources: InspectorSource[] = [
      chooseInspectorSource(entry(CUSTODY_POST), SPIKE),
      chooseInspectorSource(entry(OWN_SPACE_POST), SPIKE),
      chooseInspectorSource(entry(OTHER_SPACE_POST), SPIKE),
      chooseInspectorSource(entry('x'), SPIKE),
    ]
    expect(sources).toEqual([
      'custody',
      'own-space',
      'feed-snapshot',
      'invalid',
    ])
  })
})
