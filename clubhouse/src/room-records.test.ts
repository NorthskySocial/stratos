import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type { ClubhouseFeedPost } from './lib/feedgen'
import type { RoomCustody } from './lib/types'

const mocks = vi.hoisted(() => ({
  session: undefined as unknown,
}))

vi.mock('./lib/auth', () => ({
  createClubhouseAuth: () => ({
    init: async () => mocks.session,
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}))
vi.mock('./lib/enrollment', () => ({
  resolveAuthenticatedHandle: async () => 'spike.example',
}))
vi.mock('./telemetry', () => ({
  withClubhouseSpan: (_name: string, task: () => unknown) => task(),
  captureClubhouseException: vi.fn(),
}))

import App from './App.svelte'
import { loadClubhouseConfig } from './lib/config'
import { createClubhouseIntegration } from './lib/integration'

const SPIKE = 'did:plc:spikespiegel'
const FAYE = 'did:plc:fayevalentine'
const SPACE = 'at:space/did:web:stratos.example/zone.stratos.space.feed/bebop'
const STATUS_URL = 'https://stratos.example/oauth/boundaries/status'
const POST_URL = 'https://stratos.example/oauth/boundaries/post'
const LEGACY_SPACE_RECORD = `at://did:web:stratos.example/space/zone.stratos.space.feed/bebop/did:plc:fayevalentine/zone.stratos.feed.post/3kswordfish`
const LEGACY_ROOM_SPACE = `at://did:web:stratos.example/space/zone.stratos.space.feed/bebop`
const TOPIC_REFUSED = 'This topic link cannot be opened.'

interface RecordedRequest {
  url: string
  method: string
  body?: unknown
}

const rooms = [
  {
    id: 'bebop',
    displayName: 'Bebop',
    description: 'The crew lounge',
    available: true,
  },
]

function spacePost(
  author: string,
  rkey: string,
  text: string,
  reply?: ClubhouseFeedPost['reply'],
): ClubhouseFeedPost {
  return {
    uri: `${SPACE}/${author}/zone.stratos.feed.post/${rkey}`,
    cid: `cid-${rkey}`,
    author: { did: author },
    text,
    indexedAt: '2026-09-07T08:00:00Z',
    ...(reply ? { reply } : {}),
  }
}

function custodyPost(
  author: string,
  rkey: string,
  text: string,
): ClubhouseFeedPost {
  return {
    uri: `at://${author}/zone.stratos.feed.post/${rkey}`,
    cid: `cid-${rkey}`,
    author: { did: author },
    text,
    indexedAt: '2026-09-07T08:00:00Z',
  }
}

// A post with an avatar needs no profile lookup, so a test can expect no
// public request at all.
function pictured(post: ClubhouseFeedPost): ClubhouseFeedPost {
  return {
    ...post,
    author: { ...post.author, avatar: 'https://bebop.example/crew.png' },
  }
}

const requests: RecordedRequest[] = []
const publicRequests: string[] = []
let component: ReturnType<typeof mount> | undefined
let respondTo: (request: RecordedRequest) => Response

function stratosAnswers(custody: RoomCustody) {
  return (request: RecordedRequest): Response => {
    if (request.url === STATUS_URL) {
      return new Response(
        JSON.stringify({ rooms: [{ id: 'bebop', state: 'joined' }], custody }),
        { status: 200 },
      )
    }
    return new Response('{}', { status: 200 })
  }
}

interface RoomOptions {
  custody: RoomCustody
  posts: ClubhouseFeedPost[]
  spaces?: Record<string, unknown>
  /** The setting as written, for text that is not a JSON object; `undefined` leaves it absent. */
  spaceSetting?: { text: string | undefined }
  path?: string
}

async function openRoom({
  custody,
  posts,
  spaces,
  spaceSetting,
  path,
}: RoomOptions) {
  vi.stubEnv('VITE_STRATOS_URL', 'https://stratos.example')
  vi.stubEnv(
    'VITE_CLUBHOUSE_PDS_SPACE_URIS_JSON',
    spaceSetting
      ? spaceSetting.text
      : JSON.stringify(spaces ?? { bebop: SPACE }),
  )
  respondTo = stratosAnswers(custody)
  mocks.session = {
    sub: SPIKE,
    fetchHandler: async (url: string, init?: RequestInit) => {
      const request: RecordedRequest = {
        url,
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string'
          ? { body: JSON.parse(init.body) as unknown }
          : {}),
      }
      requests.push(request)
      return respondTo(request)
    },
  }
  const feed = { posts }
  const getFeed = vi.fn(async () => ({ posts: [...feed.posts] }))
  const integration = {
    ...createClubhouseIntegration(loadClubhouseConfig()),
    getFeed,
  }
  window.history.replaceState({}, '', path ?? '/rooms/bebop')
  component = mount(App, {
    target: document.body,
    props: { integration, catalogFetcher: vi.fn().mockResolvedValue(rooms) },
  })
  await vi.waitFor(() =>
    expect(document.querySelector('.feed-panel')).not.toBeNull(),
  )
  await vi.waitFor(() => expect(getFeed).toHaveBeenCalled())
  await tick()
  requests.length = 0
  return { feed, getFeed }
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === label,
  )
  expect(found, `button ${label}`).toBeDefined()
  return found!
}

