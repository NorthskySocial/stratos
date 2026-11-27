import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { flushSync } from 'svelte'
import type { OAuthSession } from '@atproto/oauth-client-browser'

import { fetchFeedgenPosts } from '../src/lib/feed'
import PostCard from '../src/lib/PostCard.svelte'
import RecordInspector from '../src/lib/RecordInspector.svelte'
import { createInspectorContext } from './helpers/inspector-context.svelte.js'

const SPIKE = 'did:plc:spikespiegel'
const FAYE = 'did:plc:fayevalentine'
const SPACE = 'at:space/did:web:bebop.example/zone.stratos.space.feed/crew'
const OWN_POST = `${SPACE}/${SPIKE}/zone.stratos.feed.post/swordfish`
const OWN_POST_TWO = `${SPACE}/${SPIKE}/zone.stratos.feed.post/hammerhead`
const OTHER_POST = `${SPACE}/${FAYE}/zone.stratos.feed.post/redtail`
const CUSTODY_POST = `at://${SPIKE}/zone.stratos.feed.post/swordfish`
const STRATOS = 'https://stratos.example'
const LEGACY_SPACE_POST = `at://did:web:bebop.example/space/zone.stratos.space.feed/crew/${SPIKE}/zone.stratos.feed.post/swordfish`

const ownRequest = (rkey: string) =>
  `/xrpc/com.atproto.space.getRecord?space=at%3Aspace%2Fdid%3Aweb%3Abebop.example%2Fzone.stratos.space.feed%2Fcrew&repo=did%3Aplc%3Aspikespiegel&collection=zone.stratos.feed.post&rkey=${rkey}`

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function found(uri: string, text: string): Response {
  return new Response(
    JSON.stringify({ uri, cid: 'bafy-bebop', value: { text } }),
    { status: 200 },
  )
}

function sessionFor(
  sub: string,
  answer: (url: string) => Response | Promise<Response>,
) {
  const requests: string[] = []
  const session = {
    sub,
    fetchHandler: async (url: string) => {
      requests.push(url)
      return answer(url)
    },
  } as unknown as OAuthSession
  return { session, requests }
}

function mountInspector(
  session: OAuthSession | null,
  props: {
    uri: string
    cid?: string
    record?: Record<string, unknown>
    indexedAt?: string
  },
  onclose = vi.fn(),
) {
  const context = createInspectorContext(session, STRATOS)
  const view = render(RecordInspector, {
    props: { cid: 'bafy-bebop', ...props, onclose },
    context: new Map([['stratos-inspector', context]]),
  })
  return { ...view, context, onclose }
}

let publicRequests: string[]

beforeEach(() => {
  publicRequests = []
  global.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : String(input)
    publicRequests.push(url)
    return url.includes('plc.directory')
      ? new Response(
          JSON.stringify({
            service: [
              { id: '#atproto_pds', serviceEndpoint: 'https://pds.example' },
            ],
          }),
        )
      : new Response(JSON.stringify({ value: { text: 'public stub' } }))
  }) as unknown as typeof fetch
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute('open')
      this.dispatchEvent(new Event('close'))
    },
  })
})

