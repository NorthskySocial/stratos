#!/usr/bin/env -S deno run -A

import { DOMAINS } from './lib/config.ts'
import { adminGetBoundaries, adminSetBoundaries } from './lib/admin.ts'
import { buildFeedgen, FEEDGEN_DID, FeedgenHarness } from './lib/feedgen.ts'
import { assert, fail, finish, pass, section } from './lib/log.ts'
import { createSession, getServiceAuth } from './lib/pds.ts'
import { loadState } from './lib/state.ts'
import { createRecord } from './lib/stratos.ts'

const FEEDGEN_PORT = 3300
const FEEDGEN_URL = `http://127.0.0.1:${FEEDGEN_PORT}`
const GET_FEED_LXM = 'zone.stratos.feedgen.getFeed'
const COLLECTION = 'zone.stratos.feed.post'

interface PostView {
  uri: string
  cid: string
  author: { did: string; handle?: string }
  record: Record<string, unknown>
  indexedAt: string
}

interface GetFeedBody {
  feed: Array<{ post: PostView }>
}

interface DescribeFeedBody {
  did: string
  feeds: Array<{ id: string; boundary: string }>
}

interface ReplayCheck {
  authorDid: string
  cid: string
  uri: string
  viewer: { did: string; handle: string; password: string }
}

async function mintViewerJwt(
  handle: string,
  password: string,
): Promise<string> {
  const session = await createSession(handle, password)
  return await getServiceAuth(session.accessJwt, FEEDGEN_DID, GET_FEED_LXM)
}

async function getFeed(
  token: string | null,
  feed: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(
    `${FEEDGEN_URL}/xrpc/zone.stratos.feedgen.getFeed?${new URLSearchParams({ feed })}`,
    { headers },
  )
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  }
}

async function waitForPost(
  token: string,
  feed: string,
  uri: string,
  timeoutMs = 30_000,
): Promise<PostView | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { status, body } = await getFeed(token, feed)
    const post = (body as unknown as GetFeedBody).feed?.find(
      (item) => item.post?.uri === uri,
    )?.post
    if (status === 200 && post) return post
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return null
}

