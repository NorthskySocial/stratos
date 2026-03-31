#!/usr/bin/env -S deno run -A
// Post CRUD + boundary access control tests.
//
// Test matrix:
//   Rei writes a post with the swordsmith boundary.
//   Rei can read own post (owner access).
//   Sakura (swordsmith boundary) can read Rei's post (shared boundary).
//   kaoruko (aekea boundary) CANNOT read Rei's post (no intersection).
//   Unauthenticated caller CANNOT read Rei's post.
//   listRecords filters correctly per boundary.

import {
  createRecord,
  deleteRecord,
  getRecord,
  listRecords,
  tryGetRecord,
} from './lib/stratos.ts'
import {
  loadState,
  saveState,
  type TestState,
  type UserState,
} from './lib/state.ts'
import { DOMAINS } from './lib/config.ts'
import { fail, pass, section, summary } from './lib/log.ts'

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

async function testListRecords(
  rei: UserState,
  sakura: UserState,
  kaoruko: UserState,
) {
  section('Test 6: listRecords boundary filtering')

  // Sakura (swordsmith) should see the post
  try {
    const sakuraList = await listRecords(
      rei.did,
      'zone.stratos.feed.post',
      sakura.did,
    )
    assertTrue(
      sakuraList.records.length > 0,
      "Sakura listRecords — sees Rei's post",
      `count=${sakuraList.records.length}`,
    )
  } catch (err) {
    fail('Sakura listRecords failed', String(err))
    failed++
  }

  // kaoruko (aekea) should NOT see the post
  try {
    const kaorukoList = await listRecords(
      rei.did,
      'zone.stratos.feed.post',
      kaoruko.did,
    )
    assertTrue(
      kaorukoList.records.length === 0,
      'kaoruko listRecords — empty (no swordsmith boundary)',
      `count=${kaorukoList.records.length}`,
    )
  } catch (err) {
    fail('kaoruko listRecords failed', String(err))
    failed++
  }

  // Unauthenticated should see nothing
  try {
    const anonList = await listRecords(rei.did, 'zone.stratos.feed.post')
    assertTrue(
      anonList.records.length === 0,
      'Unauthenticated listRecords — empty',
      `count=${anonList.records.length}`,
    )
  } catch (err) {
    fail('Unauthenticated listRecords failed', String(err))
    failed++
  }
}

async function testKaorukoPost(
  state: TestState,
  rei: UserState,
  kaoruko: UserState,
) {
  section('Test 7: kaoruko writes aekea-scoped post')

  let kaorukoPostRkey: string

  try {
    const result = await createRecord(kaoruko.did, 'zone.stratos.feed.post', {
      $type: 'zone.stratos.feed.post',
      text: 'Shopping at the Aekea marketplace',
      boundary: { values: [{ value: DOMAINS.aekea }] },
      createdAt: new Date().toISOString(),
    })

    kaorukoPostRkey = result.uri.split('/').pop()!
    assertTrue(!!result.uri, 'kaoruko created aekea post', result.uri)

    kaoruko.records['post1'] = {
      uri: result.uri,
      cid: result.cid,
      rkey: kaorukoPostRkey,
    }
    await saveState(state)
  } catch (err) {
    fail('kaoruko create aekea post failed', String(err))
    failed++
    kaorukoPostRkey = ''
  }

  if (kaorukoPostRkey) {
    const reiResult = await tryGetRecord(
      kaoruko.did,
      'zone.stratos.feed.post',
      kaorukoPostRkey,
      rei.did,
    )

    if (!reiResult.ok) {
      assertTrue(
        reiResult.status === 403 ||
          reiResult.status === 404 ||
          reiResult.error.includes('RecordNotFound'),
        "Rei denied kaoruko's aekea post (swordsmith ≠ aekea)",
        `status=${reiResult.status}`,
      )
    } else {
      fail("Rei should NOT see kaoruko's aekea post")
      failed++
    }

    try {
      const own = await getRecord(
        kaoruko.did,
        'zone.stratos.feed.post',
        kaorukoPostRkey,
        kaoruko.did,
      )
      assertTrue(
        own.uri === kaoruko.records['post1'].uri,
        'kaoruko reads own aekea post',
      )
    } catch (err) {
      fail('kaoruko read own aekea post failed', String(err))
      failed++
    }
  }
  return kaorukoPostRkey
}

async function testDeletion(
  rei: UserState,
  kaoruko: UserState,
  postRkey: string,
  kaorukoPostRkey: string,
) {
  section('Test 8: Delete records')

  try {
    await deleteRecord(rei.did, 'zone.stratos.feed.post', postRkey)
    pass("Rei's swordsmith post deleted")
    passed++

    const result = await tryGetRecord(
      rei.did,
      'zone.stratos.feed.post',
      postRkey,
      rei.did,
    )
    assertFalse(result.ok, "Rei's post no longer retrievable after delete")
  } catch (err) {
    fail("Delete Rei's post failed", String(err))
    failed++
  }

  if (kaorukoPostRkey) {
    try {
      await deleteRecord(kaoruko.did, 'zone.stratos.feed.post', kaorukoPostRkey)
      pass("kaoruko's aekea post deleted")
      passed++
    } catch (err) {
      fail("Delete kaoruko's post failed", String(err))
      failed++
    }
  }
}