describe('inspector sources', () => {
  it('shows the two panels for a custody record, as before', async () => {
    const { session, requests } = sessionFor(
      SPIKE,
      () => new Response(JSON.stringify({ value: { text: 'private copy' } })),
    )
    mountInspector(session, { uri: CUSTODY_POST })

    expect(await screen.findByText('Public Record')).toBeInTheDocument()
    expect(screen.getByText('Private Hydrated Record')).toBeInTheDocument()
    expect(screen.getByText(/public stub/)).toBeInTheDocument()
    expect(screen.getByText(/private copy/)).toBeInTheDocument()
    expect(publicRequests).toEqual([
      'https://plc.directory/did%3Aplc%3Aspikespiegel',
      'https://pds.example/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Aspikespiegel&collection=zone.stratos.feed.post&rkey=swordfish',
    ])
    expect(requests).toEqual([
      `${STRATOS}/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Aspikespiegel&collection=zone.stratos.feed.post&rkey=swordfish`,
    ])
  })

  it('shows one titled panel for the member own space record, with one request to the session PDS', async () => {
    const { session, requests } = sessionFor(SPIKE, () =>
      found(OWN_POST, 'Bang.'),
    )
    mountInspector(session, { uri: OWN_POST })

    expect(
      await screen.findByText('Your record on your PDS'),
    ).toBeInTheDocument()
    expect(screen.getByText(/Bang\./)).toBeInTheDocument()
    expect(screen.queryByText('Public Record')).not.toBeInTheDocument()
    expect(
      screen.queryByText('Private Hydrated Record'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Feed snapshot')).not.toBeInTheDocument()
    expect(requests).toEqual([ownRequest('swordfish')])
    expect(publicRequests).toEqual([])
  })

  it('names the error, then reads again when the member retries', async () => {
    let attempt = 0
    const { session, requests } = sessionFor(SPIKE, () => {
      attempt += 1
      return attempt === 1
        ? new Response(JSON.stringify({ error: 'RepoNotFound' }), {
            status: 400,
          })
        : found(OWN_POST, 'Back again.')
    })
    mountInspector(session, { uri: OWN_POST })

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your PDS could not find your repository for this space.',
    )
    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText(/Back again\./)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(requests).toEqual([ownRequest('swordfish'), ownRequest('swordfish')])
  })

  it('says the sign-in is no longer valid on a 401', async () => {
    const { session } = sessionFor(
      SPIKE,
      () => new Response('{}', { status: 401 }),
    )
    mountInspector(session, { uri: OWN_POST })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your sign-in is no longer valid. Sign in again to read this record.',
    )
  })

  it('shows another author space record as a labelled snapshot and sends no request while open', async () => {
    const { session, requests } = sessionFor(SPIKE, () => {
      throw new Error('the session must not be used')
    })
    mountInspector(session, {
      uri: OTHER_POST,
      record: { text: 'Served copy.' },
      indexedAt: '2026-09-07T08:00:05.000Z',
    })

    expect(await screen.findByText('Feed snapshot')).toBeInTheDocument()
    expect(screen.getByText(/Served copy\./)).toBeInTheDocument()
    expect(screen.getByText(OTHER_POST)).toBeInTheDocument()
    expect(
      screen.getByText(
        'This is the copy the feed served, not a live read from the PDS.',
      ),
    ).toBeInTheDocument()
    const time = document.querySelector('time')
    expect(time).toHaveAttribute('datetime', '2026-09-07T08:00:05.000Z')
    expect(time?.textContent).toBe(
      new Date('2026-09-07T08:00:05.000Z').toLocaleString(),
    )
    expect(
      screen.queryByText('Your record on your PDS'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Public Record')).not.toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(requests).toEqual([])
    expect(publicRequests).toEqual([])
  })

  it('says nothing can be shown when the feed kept no record, still without a request', async () => {
    const { session, requests } = sessionFor(SPIKE, () => new Response('{}'))
    mountInspector(session, { uri: OTHER_POST })

    expect(await screen.findByText('Feed snapshot')).toBeInTheDocument()
    expect(
      screen.getByText(
        'The feed did not keep a copy of this record, so there is nothing to show here.',
      ),
    ).toBeInTheDocument()
    expect(requests).toEqual([])
    expect(publicRequests).toEqual([])
  })

  it.each([
    ['an earlier-spelling record', LEGACY_SPACE_POST],
    ['an empty string', ''],
    ['plain text', 'not an address'],
  ])(
    'says the address is not valid for %s and sends nothing',
    async (_label, uri) => {
      const { session, requests } = sessionFor(SPIKE, () => new Response('{}'))
      mountInspector(session, { uri })

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'This record address is not valid',
      )
      expect(screen.queryByText('Public Record')).not.toBeInTheDocument()
      expect(requests).toEqual([])
      expect(publicRequests).toEqual([])
    },
  )

  it.each([
    ['a custody record', `${CUSTODY_POST}\n`],
    ['a custody record', `${CUSTODY_POST}\r\n`],
    ['an own space record', `${OWN_POST}\n`],
    ['an own space record', `${OWN_POST}\r\n`],
    ['another author space record', `${OTHER_POST}\n`],
  ])(
    'says the address is not valid for %s ending in a line terminator and sends nothing',
    async (_label, uri) => {
      const { session, requests } = sessionFor(SPIKE, () => new Response('{}'))
      mountInspector(session, {
        uri,
        record: { text: 'See you, space cowboy.' },
      })

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'This record address is not valid',
      )
      expect(screen.queryByText('Public Record')).not.toBeInTheDocument()
      expect(
        screen.queryByText('Private Hydrated Record'),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByText('Your record on your PDS'),
      ).not.toBeInTheDocument()
      expect(screen.queryByText('Feed snapshot')).not.toBeInTheDocument()
      expect(requests).toEqual([])
      expect(publicRequests).toEqual([])
    },
  )
})