async function type(selector: string, value: string) {
  const field = document.querySelector<HTMLTextAreaElement>(selector)!
  field.value = value
  field.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
  return field
}

function submit(field: HTMLTextAreaElement) {
  field.form!.dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  )
}

// Clubhouse has no testing-library, so regions are found by their role
// attribute and their text, which is what an assistive technology reads.
function regionsWithRole(
  role: 'alert' | 'status',
  text: string,
  scope: ParentNode = document,
): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(`[role="${role}"]`)].filter(
    (region) =>
      (region.textContent ?? '').replace(/\s+/g, ' ').trim().includes(text),
  )
}

function replyDialog(): HTMLDialogElement | null {
  return document.querySelector('dialog')
}

async function openSignedOutRoom(spaces: Record<string, unknown>) {
  vi.stubEnv('VITE_STRATOS_URL', 'https://stratos.example')
  vi.stubEnv('VITE_CLUBHOUSE_PDS_SPACE_URIS_JSON', JSON.stringify(spaces))
  mocks.session = undefined
  const getFeed = vi.fn(async () => ({ posts: [] }))
  const integration = {
    ...createClubhouseIntegration(loadClubhouseConfig()),
    getFeed,
  }
  window.history.replaceState({}, '', '/rooms/bebop')
  component = mount(App, {
    target: document.body,
    props: { integration, catalogFetcher: vi.fn().mockResolvedValue(rooms) },
  })
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain('Join this room to continue.'),
  )
  await tick()
  return { getFeed }
}

beforeEach(() => {
  requests.length = 0
  publicRequests.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      publicRequests.push(String(input instanceof Request ? input.url : input))
      return new Response('{}', { status: 404 })
    }),
  )
})

