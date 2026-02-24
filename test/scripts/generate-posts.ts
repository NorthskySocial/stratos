#!/usr/bin/env -S deno run -A
// Generate a batch of posts for each enrolled user.
// Unlike test-posts.ts, this does NOT delete them afterwards.
// Useful for populating data for manual testing (e.g. pdsls browsing).

import { createRecord } from './lib/stratos.ts'
import { loadState, saveState } from './lib/state.ts'
import { section, pass, fail, info, summary } from './lib/log.ts'

const SWORDSMITH_POSTS = [
  'Forging a new katana in the swordsmith workshop',
  'The steel must be folded precisely 13 times',
  'Quenching the blade at dawn — the water must be cold',
  'A fine hamon line appeared on the latest work',
  'Inspecting the tang — the balance is perfect',
  'New shipment of tamahagane arrived from the mountain',
  'Teaching an apprentice the art of differential hardening',
  'The tsuba needs more detailed filing work',
]

const AEKEA_POSTS = [
  'Shopping at the Aekea marketplace',
  'Found a rare blueprint at the furniture vendor',
  'The new housing district is looking great',
  'Rearranging the living room layout again',
  'Traded for a vintage lamp at the bazaar',
  'The garden expansion is finally complete',
  'Hosting an open house this weekend',
  'Picked up some wallpaper samples from the depot',
]

let passed = 0
let failed = 0

async function generatePosts(
  did: string,
  name: string,
  boundary: string,
  posts: string[],
): Promise<Array<{ uri: string; cid: string; rkey: string }>> {
  const results: Array<{ uri: string; cid: string; rkey: string }> = []

  for (const text of posts) {
    try {
      const result = await createRecord(did, 'app.stratos.feed.post', {
        $type: 'app.stratos.feed.post',
        text,
        boundary: { values: [{ value: boundary }] },
        createdAt: new Date().toISOString(),
      })
      const rkey = result.uri.split('/').pop()!
      results.push({ uri: result.uri, cid: result.cid, rkey })
      pass(`${name}: created post`, text.substring(0, 50))
      passed++
    } catch (err) {
      fail(`${name}: create post failed`, String(err))
      failed++
    }
  }

  return results
}

async function run() {
  section('Generate Posts')

  const state = await loadState()
  const rei = state.users.rei
  const kaoruko = state.users.kaoruko

  if (!rei || !kaoruko) {
    fail('Missing user state — run setup.ts + test-enrollment.ts first')
    Deno.exit(1)
  }

  section(`Rei (swordsmith) — ${SWORDSMITH_POSTS.length} posts`)
  const reiResults = await generatePosts(
    rei.did,
    'Rei',
    'swordsmith',
    SWORDSMITH_POSTS,
  )
  info(`Rei: ${reiResults.length} posts created`)

  section(`kaoruko (aekea) — ${AEKEA_POSTS.length} posts`)
  const kaorukoResults = await generatePosts(
    kaoruko.did,
    'kaoruko',
    'aekea',
    AEKEA_POSTS,
  )
  info(`kaoruko: ${kaorukoResults.length} posts created`)

  // Save last post per user to state for reference
  if (reiResults.length > 0) {
    rei.records['generated'] = reiResults[reiResults.length - 1]
  }
  if (kaorukoResults.length > 0) {
    kaoruko.records['generated'] = kaorukoResults[kaorukoResults.length - 1]
  }
  await saveState(state)

  summary(passed, failed)
  if (failed > 0) Deno.exit(1)
}

run().catch((err) => {
  console.error('\nPost generation failed:', err)
  Deno.exit(1)
})