describe('late answers and changed sessions', () => {
  it('never shows a late answer for an earlier post', async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    const { session, requests } = sessionFor(SPIKE, (url) =>
      url === ownRequest('swordfish') ? first.promise : second.promise,
    )
    const { rerender } = mountInspector(session, { uri: OWN_POST })
    await waitFor(() => expect(requests).toHaveLength(1))

    await rerender({ uri: OWN_POST_TWO })
    await waitFor(() => expect(requests).toHaveLength(2))
    first.resolve(found(OWN_POST, 'Answer for the first post.'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(
      screen.queryByText(/Answer for the first post\./),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { hidden: true })).toHaveAttribute(
      'aria-busy',
      'true',
    )

    second.resolve(found(OWN_POST_TWO, 'Answer for the second post.'))
    expect(
      await screen.findByText(/Answer for the second post\./),
    ).toBeInTheDocument()
    expect(requests).toEqual([
      ownRequest('swordfish'),
      ownRequest('hammerhead'),
    ])
  })

  it('does not let an earlier answer replace the current one', async () => {
    const first = deferred<Response>()
    const { session, requests } = sessionFor(SPIKE, (url) =>
      url === ownRequest('swordfish')
        ? first.promise
        : found(OWN_POST_TWO, 'Answer for the second post.'),
    )
    const { rerender } = mountInspector(session, { uri: OWN_POST })
    await waitFor(() => expect(requests).toHaveLength(1))
    await rerender({ uri: OWN_POST_TWO })
    expect(
      await screen.findByText(/Answer for the second post\./),
    ).toBeInTheDocument()

    first.resolve(found(OWN_POST, 'Answer for the first post.'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.getByText(/Answer for the second post\./)).toBeInTheDocument()
    expect(
      screen.queryByText(/Answer for the first post\./),
    ).not.toBeInTheDocument()
  })

  it.each([
    ['a different session for the same account', 'same-account'],
    ['sign-out', 'signed-out'],
    ['another account', 'other-account'],
  ] as const)('closes and clears on %s', async (_label, change) => {
    const { session } = sessionFor(SPIKE, () => found(OWN_POST, 'Bang.'))
    const { context, onclose } = mountInspector(session, { uri: OWN_POST })
    expect(await screen.findByText(/Bang\./)).toBeInTheDocument()

    context.session =
      change === 'signed-out'
        ? null
        : sessionFor(change === 'same-account' ? SPIKE : FAYE, () =>
            found(OWN_POST, 'Someone else.'),
          ).session
    flushSync()

    await waitFor(() => expect(onclose).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/Bang\./)).not.toBeInTheDocument()
    expect(document.querySelector('dialog')).not.toHaveAttribute('open')
  })

  it('shows nothing from an earlier record when the inspector is opened again', async () => {
    const first = sessionFor(SPIKE, () => found(OWN_POST, 'Bang.'))
    const opened = mountInspector(first.session, { uri: OWN_POST })
    expect(await screen.findByText(/Bang\./)).toBeInTheDocument()
    opened.unmount()

    const pending = deferred<Response>()
    const second = sessionFor(SPIKE, () => pending.promise)
    mountInspector(second.session, { uri: OWN_POST_TWO })
    await waitFor(() => expect(second.requests).toHaveLength(1))
    expect(screen.queryByText(/Bang\./)).not.toBeInTheDocument()
    expect(
      screen.queryByText('Your record on your PDS'),
    ).not.toBeInTheDocument()
  })
})