afterEach(async () => {
  if (component) await unmount(component)
  component = undefined
  document.body.replaceChildren()
  window.sessionStorage.clear()
  window.history.replaceState({}, '', '/')
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('deleting a room post', () => {
  it('deletes an own PDS-custody post with one space request and then reloads the feed', async () => {
    const own = spacePost(SPIKE, '3kswordfish', 'Bang.')
    const { feed, getFeed } = await openRoom({ custody: 'pds', posts: [own] })
    const loadsBefore = getFeed.mock.calls.length

    button('Delete').click()
    await tick()
    feed.posts = []
    button('Delete now').click()
    await vi.waitFor(() =>
      expect(getFeed.mock.calls.length).toBeGreaterThan(loadsBefore),
    )

    expect(requests).toEqual([
      { url: STATUS_URL, method: 'GET' },
      {
        url: '/xrpc/com.atproto.space.deleteRecord',
        method: 'POST',
        body: {
          space: SPACE,
          repo: SPIKE,
          collection: 'zone.stratos.feed.post',
          rkey: '3kswordfish',
        },
      },
    ])
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('No topics are visible'),
    )
  })

  it('shows the failure and keeps the post when the PDS refuses the delete', async () => {
    const own = spacePost(SPIKE, '3kswordfish', 'Bang.')
    const { getFeed } = await openRoom({ custody: 'pds', posts: [own] })
    const loadsBefore = getFeed.mock.calls.length
    respondTo = (request) =>
      request.url === STATUS_URL
        ? stratosAnswers('pds')(request)
        : new Response('{}', { status: 500 })

    button('Delete').click()
    await tick()
    button('Delete now').click()
    await vi.waitFor(() =>
      expect(document.querySelector('.delete-error')?.textContent).toContain(
        'PDS could not delete the post (HTTP 500).',
      ),
    )

    expect(requests.map((request) => request.url)).toEqual([
      STATUS_URL,
      '/xrpc/com.atproto.space.deleteRecord',
    ])
    expect(getFeed.mock.calls.length).toBe(loadsBefore)
    expect(document.body.textContent).toContain('Bang.')
    expect(document.body.textContent).not.toContain('Post deleted')
  })

  it.each([
    ['the room space is not a space URI', { spaces: { bebop: '' } }],
    ['the room spaces setting cannot be read', { spaceSetting: { text: '[' } }],
  ])(
    'shows the configuration error and sends no delete when %s',
    async (_label, setting) => {
      const own = spacePost(SPIKE, '3kswordfish', 'Bang.')
      const { getFeed } = await openRoom({
        custody: 'pds',
        posts: [own],
        ...setting,
      })
      const loadsBefore = getFeed.mock.calls.length

      button('Delete').click()
      await tick()
      button('Delete now').click()
      await vi.waitFor(() =>
        expect(document.querySelector('.delete-error')?.textContent).toBe(
          'Posting needs service configuration for this room.',
        ),
      )

      expect(requests).toEqual([{ url: STATUS_URL, method: 'GET' }])
      expect(getFeed.mock.calls.length).toBe(loadsBefore)
      expect(document.body.textContent).toContain('Bang.')
    },
  )

  it('keeps the Stratos-custody delete on the service endpoint', async () => {
    const own = custodyPost(SPIKE, '3kswordfish', 'Bang.')
    await openRoom({ custody: 'stratos', posts: [own] })

    button('Delete').click()
    await tick()
    button('Delete now').click()
    await vi.waitFor(() => expect(requests.length).toBe(2))

    expect(requests).toEqual([
      { url: STATUS_URL, method: 'GET' },
      {
        url: POST_URL,
        method: 'DELETE',
        body: { uri: own.uri, cid: own.cid },
      },
    ])
  })

  it('shows the service refusal in plain words and keeps the post', async () => {
    const own = custodyPost(SPIKE, '3kswordfish', 'Bang.')
    await openRoom({ custody: 'stratos', posts: [own] })
    respondTo = (request) =>
      request.url === STATUS_URL
        ? stratosAnswers('stratos')(request)
        : new Response(
            JSON.stringify({
              error: 'InvalidRequest',
              message: 'That post could not be found.',
            }),
            { status: 400 },
          )

    button('Delete').click()
    await tick()
    button('Delete now').click()
    await vi.waitFor(() =>
      expect(document.querySelector('.delete-error')?.textContent).toBe(
        'That post could not be found.',
      ),
    )
    expect(document.body.textContent).toContain('Bang.')
  })

  it('offers no delete for a post by another author', async () => {
    await openRoom({
      custody: 'pds',
      posts: [spacePost(FAYE, '3kswordfish', 'Bang.')],
    })
    const labels = [...document.querySelectorAll('button')].map((entry) =>
      entry.textContent?.trim(),
    )
    expect(labels).not.toContain('Delete')
    expect(requests).toEqual([])
  })

  it('sends nothing when the feed says the post is the viewer own but its address names another author', async () => {
    const mismatched = {
      ...spacePost(FAYE, '3kswordfish', 'Bang.'),
      author: { did: SPIKE },
    }
    await openRoom({ custody: 'pds', posts: [mismatched] })

    button('Delete').click()
    await tick()
    button('Delete now').click()
    await vi.waitFor(() =>
      expect(document.querySelector('.delete-error')?.textContent).toBe(
        'You can only delete your own posts.',
      ),
    )
    expect(requests).toEqual([])
    expect(document.body.textContent).toContain('Bang.')
  })

  it('sends nothing when the post reference is not a record address', async () => {
    const odd = {
      ...custodyPost(SPIKE, '3kswordfish', 'Bang.'),
      uri: 'at://spike.example/zone.stratos.feed.post/3kswordfish',
    }
    await openRoom({ custody: 'stratos', posts: [odd] })

    button('Delete').click()
    await tick()
    button('Delete now').click()
    await vi.waitFor(() =>
      expect(document.querySelector('.delete-error')?.textContent).toBe(
        'The post reference is invalid.',
      ),
    )
    expect(requests).toEqual([])
  })
})

describe('topics in a PDS-custody room', () => {
  const topic = spacePost(FAYE, '3kswordfish', 'Who has the bounty?')

  it('opens a space record topic and puts it in the link as one encoded value', async () => {
    await openRoom({ custody: 'pds', posts: [topic] })

    button('Open topic').click()
    await tick()

    expect(window.location.pathname).toBe('/rooms/bebop')
    expect(window.location.search).toBe(
      `?topic=${encodeURIComponent(topic.uri)}`,
    )
    expect(document.querySelector('.thread-view')).not.toBeNull()
    expect(document.body.textContent).not.toContain(TOPIC_REFUSED)
    expect(requests).toEqual([])
  })

  it('opens the thread from a shared link whose topic is a space record', async () => {
    await openRoom({
      custody: 'pds',
      posts: [topic],
      path: `/rooms/bebop?topic=${encodeURIComponent(topic.uri)}`,
    })
    expect(document.querySelector('.thread-view')).not.toBeNull()
    expect(document.body.textContent).toContain('Who has the bounty?')
  })

  it('opens a custody topic from its link', async () => {
    const custody = custodyPost(FAYE, '3kswordfish', 'Custody topic.')
    await openRoom({
      custody: 'stratos',
      posts: [custody],
      path: `/rooms/bebop?topic=${encodeURIComponent(custody.uri)}`,
    })
    expect(document.querySelector('.thread-view')).not.toBeNull()
  })

  it('opens the room without a topic and says so when the link holds an earlier-spelling address', async () => {
    await openRoom({
      custody: 'pds',
      posts: [topic],
      path: `/rooms/bebop?topic=${encodeURIComponent(LEGACY_SPACE_RECORD)}`,
    })

    expect(document.querySelector('.thread-view')).toBeNull()
    expect(document.querySelector('.topic-card')).not.toBeNull()
    const notices = regionsWithRole('status', TOPIC_REFUSED)
    expect(notices).toHaveLength(1)
    expect(notices[0].textContent?.trim()).toBe(TOPIC_REFUSED)
    expect(requests).toEqual([])
  })

  it('keeps a typed draft when a refused topic link is followed', async () => {
    await openRoom({ custody: 'pds', posts: [topic] })
    const field = await type('#room-post', 'Draft about Ganymede')

    window.history.pushState(
      {},
      '',
      '/rooms/bebop?topic=https%3A%2F%2Fexample.test',
    )
    window.dispatchEvent(new PopStateEvent('popstate'))
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(TOPIC_REFUSED),
    )

    expect(document.querySelector<HTMLTextAreaElement>('#room-post')).toBe(
      field,
    )
    expect(field.value).toBe('Draft about Ganymede')
  })

  it('shows the notice when a feed post cannot be opened as a topic', async () => {
    const odd = {
      ...custodyPost(FAYE, '3kswordfish', 'Odd topic.'),
      uri: 'at://faye.example/zone.stratos.feed.post/3kswordfish',
    }
    await openRoom({ custody: 'stratos', posts: [odd] })
    const field = await type('#room-post', 'Draft stays')

    button('Open topic').click()
    await tick()

    expect(document.querySelector('.thread-view')).toBeNull()
    const notices = regionsWithRole('status', TOPIC_REFUSED)
    expect(notices).toHaveLength(1)
    expect(notices[0].textContent?.trim()).toBe(TOPIC_REFUSED)
    expect(field.value).toBe('Draft stays')
    expect(window.location.search).toBe('')
  })

  it('sends the root and parent exactly as the feed served them when replying', async () => {
    const root = spacePost(FAYE, '3kroot', 'Who has the bounty?')
    const reply = spacePost(SPIKE, '3kreply', 'Not me.', {
      root: { uri: root.uri, cid: root.cid },
      parent: { uri: root.uri, cid: root.cid },
    })
    await openRoom({
      custody: 'pds',
      posts: [root, reply],
      path: `/rooms/bebop?topic=${encodeURIComponent(root.uri)}`,
    })

    button('Reply').click()
    await tick()
    const field = await type('#topic-reply', 'See you, space cowboy.')
    respondTo = (request) =>
      request.url === STATUS_URL
        ? stratosAnswers('pds')(request)
        : new Response(
            JSON.stringify({
              uri: `${SPACE}/${SPIKE}/zone.stratos.feed.post/3knew`,
              cid: 'cid-new',
            }),
            { status: 200 },
          )
    submit(field)
    await vi.waitFor(() => expect(requests.length).toBe(2))

    const created = requests[1]
    expect(created.url).toBe('/xrpc/com.atproto.space.createRecord')
    expect(created.body).toMatchObject({
      space: SPACE,
      repo: SPIKE,
      collection: 'zone.stratos.feed.post',
      record: {
        text: 'See you, space cowboy.',
        reply: {
          root: { uri: root.uri, cid: root.cid },
          parent: { uri: reply.uri, cid: reply.cid },
        },
      },
    })
  })
})

