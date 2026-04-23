#!/usr/bin/env -S deno run -A
/**
 * AppView feed E2E tests.
 *
 * Validates the full pipeline:
 *   Stratos records → WebSocket subscription → AppView indexing → Feed endpoints
 *
 * Prerequisites:
 *   - Stratos running with enrolled users and configured boundaries
 *   - AppView test server running and connected to Stratos
 *   - Posts created via test-posts.ts (or created fresh here)
 *
 * Test matrix:
 *   - Rei (swordsmith) sees swordsmith posts in timeline
 *   - Kaoruko (aekea) sees aekea posts in timeline
 *   - Kaoruko does NOT see Rei's swordsmith posts
 *   - getAuthorFeed filters by viewer boundary
 *   - getPost allows same-boundary access
 *   - getPost denies cross-boundary access
 *   - Unauthenticated timeline is denied
 */

import { createRecord } from './lib/stratos.ts'
import type { CreateRecordResponse } from './lib/stratos.ts'
import { loadState } from './lib/state.ts'
import type { TestState, UserState } from './lib/state.ts'
import { fail, info, pass, section, summary } from './lib/log.ts'
import type { FeedViewPost } from './lib/appview.ts'
import {
  enrollWithAppview,
  getAppviewDiagnostics,
  getAuthorFeed,
  getPost,
  getTimeline,
  getTimelineUnauthenticated,
  tryGetPost,
  waitForAppviewHealthy,
  waitForIndexing,
} from './lib/appview.ts'

let passed = 0
let failed = 0

function assertTrue(
  condition: unknown,
  testName: string,
  detail?: string,
): void {
  if (condition) {
    pass(testName, detail)
    passed++
  } else {
    fail(testName, detail)
    failed++
  }
}

function assertFalse(
  condition: unknown,
  testName: string,
  detail?: string,
): void {
  if (!condition) {
    pass(testName, detail)
    passed++
  } else {
    fail(testName, detail)
    failed++
  }
}

async function run() {
  section('AppView Feed E2E Tests')

  const state = await loadState()
  const users = await validateUserState(state)

  await ensureAppViewHealthy()
  await registerEnrollments(state)

  // Wait for WebSocket subscriptions to connect
  info('Waiting for actor subscriptions to connect...')
  await new Promise((r) => setTimeout(r, 3000))

  const posts = await createTestPosts(users)
  await waitForAppViewIndexing(4)

  await runTimelineTests(users, posts)
  await runAuthorFeedTests(users)
  await runGetPostTests(users, posts)
  await runUnauthenticatedTests()
  await runBoundaryFilterTests(state, posts)

  section('AppView Feed Test Results')
  summary(passed, failed)

  if (failed > 0) {
    await logFinalDiagnostics()
    Deno.exit(1)
  }
}

async function validateUserState(state: TestState) {
  const { rei, sakura, kaoruko } = state.users
  if (!rei?.did || !sakura?.did || !kaoruko?.did) {
    fail(
      'Missing user state',
      'Run setup.ts + direct-enroll.ts + configure-boundaries.ts first',
    )
    Deno.exit(1)
  }
  return { rei, sakura, kaoruko }
}

async function ensureAppViewHealthy() {
  section('Wait for AppView')
  try {
    await waitForAppviewHealthy(30_000)
    pass('AppView is healthy')
  } catch (err) {
    fail('AppView health check failed', String(err))
    Deno.exit(1)
  }
}

async function registerEnrollments(state: TestState) {
  section('Register enrollments with AppView')
  for (const [name, user] of Object.entries(state.users)) {
    if (!user.did) continue
    try {
      const result = await enrollWithAppview(user.did)
      pass(
        `Enrolled ${name} with AppView`,
        `boundaries=[${result.boundaries.join(',')}]`,
      )
    } catch (err) {
      fail(`Failed to enroll ${name} with AppView`, String(err))
    }
  }
}

async function createTestPosts(users: {
  rei: UserState
  sakura: UserState
  kaoruko: UserState
}) {
  section('Create test posts')
  const { rei, sakura, kaoruko } = users

  info('Creating swordsmith posts from Rei...')
  const reiPost1 = await createRecord(rei.did, 'zone.stratos.feed.post', {
    $type: 'zone.stratos.feed.post',
    text: 'Rei forging a new katana at the Spirit Forge',
    boundary: { values: [{ value: 'swordsmith' }] },
    createdAt: new Date().toISOString(),
  })
  pass('Rei post 1 created', reiPost1.uri)

  const reiPost2 = await createRecord(rei.did, 'zone.stratos.feed.post', {
    $type: 'zone.stratos.feed.post',
    text: 'The blade of the Zanpakutō glows with inner fire',
    boundary: { values: [{ value: 'swordsmith' }] },
    createdAt: new Date().toISOString(),
  })
  pass('Rei post 2 created', reiPost2.uri)

  info('Creating swordsmith post from Sakura...')
  const sakuraPost = await createRecord(sakura.did, 'zone.stratos.feed.post', {
    $type: 'zone.stratos.feed.post',
    text: 'Sakura polishing the sacred Hōgyoku blade',
    boundary: { values: [{ value: 'swordsmith' }] },
    createdAt: new Date().toISOString(),
  })
  pass('Sakura post created', sakuraPost.uri)

  info('Creating aekea post from Kaoruko...')
  const kaorukoPost = await createRecord(
    kaoruko.did,
    'zone.stratos.feed.post',
    {
      $type: 'zone.stratos.feed.post',
      text: 'Kaoruko arranging flowers in the Aekea garden pavilion',
      boundary: { values: [{ value: 'aekea' }] },
      createdAt: new Date().toISOString(),
    },
  )
  pass('Kaoruko post created', kaorukoPost.uri)

  return { reiPost1, reiPost2, sakuraPost, kaorukoPost }
}

