#!/usr/bin/env -S deno run -A

import { DOMAINS } from './lib/config.ts'
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
): Promise<PostView | null> {
  const deadline = Date.now() + 30_000
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

async function run(): Promise<void> {
  section('Phase 4f: Feedgen — describeFeed & getFeed')
  const state = await loadState()
  const rei = state.users.rei
  const sakura = state.users.sakura
  const kaoruko = state.users.kaoruko
  if (!rei?.enrolled || !sakura?.enrolled || !kaoruko?.enrolled) {
    fail('Users rei, sakura, kaoruko must be enrolled — run earlier phases')
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

run().catch((err) => {
  console.error('\nFeedgen test failed:', err)
  Deno.exit(1)
})