describe('posting from a PDS-custody room', () => {
  it('keeps the draft and shows the failure when the PDS refuses the post', async () => {
    await openRoom({ custody: 'pds', posts: [] })
    const field = await type('#room-post', 'Bang.')
    respondTo = (request) =>
      request.url === STATUS_URL
        ? stratosAnswers('pds')(request)
        : new Response('{}', { status: 500 })

    submit(field)
    await vi.waitFor(() =>
      expect(document.querySelector('#room-post-message')?.textContent).toBe(
        'PDS could not create the post (HTTP 500).',
      ),
    )
    expect(field.value).toBe('Bang.')
  })

  it.each([
    [
      'a custody URI',
      'at://did:web:stratos.example/zone.stratos.space.feed/bebop',
    ],
    ['an earlier-spelling string', LEGACY_ROOM_SPACE],
    ['an empty string', ''],
    [
      'a space record URI',
      `${SPACE}/${SPIKE}/zone.stratos.feed.post/3kswordfish`,
    ],
  ])(
    'shows the configuration error and sends no post when the room space is %s',
    async (_label, value) => {
      await openRoom({
        custody: 'pds',
        posts: [],
        spaces: { bebop: value },
      })
      expect(
        regionsWithRole('alert', 'Posting is not set up for the room "bebop"'),
      ).toHaveLength(1)

      const field = await type('#room-post', 'Bang.')
      submit(field)
      await vi.waitFor(() =>
        expect(document.querySelector('#room-post-message')?.textContent).toBe(
          'Posting needs service configuration for this room.',
        ),
      )

      expect(requests).toEqual([{ url: STATUS_URL, method: 'GET' }])
      expect(field.value).toBe('Bang.')
    },
  )

  it('shows no configuration error for a valid room space', async () => {
    await openRoom({ custody: 'pds', posts: [] })
    expect(regionsWithRole('alert', 'Posting is not set up')).toEqual([])
  })
})

