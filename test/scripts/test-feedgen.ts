#!/usr/bin/env -S deno run -A
// Feedgen E2E — boundary-scoped hydrated feeds over the real service stack.
//
// Builds and launches the feedgen from its workspace package against the
// running Stratos, then asserts the zone.stratos.feedgen.* lexicon contract:
// describeFeed lists the configured feeds, getFeed returns hydrated postViews
// only to viewers holding the feed's boundary, and the declared UnknownFeed /
// BoundaryMismatch errors and the service-auth requirement are enforced.
//
// The feedgen's identity (did:web:feedgen.test) is declared to Stratos via
// STRATOS_SERVICE_ENROLLMENTS in the compose files, with an inline did:key so
// Stratos verifies its JWTs without resolving the non-resolvable did:web.

import { DOMAINS, SERVICE_DID, STRATOS_URL, TEST_ROOT } from './lib/config.ts'
import { loadState } from './lib/state.ts'
import { createSession, getServiceAuth } from './lib/pds.ts'
import { createRecord } from './lib/stratos.ts'
import { assert, fail, finish, info, pass, section } from './lib/log.ts'

const FEEDGEN_DID = 'did:web:feedgen.test'
// Private key for the did:key declared in STRATOS_SERVICE_ENROLLMENTS
// (docker-compose.test.yml / docker-compose.e2e.yml). Test-only material.
const FEEDGEN_SIGNING_KEY =
  '097ce261481a889a756db476dceb6cc57596541c264675e9712c7252cfd1183c'
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
  cursor?: string
  feed: Array<{ post: PostView }>
}

interface DescribeFeedBody {
  did: string
  feeds: Array<{ id: string; boundary: string }>
}

async function buildFeedgen(): Promise<boolean> {
  // Run the esbuild bundle, not the tsc build. The tsc dist keeps the bare
  // stratos-core import, which resolves to workspace TS source that plain
  // node cannot load. The bundle is the artifact the Docker image ships.
  info('bundling stratos-feedgen (production esbuild bundle)')
  const result = await new Deno.Command('pnpm', {
    args: ['--filter', '@northskysocial/stratos-feedgen', 'bundle'],
    cwd: `${TEST_ROOT}/..`,
    stdout: 'inherit',
    stderr: 'inherit',
  }).output()
  return result.success
}

