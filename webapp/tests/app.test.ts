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

  return {
    session: { sub: 'did:plc:motoko' },
    createRecord,
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
  feedStats: vi.fn(() => ({ postCount: 0, userCount: 0 })),
  fetchAppviewStratosPosts: vi.fn(),
  fetchFeedgenPosts: vi.fn(),
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
        expect(
          screen.getByPlaceholderText('Write a post…'),
        ).not.toBeDisabled(),
      )
    }

    await fireEvent.input(
      screen.getByPlaceholderText('Stratos Service URL'),
      { target: { value: 'https://stratos.example' } },
    )
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
})