describe('the reply dialog message', () => {
  const root = pictured(spacePost(FAYE, '3kroot', 'Who has the bounty?'))
  const response = pictured(
    spacePost(FAYE, '3kresponse', 'Ask Jet.', {
      root: { uri: root.uri, cid: root.cid },
      parent: { uri: root.uri, cid: root.cid },
    }),
  )
  const CREATE_FAILED = 'PDS could not create the post (HTTP 500).'

  function pdsAnswersCreate(status: number) {
    return (request: RecordedRequest): Response =>
      request.url === STATUS_URL
        ? stratosAnswers('pds')(request)
        : status === 200
          ? new Response(
              JSON.stringify({
                uri: `${SPACE}/${SPIKE}/zone.stratos.feed.post/3knew`,
                cid: 'cid-new',
              }),
              { status },
            )
          : new Response('{}', { status })
  }

  it('shows a failed reply in the dialog only, keeps the text, clears on reopen and after a reply that succeeds', async () => {
    const { getFeed } = await openRoom({
      custody: 'pds',
      posts: [root, response],
      path: `/rooms/bebop?topic=${encodeURIComponent(root.uri)}`,
    })

    button('Reply to topic').click()
    await tick()
    const field = await type('#topic-reply', 'See you, space cowboy.')
    respondTo = pdsAnswersCreate(500)
    submit(field)
    await vi.waitFor(() =>
      expect(
        regionsWithRole('alert', CREATE_FAILED, replyDialog()!),
      ).toHaveLength(1),
    )
    expect(regionsWithRole('alert', CREATE_FAILED)).toHaveLength(1)
    expect(field.value).toBe('See you, space cowboy.')

    button('Reply').click()
    await tick()
    expect(replyDialog()?.textContent).toContain('Ask Jet.')
    expect(regionsWithRole('alert', '', replyDialog()!)).toEqual([])

    button('Cancel').click()
    await tick()
    button('Reply to topic').click()
    await tick()
    expect(regionsWithRole('alert', '', replyDialog()!)).toEqual([])

    const loadsBefore = getFeed.mock.calls.length
    respondTo = pdsAnswersCreate(200)
    submit(document.querySelector<HTMLTextAreaElement>('#topic-reply')!)
    await vi.waitFor(() =>
      expect(getFeed.mock.calls.length).toBeGreaterThan(loadsBefore),
    )
    await tick()
    expect(replyDialog()).toBeNull()
    expect(regionsWithRole('alert', CREATE_FAILED)).toEqual([])

    button('Reply to topic').click()
    await tick()
    expect(regionsWithRole('alert', '', replyDialog()!)).toEqual([])
    expect(requests.map((request) => request.url)).toEqual([
      STATUS_URL,
      '/xrpc/com.atproto.space.createRecord',
      STATUS_URL,
      '/xrpc/com.atproto.space.createRecord',
    ])
    expect(publicRequests).toEqual([])
  })

  it('opens the reply dialog with no message after an unrelated delete failed', async () => {
    const own = pictured(spacePost(SPIKE, '3kswordfish', 'Bang.'))
    await openRoom({ custody: 'pds', posts: [own] })
    respondTo = pdsAnswersCreate(500)

    button('Delete').click()
    await tick()
    button('Delete now').click()
    await vi.waitFor(() =>
      expect(
        regionsWithRole('alert', 'PDS could not delete the post (HTTP 500).'),
      ).toHaveLength(1),
    )
    expect(
      regionsWithRole(
        'alert',
        'PDS could not delete the post',
        document.querySelector('.post-composer')!,
      ),
    ).toEqual([])

    button('Reply').click()
    await tick()
    expect(replyDialog()).not.toBeNull()
    expect(regionsWithRole('alert', '', replyDialog()!)).toEqual([])
    expect(requests.map((request) => request.url)).toEqual([
      STATUS_URL,
      '/xrpc/com.atproto.space.deleteRecord',
    ])
    expect(publicRequests).toEqual([])
  })

  it('shows a refused topic notice once, and keeps delete and reply failures in their own places', async () => {
    const odd = pictured({
      ...custodyPost(SPIKE, '3kswordfish', 'Odd topic.'),
      uri: 'at://spike.example/zone.stratos.feed.post/3kswordfish',
    })
    await openRoom({ custody: 'stratos', posts: [odd] })

    button('Reply').click()
    await tick()
    expect(replyDialog()).not.toBeNull()
    expect(document.body.textContent?.split(TOPIC_REFUSED)).toHaveLength(2)
    expect(regionsWithRole('status', TOPIC_REFUSED)).toHaveLength(1)
    expect(regionsWithRole('alert', '', replyDialog()!)).toEqual([])
    expect(regionsWithRole('alert', TOPIC_REFUSED)).toEqual([])

    button('Delete').click()
    await tick()
    button('Delete now').click()
    await vi.waitFor(() =>
      expect(
        regionsWithRole('alert', 'The post reference is invalid.'),
      ).toHaveLength(1),
    )
    expect(regionsWithRole('alert', '', replyDialog()!)).toEqual([])
    expect(
      regionsWithRole('alert', '', document.querySelector('.post-composer')!),
    ).toEqual([])

    respondTo = (request) =>
      request.url === STATUS_URL
        ? stratosAnswers('stratos')(request)
        : new Response('{}', { status: 500 })
    submit(await type('#topic-reply', 'Bang.'))
    await vi.waitFor(() =>
      expect(
        regionsWithRole(
          'alert',
          'Stratos could not create the post (HTTP 500).',
          replyDialog()!,
        ),
      ).toHaveLength(1),
    )
    expect(
      regionsWithRole('alert', '', document.querySelector('.post-composer')!),
    ).toEqual([])
    expect(requests.map((request) => request.url)).toEqual([
      STATUS_URL,
      POST_URL,
    ])
    expect(publicRequests).toEqual([])
  })

  it('keeps a failed topic in the composer and out of a reply dialog', async () => {
    const topic = pictured(spacePost(FAYE, '3kroot', 'Who has the bounty?'))
    await openRoom({ custody: 'pds', posts: [topic] })
    respondTo = pdsAnswersCreate(500)

    submit(await type('#room-post', 'Bang.'))
    await vi.waitFor(() =>
      expect(
        regionsWithRole(
          'alert',
          CREATE_FAILED,
          document.querySelector('.post-composer')!,
        ),
      ).toHaveLength(1),
    )

    button('Reply').click()
    await tick()
    expect(replyDialog()).not.toBeNull()
    expect(regionsWithRole('alert', '', replyDialog()!)).toEqual([])
    expect(publicRequests).toEqual([])
  })
})