function startFeedgen(sqlitePath: string): Deno.ChildProcess {
  const feedsJson = JSON.stringify({
    feeds: [
      { id: 'swordsmith', boundary: DOMAINS.swordsmith },
      { id: 'aekea', boundary: DOMAINS.aekea },
    ],
  })
  return new Deno.Command('node', {
    args: ['dist-bundle/main.mjs'],
    cwd: `${TEST_ROOT}/../stratos-feedgen`,
    env: {
      FEEDGEN_SERVICE_DID: FEEDGEN_DID,
      FEEDGEN_SIGNING_KEY,
      FEEDGEN_PUBLIC_URL: FEEDGEN_URL,
      FEEDGEN_PORT: String(FEEDGEN_PORT),
      FEEDGEN_SQLITE_PATH: sqlitePath,
      FEEDGEN_FEEDS_JSON: feedsJson,
      STRATOS_SERVICE_URL: STRATOS_URL,
      STRATOS_SERVICE_DID: SERVICE_DID,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  }).spawn()
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${FEEDGEN_URL}/health`)
      const body = (await res.json()) as { ok?: boolean }
      if (res.ok && body.ok === true) return true
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
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
  const params = new URLSearchParams({ feed })
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(
    `${FEEDGEN_URL}/xrpc/zone.stratos.feedgen.getFeed?${params}`,
    { headers },
  )
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, body }
}

/** Poll getFeed until the given post uri appears (indexing is async). */
async function waitForPost(
  token: string,
  feed: string,
  uri: string,
  timeoutMs: number,
): Promise<PostView | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { status, body } = await getFeed(token, feed)
    if (status === 200) {
      const found = (body as unknown as GetFeedBody).feed?.find(
        (item) => item.post?.uri === uri,
      )
      if (found) return found.post
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

interface FeedgenUsers {
  rei: { did: string; handle: string; password: string }
  sakura: { handle: string; password: string }
  kaoruko: { handle: string; password: string }
}

async function run() {
  section('Phase 4f: Feedgen — describeFeed & getFeed')

  const state = await loadState()
  const rei = state.users.rei // author, swordsmith
  const sakura = state.users.sakura // shares swordsmith
  const kaoruko = state.users.kaoruko // aekea only
  if (!rei?.enrolled || !sakura?.enrolled || !kaoruko?.enrolled) {
    fail('Users rei, sakura, kaoruko must be enrolled — run earlier phases')
    finish()
  }

  if (!(await buildFeedgen())) {
    fail('stratos-feedgen bundle')
    finish()
  }
  pass('stratos-feedgen bundled')

  const tmpDir = await Deno.makeTempDir({ prefix: 'feedgen-e2e-' })
  const feedgen = startFeedgen(`${tmpDir}/feedgen.sqlite`)

  // finish() calls Deno.exit, which skips finally blocks. Early aborts in
  // exerciseFeedgen therefore return instead, so the child process and the
  // temp dir are cleaned up before the summary runs.
  try {
    await exerciseFeedgen({ rei, sakura, kaoruko })
  } finally {
    info('stopping feedgen')
    try {
      feedgen.kill('SIGTERM')
      await feedgen.status
    } catch {
      // already exited
    }
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {})
  }

  finish()
}

async function exerciseFeedgen({ rei, sakura, kaoruko }: FeedgenUsers) {
  if (!(await waitForHealth(30_000))) {
    fail('feedgen /health did not become ready within 30s')
    return
  }
  pass('feedgen healthy', FEEDGEN_URL)

  section('Fresh boundary-scoped post to index')
  const text = 'Totosai reforges Tessaiga at the swordsmith village'
  let createdUri = ''
  let createdCid = ''
  try {
    const created = await createRecord(rei.did, COLLECTION, {
      $type: COLLECTION,
      text,
      boundary: { values: [{ value: DOMAINS.swordsmith }] },
      createdAt: new Date().toISOString(),
    })
    createdUri = created.uri
    createdCid = created.cid
    pass('createRecord as rei (swordsmith boundary)', created.uri)
  } catch (err) {
    fail('createRecord as rei (swordsmith boundary)', String(err))
    return
  }

  section('describeFeed lists the configured feeds (unauthenticated)')
  const describeRes = await fetch(
    `${FEEDGEN_URL}/xrpc/zone.stratos.feedgen.describeFeed`,
  )
  assert(describeRes.status === 200, 'describeFeed responds 200')
  const describe = (await describeRes.json()) as DescribeFeedBody
  assert(
    describe.did === FEEDGEN_DID,
    'describeFeed.did is the feedgen DID',
    describe.did,
  )
  for (const id of ['swordsmith', 'aekea']) {
    const entry = describe.feeds?.find((f) => f.id === id)
    assert(
      entry !== undefined && entry.boundary === DOMAINS[id as 'swordsmith'],
      `describeFeed lists feed "${id}" with its boundary`,
      entry?.boundary,
    )
  }

  section('getFeed returns the hydrated post to a boundary member')
  const sakuraJwt = await mintViewerJwt(sakura.handle, sakura.password)
  const post = await waitForPost(sakuraJwt, 'swordsmith', createdUri, 30_000)
  assert(
    post !== null,
    'shared-boundary viewer sees the fresh post',
    createdUri,
  )
  if (post) {
    assert(post.cid === createdCid, 'postView.cid matches the create', post.cid)
    assert(
      post.author?.did === rei.did,
      'postView.author.did is the author',
      post.author?.did,
    )
    assert(
      post.record?.['text'] === text,
      'postView.record is the hydrated record body',
    )
    assert(
      !Number.isNaN(Date.parse(post.indexedAt)),
      'postView.indexedAt is a datetime',
      post.indexedAt,
    )
  }

  section('Declared errors: BoundaryMismatch and UnknownFeed')
  const kaorukoJwt = await mintViewerJwt(kaoruko.handle, kaoruko.password)
  const mismatch = await getFeed(kaorukoJwt, 'swordsmith')
  assert(
    mismatch.status === 400 && mismatch.body['error'] === 'BoundaryMismatch',
    'viewer without the boundary gets BoundaryMismatch',
    `status=${mismatch.status} error=${mismatch.body['error']}`,
  )
  const unknown = await getFeed(sakuraJwt, 'yorozuya')
  assert(
    unknown.status === 400 && unknown.body['error'] === 'UnknownFeed',
    'unconfigured feed id gets UnknownFeed',
    `status=${unknown.status} error=${unknown.body['error']}`,
  )

  section('getFeed requires service-auth')
  const anon = await getFeed(null, 'swordsmith')
  assert(
    anon.status === 401,
    'unauthenticated getFeed is rejected with 401',
    `status=${anon.status}`,
  )
}

run().catch((err) => {
  console.error('\nFeedgen test failed:', err)
  Deno.exit(1)
})
