import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type {
  ClubhouseIdentity,
  ClubhouseIntegration,
  RoomAccessState,
} from './lib/types'
import type { ClubhouseFeedPost, FeedPage } from './lib/feedgen'
import { rememberRoomJoin, rememberRoomReturn } from './lib/join'

const mocks = vi.hoisted(() => ({
  createIntegration: vi.fn(),
  captureException: vi.fn(),
}))

vi.mock('./lib/integration', () => ({
  createClubhouseIntegration: mocks.createIntegration,
}))
vi.mock('./telemetry', () => ({
  withClubhouseSpan: (_name: string, task: () => unknown) => task(),
  captureClubhouseException: mocks.captureException,
}))

import App from './App.svelte'

const rooms = [
  {
    id: 'nerv',
    displayName: 'Tokyo-3',
    description: 'The pilots lounge',
    available: true,
  },
  {
    id: 'bebop',
    displayName: 'Bebop',
    description: 'The crew lounge',
    available: true,
  },
]
const rei: ClubhouseIdentity = { did: 'did:plc:rei', handle: 'rei.example' }
const joined = { nerv: 'joined', bebop: 'joined' } as const

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function post(rkey = 'eva', text = 'Meet at Tokyo-3'): ClubhouseFeedPost {
  return {
    uri: `at://${rei.did}/zone.stratos.feed.post/${rkey}`,
    cid: `cid-${rkey}`,
    author: { did: rei.did },
    text,
    indexedAt: '2026-09-07T08:00:00Z',
  }
}

function button(label: string): HTMLButtonElement {
  const result = [...document.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === label,
  )
  expect(result, `button ${label}`).toBeDefined()
  return result!
}

let component: ReturnType<typeof mount> | undefined

function render(
  integration: ClubhouseIntegration,
  path = '/',
  catalogFetcher = vi.fn().mockResolvedValue(rooms),
) {
  window.history.replaceState({}, '', path)
  component = mount(App, {
    target: document.body,
    props: { integration, catalogFetcher },
  })
  return catalogFetcher
}

function renderRoom(overrides: ClubhouseIntegration = {}) {
  const integration = {
    initialize: vi.fn().mockResolvedValue(rei),
    getRoomStates: vi.fn().mockResolvedValue(joined),
    getFeed: vi.fn().mockResolvedValue({ posts: [post()] }),
    ...overrides,
  }
  render(integration, '/rooms/nerv')
  return integration
}

afterEach(async () => {
  if (component) await unmount(component)
  component = undefined
  document.body.replaceChildren()
  window.sessionStorage.clear()
  window.history.replaceState({}, '', '/')
  vi.clearAllMocks()
})