describe('the room configuration alert', () => {
  const INVALID_SPACES = {
    bebop: 'at://did:web:stratos.example/zone.stratos.space.feed/bebop',
  }
  const CONFIGURATION_PROBLEM = 'Posting is not set up for the room "bebop"'

  it('is shown to a PDS-custody member, whom it stops from posting', async () => {
    await openRoom({ custody: 'pds', posts: [], spaces: INVALID_SPACES })
    expect(regionsWithRole('alert', CONFIGURATION_PROBLEM)).toHaveLength(1)
    expect(publicRequests).toEqual([])
  })

  it('is not shown to a Stratos-custody member, who can still post in the room', async () => {
    const { getFeed } = await openRoom({
      custody: 'stratos',
      posts: [],
      spaces: INVALID_SPACES,
    })
    expect(regionsWithRole('alert', CONFIGURATION_PROBLEM)).toEqual([])
    expect(document.body.textContent).not.toContain('Posting is not set up')

    const loadsBefore = getFeed.mock.calls.length
    respondTo = (request) =>
      request.url === STATUS_URL
        ? stratosAnswers('stratos')(request)
        : new Response(
            JSON.stringify({
              uri: `at://${SPIKE}/zone.stratos.feed.post/3knew`,
              cid: 'cid-new',
            }),
            { status: 200 },
          )
    submit(await type('#room-post', 'Bang.'))
    await vi.waitFor(() =>
      expect(getFeed.mock.calls.length).toBeGreaterThan(loadsBefore),
    )
    expect(requests).toEqual([
      { url: STATUS_URL, method: 'GET' },
      {
        url: POST_URL,
        method: 'POST',
        body: { roomId: 'bebop', text: 'Bang.' },
      },
    ])
    expect(regionsWithRole('alert', '')).toEqual([])
    expect(publicRequests).toEqual([])
  })

  it('is not shown to a signed-out visitor', async () => {
    await openSignedOutRoom(INVALID_SPACES)
    expect(regionsWithRole('alert', CONFIGURATION_PROBLEM)).toEqual([])
    expect(document.body.textContent).not.toContain('Posting is not set up')
    expect(requests).toEqual([])
    expect(publicRequests).toEqual([])
  })
})

describe('deleting a post kept somewhere else than the member posts', () => {
  const KEPT_ELSEWHERE =
    'This post cannot be deleted from here. Your posts are kept in a different place from this one.'

  it.each([
    ['a PDS-custody member and a custody address', 'pds', 'custody'],
    ['a Stratos-custody member and a space address', 'stratos', 'space'],
  ] as const)(
    'says so for %s and sends no delete',
    async (_label, custody, kind) => {
      const own = pictured(
        kind === 'custody'
          ? custodyPost(SPIKE, '3kswordfish', 'Bang.')
          : spacePost(SPIKE, '3kswordfish', 'Bang.'),
      )
      await openRoom({ custody, posts: [own] })

      button('Delete').click()
      await tick()
      button('Delete now').click()
      await vi.waitFor(() =>
        expect(regionsWithRole('alert', KEPT_ELSEWHERE)).toHaveLength(1),
      )
      expect(
        regionsWithRole('alert', 'The post reference is invalid.'),
      ).toEqual([])
      expect(requests).toEqual([{ url: STATUS_URL, method: 'GET' }])
      expect(publicRequests).toEqual([])
      expect(document.body.textContent).toContain('Bang.')
    },
  )
})

describe('deleting a post in a space that is not the room configured one', () => {
  const KEPT_ELSEWHERE =
    'This post cannot be deleted from here. Your posts are kept in a different place from this one.'

  it.each([
    ['another authority', SPACE.replace('stratos.example', 'other.example')],
    ['another space type', SPACE.replace('space.feed', 'space.other')],
    ['another space name', SPACE.replace('bebop', 'cowboys')],
  ])(
    'says so for a PDS-custody member and %s, and sends no delete',
    async (_label, space) => {
      const own = pictured({
        ...spacePost(SPIKE, '3kswordfish', 'Bang.'),
        uri: `${space}/${SPIKE}/zone.stratos.feed.post/3kswordfish`,
      })
      await openRoom({ custody: 'pds', posts: [own] })

      button('Delete').click()
      await tick()
      button('Delete now').click()
      await vi.waitFor(() =>
        expect(regionsWithRole('alert', KEPT_ELSEWHERE)).toHaveLength(1),
      )
      expect(requests).toEqual([{ url: STATUS_URL, method: 'GET' }])
      expect(publicRequests).toEqual([])
      expect(document.body.textContent).toContain('Bang.')
    },
  )
})