describe('dialog behaviour', () => {
  it('is named, busy while loading and not busy afterwards', async () => {
    const pending = deferred<Response>()
    const { session } = sessionFor(SPIKE, () => pending.promise)
    mountInspector(session, { uri: OWN_POST })

    const dialog = screen.getByRole('dialog', { name: 'Record Inspector' })
    expect(dialog).toHaveAttribute('aria-labelledby', 'inspector-title')
    expect(dialog).toHaveAttribute('aria-busy', 'true')
    pending.resolve(found(OWN_POST, 'Bang.'))
    await screen.findByText(/Bang\./)
    expect(dialog).toHaveAttribute('aria-busy', 'false')
  })

  it('closes on Escape and returns focus to the control that opened it', async () => {
    const opener = document.createElement('button')
    opener.textContent = 'Inspect'
    document.body.append(opener)
    opener.focus()
    const { session } = sessionFor(SPIKE, () => found(OWN_POST, 'Bang.'))
    const { onclose } = mountInspector(session, { uri: OWN_POST })
    await screen.findByText(/Bang\./)

    const dialog = screen.getByRole('dialog')
    const escape = new Event('cancel', { cancelable: true })
    await fireEvent(dialog, escape)

    expect(escape.defaultPrevented).toBe(true)
    expect(onclose).toHaveBeenCalledTimes(1)
    expect(dialog).not.toHaveAttribute('open')
    expect(opener).toHaveFocus()
    opener.remove()
  })

  it('closes from the labelled close button and returns focus', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const { session } = sessionFor(SPIKE, () => found(OWN_POST, 'Bang.'))
    const { onclose } = mountInspector(session, { uri: OWN_POST })
    await screen.findByText(/Bang\./)

    await fireEvent.click(
      screen.getByRole('button', { name: 'Close record inspector' }),
    )

    expect(onclose).toHaveBeenCalledTimes(1)
    expect(opener).toHaveFocus()
    opener.remove()
  })
})