async function waitForAppViewIndexing(expectedCount: number) {
  section('Wait for indexing')
  try {
    const diag = await waitForIndexing(expectedCount, 30_000)
    pass(
      'AppView indexed all posts',
      `posts=${diag.posts} boundaries=${diag.boundaries}`,
    )
  } catch (err) {
    fail('Indexing timeout', String(err))
    await logFinalDiagnostics()
    Deno.exit(1)
  }
}

async function runTimelineTests(
  users: { rei: UserState; kaoruko: UserState },
  posts: {
    reiPost1: CreateRecordResponse
    sakuraPost: CreateRecordResponse
    kaorukoPost: CreateRecordResponse
  },
) {
  section('Test 1: Timeline — swordsmith viewer sees swordsmith posts')
  const { rei, kaoruko } = users
  const { reiPost1, sakuraPost, kaorukoPost } = posts

  try {
    const timeline = await getTimeline(rei.did)
    const uris = timeline.feed.map((f: FeedViewPost) => f.post.uri)

    assertTrue(
      timeline.feed.length >= 3,
      'Rei sees at least 3 swordsmith posts',
      `got ${timeline.feed.length} posts`,
    )
    assertTrue(uris.includes(reiPost1.uri), 'Timeline includes Rei post 1')
    assertTrue(uris.includes(sakuraPost.uri), 'Timeline includes Sakura post')
    assertFalse(
      uris.includes(kaorukoPost.uri),
      'Timeline does NOT include Kaoruko aekea post',
    )
  } catch (err) {
    fail('Rei timeline test failed', String(err))
    failed++
  }

  section('Test 2: Timeline — aekea viewer sees aekea posts only')
  try {
    const timeline = await getTimeline(kaoruko.did)
    const uris = timeline.feed.map((f: FeedViewPost) => f.post.uri)
    assertTrue(timeline.feed.length >= 1, 'Kaoruko sees at least 1 aekea post')
    assertTrue(uris.includes(kaorukoPost.uri), 'Timeline includes Kaoruko post')
    assertFalse(
      uris.includes(reiPost1.uri),
      'Timeline does NOT include Rei post',
    )
  } catch (err) {
    fail('Kaoruko timeline test failed', String(err))
    failed++
  }
}

async function runAuthorFeedTests(users: {
  rei: UserState
  kaoruko: UserState
}) {
  section('Test 3: Author feed — same boundary viewer')
  const { rei, kaoruko } = users
  try {
    const feed = await getAuthorFeed(rei.did, rei.did)
    assertTrue(feed.feed.length >= 2, 'Rei sees own posts in author feed')
    const texts = feed.feed.map((f: FeedViewPost) => f.post.record.text)
    assertTrue(
      texts.some((t: string) => t.includes('Spirit Forge')),
      'Author feed includes Rei post 1 text',
    )
  } catch (err) {
    fail('Rei author feed test failed', String(err))
    failed++
  }

  section('Test 4: Author feed — cross-boundary viewer gets empty')
  try {
    const feed = await getAuthorFeed(kaoruko.did, rei.did)
    assertTrue(feed.feed.length === 0, "Kaoruko cannot see Rei's posts")
  } catch (err) {
    fail('Cross-boundary author feed test failed', String(err))
    failed++
  }
}

async function runGetPostTests(
  users: { sakura: UserState; kaoruko: UserState },
  posts: { reiPost1: CreateRecordResponse },
) {
  section('Test 5: getPost — same boundary access allowed')
  const { sakura, kaoruko } = users
  const { reiPost1 } = posts
  try {
    const result = await getPost(sakura.did, reiPost1.uri)
    assertTrue(
      result.post.post.uri === reiPost1.uri,
      "Sakura can read Rei's post",
    )
  } catch (err) {
    fail('Same-boundary getPost test failed', String(err))
    failed++
  }

  section('Test 6: getPost — cross-boundary denied')
  try {
    const result = await tryGetPost(kaoruko.did, reiPost1.uri)
    assertFalse(result.ok, "Kaoruko cannot read Rei's swordsmith post")
    if (!result.ok) {
      assertTrue(
        result.error.includes('BoundaryMismatch'),
        'Error is BoundaryMismatch',
      )
    }
  } catch (err) {
    fail('Cross-boundary getPost test failed', String(err))
    failed++
  }
}

async function runUnauthenticatedTests() {
  section('Test 7: Unauthenticated timeline denied')
  try {
    const result = await getTimelineUnauthenticated()
    assertFalse(result.ok, 'Unauthenticated timeline is rejected')
  } catch (err) {
    fail('Unauthenticated timeline test failed', String(err))
    failed++
  }
}

async function runBoundaryFilterTests(
  state: TestState,
  posts: { kaorukoPost: CreateRecordResponse },
) {
  section('Test 8: Timeline boundary filter parameter')
  const fuyuko = state.users.fuyuko
  const { kaorukoPost } = posts
  if (fuyuko?.did) {
    try {
      const timeline = await getTimeline(fuyuko.did, { boundary: 'swordsmith' })
      const uris = timeline.feed.map((f: FeedViewPost) => f.post.uri)
      assertFalse(
        uris.includes(kaorukoPost.uri),
        'Boundary filter excludes non-matching posts',
      )
    } catch (err) {
      fail('Boundary filter test failed', String(err))
      failed++
    }
  }
}

async function logFinalDiagnostics() {
  try {
    const diag = await getAppviewDiagnostics()
    info(`Final diagnostics:\n${JSON.stringify(diag, null, 2)}`)
  } catch {
    // ignore
  }
}

run().catch((err) => {
  console.error('\nAppView feed tests failed:', err)
  Deno.exit(1)
})
