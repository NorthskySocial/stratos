import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { tick } from 'svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App.svelte'

const appState = vi.hoisted(() => {
  let onSessionDeleted: (() => void) | undefined
  const publicPostRequests: Array<{
    promise: Promise<unknown[]>
    resolve: (posts: unknown[]) => void
  }> = []
  const fetchRepoPublicPosts = vi.fn(() => {
    let resolveRequest!: (posts: unknown[]) => void
    const promise = new Promise<unknown[]>((resolve) => {
      resolveRequest = resolve
    })
    publicPostRequests.push({ promise, resolve: resolveRequest })
    return promise
  })
  const createRecord = vi.fn().mockResolvedValue({})
  const fetchFeedgenPosts = vi.fn().mockResolvedValue({ ok: true, posts: [] })

  return {
    session: { sub: 'did:plc:motoko' },
    createRecord,
    fetchFeedgenPosts,
    fetchRepoPublicPosts,
    resolvePublicPosts: async (requestIndex: number, posts: unknown[]) => {
      const request = publicPostRequests[requestIndex]
      if (!request) {
        throw new Error(`Missing public post request ${requestIndex}`)
      }
      request.resolve(posts)
      await request.promise
    },
    getOnSessionDeleted: () => onSessionDeleted,
    setOnSessionDeleted: (callback: () => void) => {
      onSessionDeleted = callback
    },
    reset: () => {
      onSessionDeleted = undefined
      publicPostRequests.length = 0
      fetchRepoPublicPosts.mockClear()
      createRecord.mockClear()
      fetchFeedgenPosts.mockReset()
      fetchFeedgenPosts.mockResolvedValue({ ok: true, posts: [] })
    },
  }
})

vi.mock('@atproto/api', () => ({
  Agent: class {
    com = {
      atproto: {
        repo: {
          describeRepo: vi.fn().mockResolvedValue({
            data: { handle: 'motoko.example' },
          }),
          createRecord: appState.createRecord,
        },
      },
    }
  },
}))

vi.mock('../src/lib/auth', () => ({
  init: vi.fn().mockResolvedValue(appState.session),
  onSessionDeleted: vi.fn(appState.setOnSessionDeleted),
  signIn: vi.fn(),
  signOut: vi.fn(),
  getSpaceWriteScopeStatus: vi.fn().mockResolvedValue('unavailable'),
}))

vi.mock('../src/lib/stratos', () => ({
  APPVIEW_URL: undefined,
  FEEDGEN_DID: undefined,
  FEEDGEN_FEED: 'engineering',
  STRATOS_URL: undefined,
  checkStratosServiceStatus: vi.fn().mockResolvedValue({ enrolled: false }),
  discoverStratosEnrollment: vi.fn().mockResolvedValue(null),
  fetchServerDomains: vi.fn().mockResolvedValue([]),
  verifyAttestation: vi.fn().mockResolvedValue(true),
  enrollInStratos: vi.fn(),
}))

vi.mock('../src/lib/stratos-agent', () => ({
  configureAgent: vi.fn((agent) => agent),
  createServiceAgent: vi.fn(),
  createStratosAgent: vi.fn(),
}))

vi.mock('../src/lib/feed', () => ({
  authorFromUri: (uri: string) => uri.split('/')[2] ?? '',
  buildUnifiedFeed: (publicPosts: unknown[], stratosPosts: unknown[]) => [
    ...publicPosts,
    ...stratosPosts,
  ],
  feedStats: vi.fn((posts: unknown[]) => ({
    postCount: posts.length,
    userCount: 0,
  })),
  fetchAppviewStratosPosts: vi.fn(),
  fetchFeedgenPosts: appState.fetchFeedgenPosts,
  fetchPublicPosts: vi.fn(),
  fetchRepoPublicPosts: appState.fetchRepoPublicPosts,
  fetchStratosPosts: vi.fn(),
  filterByDomain: (posts: unknown[]) => posts,
  groupIntoThreads: (posts: unknown[]) =>
    posts.map((post) => ({ post, replies: [], depth: 0 })),
  resolveHandles: (posts: unknown[]) => posts,
}))

function feedPost(text: string, rkey: string) {
  return {
    uri: `at://did:plc:motoko/app.bsky.feed.post/${rkey}`,
    cid: `motoko-${rkey}`,
    author: 'did:plc:motoko',
    authorHandle: 'motoko.example',
    text,
    createdAt: '1995-11-18T00:00:00.000Z',
    boundaries: [],
    isPrivate: false,
    reply: null,
  }
}