describe('an unreadable room spaces setting', () => {
  const UNREADABLE =
    'Posting is not set up because the room spaces setting could not be read; ask whoever runs this Clubhouse to correct it.'

  it.each([
    ['text that is not JSON', '{bebop: '],
    ['a JSON array', '[]'],
  ])(
    'shows the error to a PDS-custody member when it is %s, and posting answers the configuration error',
    async (_label, text) => {
      await openRoom({
        custody: 'pds',
        posts: [],
        spaceSetting: { text },
      })
      const alerts = regionsWithRole('alert', '')
      expect(alerts).toHaveLength(1)
      expect(alerts[0].textContent?.trim()).toBe(UNREADABLE)

      const field = await type('#room-post', 'Bang.')
      submit(field)
      await vi.waitFor(() =>
        expect(document.querySelector('#room-post-message')?.textContent).toBe(
          'Posting needs service configuration for this room.',
        ),
      )
      expect(requests).toEqual([{ url: STATUS_URL, method: 'GET' }])
      expect(publicRequests).toEqual([])
    },
  )

  it.each([
    ['text that is not JSON', '{bebop: '],
    ['a JSON array', '[]'],
  ])(
    'shows nothing to a Stratos-custody member when it is %s',
    async (_label, text) => {
      await openRoom({
        custody: 'stratos',
        posts: [],
        spaceSetting: { text },
      })
      expect(regionsWithRole('alert', '')).toEqual([])
      expect(document.body.textContent).not.toContain('room spaces setting')
      expect(requests).toEqual([])
      expect(publicRequests).toEqual([])
    },
  )

  it('shows nothing to a PDS-custody member when the setting is absent', async () => {
    await openRoom({
      custody: 'pds',
      posts: [],
      spaceSetting: { text: undefined },
    })
    expect(regionsWithRole('alert', '')).toEqual([])
    expect(document.body.textContent).not.toContain('room spaces setting')
    expect(requests).toEqual([])
    expect(publicRequests).toEqual([])
  })
})

describe('a record address ending in a line terminator', () => {
  const topic = pictured(spacePost(FAYE, '3kswordfish', 'Who has the bounty?'))

  it.each([
    ['a line feed', '\n'],
    ['a carriage return and line feed', '\r\n'],
  ])(
    'refuses a topic link ending in %s, opens no thread and sends nothing',
    async (_label, terminator) => {
      await openRoom({
        custody: 'pds',
        posts: [topic],
        path: `/rooms/bebop?topic=${encodeURIComponent(topic.uri + terminator)}`,
      })

      expect(document.querySelector('.thread-view')).toBeNull()
      const notices = regionsWithRole('status', TOPIC_REFUSED)
      expect(notices).toHaveLength(1)
      expect(notices[0].textContent?.trim()).toBe(TOPIC_REFUSED)
      expect(requests).toEqual([])
      expect(publicRequests).toEqual([])
    },
  )

  it('refuses to open a feed post whose address ends in a line feed', async () => {
    const odd = { ...topic, uri: `${topic.uri}\n` }
    await openRoom({ custody: 'pds', posts: [odd] })

    button('Open topic').click()
    await tick()

    expect(document.querySelector('.thread-view')).toBeNull()
    expect(regionsWithRole('status', TOPIC_REFUSED)).toHaveLength(1)
    expect(window.location.search).toBe('')
    expect(requests).toEqual([])
    expect(publicRequests).toEqual([])
  })

  it.each([
    ['a PDS-custody member and a space address', 'pds', 'space', '\n'],
    ['a PDS-custody member and a space address', 'pds', 'space', '\r\n'],
    [
      'a Stratos-custody member and a custody address',
      'stratos',
      'custody',
      '\n',
    ],
    [
      'a Stratos-custody member and a custody address',
      'stratos',
      'custody',
      '\r\n',
    ],
  ] as const)(
    'refuses the delete for %s ending in a line terminator and sends nothing',
    async (_label, custody, kind, terminator) => {
      const post = pictured(
        kind === 'custody'
          ? custodyPost(SPIKE, '3kswordfish', 'Bang.')
          : spacePost(SPIKE, '3kswordfish', 'Bang.'),
      )
      await openRoom({
        custody,
        posts: [{ ...post, uri: post.uri + terminator }],
      })

      button('Delete').click()
      await tick()
      button('Delete now').click()
      await vi.waitFor(() =>
        expect(document.querySelector('.delete-error')?.textContent).toBe(
          'The post reference is invalid.',
        ),
      )
      expect(requests).toEqual([])
      expect(publicRequests).toEqual([])
      expect(document.body.textContent).toContain('Bang.')
    },
  )
})