describe('room loading', () => {
  it('starts the catalogue before dynamic session setup and renders it while auth and membership are pending', async () => {
    const catalog = deferred<typeof rooms>()
    const session = deferred<ClubhouseIdentity | null>()
    const membership = deferred<Record<string, RoomAccessState>>()
    const initialize = vi.fn(() => session.promise)
    const getRoomStates = vi.fn(() => membership.promise)
    const catalogFetcher = vi.fn(() => catalog.promise)
    mocks.createIntegration.mockImplementation(() => {
      expect(catalogFetcher).toHaveBeenCalledOnce()
      return { initialize, getRoomStates }
    })
    render({}, '/', catalogFetcher)
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce())
    expect(getRoomStates).not.toHaveBeenCalled()

    catalog.resolve(rooms)
    await vi.waitFor(() =>
      expect(document.querySelector('.room-grid')).not.toBeNull(),
    )
    expect(document.body.textContent).toContain('Tokyo-3')
    expect(
      document.querySelector('.room-card .status')?.textContent?.trim(),
    ).toBe('Checking room access…')
    expect(document.querySelector('.sign-in')).toBeNull()
    expect(button('Checking access…').disabled).toBe(true)
    expect(getRoomStates).not.toHaveBeenCalled()

    session.resolve(rei)
    await vi.waitFor(() =>
      expect(getRoomStates).toHaveBeenCalledWith(['nerv', 'bebop']),
    )
    expect(document.body.textContent).toContain('Signed in as rei.example')
    expect(button('Checking access…').disabled).toBe(true)
    membership.resolve(joined)
    await vi.waitFor(() => expect(button('Open room').disabled).toBe(false))
  })

  it('shows the selected room before the feed and renders posts before author enrichment completes', async () => {
    const feed = deferred<FeedPage>()
    const enrichment = deferred<FeedPage>()
    const enrichFeedAuthors = vi.fn(() => {
      expect(document.body.textContent).toContain('Meet at Tokyo-3')
      return enrichment.promise
    })
    renderRoom({ getFeed: () => feed.promise, enrichFeedAuthors })
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Loading room topics…'),
    )
    expect(document.querySelector('#room-title')?.textContent).toBe('Tokyo-3')
    expect(document.querySelector('.loading-state')).toBeNull()
    feed.resolve({ posts: [post()], cursor: 'next' })
    await vi.waitFor(() => expect(enrichFeedAuthors).toHaveBeenCalledOnce())
    expect(document.body.textContent).toContain('Meet at Tokyo-3')
    expect(button('Load more topics').disabled).toBe(false)

    enrichment.resolve({
      posts: [
        {
          ...post('eva', 'Stale text'),
          author: { ...post().author, displayName: 'Rei Ayanami' },
        },
      ],
    })
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Rei Ayanami'),
    )
    expect(document.body.textContent).toContain('Meet at Tokyo-3')
    expect(document.body.textContent).not.toContain('Stale text')
    expect(button('Load more topics')).toBeDefined()
  })

  it('shows selected-room access checking until both session and membership resolve', async () => {
    const session = deferred<ClubhouseIdentity | null>()
    const membership = deferred<Record<string, RoomAccessState>>()
    const getRoomStates = vi.fn(() => membership.promise)
    const { getFeed } = renderRoom({
      initialize: () => session.promise,
      getRoomStates,
    })
    await vi.waitFor(() =>
      expect(document.querySelector('#room-title')?.textContent).toBe(
        'Tokyo-3',
      ),
    )
    expect(document.querySelector('.feed-status')?.textContent).toBe(
      'Checking room access…',
    )
    expect(document.querySelector('.feed-panel')).toBeNull()
    expect(getRoomStates).not.toHaveBeenCalled()
    expect(getFeed).not.toHaveBeenCalled()
    session.resolve(rei)
    await vi.waitFor(() => expect(getRoomStates).toHaveBeenCalledOnce())
    expect(document.querySelector('.feed-status')?.textContent).toBe(
      'Checking room access…',
    )
    expect(document.querySelector('.feed-panel')).toBeNull()
    expect(getFeed).not.toHaveBeenCalled()
    membership.resolve(joined)
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Meet at Tokyo-3'),
    )
  })

  it('merges earlier author results without dropping paginated posts or their cursor', async () => {
    const enrichment = deferred<FeedPage>()
    const getFeed = vi
      .fn()
      .mockResolvedValueOnce({ posts: [post()], cursor: 'eva-next' })
      .mockResolvedValueOnce({
        posts: [post('asuka', 'Asuka joins')],
        cursor: 'asuka-next',
      })
      .mockResolvedValue({ posts: [] })
    const enrichFeedAuthors = vi
      .fn()
      .mockReturnValueOnce(enrichment.promise)
      .mockImplementation(async (page: FeedPage) => page)
    renderRoom({ getFeed, enrichFeedAuthors })
    await vi.waitFor(() => expect(enrichFeedAuthors).toHaveBeenCalledOnce())
    button('Load more topics').click()
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Asuka joins'),
    )
    enrichment.resolve({
      posts: [
        { ...post(), author: { did: rei.did, displayName: 'Rei Ayanami' } },
      ],
      cursor: 'old-cursor',
    })
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Rei Ayanami'),
    )
    expect(document.body.textContent).toContain('Asuka joins')
    button('Load more topics').click()
    await vi.waitFor(() =>
      expect(getFeed).toHaveBeenLastCalledWith('nerv', 50, 'asuka-next'),
    )
  })

  it('ignores author results from a previous visit to the same room', async () => {
    const enrichment = deferred<FeedPage>()
    const enrichFeedAuthors = vi
      .fn()
      .mockReturnValueOnce(enrichment.promise)
      .mockImplementation(async (page: FeedPage) => page)
    renderRoom({ enrichFeedAuthors })
    await vi.waitFor(() => expect(enrichFeedAuthors).toHaveBeenCalledOnce())
    button('Back to rooms').click()
    await tick()
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    button('Open room').click()
    await vi.waitFor(() => expect(enrichFeedAuthors).toHaveBeenCalledTimes(2))
    enrichment.resolve({
      posts: [
        { ...post(), author: { did: rei.did, displayName: 'Outdated Rei' } },
      ],
    })
    await tick()
    await tick()
    expect(document.body.textContent).not.toContain('Outdated Rei')
    expect(document.body.textContent).toContain('Meet at Tokyo-3')
  })

  it('does not revive private posts after sign-out while enrichment is pending', async () => {
    const enrichment = deferred<FeedPage>()
    const enrichFeedAuthors = vi.fn(() => enrichment.promise)
    renderRoom({ enrichFeedAuthors, signOut: async () => {} })
    await vi.waitFor(() => expect(enrichFeedAuthors).toHaveBeenCalledOnce())
    button('Sign out').click()
    await vi.waitFor(() =>
      expect(document.querySelector('.sign-in')).not.toBeNull(),
    )
    enrichment.resolve({
      posts: [
        { ...post(), author: { did: rei.did, displayName: 'Outdated Rei' } },
      ],
    })
    await tick()
    await tick()
    expect(document.body.textContent).not.toContain('Meet at Tokyo-3')
    expect(document.body.textContent).not.toContain('Outdated Rei')
    expect(button('Join room').disabled).toBe(false)
  })

  it('rejects old author enrichment when browser navigation reloads the same room', async () => {
    const enrichment = deferred<FeedPage>()
    const enrichFeedAuthors = vi
      .fn()
      .mockReturnValueOnce(enrichment.promise)
      .mockImplementation(async (page: FeedPage) => page)
    renderRoom({ enrichFeedAuthors })
    await vi.waitFor(() => expect(enrichFeedAuthors).toHaveBeenCalledOnce())
    window.history.replaceState(
      {},
      '',
      `/rooms/nerv?topic=${encodeURIComponent(post().uri)}`,
    )
    window.dispatchEvent(new PopStateEvent('popstate'))
    await vi.waitFor(() => expect(enrichFeedAuthors).toHaveBeenCalledTimes(2))
    enrichment.resolve({
      posts: [
        { ...post(), author: { did: rei.did, displayName: 'Outdated Rei' } },
      ],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await tick()
    expect(document.querySelector('.thread-view')).not.toBeNull()
    expect(document.body.textContent).toContain('Meet at Tokyo-3')
    expect(document.body.textContent).not.toContain('Outdated Rei')
  })

  it('rejects old author results after a post refresh replaces the feed', async () => {
    const enrichment = deferred<FeedPage>()
    const updated = {
      ...post('eva', 'Updated topic'),
      author: { did: rei.did, displayName: 'Current Rei' },
    }
    const getFeed = vi
      .fn()
      .mockResolvedValueOnce({ posts: [post()] })
      .mockResolvedValue({ posts: [updated, post('asuka', 'New topic')] })
    const enrichFeedAuthors = vi
      .fn()
      .mockReturnValueOnce(enrichment.promise)
      .mockImplementation(async (page: FeedPage) => page)
    renderRoom({
      getFeed,
      enrichFeedAuthors,
      createPost: async () => ({ uri: 'asuka', cid: 'cid-asuka' }),
    })
    await vi.waitFor(() => expect(enrichFeedAuthors).toHaveBeenCalledOnce())
    const input = document.querySelector<HTMLTextAreaElement>('#room-post')!
    input.value = 'New topic'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    input.form!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Updated topic'),
    )
    enrichment.resolve({
      posts: [
        { ...post(), author: { did: rei.did, displayName: 'Outdated Rei' } },
      ],
    })
    await tick()
    await tick()
    expect(document.body.textContent).toContain('Current Rei')
    expect(document.body.textContent).toContain('New topic')
    expect(document.body.textContent).not.toContain('Outdated Rei')
    expect(document.body.textContent).not.toContain('Meet at Tokyo-3')
  })

  it('ignores membership that completes after sign-out', async () => {
    const membership = deferred<Record<string, RoomAccessState>>()
    const getRoomStates = vi.fn(() => membership.promise)
    const { getFeed } = renderRoom({ getRoomStates, signOut: async () => {} })
    await vi.waitFor(() => expect(getRoomStates).toHaveBeenCalledOnce())
    button('Sign out').click()
    await vi.waitFor(() =>
      expect(document.querySelector('.sign-in')).not.toBeNull(),
    )
    membership.resolve(joined)
    await tick()
    await tick()
    expect(getFeed).not.toHaveBeenCalled()
    expect(button('Join room').disabled).toBe(false)
  })

  it('ignores a failed membership lookup after sign-out', async () => {
    const membership = deferred<Record<string, RoomAccessState>>()
    const getRoomStates = vi.fn(() => membership.promise)
    renderRoom({ getRoomStates, signOut: async () => {} })
    await vi.waitFor(() => expect(getRoomStates).toHaveBeenCalledOnce())
    button('Sign out').click()
    await vi.waitFor(() =>
      expect(document.querySelector('.sign-in')).not.toBeNull(),
    )
    membership.reject(new Error('Membership unavailable'))
    await tick()
    await tick()
    expect(document.body.textContent).toContain('Signed out')
    expect(document.body.textContent).not.toContain(
      'Room access status is unavailable.',
    )
  })

  it.each([false, true])(
    'handles single-room status completion with signedOut=%s',
    async (signedOut) => {
      const membership = deferred<RoomAccessState>()
      const getRoomState = vi.fn(() => membership.promise)
      const { getFeed } = renderRoom({
        getRoomStates: undefined,
        getRoomState,
        signOut: async () => {},
      })
      await vi.waitFor(() =>
        expect(getRoomState).toHaveBeenCalledTimes(rooms.length),
      )
      if (signedOut) {
        button('Sign out').click()
        await vi.waitFor(() =>
          expect(document.querySelector('.sign-in')).not.toBeNull(),
        )
      }
      membership.resolve('joined')
      if (signedOut) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        await tick()
        expect(getFeed).not.toHaveBeenCalled()
        expect(button('Join room').disabled).toBe(false)
      } else {
        await vi.waitFor(() =>
          expect(document.body.textContent).toContain('Meet at Tokyo-3'),
        )
      }
    },
  )

  it('keeps readable posts when optional enrichment fails', async () => {
    const cause = new Error('Profile lookup unavailable')
    renderRoom({
      enrichFeedAuthors: async () => {
        throw cause
      },
    })
    await vi.waitFor(() =>
      expect(mocks.captureException).toHaveBeenCalledWith(cause),
    )
    expect(document.body.textContent).toContain('Meet at Tokyo-3')
    expect(document.querySelector('.feed-status-error')).toBeNull()
  })

  it('supports integrations without optional author enrichment', async () => {
    renderRoom()
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Meet at Tokyo-3'),
    )
    expect(mocks.captureException).not.toHaveBeenCalled()
  })

  it('makes sign-in available when session restoration fails without hiding the catalogue', async () => {
    render({
      initialize: async () => {
        throw new Error('Session expired')
      },
    })
    await vi.waitFor(() =>
      expect(document.querySelector('.sign-in')).not.toBeNull(),
    )
    expect(document.body.textContent).toContain(
      'Saved session could not be restored',
    )
    expect(document.body.textContent).toContain('Tokyo-3')
    expect(button('Join room').disabled).toBe(false)
  })

  it('ends the access placeholder after membership fails without treating the viewer as joined', async () => {
    renderRoom({
      getRoomStates: async () => {
        throw new Error('Membership unavailable')
      },
    })
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        'Room access status is unavailable.',
      ),
    )
    expect(document.querySelector('.feed-panel')).toBeNull()
    expect(button('Join room').disabled).toBe(false)
  })

  it('renders supplied rooms during session restoration without fetching a catalogue', async () => {
    const session = deferred<ClubhouseIdentity | null>()
    const catalogFetcher = vi.fn()
    component = mount(App, {
      target: document.body,
      props: {
        initialRooms: rooms,
        catalogFetcher,
        integration: { initialize: () => session.promise },
      },
    })
    await vi.waitFor(() =>
      expect(document.querySelector('.room-grid')).not.toBeNull(),
    )
    expect(button('Checking access…').disabled).toBe(true)
    expect(catalogFetcher).not.toHaveBeenCalled()
    session.resolve(null)
    await vi.waitFor(() => expect(button('Join room').disabled).toBe(false))
  })

  it('preserves a pending enrollment callback until membership is explicitly rechecked', async () => {
    rememberRoomReturn('/rooms/nerv')
    const getFeed = vi.fn().mockResolvedValue({ posts: [post()] })
    render(
      {
        initialize: async () => rei,
        getRoomStates: async () => joined,
        getFeed,
      },
      '/?stratos_enrolled=true&stratos_enrollment=pending',
    )
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        'Your join request is pending.',
      ),
    )
    expect(window.location.pathname).toBe('/rooms/nerv')
    expect(getFeed).not.toHaveBeenCalled()
    button('Check room again').click()
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Meet at Tokyo-3'),
    )
    expect(getFeed).toHaveBeenCalledOnce()
  })

  it('resumes a saved join without waiting for the selected feed', async () => {
    rememberRoomJoin('bebop')
    const feed = deferred<FeedPage>()
    const requestJoin = vi.fn().mockResolvedValue('pending')
    renderRoom({ getFeed: () => feed.promise, requestJoin })
    await vi.waitFor(() => expect(requestJoin).toHaveBeenCalledWith('bebop'))
    expect(document.body.textContent).toContain('Loading room topics…')
    feed.resolve({ posts: [] })
  })

  it('retries a failed catalogue after restoring the session', async () => {
    const catalogFetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('Catalogue offline'))
      .mockResolvedValue(rooms)
    const getRoomStates = vi.fn().mockResolvedValue(joined)
    render({ initialize: async () => rei, getRoomStates }, '/', catalogFetcher)
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Catalogue offline'),
    )
    expect(getRoomStates).not.toHaveBeenCalled()
    button('Try again').click()
    await vi.waitFor(() => expect(button('Open room')).toBeDefined())
    expect(catalogFetcher).toHaveBeenCalledTimes(2)
    expect(getRoomStates).toHaveBeenCalledOnce()
  })

  it('waits for the session when a catalogue retry completes during restoration', async () => {
    const session = deferred<ClubhouseIdentity | null>()
    const catalogFetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('Catalogue offline'))
      .mockResolvedValue(rooms)
    const getRoomStates = vi.fn().mockResolvedValue(joined)
    render(
      { initialize: () => session.promise, getRoomStates },
      '/',
      catalogFetcher,
    )
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Catalogue offline'),
    )
    button('Try again').click()
    await vi.waitFor(() =>
      expect(document.querySelector('.room-grid')).not.toBeNull(),
    )
    expect(getRoomStates).not.toHaveBeenCalled()
    expect(button('Checking access…').disabled).toBe(true)
    session.resolve(rei)
    await vi.waitFor(() => expect(button('Open room')).toBeDefined())
    expect(getRoomStates).toHaveBeenCalledOnce()
  })

  it('does not request membership if a catalogue retry fails', async () => {
    const catalogFetcher = vi
      .fn()
      .mockRejectedValue(new Error('Catalogue offline'))
    const getRoomStates = vi.fn()
    render({ initialize: async () => rei, getRoomStates }, '/', catalogFetcher)
    await vi.waitFor(() =>
      expect(document.querySelector('.signed-in-account')).not.toBeNull(),
    )
    button('Try again').click()
    await vi.waitFor(() => expect(catalogFetcher).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Catalogue offline'),
    )
    expect(getRoomStates).not.toHaveBeenCalled()
  })

  it.each(['session', 'catalogue'] as const)(
    'stops bootstrap after unmount while waiting for the %s',
    async (pending) => {
      const session = deferred<ClubhouseIdentity | null>()
      const catalog = deferred<typeof rooms>()
      const getRoomStates = vi.fn()
      const initialize = vi.fn(() => session.promise)
      const catalogFetcher = vi.fn(() => catalog.promise)
      render({ initialize, getRoomStates }, '/', catalogFetcher)
      await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce())
      if (pending === 'session') {
        catalog.resolve(rooms)
        await vi.waitFor(() =>
          expect(document.querySelector('.room-grid')).not.toBeNull(),
        )
      } else {
        session.resolve(rei)
        await vi.waitFor(() =>
          expect(document.querySelector('.signed-in-account')).not.toBeNull(),
        )
      }
      await unmount(component!)
      component = undefined
      session.resolve(rei)
      catalog.resolve(rooms)
      await tick()
      await tick()
      expect(getRoomStates).not.toHaveBeenCalled()
    },
  )
})
