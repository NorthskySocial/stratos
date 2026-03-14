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
import { loadState, saveState } from './lib/state.ts'
import { section, pass, fail, info, summary } from './lib/log.ts'
import {
  waitForAppviewHealthy,
  waitForIndexing,
  getTimeline,
  getAuthorFeed,
  getPost,
  tryGetPost,
  getTimelineUnauthenticated,
  getAppviewDiagnostics,
  enrollWithAppview,
} from './lib/appview.ts'

let passed = 0
let failed = 0

function assert(condition: boolean, testName: string, detail?: string): void {
  if (condition) {
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
  const rei = state.users.rei
  const sakura = state.users.sakura
  const kaoruko = state.users.kaoruko

  if (!rei?.did || !sakura?.did || !kaoruko?.did) {
    fail(
      'Missing user state',
      'Run setup.ts + direct-enroll.ts + configure-boundaries.ts first',
    )
    Deno.exit(1)
  }

  // ─────────────────────────────────────────────────────────────
  // Wait for AppView to be healthy
  // ─────────────────────────────────────────────────────────────
  section('Wait for AppView')

  try {
    await waitForAppviewHealthy(30_000)
    pass('AppView is healthy')
  } catch (err) {
    fail('AppView health check failed', String(err))
    Deno.exit(1)
  }

  // ─────────────────────────────────────────────────────────────
  // Register enrollments with AppView
  // ─────────────────────────────────────────────────────────────
  section('Register enrollments with AppView')

  for (const [name, user] of Object.entries(state.users)) {
    if (!user.did) continue
    try {
      const result = await enrollWithAppview(user.did)
      pass(`Enrolled ${name} with AppView`, `boundaries=[${result.boundaries.join(',')}]`)
    } catch (err) {
      fail(`Failed to enroll ${name} with AppView`, String(err))
    }
  }

  // Wait for WebSocket subscriptions to connect
  info('Waiting for actor subscriptions to connect...')
  await new Promise((r) => setTimeout(r, 3000))

  // ─────────────────────────────────────────────────────────────
  // Create test posts on Stratos
  // ─────────────────────────────────────────────────────────────
  section('Create test posts')

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

  // Save post URIs for later
  state.users.rei.records['appview_post1'] = {
    uri: reiPost1.uri,
    cid: reiPost1.cid,
    rkey: reiPost1.uri.split('/').pop()!,
  }
  state.users.rei.records['appview_post2'] = {
    uri: reiPost2.uri,
    cid: reiPost2.cid,
    rkey: reiPost2.uri.split('/').pop()!,
  }
  state.users.sakura.records['appview_post'] = {
    uri: sakuraPost.uri,
    cid: sakuraPost.cid,
    rkey: sakuraPost.uri.split('/').pop()!,
  }
  state.users.kaoruko.records['appview_post'] = {
    uri: kaorukoPost.uri,
    cid: kaorukoPost.cid,
    rkey: kaorukoPost.uri.split('/').pop()!,
  }
  await saveState(state)

  // ─────────────────────────────────────────────────────────────
  // Wait for AppView to index all posts
  // ─────────────────────────────────────────────────────────────
  section('Wait for indexing')

  try {
    const diag = await waitForIndexing(4, 30_000)
    pass('AppView indexed all posts', `posts=${diag.posts} boundaries=${diag.boundaries}`)
  } catch (err) {
    fail('Indexing timeout', String(err))
    // Show diagnostics for debugging
    try {
      const diag = await getAppviewDiagnostics()
      info(`Diagnostics: ${JSON.stringify(diag, null, 2)}`)
    } catch {
      // ignore
    }
    Deno.exit(1)
  }

  // ─────────────────────────────────────────────────────────────
  // Test 1: Rei (swordsmith) sees swordsmith posts in timeline
  // ─────────────────────────────────────────────────────────────
  section('Test 1: Timeline — swordsmith viewer sees swordsmith posts')

  try {
    const timeline = await getTimeline(rei.did)
    const uris = timeline.feed.map((f) => f.post.uri)

    assert(
      timeline.feed.length >= 3,
      'Rei sees at least 3 swordsmith posts',
      `got ${timeline.feed.length} posts`,
    )

    assert(
      uris.includes(reiPost1.uri),
      'Timeline includes Rei post 1',
      reiPost1.uri,
    )

    assert(
      uris.includes(sakuraPost.uri),
      'Timeline includes Sakura post',
      sakuraPost.uri,
    )

    assert(
      !uris.includes(kaorukoPost.uri),
      'Timeline does NOT include Kaoruko aekea post',
      `should not contain ${kaorukoPost.uri}`,
    )
  } catch (err) {
    fail('Rei timeline test failed', String(err))
    failed++
  }

  // ─────────────────────────────────────────────────────────────
  // Test 2: Kaoruko (aekea) sees aekea posts, not swordsmith
  // ─────────────────────────────────────────────────────────────
  section('Test 2: Timeline — aekea viewer sees aekea posts only')

  try {
    const timeline = await getTimeline(kaoruko.did)
    const uris = timeline.feed.map((f) => f.post.uri)

    assert(
      timeline.feed.length >= 1,
      'Kaoruko sees at least 1 aekea post',
      `got ${timeline.feed.length} posts`,
    )

    assert(
      uris.includes(kaorukoPost.uri),
      'Timeline includes Kaoruko post',
      kaorukoPost.uri,
    )

    assert(
      !uris.includes(reiPost1.uri),
      'Timeline does NOT include Rei swordsmith post',
      `should not contain ${reiPost1.uri}`,
    )

    assert(
      !uris.includes(sakuraPost.uri),
      'Timeline does NOT include Sakura swordsmith post',
      `should not contain ${sakuraPost.uri}`,
    )
  } catch (err) {
    fail('Kaoruko timeline test failed', String(err))
    failed++
  }

  // ─────────────────────────────────────────────────────────────
  // Test 3: getAuthorFeed — Rei views Rei's feed
  // ─────────────────────────────────────────────────────────────
  section('Test 3: Author feed — same boundary viewer')

  try {
    const feed = await getAuthorFeed(rei.did, rei.did)
    assert(
      feed.feed.length >= 2,
      "Rei sees own posts in author feed",
      `got ${feed.feed.length} posts`,
    )

    const texts = feed.feed.map((f) => f.post.record.text)
    assert(
      texts.some((t) => t.includes('Spirit Forge')),
      'Author feed includes Rei post 1 text',
    )
  } catch (err) {
    fail('Rei author feed test failed', String(err))
    failed++
  }

  // ─────────────────────────────────────────────────────────────
  // Test 4: getAuthorFeed — cross-boundary denial
  // ─────────────────────────────────────────────────────────────
  section("Test 4: Author feed — cross-boundary viewer gets empty")

  try {
    const feed = await getAuthorFeed(kaoruko.did, rei.did)
    assert(
      feed.feed.length === 0,
      "Kaoruko cannot see Rei's posts via author feed",
      `got ${feed.feed.length} posts (expected 0)`,
    )
  } catch (err) {
    fail('Cross-boundary author feed test failed', String(err))
    failed++
  }

  // ─────────────────────────────────────────────────────────────
  // Test 5: getPost — same boundary access
  // ─────────────────────────────────────────────────────────────
  section('Test 5: getPost — same boundary access allowed')

  try {
    const result = await getPost(sakura.did, reiPost1.uri)
    assert(
      result.post.post.uri === reiPost1.uri,
      "Sakura can read Rei's post via getPost",
      reiPost1.uri,
    )

    assert(
      result.post.post.record.text.includes('Spirit Forge'),
      'Post text is correct',
      result.post.post.record.text,
    )
  } catch (err) {
    fail('Same-boundary getPost test failed', String(err))
    failed++
  }

  // ─────────────────────────────────────────────────────────────
  // Test 6: getPost — cross-boundary denial
  // ─────────────────────────────────────────────────────────────
  section('Test 6: getPost — cross-boundary denied')

  try {
    const result = await tryGetPost(kaoruko.did, reiPost1.uri)
    assert(
      !result.ok,
      "Kaoruko cannot read Rei's swordsmith post",
      result.ok ? 'unexpectedly succeeded' : `status=${result.status}`,
    )

    if (!result.ok) {
      assert(
        result.error.includes('BoundaryMismatch'),
        'Error is BoundaryMismatch',
        result.error,
      )
    }
  } catch (err) {
    fail('Cross-boundary getPost test failed', String(err))
    failed++
  }

  // ─────────────────────────────────────────────────────────────
  // Test 7: Unauthenticated timeline denied
  // ─────────────────────────────────────────────────────────────
  section('Test 7: Unauthenticated timeline denied')

  try {
    const result = await getTimelineUnauthenticated()
    assert(
      !result.ok,
      'Unauthenticated timeline is rejected',
      `status=${result.status}`,
    )
  } catch (err) {
    fail('Unauthenticated timeline test failed', String(err))
    failed++
  }

  // ─────────────────────────────────────────────────────────────
  // Test 8: Boundary filter on timeline
  // ─────────────────────────────────────────────────────────────
  section('Test 8: Timeline boundary filter parameter')

  // Create a user with BOTH boundaries to test filtering
  // (skip if fuyuko is not available)
  const fuyuko = state.users.fuyuko
  if (fuyuko?.did) {
    try {
      const timeline = await getTimeline(fuyuko.did, { boundary: 'swordsmith' })
      const uris = timeline.feed.map((f) => f.post.uri)
      assert(
        !uris.includes(kaorukoPost.uri),
        'Boundary filter excludes non-matching posts',
        `swordsmith filter returned ${timeline.feed.length} posts`,
      )
    } catch (err) {
      fail('Boundary filter test failed', String(err))
      failed++
    }
  } else {
    info('Skipping boundary filter test (fuyuko not available)')
  }

  // ─────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────
  section('AppView Feed Test Results')
  summary(passed, failed)

  if (failed > 0) {
    // Show diagnostics on failure
    try {
      const diag = await getAppviewDiagnostics()
      info(`Final diagnostics:\n${JSON.stringify(diag, null, 2)}`)
    } catch {
      // ignore
    }
    Deno.exit(1)
  }
}

run().catch((err) => {
  console.error('\nAppView feed tests failed:', err)
  Deno.exit(1)
})