describe('rooms named like the properties every object inherits', () => {
  const INHERITED_NAMES = [
    'constructor',
    'toString',
    'hasOwnProperty',
    'valueOf',
    '__proto__',
  ]
  const INVALID_SPACE =
    'at://did:web:stratos.example/zone.stratos.space.feed/bebop'
  const problemFor = (roomId: string) =>
    `Posting is not set up for the room "${roomId}": the space it was given is not a valid space address. Ask whoever runs this Clubhouse to correct it.`

  // The configured value is written as JSON text, so a `__proto__` key reaches
  // the reader exactly as an operator would write it.
  function spacesJson(entries: Array<[string, string]>): string {
    return JSON.stringify(Object.fromEntries(entries))
  }

  async function openNamedRoom(
    roomId: string,
    custody: RoomCustody,
    configuredSpaces: string,
  ) {
    vi.stubEnv('VITE_STRATOS_URL', 'https://stratos.example')
    vi.stubEnv('VITE_CLUBHOUSE_PDS_SPACE_URIS_JSON', configuredSpaces)
    respondTo = (request) =>
      request.url === STATUS_URL
        ? new Response(
            JSON.stringify({
              rooms: [{ id: roomId, state: 'joined' }],
              custody,
            }),
            { status: 200 },
          )
        : new Response('{}', { status: 200 })
    mocks.session = {
      sub: SPIKE,
      fetchHandler: async (url: string, init?: RequestInit) => {
        const request: RecordedRequest = {
          url,
          method: init?.method ?? 'GET',
          ...(typeof init?.body === 'string'
            ? { body: JSON.parse(init.body) as unknown }
            : {}),
        }
        requests.push(request)
        return respondTo(request)
      },
    }
    const getFeed = vi.fn(async () => ({ posts: [] }))
    const integration = {
      ...createClubhouseIntegration(loadClubhouseConfig()),
      getFeed,
    }
    window.history.replaceState({}, '', `/rooms/${encodeURIComponent(roomId)}`)
    component = mount(App, {
      target: document.body,
      props: {
        integration,
        catalogFetcher: vi.fn().mockResolvedValue([
          {
            id: roomId,
            displayName: 'Bebop',
            description: 'The crew lounge',
            available: true,
          },
        ]),
      },
    })
    await vi.waitFor(() =>
      expect(document.querySelector('.feed-panel')).not.toBeNull(),
    )
    await vi.waitFor(() => expect(getFeed).toHaveBeenCalled())
    await tick()
    requests.length = 0
  }

  async function postBang(roomId: string) {
    respondTo = (request) =>
      request.url === STATUS_URL
        ? new Response(
            JSON.stringify({
              rooms: [{ id: roomId, state: 'joined' }],
              custody: 'pds',
            }),
            { status: 200 },
          )
        : new Response(
            JSON.stringify({
              uri: `${SPACE}/${SPIKE}/zone.stratos.feed.post/3knew`,
              cid: 'cid-new',
            }),
            { status: 200 },
          )
    const field = await type('#room-post', 'Bang.')
    submit(field)
    return field
  }

  it.each(INHERITED_NAMES)(
    'shows no alert for the room %s with a valid space, and posts with that space',
    async (roomId) => {
      await openNamedRoom(roomId, 'pds', spacesJson([[roomId, SPACE]]))
      expect(regionsWithRole('alert', '')).toEqual([])
      expect(document.body.textContent).not.toContain('Posting is not set up')

      await postBang(roomId)
      await vi.waitFor(() => expect(requests).toHaveLength(2))
      expect(requests[0]).toEqual({ url: STATUS_URL, method: 'GET' })
      expect(requests[1]).toMatchObject({
        url: '/xrpc/com.atproto.space.createRecord',
        method: 'POST',
        body: {
          space: SPACE,
          repo: SPIKE,
          collection: 'zone.stratos.feed.post',
          record: { text: 'Bang.' },
        },
      })
      expect(publicRequests).toEqual([])
    },
  )

  it.each(INHERITED_NAMES)(
    'names the room %s when its space is invalid, to a PDS-custody member',
    async (roomId) => {
      await openNamedRoom(roomId, 'pds', spacesJson([[roomId, INVALID_SPACE]]))
      const alerts = regionsWithRole('alert', '')
      expect(alerts).toHaveLength(1)
      expect(alerts[0].textContent?.trim()).toBe(problemFor(roomId))
      expect(requests).toEqual([])
      expect(publicRequests).toEqual([])
    },
  )

  it.each(INHERITED_NAMES)(
    'shows no alert for the room %s with an invalid space to a Stratos-custody member',
    async (roomId) => {
      await openNamedRoom(
        roomId,
        'stratos',
        spacesJson([[roomId, INVALID_SPACE]]),
      )
      expect(regionsWithRole('alert', '')).toEqual([])
      expect(document.body.textContent).not.toContain('Posting is not set up')
    },
  )

  it.each(INHERITED_NAMES)(
    'shows nothing and sends no post for the room %s when no space is configured for it',
    async (roomId) => {
      await openNamedRoom(roomId, 'pds', spacesJson([['bebop', SPACE]]))
      expect(regionsWithRole('alert', '')).toEqual([])
      expect(document.body.textContent).not.toContain('Posting is not set up')

      const field = await postBang(roomId)
      await vi.waitFor(() =>
        expect(document.querySelector('#room-post-message')?.textContent).toBe(
          'Posting needs service configuration for this room.',
        ),
      )
      expect(requests).toEqual([{ url: STATUS_URL, method: 'GET' }])
      expect(field.value).toBe('Bang.')
      expect(publicRequests).toEqual([])
    },
  )
})