describe('opening from a post card', () => {
  it('opens an own space post from its card, reads it once and gives focus back to the card control', async () => {
    const { session, requests } = sessionFor(SPIKE, () =>
      found(OWN_POST, 'Bang.'),
    )
    const context = createInspectorContext(session, STRATOS)
    render(PostCard, {
      props: {
        post: {
          uri: OWN_POST,
          cid: 'bafy-bebop',
          author: SPIKE,
          authorHandle: 'spike.example',
          text: 'Bang.',
          createdAt: '2026-09-07T08:00:00.000Z',
          boundaries: [],
          isPrivate: true,
          reply: null,
        },
        stratosAgent: null,
        currentDid: SPIKE,
        onreply: () => {},
        ondelete: async () => {},
      },
      context: new Map([['stratos-inspector', context]]),
    })

    const opener = screen.getByRole('button', {
      name: 'Inspect your record on your PDS',
    })
    opener.focus()
    await fireEvent.click(opener)
    expect(
      await screen.findByText('Your record on your PDS'),
    ).toBeInTheDocument()
    expect(requests).toEqual([ownRequest('swordfish')])

    await fireEvent.click(
      screen.getByRole('button', { name: 'Close record inspector' }),
    )
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { hidden: true })).toBeNull(),
    )
    expect(opener).toHaveFocus()
    expect(opener).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows another author post from the card with no request', async () => {
    const { session, requests } = sessionFor(SPIKE, () => new Response('{}'))
    const context = createInspectorContext(session, STRATOS)
    render(PostCard, {
      props: {
        post: {
          uri: OTHER_POST,
          cid: 'bafy-redtail',
          author: FAYE,
          authorHandle: 'faye.example',
          text: 'Redtail.',
          createdAt: '2026-09-07T08:00:00.000Z',
          boundaries: [],
          isPrivate: true,
          reply: null,
        },
        stratosAgent: null,
        currentDid: SPIKE,
        onreply: () => {},
        ondelete: async () => {},
      },
      context: new Map([['stratos-inspector', context]]),
    })

    await fireEvent.click(
      screen.getByRole('button', { name: 'Inspect the copy the feed served' }),
    )
    expect(await screen.findByText('Feed snapshot')).toBeInTheDocument()
    expect(requests).toEqual([])
    expect(publicRequests).toEqual([])
  })

  it('shows the served record and indexed time as a snapshot for another author, with no request anywhere', async () => {
    const { session, requests } = sessionFor(SPIKE, () => new Response('{}'))
    const context = createInspectorContext(session, STRATOS)
    render(PostCard, {
      props: {
        post: {
          uri: OTHER_POST,
          cid: 'bafy-redtail',
          author: FAYE,
          authorHandle: 'faye.example',
          text: 'Display text only.',
          createdAt: '2026-09-07T08:00:00.000Z',
          boundaries: [],
          isPrivate: true,
          reply: null,
          record: { text: 'Served record text.', marker: 'raw-field' },
          indexedAt: '2026-09-07T08:00:05.000Z',
        },
        stratosAgent: null,
        currentDid: SPIKE,
        onreply: () => {},
        ondelete: async () => {},
      },
      context: new Map([['stratos-inspector', context]]),
    })

    await fireEvent.click(
      screen.getByRole('button', { name: 'Inspect the copy the feed served' }),
    )
    expect(await screen.findByText('Feed snapshot')).toBeInTheDocument()
    expect(screen.getByText(/Served record text\./)).toBeInTheDocument()
    expect(screen.getByText(/raw-field/)).toBeInTheDocument()
    expect(
      screen.queryByText(/The feed did not keep a copy/),
    ).not.toBeInTheDocument()
    expect(document.querySelector('dialog time')).toHaveAttribute(
      'datetime',
      '2026-09-07T08:00:05.000Z',
    )
    expect(requests).toEqual([])
    expect(publicRequests).toEqual([])
  })

  it('shows the snapshot for a post that came through the feed mapper', async () => {
    const served = {
      $type: 'zone.stratos.feed.post',
      text: 'Redtail, as served.',
      createdAt: '2026-09-07T08:00:00.000Z',
    }
    const feedSession = {
      sub: SPIKE,
      fetchHandler: async () =>
        new Response(
          JSON.stringify({
            feed: [
              {
                post: {
                  uri: OTHER_POST,
                  cid: 'bafy-redtail',
                  indexedAt: '2026-09-07T08:00:05.000Z',
                  author: { did: FAYE, handle: 'faye.example' },
                  record: served,
                },
              },
            ],
          }),
        ),
    } as unknown as OAuthSession
    const result = await fetchFeedgenPosts(
      feedSession,
      'did:web:batou.test',
      'private',
    )
    expect(result.ok).toBe(true)
    const { session, requests } = sessionFor(SPIKE, () => new Response('{}'))
    render(PostCard, {
      props: {
        post: result.posts[0],
        stratosAgent: null,
        currentDid: SPIKE,
        onreply: () => {},
        ondelete: async () => {},
      },
      context: new Map([
        ['stratos-inspector', createInspectorContext(session, STRATOS)],
      ]),
    })
    await fireEvent.click(
      screen.getByRole('button', { name: 'Inspect the copy the feed served' }),
    )
    expect(await screen.findByText('Feed snapshot')).toBeInTheDocument()
    expect(screen.getAllByText(/Redtail, as served\./).length).toBeGreaterThan(
      1,
    )
    expect(requests).toEqual([])
    expect(publicRequests).toEqual([])
  })

  it('does not name an unreadable parent author as the empty string', () => {
    render(PostCard, {
      post: {
        uri: OWN_POST,
        cid: 'bafy-bebop',
        author: SPIKE,
        authorHandle: 'spike.example',
        text: 'Bang.',
        createdAt: '2026-09-07T08:00:00.000Z',
        boundaries: [],
        isPrivate: true,
        reply: {
          root: { uri: OWN_POST, cid: 'bafy-bebop' },
          parent: { uri: 'not an address', cid: 'bafy-parent' },
        },
      },
      stratosAgent: null,
      currentDid: SPIKE,
      onreply: () => {},
      ondelete: async () => {},
    })
    expect(screen.getByText('↩ replying to a post')).toBeInTheDocument()
  })
})

