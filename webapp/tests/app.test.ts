import { render, screen, waitFor } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import App from '../src/App.svelte'

const appState = vi.hoisted(() => {
  let onSessionDeleted: (() => void) | undefined
  let resolvePublicPosts: (posts: unknown[]) => void
  const publicPosts = new Promise<unknown[]>((resolve) => {
    resolvePublicPosts = resolve
  })
  const fetchRepoPublicPosts = vi.fn(() => publicPosts)

  return {
    session: { sub: 'did:plc:motoko' },
    fetchRepoPublicPosts,
    publicPosts,
    resolvePublicPosts: (posts: unknown[]) => resolvePublicPosts(posts),
    getOnSessionDeleted: () => onSessionDeleted,
    setOnSessionDeleted: (callback: () => void) => {
      onSessionDeleted = callback
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
  resolveHandles: (posts: unknown[]) => posts,
}))

describe('App.svelte', () => {
  it('does not restore a completed feed after its session is deleted', async () => {
    render(App)

    await waitFor(() =>
      expect(appState.fetchRepoPublicPosts).toHaveBeenCalledTimes(1),
    )
    appState.getOnSessionDeleted()?.()
    appState.resolvePublicPosts([
      {
        uri: 'at://did:plc:motoko/app.bsky.feed.post/one',
        cid: 'motoko-cid',
        author: 'did:plc:motoko',
        authorHandle: 'motoko.example',
        text: 'A stale post must not cross the airlock.',
        createdAt: '1995-11-18T00:00:00.000Z',
        boundaries: [],
        isPrivate: false,
        reply: null,
      },
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
})
