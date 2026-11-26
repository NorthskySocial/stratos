import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { StratosEnrollment } from '../src/lib/stratos'
import type { FeedPost } from '../src/lib/feed'
import LikeButton from '../src/lib/LikeButton.svelte'
import {
  startStratosResponder,
  type StratosResponder,
} from './helpers/stratos-responder'

const STRATOS_ORIGIN = 'https://stratos.example'
const BOUNDARY = 'did:web:stratos.example/nerve'
const VIEWER = 'did:plc:shinji'
const POST_URI = 'at://did:plc:misato/zone.stratos.feed.post/3kcurry'
const LIKE_URI = `at://${VIEWER}/app.bsky.feed.like/3kunit01`

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

function enrollment(custody: StratosEnrollment['custody']): StratosEnrollment {
  return {
    service: STRATOS_ORIGIN,
    custody,
    boundaries: [{ value: BOUNDARY }],
    signingKey: 'did:key:zQ3shjRei',
    attestation: null,
    createdAt: '1995-10-04T00:00:00.000Z',
    rkey: 'nerve',
  }
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

function renderButton(
  custody: StratosEnrollment['custody'],
  feedPost: FeedPost,
) {
  const session = responder.session(VIEWER, STRATOS_ORIGIN)
  const view = render(LikeButton, {
    props: {
      post: feedPost,
      session,
      enrollment: enrollment(custody),
      attestationVerified: true,
    },
  })
  return { session, ...view }
}

describe('LikeButton.svelte', () => {
  it('shows the like count the feed generator returned', () => {
    renderButton('stratos', post({ likeCount: 7 }))

    expect(screen.getByText('7 likes')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Like' })).toBeEnabled()
  })

  it('likes the post with its URI and CID inside the post boundary', async () => {
    responder.respondWith(200, {
      uri: LIKE_URI,
      cid: 'bafyreilike',
    })
    renderButton('stratos', post())

    await fireEvent.click(screen.getByRole('button', { name: 'Like' }))

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Unlike' }),
      ).toBeInTheDocument(),
    )
    expect(responder.requests).toEqual([
      {
        method: 'POST',
        path: '/xrpc/zone.stratos.repo.createRecord',
        body: {
          boundary: BOUNDARY,
          repo: VIEWER,
          collection: 'app.bsky.feed.like',
          record: {
            $type: 'app.bsky.feed.like',
            subject: { uri: POST_URI, cid: 'bafyreikaji' },
            createdAt: expect.any(String),
          },
        },
      },
    ])
    expect(screen.getByText('3 likes')).toBeInTheDocument()
  })

  it('unlikes through deleteRecord with the rkey of viewer.like', async () => {
    renderButton('stratos', post({ viewer: { like: LIKE_URI } }))

    await fireEvent.click(screen.getByRole('button', { name: 'Unlike' }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Like' })).toBeInTheDocument(),
    )
    expect(responder.requests).toEqual([
      {
        method: 'POST',
        path: '/xrpc/zone.stratos.repo.deleteRecord',
        body: {
          boundary: BOUNDARY,
          repo: VIEWER,
          collection: 'app.bsky.feed.like',
          rkey: '3kunit01',
        },
      },
    ])
    expect(screen.getByText('1 like')).toBeInTheDocument()
  })

  it('disables the button with a reason for PDS custody and sends nothing', async () => {
    renderButton('pds', post())

    const button = screen.getByRole('button', { name: 'Like' })
    expect(button).toBeDisabled()
    expect(
      screen.getByText(
        /Likes are not available for PDS-hosted private posts yet/i,
      ),
    ).toBeInTheDocument()
    await fireEvent.click(button)
    expect(responder.requests).toEqual([])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('asks the member to authorize again when the grant predates likes', async () => {
    responder.respondWith(400, {
      error: 'ScopeUpgradeRequired',
      message: 'Authorize again.',
    })
    renderButton('stratos', post())

    await fireEvent.click(screen.getByRole('button', { name: 'Like' }))

    await waitFor(() =>
      expect(
        screen.getByText(/Sign out and authorize the app again to like posts/i),
      ).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: 'Like' })).toBeEnabled()
    expect(screen.getByText('2 likes')).toBeInTheDocument()
  })

  it('keeps the count and offers a retry when the service refuses the like', async () => {
    responder.respondWith(400, {
      error: 'InvalidRecord',
      message: 'The subject must be a post in this boundary',
    })
    renderButton('stratos', post())

    await fireEvent.click(screen.getByRole('button', { name: 'Like' }))

    await waitFor(() =>
      expect(screen.getByText(/Could not like the post/i)).toBeInTheDocument(),
    )
    expect(screen.getByText('2 likes')).toBeInTheDocument()
  })

  it('does not write when the post has no boundary', async () => {
    renderButton('stratos', post({ boundaries: [] }))

    await fireEvent.click(screen.getByRole('button', { name: 'Like' }))

    await waitFor(() =>
      expect(screen.getByText(/Could not like the post/i)).toBeInTheDocument(),
    )
    expect(responder.requests).toEqual([])
  })

  it('sends one request when the button is pressed twice before the first finishes', async () => {
    responder.respondWith(200, { uri: LIKE_URI, cid: 'bafyreilike' })
    renderButton('stratos', post())
    const button = screen.getByRole('button', { name: 'Like' })

    void fireEvent.click(button)
    // The disabled attribute already blocks a second click in the DOM; lift it to reach the handler's own guard.
    button.removeAttribute('disabled')
    await fireEvent.click(button)

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Unlike' }),
      ).toBeInTheDocument(),
    )
    await new Promise((settle) => setTimeout(settle, 100))
    expect(responder.requests).toHaveLength(1)
    expect(screen.getByText('3 likes')).toBeInTheDocument()
  })

  it('keeps the like when a refresh arrives before the feed generator has ingested it', async () => {
    responder.respondWith(200, { uri: LIKE_URI, cid: 'bafyreilike' })
    const { rerender } = renderButton('stratos', post())
    await fireEvent.click(screen.getByRole('button', { name: 'Like' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Unlike' }),
      ).toBeInTheDocument(),
    )

    await rerender({ post: post() })

    expect(screen.getByRole('button', { name: 'Unlike' })).toBeInTheDocument()
    expect(screen.getByText('3 likes')).toBeInTheDocument()
    expect(responder.requests).toHaveLength(1)
  })

  it('takes the served like and count once the feed generator agrees', async () => {
    responder.respondWith(200, { uri: LIKE_URI, cid: 'bafyreilike' })
    const { rerender } = renderButton('stratos', post())
    await fireEvent.click(screen.getByRole('button', { name: 'Like' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Unlike' }),
      ).toBeInTheDocument(),
    )

    await rerender({ post: post({ viewer: { like: LIKE_URI }, likeCount: 5 }) })
    expect(screen.getByText('5 likes')).toBeInTheDocument()

    await rerender({ post: post({ likeCount: 4 }) })
    expect(screen.getByRole('button', { name: 'Like' })).toBeInTheDocument()
    expect(screen.getByText('4 likes')).toBeInTheDocument()
  })

  it('keeps the unlike when a refresh still shows the like', async () => {
    const liked = post({ viewer: { like: LIKE_URI } })
    const { rerender } = renderButton('stratos', liked)
    await fireEvent.click(screen.getByRole('button', { name: 'Unlike' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Like' })).toBeInTheDocument(),
    )

    await rerender({ post: post({ viewer: { like: LIKE_URI } }) })

    expect(screen.getByRole('button', { name: 'Like' })).toBeInTheDocument()
    expect(screen.getByText('1 like')).toBeInTheDocument()
  })

  it('gives each unavailable note its own id that its button points to', () => {
    const session = responder.session(VIEWER, STRATOS_ORIGIN)
    const props = {
      session,
      enrollment: enrollment('pds'),
      attestationVerified: true,
    }
    render(LikeButton, { props: { ...props, post: post() } })
    render(LikeButton, {
      props: { ...props, post: post({ uri: `${POST_URI}b` }) },
    })

    const notes = screen.getAllByText(/Likes are not available/i)
    expect(notes).toHaveLength(2)
    expect(notes[0].id).not.toBe(notes[1].id)
    for (const button of screen.getAllByRole('button', { name: 'Like' })) {
      expect(button).toHaveAccessibleDescription(
        /Likes are not available for PDS-hosted private posts yet/i,
      )
    }
    const ids = screen
      .getAllByRole('button', { name: 'Like' })
      .map((button) => button.getAttribute('aria-describedby'))
    expect(new Set(ids).size).toBe(2)
  })

  it.each([false, null])(
    'disables the button with a reason when the attestation is %s and sends nothing',
    async (attestationVerified) => {
      const session = responder.session(VIEWER, STRATOS_ORIGIN)
      render(LikeButton, {
        props: {
          post: post(),
          session,
          enrollment: enrollment('stratos'),
          attestationVerified,
        },
      })

      const button = screen.getByRole('button', { name: 'Like' })
      expect(button).toBeDisabled()
      expect(button).toHaveAccessibleDescription(
        /Liking requires a valid enrollment attestation/i,
      )
      await fireEvent.click(button)
      expect(responder.requests).toEqual([])
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    },
  )
})
