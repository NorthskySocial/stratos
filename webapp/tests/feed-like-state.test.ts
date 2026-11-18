import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { StratosEnrollment } from '../src/lib/stratos'
import type { FeedPost } from '../src/lib/feed'
import Feed from '../src/lib/Feed.svelte'
import LikeButton from '../src/lib/LikeButton.svelte'
import {
  startStratosResponder,
  type StratosResponder,
} from './helpers/stratos-responder'

const STRATOS_ORIGIN = 'https://stratos.example'
const BOUNDARY = 'did:web:stratos.example/nerve'
const VIEWER = 'did:plc:shinji'
const POST_URI = 'at://did:plc:misato/zone.stratos.feed.post/3kcurry'
const OTHER_POST_URI = 'at://did:plc:asuka/zone.stratos.feed.post/3kunit02'
const LIKE_URI = `at://${VIEWER}/app.bsky.feed.like/3kunit01`
const ALREADY_LIKED = {
  error: 'RecordAlreadyExists',
  message: 'The member already likes this post',
}

let responder: StratosResponder

beforeAll(async () => {
  responder = await startStratosResponder()
})

afterAll(async () => {
  await responder.stop()
})

afterEach(() => {
  responder.requests.length = 0
  responder.respondWith(200, {})
})

const enrollment: StratosEnrollment = {
  service: STRATOS_ORIGIN,
  custody: 'stratos',
  boundaries: [{ value: BOUNDARY }],
  signingKey: 'did:key:zQ3shjRei',
  attestation: null,
  createdAt: '1995-10-04T00:00:00.000Z',
  rkey: 'nerve',
}

function post(overrides: Partial<FeedPost> = {}): FeedPost {
  return {
    uri: POST_URI,
    cid: 'bafyreikaji',
    text: 'Curry night at Misato’s.',
    createdAt: '1995-10-04T00:00:00.000Z',
    isPrivate: true,
    reply: null,
    author: 'did:plc:misato',
    authorHandle: 'misato.example',
    boundaries: [BOUNDARY],
    likeCount: 2,
    ...overrides,
  }
}

function renderFeed(posts: FeedPost[]) {
  const session = responder.session(VIEWER, STRATOS_ORIGIN)
  const onretry = vi.fn(async () => {})
  const view = render(Feed, {
    props: {
      posts,
      stratosAgent: null,
      loading: false,
      currentDid: VIEWER,
      session: session as never,
      enrollment,
      attestationVerified: true,
      onretry,
      onreply: () => {},
      ondelete: async () => {},
    },
  })
  return { onretry, ...view }
}

const likeButton = () => screen.getByRole('button', { name: 'Like' })
const unlikeButton = () => screen.getByRole('button', { name: 'Unlike' })

describe('like state above the feed list', () => {
  it('keeps a like when the card is removed and rebuilt by a refresh the feed generator has not caught up with', async () => {
    responder.respondWith(200, { uri: LIKE_URI, cid: 'bafyreilike' })
    const { rerender } = renderFeed([post()])
    await fireEvent.click(likeButton())
    await waitFor(() => expect(unlikeButton()).toBeInTheDocument())

    await rerender({ posts: [] })
    expect(screen.queryByRole('button', { name: /like/i })).toBeNull()
    await rerender({ posts: [post()] })

    expect(unlikeButton()).toBeInTheDocument()
    expect(screen.getByText('3 likes')).toBeInTheDocument()
    expect(responder.requests).toHaveLength(1)
  })

  it('drops the kept like once the served post agrees, and then follows the feed', async () => {
    responder.respondWith(200, { uri: LIKE_URI, cid: 'bafyreilike' })
    const { rerender } = renderFeed([post()])
    await fireEvent.click(likeButton())
    await waitFor(() => expect(unlikeButton()).toBeInTheDocument())

    await rerender({ posts: [] })
    await rerender({
      posts: [post({ viewer: { like: LIKE_URI }, likeCount: 5 })],
    })
    expect(screen.getByText('5 likes')).toBeInTheDocument()
    await rerender({ posts: [] })
    await rerender({ posts: [post({ likeCount: 4 })] })

    expect(likeButton()).toBeInTheDocument()
    expect(screen.getByText('4 likes')).toBeInTheDocument()
  })

  it('keeps an unlike across a rebuilt card while the served post still shows the like', async () => {
    const { rerender } = renderFeed([post({ viewer: { like: LIKE_URI } })])
    await fireEvent.click(unlikeButton())
    await waitFor(() => expect(likeButton()).toBeInTheDocument())

    await rerender({ posts: [] })
    await rerender({ posts: [post({ viewer: { like: LIKE_URI } })] })

    expect(likeButton()).toBeInTheDocument()
    expect(screen.getByText('1 like')).toBeInTheDocument()
  })

  it('keeps the state of each post apart', async () => {
    responder.respondWith(200, { uri: LIKE_URI, cid: 'bafyreilike' })
    const other = post({ uri: OTHER_POST_URI, author: 'did:plc:asuka' })
    const { rerender } = renderFeed([post(), other])
    await fireEvent.click(screen.getAllByRole('button', { name: 'Like' })[0])
    await waitFor(() => expect(unlikeButton()).toBeInTheDocument())

    await rerender({ posts: [] })
    await rerender({ posts: [post(), other] })

    expect(screen.getAllByRole('button', { name: 'Unlike' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Like' })).toHaveLength(1)
  })

  it('treats the post as liked and refreshes when a like is already there', async () => {
    const { rerender, onretry } = renderFeed([
      post({ viewer: { like: LIKE_URI } }),
    ])
    await fireEvent.click(unlikeButton())
    await waitFor(() => expect(likeButton()).toBeInTheDocument())
    // Another device liked the post again before this refresh.
    await rerender({ posts: [post({ viewer: { like: LIKE_URI } })] })
    expect(likeButton()).toBeInTheDocument()
    responder.respondWith(400, ALREADY_LIKED)

    await fireEvent.click(likeButton())

    await waitFor(() => expect(unlikeButton()).toBeInTheDocument())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(onretry).toHaveBeenCalledTimes(1)
  })
})

describe('a like button with no feed above it', () => {
  it('treats the post as liked without an error when a like is already there', async () => {
    responder.respondWith(400, ALREADY_LIKED)
    render(LikeButton, {
      props: {
        post: post(),
        session: responder.session(VIEWER, STRATOS_ORIGIN),
        enrollment,
        attestationVerified: true,
      },
    })

    await fireEvent.click(likeButton())

    await waitFor(() => expect(responder.requests).toHaveLength(1))
    await new Promise((settle) => setTimeout(settle, 50))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(likeButton()).toBeEnabled()
  })
})