async function testDeniedAccess(
  rei: UserState,
  kaoruko: UserState,
  postRkey: string,
) {
  section('Test 4: Cross-boundary user denied')

  {
    const result = await tryGetRecord(
      rei.did,
      'zone.stratos.feed.post',
      postRkey,
      kaoruko.did,
    )

    assertFalse(
      result.ok,
      "Kaoruko cannot read Rei's post (swordsmith vs aekea)",
    )
    if (!result.ok) {
      assertTrue(result.status === 403, 'Denied with 403 Forbidden')
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Test 5: Unauthenticated caller CANNOT retrieve Rei's post
  // ─────────────────────────────────────────────────────────────
  section('Test 5: Unauthenticated caller denied')

  {
    const result = await tryGetRecord(
      rei.did,
      'zone.stratos.feed.post',
      postRkey,
    )

    assertFalse(result.ok, 'Unauthenticated caller cannot read private post')
    if (!result.ok) {
      assertTrue(result.status === 401, 'Denied with 401 Unauthorized')
    }
  }
}

async function testSharedBoundaryAccess(
  rei: UserState,
  sakura: UserState,
  postUri: string,
  postRkey: string,
) {
  section('Test 3: Same-boundary user reads post')

  try {
    const record = await getRecord(
      rei.did,
      'zone.stratos.feed.post',
      postRkey,
      sakura.did,
    )

    assertTrue(
      record.uri === postUri,
      "Sakura reads Rei's post (shared swordsmith boundary)",
      record.uri,
    )
  } catch (err) {
    fail("Sakura get Rei's post failed (should have access)", String(err))
    failed++
  }
}

async function testOwnerAccess(
  rei: UserState,
  postUri: string,
  postRkey: string,
) {
  section('Test 2: Owner retrieves own post')

  try {
    const record = await getRecord(
      rei.did,
      'zone.stratos.feed.post',
      postRkey,
      rei.did,
    )

    assertTrue(record.uri === postUri, 'Rei reads own post — URI matches')

    const value = record.value as Record<string, unknown>
    assertTrue(
      value.text === 'Forging a new katana in the swordsmith workshop',
      'Rei reads own post — text matches',
    )

    const boundary = value.boundary as
      | { values: Array<{ value: string }> }
      | undefined
    assertTrue(
      boundary?.values?.[0]?.value === DOMAINS.swordsmith,
      'Rei reads own post — boundary is swordsmith',
    )
  } catch (err) {
    fail('Rei get own post failed', String(err))
    failed++
  }
}

async function run() {
  section('Phase 4: Post CRUD & Boundary Tests')

  const state = await loadState()
  const rei = state.users.rei
  const sakura = state.users.sakura
  const kaoruko = state.users.kaoruko

  if (!rei || !sakura || !kaoruko) {
    fail('Missing user state — run setup.ts + test-enrollment.ts first')
    Deno.exit(1)
  }

  // ─────────────────────────────────────────────────────────────
  // Test 1: Rei writes a post with swordsmith boundary
  // ─────────────────────────────────────────────────────────────
  section('Test 1: Create post with boundary')

  let postUri: string
  let postRkey: string
  let postCid: string

  try {
    const result = await createRecord(rei.did, 'zone.stratos.feed.post', {
      $type: 'zone.stratos.feed.post',
      text: 'Forging a new katana in the swordsmith workshop',
      boundary: { values: [{ value: DOMAINS.swordsmith }] },
      createdAt: new Date().toISOString(),
    })

    postUri = result.uri
    postCid = result.cid
    postRkey = postUri.split('/').pop()!

    assertTrue(!!postUri && !!postCid, 'Rei created post', postUri)

    // Save to state for later phases
    rei.records['post1'] = { uri: postUri, cid: postCid, rkey: postRkey }
    await saveState(state)
  } catch (err) {
    fail('Rei create post failed', String(err))
    failed++
    Deno.exit(1)
  }

  await testOwnerAccess(rei, postUri, postRkey)
  await testSharedBoundaryAccess(rei, sakura, postUri, postRkey)
  await testDeniedAccess(rei, kaoruko, postRkey)
  await testListRecords(rei, sakura, kaoruko)

  const kaorukoPostRkey = await testKaorukoPost(state, rei, kaoruko)
  await testDeletion(rei, kaoruko, postRkey, kaorukoPostRkey)

  summary(passed, failed)
  if (failed > 0) Deno.exit(1)
}

run().catch((err) => {
  console.error('\nPost tests failed:', err)
  Deno.exit(1)
})