describe('a feed refresh while the inspector is open', () => {
  it('does not read an own space record again when the same post gets a new record object', async () => {
    const { session, requests } = sessionFor(SPIKE, () =>
      found(OWN_POST, 'Bang.'),
    )
    const { rerender } = mountInspector(session, {
      uri: OWN_POST,
      record: { text: 'Bang.' },
      indexedAt: '2026-09-07T08:00:05.000Z',
    })
    expect(await screen.findByText(/Bang\./)).toBeInTheDocument()

    await rerender({
      uri: OWN_POST,
      record: { text: 'Bang.' },
      indexedAt: '2026-09-07T08:00:06.000Z',
    })
    expect(screen.queryByText(/Fetching records/)).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { hidden: true })).toHaveAttribute(
      'aria-busy',
      'false',
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.getByText(/Bang\./)).toBeInTheDocument()
    expect(requests).toEqual([ownRequest('swordfish')])
    expect(publicRequests).toEqual([])
  })

  it('does not repeat the three custody requests when the same post gets a new record object', async () => {
    const { session, requests } = sessionFor(
      SPIKE,
      () => new Response(JSON.stringify({ value: { text: 'private copy' } })),
    )
    const { rerender } = mountInspector(session, {
      uri: CUSTODY_POST,
      record: { text: 'Sync report.' },
    })
    expect(await screen.findByText(/private copy/)).toBeInTheDocument()

    await rerender({ uri: CUSTODY_POST, record: { text: 'Sync report.' } })
    expect(screen.queryByText(/Fetching records/)).not.toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.getByText(/private copy/)).toBeInTheDocument()
    expect([...publicRequests, ...requests]).toHaveLength(3)
    expect(publicRequests).toEqual([
      'https://plc.directory/did%3Aplc%3Aspikespiegel',
      'https://pds.example/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Aspikespiegel&collection=zone.stratos.feed.post&rkey=swordfish',
    ])
    expect(requests).toEqual([
      `${STRATOS}/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Aspikespiegel&collection=zone.stratos.feed.post&rkey=swordfish`,
    ])
  })

  it('shows the new record of another author post at once, without a request', async () => {
    const { session, requests } = sessionFor(SPIKE, () => {
      throw new Error('the session must not be used')
    })
    const { rerender } = mountInspector(session, {
      uri: OTHER_POST,
      record: { text: 'Served copy.' },
      indexedAt: '2026-09-07T08:00:05.000Z',
    })
    expect(await screen.findByText(/Served copy\./)).toBeInTheDocument()

    await rerender({
      uri: OTHER_POST,
      record: { text: 'Refreshed copy.' },
      indexedAt: '2026-09-07T08:01:00.000Z',
    })
    expect(screen.queryByText(/Fetching records/)).not.toBeInTheDocument()
    expect(screen.getByText(/Refreshed copy\./)).toBeInTheDocument()
    expect(screen.queryByText(/Served copy\./)).not.toBeInTheDocument()
    expect(document.querySelector('dialog time')).toHaveAttribute(
      'datetime',
      '2026-09-07T08:01:00.000Z',
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(requests).toEqual([])
    expect(publicRequests).toEqual([])
  })
})

describe('a feed refresh while the inspector is open from a card', () => {
  it('reads an own space post once when the card gets a new post object for it', async () => {
    const { session, requests } = sessionFor(SPIKE, () =>
      found(OWN_POST, 'Bang.'),
    )
    const post = {
      uri: OWN_POST,
      cid: 'bafy-bebop',
      author: SPIKE,
      authorHandle: 'spike.example',
      text: 'Bang.',
      createdAt: '2026-09-07T08:00:00.000Z',
      boundaries: [],
      isPrivate: true,
      reply: null,
      record: { text: 'Bang.' },
      indexedAt: '2026-09-07T08:00:05.000Z',
    }
    const { rerender } = render(PostCard, {
      props: {
        post,
        stratosAgent: null,
        currentDid: SPIKE,
        onreply: () => {},
        ondelete: async () => {},
      },
      context: new Map([
        ['stratos-inspector', createInspectorContext(session, STRATOS)],
      ]),
    })
    await fireEvent.click(
      screen.getByRole('button', { name: 'Inspect your record on your PDS' }),
    )
    expect(
      await screen.findByText('Your record on your PDS'),
    ).toBeInTheDocument()

    await rerender({
      post: {
        ...post,
        record: { text: 'Bang.' },
        indexedAt: '2026-09-07T08:00:06.000Z',
      },
    })
    expect(screen.queryByText(/Fetching records/)).not.toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.getByText('Your record on your PDS')).toBeInTheDocument()
    expect(requests).toEqual([ownRequest('swordfish')])
    expect(publicRequests).toEqual([])
  })
})