describe('App.svelte', () => {
  beforeEach(() => {
    appState.reset()
    ;(
      window as Window & {
        __MOCK_SESSION__?: { sub: string; handle: string; feedgenDid: string }
      }
    ).__MOCK_SESSION__ = {
      sub: 'did:plc:motoko',
      handle: 'motoko.example',
      feedgenDid: 'did:web:batou.test',
    }
  })

  it('does not restore a completed feed after its session is deleted', async () => {
    render(App)

    await waitFor(() =>
      expect(appState.fetchRepoPublicPosts).toHaveBeenCalledTimes(1),
    )
    appState.getOnSessionDeleted()?.()
    await appState.resolvePublicPosts(0, [
      feedPost('A stale post must not cross the airlock.', 'one'),
    ])

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Sign In' }),
      ).toBeInTheDocument(),
    )
    expect(
      screen.queryByText('A stale post must not cross the airlock.'),
    ).not.toBeInTheDocument()
  })

  it('keeps only the latest same-session feed refresh active', async () => {
    render(App)

    await waitFor(() =>
      expect(appState.fetchRepoPublicPosts).toHaveBeenCalledTimes(1),
    )
    await appState.resolvePublicPosts(0, [
      feedPost('The original Section Nine briefing.', 'initial'),
    ])
    await screen.findByText('The original Section Nine briefing.')

    const startRefresh = async (text: string, expectedRequestCount: number) => {
      const composer = screen.getByPlaceholderText('Write a post…')
      await fireEvent.input(composer, { target: { value: text } })
      await fireEvent.click(screen.getByRole('button', { name: /Post$/ }))
      await waitFor(() =>
        expect(appState.fetchRepoPublicPosts).toHaveBeenCalledTimes(
          expectedRequestCount,
        ),
      )
      await waitFor(() =>
        expect(screen.getByPlaceholderText('Write a post…')).not.toBeDisabled(),
      )
    }

    await fireEvent.input(screen.getByPlaceholderText('Stratos Service URL'), {
      target: { value: 'https://stratos.example' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Set URL' }))
    await waitFor(() =>
      expect(appState.fetchRepoPublicPosts).toHaveBeenCalledTimes(2),
    )
    await startRefresh('Togusa requests the newer refresh.', 3)

    await appState.resolvePublicPosts(1, [
      feedPost('An older refresh completed first.', 'older-first'),
    ])
    await Promise.resolve()
    await tick()
    expect(screen.getByText('Loading posts…')).toBeInTheDocument()

    await startRefresh('The Major requests the final refresh.', 4)
    await appState.resolvePublicPosts(3, [
      feedPost('The newest briefing wins.', 'newest'),
    ])
    await screen.findByText('The newest briefing wins.')

    await appState.resolvePublicPosts(2, [
      feedPost('A late stale briefing.', 'late-stale'),
    ])
    await tick()
    expect(screen.getByText('The newest briefing wins.')).toBeInTheDocument()
    expect(screen.queryByText('A late stale briefing.')).not.toBeInTheDocument()
    expect(screen.queryByText('Loading posts…')).not.toBeInTheDocument()
  })

  it('shows private feed failure alongside public results and recovers on retry', async () => {
    appState.fetchFeedgenPosts
      .mockResolvedValueOnce({
        ok: false,
        category: 'not-ready',
        status: 503,
        retryable: true,
      })
      .mockResolvedValueOnce({
        ok: true,
        posts: [feedPost('The Major returns.', 'private')],
      })
    render(App)
    await waitFor(() =>
      expect(appState.fetchRepoPublicPosts).toHaveBeenCalledTimes(1),
    )
    await appState.resolvePublicPosts(0, [
      feedPost('Public briefing remains.', 'public'),
    ])

    expect(
      await screen.findByText(
        'Your private feed is getting ready. Try again shortly.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Public briefing remains.')).toBeInTheDocument()
    expect(
      screen.queryByText('No posts yet. Create your first post above!'),
    ).not.toBeInTheDocument()

    await fireEvent.click(
      screen.getByRole('button', { name: 'Retry private feed' }),
    )
    await waitFor(() =>
      expect(appState.fetchRepoPublicPosts).toHaveBeenCalledTimes(2),
    )
    await appState.resolvePublicPosts(1, [
      feedPost('Public briefing remains.', 'public'),
    ])
    expect(await screen.findByText('The Major returns.')).toBeInTheDocument()
    expect(
      screen.queryByText(
        'Your private feed is getting ready. Try again shortly.',
      ),
    ).not.toBeInTheDocument()
  })

  it('shows the empty state only after an authorized empty feed succeeds', async () => {
    appState.fetchFeedgenPosts.mockResolvedValueOnce({ ok: true, posts: [] })
    render(App)
    await waitFor(() =>
      expect(appState.fetchRepoPublicPosts).toHaveBeenCalledTimes(1),
    )
    await appState.resolvePublicPosts(0, [])
    expect(
      await screen.findByText('No posts yet. Create your first post above!'),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Retry private feed' }),
    ).not.toBeInTheDocument()
  })

  it('does not describe an unavailable private feed as empty', async () => {
    appState.fetchFeedgenPosts.mockResolvedValueOnce({
      ok: false,
      posts: [],
      category: 'network',
      retryable: true,
    })
    render(App)
    await waitFor(() =>
      expect(appState.fetchRepoPublicPosts).toHaveBeenCalledTimes(1),
    )
    await appState.resolvePublicPosts(0, [])
    expect(
      await screen.findByText(
        'Could not reach your private feed. Check your connection and try again.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('No posts yet. Create your first post above!'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Retry private feed' }),
    ).toBeInTheDocument()
  })

  it.each([
    [
      'authorization',
      'Your private feed access has expired or was denied. Sign out and sign back in, or ask your administrator to check your access.',
      false,
    ],
    [
      'malformed',
      'Your private feed returned an invalid response. Try again.',
      true,
    ],
    [
      'unavailable',
      'Your private feed request was rejected. Ask your administrator to check the feed configuration.',
      false,
    ],
    ['unavailable', 'Your private feed is unavailable. Try again later.', true],
  ])(
    'announces %s failure without showing an empty feed',
    async (category, message, retryable) => {
      appState.fetchFeedgenPosts.mockResolvedValueOnce({
        ok: false,
        posts: [],
        category,
        retryable,
      })
      render(App)
      await waitFor(() =>
        expect(appState.fetchRepoPublicPosts).toHaveBeenCalledTimes(1),
      )
      await appState.resolvePublicPosts(0, [])
      expect(
        (await screen.findByText(message)).closest('[role="status"]'),
      ).toBeInTheDocument()
      expect(
        screen.queryByText('No posts yet. Create your first post above!'),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Retry private feed' }) !== null,
      ).toBe(retryable)
    },
  )

  it('clears private posts on authorization loss and ignores a later refresh after logout', async () => {
    const privatePost = {
      ...feedPost('Private Section Nine report.', 'private'),
      isPrivate: true,
    }
    appState.fetchFeedgenPosts
      .mockResolvedValueOnce({ ok: true, posts: [privatePost] })
      .mockResolvedValueOnce({
        ok: false,
        category: 'authorization',
        status: 401,
        retryable: false,
      })
    render(App)
    await waitFor(() =>
      expect(appState.fetchRepoPublicPosts).toHaveBeenCalledTimes(1),
    )
    await appState.resolvePublicPosts(0, [
      feedPost('Public Section Nine briefing.', 'public'),
    ])
    await screen.findByText('Private Section Nine report.')
    expect(screen.getByText('Posts').parentElement).toHaveTextContent('2')
    await fireEvent.click(
      screen
        .getByText('Private Section Nine report.')
        .closest('.post-card')!
        .querySelector('button.reply-btn')!,
    )
    expect(
      screen.getByRole('button', { name: 'Cancel reply' }),
    ).toBeInTheDocument()

    await fireEvent.input(screen.getByPlaceholderText('Stratos Service URL'), {
      target: { value: 'https://stratos.example' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Set URL' }))
    await tick()
    expect(
      screen.queryByText('Private Section Nine report.'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText('Public Section Nine briefing.'),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Cancel reply' }),
      ).not.toBeInTheDocument(),
    )
    await waitFor(() =>
      expect(screen.getByText('Posts').parentElement).toHaveTextContent('1'),
    )
    await waitFor(() =>
      expect(appState.fetchRepoPublicPosts).toHaveBeenCalledTimes(2),
    )
    await appState.resolvePublicPosts(1, [
      feedPost('Public Section Nine briefing.', 'public'),
    ])
    expect(
      await screen.findByText(
        'Your private feed access has expired or was denied. Sign out and sign back in, or ask your administrator to check your access.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Public Section Nine briefing.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Retry private feed' }),
    ).not.toBeInTheDocument()

    let resolveRefresh!: (value: unknown) => void
    appState.fetchFeedgenPosts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve
        }),
    )
    await fireEvent.input(screen.getByPlaceholderText('Write a post…'), {
      target: { value: 'Togusa requests a fresh briefing.' },
    })
    await fireEvent.click(
      screen.getByRole('button', { name: /^Post$/ }),
    )
    await waitFor(() =>
      expect(appState.fetchRepoPublicPosts).toHaveBeenCalledTimes(3),
    )
    await appState.resolvePublicPosts(2, [])
    await waitFor(() =>
      expect(appState.fetchFeedgenPosts).toHaveBeenCalledTimes(3),
    )
    appState.getOnSessionDeleted()?.()
    resolveRefresh({ ok: true, posts: [privatePost] })
    await tick()
    expect(
      screen.queryByText('Private Section Nine report.'),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument()
  })
})