async function waitForFeedReadiness(
  token: string,
  feed: string,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { status } = await getFeed(token, feed)
    if (status === 200) return true
    if (status !== 503) return false
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

async function run(): Promise<void> {
  section('Phase 4f: Feedgen — describeFeed & getFeed')
  const state = await loadState()
  const rei = state.users.rei
  const sakura = state.users.sakura
  const kaoruko = state.users.kaoruko
  const adminSessionCookie = state.adminSessionCookie
  if (
    !rei?.enrolled ||
    !sakura?.enrolled ||
    !kaoruko?.enrolled ||
    !adminSessionCookie
  ) {
    fail(
      'Users rei, sakura, kaoruko and an admin session must be available — run earlier phases',
    )
    finish()
  }
  if (!(await buildFeedgen())) {
    fail('stratos-feedgen bundle')
    finish()
  }
  pass('stratos-feedgen bundled')

  const feedgen = await FeedgenHarness.create()
  try {
    await feedgen.start({ port: FEEDGEN_PORT })
    await assertFeedgenWarmup(feedgen, 'initial')
    const replay = await exerciseFeedgen(feedgen, { rei, sakura, kaoruko })
    if (replay) {
      await feedgen.stop()
      await feedgen.start({ port: FEEDGEN_PORT })
      await assertFeedgenWarmup(feedgen, 'restart')
      await verifyReplay(feedgen, replay)
      await verifyReplayAuthorization(feedgen, replay, adminSessionCookie)
    }
  } finally {
    await feedgen.cleanup()
  }
  finish()
}

async function assertFeedgenWarmup(
  feedgen: FeedgenHarness,
  phase: string,
): Promise<void> {
  const warmup = await feedgen.waitForWarmup(30_000)
  assert(
    warmup.attempted === 2,
    `${phase} credential warm-up attempts both configured boundaries`,
    String(warmup.attempted),
  )
  assert(
    warmup.acquired === 2,
    `${phase} credential warm-up acquires both configured boundaries`,
    String(warmup.acquired),
  )
  assert(
    warmup.failed === 0,
    `${phase} credential warm-up has no failed boundary`,
    String(warmup.failed),
  )
}

async function exerciseFeedgen(
  feedgen: FeedgenHarness,
  users: {
    rei: { did: string; handle: string; password: string }
    sakura: { did: string; handle: string; password: string }
    kaoruko: { handle: string; password: string }
  },
): Promise<ReplayCheck | null> {
  if (!(await feedgen.waitForHealth(FEEDGEN_PORT, 30_000))) {
    fail('feedgen /health did not become ready within 30s')
    return null
  }
  pass('feedgen healthy', FEEDGEN_URL)

  const text = 'Totosai reforges Tessaiga at the swordsmith village'
  let created: { uri: string; cid: string }
  try {
    created = await createRecord(users.rei.did, COLLECTION, {
      $type: COLLECTION,
      text,
      boundary: { values: [{ value: DOMAINS.swordsmith }] },
      createdAt: new Date().toISOString(),
    })
    pass('createRecord as rei (swordsmith boundary)', created.uri)
  } catch (err) {
    fail('createRecord as rei (swordsmith boundary)', String(err))
    return null
  }

  const describeRes = await fetch(
    `${FEEDGEN_URL}/xrpc/zone.stratos.feedgen.describeFeed`,
  )
  assert(describeRes.status === 200, 'describeFeed responds 200')
  const describe = (await describeRes.json()) as DescribeFeedBody
  assert(describe.did === FEEDGEN_DID, 'describeFeed.did is the feedgen DID')
  for (const id of ['swordsmith', 'aekea'] as const) {
    const entry = describe.feeds.find((feed) => feed.id === id)
    assert(
      entry?.boundary === DOMAINS[id],
      `describeFeed lists feed "${id}" with its boundary`,
      entry?.boundary,
    )
  }

  const sakuraJwt = await mintViewerJwt(
    users.sakura.handle,
    users.sakura.password,
  )
  const post = await waitForPost(sakuraJwt, 'swordsmith', created.uri)
  assert(
    post !== null,
    'shared-boundary viewer sees the fresh post',
    created.uri,
  )
  if (post) {
    assert(
      post.cid === created.cid,
      'postView.cid matches the create',
      post.cid,
    )
    assert(
      post.author.did === users.rei.did,
      'postView.author.did is the author',
    )
    assert(
      post.record['text'] === text,
      'postView.record is the hydrated record body',
    )
    assert(
      !Number.isNaN(Date.parse(post.indexedAt)),
      'postView.indexedAt is a datetime',
    )
  }

  const kaorukoJwt = await mintViewerJwt(
    users.kaoruko.handle,
    users.kaoruko.password,
  )
  const mismatch = await getFeed(kaorukoJwt, 'swordsmith')
  assert(
    mismatch.status === 400 && mismatch.body['error'] === 'BoundaryMismatch',
    'viewer without the boundary gets BoundaryMismatch',
  )
  const unknown = await getFeed(sakuraJwt, 'yorozuya')
  assert(
    unknown.status === 400 && unknown.body['error'] === 'UnknownFeed',
    'unconfigured feed id gets UnknownFeed',
  )
  const anonymous = await getFeed(null, 'swordsmith')
  assert(
    anonymous.status === 401,
    'unauthenticated getFeed is rejected with 401',
  )

  return post
    ? {
        authorDid: users.rei.did,
        cid: created.cid,
        uri: created.uri,
        viewer: users.sakura,
      }
    : null
}

async function verifyReplay(
  feedgen: FeedgenHarness,
  replay: ReplayCheck,
): Promise<void> {
  section('Restart replay rebuilds the in-memory feed index')
  if (!(await feedgen.waitForHealth(FEEDGEN_PORT, 30_000))) {
    fail('restarted feedgen /health did not become ready within 30s')
    return
  }
  const token = await mintViewerJwt(
    replay.viewer.handle,
    replay.viewer.password,
  )
  const post = await waitForPost(token, 'swordsmith', replay.uri)
  assert(post?.uri === replay.uri, 'same viewer sees the same URI after replay')
  assert(post?.cid === replay.cid, 'same viewer sees the same CID after replay')
  assert(
    post?.author.did === replay.authorDid,
    'same viewer sees the same author after replay',
  )
}

async function verifyReplayAuthorization(
  feedgen: FeedgenHarness,
  replay: ReplayCheck,
  adminSessionCookie: string,
): Promise<void> {
  section('Replay admission uses current author membership')
  const originalBoundaries = await adminGetBoundaries(
    replay.authorDid,
    adminSessionCookie,
  )
  assert(
    originalBoundaries?.includes(DOMAINS.swordsmith),
    'author holds swordsmith before the replay-authorization check',
    originalBoundaries?.join(', '),
  )
  if (!originalBoundaries?.includes(DOMAINS.swordsmith)) return

  await feedgen.stop()
  let boundariesChanged = false
  try {
    const change = await adminSetBoundaries(
      replay.authorDid,
      [DOMAINS.aekea],
      adminSessionCookie,
    )
    boundariesChanged = change.status === 200
    assert(
      boundariesChanged,
      'admin moves the author from swordsmith to aekea while feedgen is stopped',
      `status=${change.status}`,
    )
    if (!boundariesChanged) return

    await feedgen.start({ port: FEEDGEN_PORT })
    await assertFeedgenWarmup(feedgen, 'stale-membership replay')
    if (!(await feedgen.waitForHealth(FEEDGEN_PORT, 30_000))) {
      fail('feedgen /health did not become ready for replay authorization')
      return
    }
    const token = await mintViewerJwt(
      replay.viewer.handle,
      replay.viewer.password,
    )
    const feedReady = await waitForFeedReadiness(token, 'swordsmith')
    assert(
      feedReady,
      'feed reads become ready before replay authorization is evaluated',
    )
    if (!feedReady) return
    const resurrected = await waitForPost(
      token,
      'swordsmith',
      replay.uri,
      15_000,
    )
    assert(
      resurrected === null,
      'a historical swordsmith post is denied after the author loses swordsmith',
      resurrected?.uri,
    )
  } finally {
    if (boundariesChanged) {
      const restore = await adminSetBoundaries(
        replay.authorDid,
        originalBoundaries,
        adminSessionCookie,
      )
      assert(
        restore.status === 200,
        'admin restores the author boundaries after replay authorization',
        `status=${restore.status}`,
      )
    }
  }
}

run().catch((err) => {
  console.error('\nFeedgen test failed:', err)
  Deno.exit(1)
})