describe('a session replaced by another signed-in session', () => {
  it.each([
    ['the same account', 'its own space post', SPIKE, OWN_POST],
    ['the same account', 'a custody post', SPIKE, CUSTODY_POST],
    ['another account', 'a custody post', FAYE, CUSTODY_POST],
  ])(
    'sends nothing with the new session for %s and %s until the inspector is opened again',
    async (_account, _post, replacementDid, uri) => {
      const { session } = sessionFor(SPIKE, () => found(uri, 'Bang.'))
      const { context, onclose, unmount } = mountInspector(session, { uri })
      expect((await screen.findAllByText(/Bang\./)).length).toBeGreaterThan(0)
      const publicBefore = [...publicRequests]

      const replacement = sessionFor(replacementDid, () =>
        found(uri, 'Read with the new session.'),
      )
      context.session = replacement.session
      flushSync()
      await waitFor(() => expect(onclose).toHaveBeenCalledTimes(1))
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(replacement.requests).toEqual([])
      expect(publicRequests).toEqual(publicBefore)
      expect(screen.queryByText(/Bang\./)).not.toBeInTheDocument()
      expect(
        screen.queryByText(/Read with the new session\./),
      ).not.toBeInTheDocument()
      expect(document.querySelector('dialog')).not.toHaveAttribute('open')

      unmount()
      mountInspector(replacement.session, { uri })
      await waitFor(() => expect(replacement.requests).toHaveLength(1))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(replacement.requests).toHaveLength(1)
    },
  )

  it('ignores an answer for the earlier session that arrives after the change', async () => {
    const pending = deferred<Response>()
    const { session, requests } = sessionFor(SPIKE, () => pending.promise)
    const { context, onclose } = mountInspector(session, { uri: OWN_POST })
    await waitFor(() => expect(requests).toHaveLength(1))

    const replacement = sessionFor(SPIKE, () => found(OWN_POST, 'New.'))
    context.session = replacement.session
    flushSync()
    await waitFor(() => expect(onclose).toHaveBeenCalledTimes(1))
    pending.resolve(found(OWN_POST, 'Answer for the earlier session.'))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(
      screen.queryByText(/Answer for the earlier session\./),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Your record on your PDS'),
    ).not.toBeInTheDocument()
    expect(replacement.requests).toEqual([])
  })
})

describe('labels that name the source', () => {
  it.each([
    [
      'a custody post',
      CUSTODY_POST,
      'What the PDS shows publicly, and what Stratos holds privately',
    ],
    ['an own space post', OWN_POST, 'Read from your PDS with your sign-in'],
    [
      'another author space post',
      OTHER_POST,
      'The copy the feed already served',
    ],
  ])(
    'names the source in the subtitle from the first frame for %s',
    (_label, uri, subtitle) => {
      const { session } = sessionFor(SPIKE, () => deferred<Response>().promise)
      global.fetch = vi.fn(
        () => deferred<Response>().promise,
      ) as unknown as typeof fetch
      mountInspector(session, { uri, record: { text: 'Served copy.' } })

      expect(screen.getByText(subtitle)).toBeInTheDocument()
      expect(
        screen.queryByText('PDS stub → Stratos hydration reference chain'),
      ).not.toBeInTheDocument()
    },
  )

  it('shows the own space subtitle while the read is still loading', async () => {
    const pending = deferred<Response>()
    const { session } = sessionFor(SPIKE, () => pending.promise)
    mountInspector(session, { uri: OWN_POST })
    await waitFor(() =>
      expect(screen.getByRole('dialog', { hidden: true })).toHaveAttribute(
        'aria-busy',
        'true',
      ),
    )
    expect(
      screen.getByText('Read from your PDS with your sign-in'),
    ).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Fetching records…')
  })

  it.each([
    [
      'a custody post',
      CUSTODY_POST,
      SPIKE,
      'Inspect the public and private records',
    ],
    ['an own space post', OWN_POST, SPIKE, 'Inspect your record on your PDS'],
    [
      'another author space post',
      OTHER_POST,
      FAYE,
      'Inspect the copy the feed served',
    ],
  ])('names the source on the opener of %s', (_label, uri, author, name) => {
    const { session, requests } = sessionFor(SPIKE, () => new Response('{}'))
    render(PostCard, {
      props: {
        post: {
          uri,
          cid: 'bafy-bebop',
          author,
          authorHandle: '',
          text: 'Bang.',
          createdAt: '2026-09-07T08:00:00.000Z',
          boundaries: [],
          isPrivate: true,
          reply: null,
        },
        stratosAgent: null,
        currentDid: SPIKE,
        onreply: () => {},
        ondelete: async () => {},
      },
      context: new Map([
        ['stratos-inspector', createInspectorContext(session, STRATOS)],
      ]),
    })

    const opener = screen.getByRole('button', { name })
    expect(opener).toHaveAttribute('title', name)
    expect(
      screen.queryByRole('button', { name: 'Inspect record custody' }),
    ).not.toBeInTheDocument()
    expect(requests).toEqual([])
    expect(publicRequests).toEqual([])
  })
})
