#!/usr/bin/env -S deno run -A
// Generate a batch of posts (standalone + threaded) for each enrolled user.
// Unlike test-posts.ts, this does NOT delete them afterwards.
// Useful for populating data for manual testing (e.g. pdsls browsing).

import { createRecord } from './lib/stratos.ts'
import { loadState, saveState } from './lib/state.ts'
import type { UserState } from './lib/state.ts'
import { DOMAINS } from './lib/config.ts'
import { section, pass, fail, info, summary } from './lib/log.ts'

// Standalone posts per domain

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

// Threaded conversations — each line maps a user key to a post text.
// Lines are created sequentially; each post after the first replies to
// the previous one, forming a linear thread.

interface ThreadLine {
  user: string
  text: string
}

interface ThreadDef {
  label: string
  boundary: string
  lines: ThreadLine[]
}

// Swordsmith threads — rei, sakura, fuyuko

const SWORDSMITH_THREADS: ThreadDef[] = [
  {
    label: 'The duel on the cliff',
    boundary: DOMAINS.swordsmith,
    lines: [
      {
        user: 'fuyuko',
        text: "You'll put down your rock, and I'll put down my sword… and we'll try and kill each other like civilized people?",
      },
      { user: 'sakura', text: 'I could kill you now.' },
      {
        user: 'fuyuko',
        text: 'Frankly, I think the odds are slightly in your favor at hand-fighting.',
      },
      {
        user: 'sakura',
        text: "It's not my fault being the biggest and the strongest. I don't even exercise.",
      },
      {
        user: 'fuyuko',
        text: 'Are you just fiddling around with me, or what?',
      },
      {
        user: 'sakura',
        text: "I want you to feel you are doing well. I hate for people to die embarrassed. You're quick!",
      },
      { user: 'fuyuko', text: 'Good thing, too!' },
      {
        user: 'sakura',
        text: 'Why are you wearing a mask? Were you burned with acid or something like that?',
      },
      {
        user: 'fuyuko',
        text: "No. It's just they're terribly comfortable. I think everyone will be wearing them in the future.",
      },
    ],
  },
  {
    label: 'Prepare to die',
    boundary: DOMAINS.swordsmith,
    lines: [
      {
        user: 'rei',
        text: 'HELLO! My name is Inigo Montoya. You killed my father. Prepare to die.',
      },
      { user: 'fuyuko', text: 'Stop saying that!' },
      {
        user: 'rei',
        text: 'HELLO! MY NAME IS INIGO MONTOYA! YOU KILLED MY FATHER! PREPARE TO DIE!',
      },
      { user: 'fuyuko', text: 'NO!' },
      { user: 'rei', text: 'Offer me money.' },
      { user: 'fuyuko', text: 'Yes!' },
      { user: 'rei', text: 'Power, too, promise me that.' },
      { user: 'fuyuko', text: 'All that I have and more, please.' },
      { user: 'rei', text: 'Offer me everything I ask for.' },
      { user: 'fuyuko', text: 'Anything you want.' },
      {
        user: 'rei',
        text: 'I want my father back, you son of a bitch.',
      },
    ],
  },
]

// Aekea threads — kaoruko, haruki

const AEKEA_THREADS: ThreadDef[] = [
  {
    label: 'Inconceivable',
    boundary: DOMAINS.aekea,
    lines: [
      { user: 'kaoruko', text: "He didn't fall? Inconceivable!" },
      {
        user: 'haruki',
        text: "You keep using that word. I do not think it means what you think it means. My God, he's climbing.",
      },
    ],
  },
  {
    label: 'No one of consequence',
    boundary: DOMAINS.aekea,
    lines: [
      { user: 'haruki', text: 'Who are you?' },
      { user: 'kaoruko', text: 'No one of consequence.' },
      { user: 'haruki', text: 'I must know.' },
      { user: 'kaoruko', text: 'Get used to disappointment.' },
    ],
  },
]

let passed = 0
let failed = 0

interface PostRef {
  uri: string
  cid: string
  rkey: string
}

async function generatePosts(
  did: string,
  name: string,
  boundary: string,
  posts: string[],
): Promise<PostRef[]> {
  const results: PostRef[] = []

  for (const text of posts) {
    try {
      const result = await createRecord(did, 'zone.stratos.feed.post', {
        $type: 'zone.stratos.feed.post',
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

async function generateThread(
  thread: ThreadDef,
  users: Record<string, UserState>,
): Promise<PostRef[]> {
  const results: PostRef[] = []
  let root: { uri: string; cid: string } | null = null

  for (const line of thread.lines) {
    const user = users[line.user]
    if (!user) {
      fail(`Thread "${thread.label}"`, `missing user "${line.user}" in state`)
      failed++
      continue
    }

    const record: Record<string, unknown> = {
      $type: 'zone.stratos.feed.post',
      text: line.text,
      boundary: { values: [{ value: thread.boundary }] },
      createdAt: new Date().toISOString(),
    }

    if (results.length > 0) {
      const parent = results[results.length - 1]
      record.reply = {
        root: { uri: root!.uri, cid: root!.cid },
        parent: { uri: parent.uri, cid: parent.cid },
      }
    }

    try {
      const result = await createRecord(
        user.did,
        'zone.stratos.feed.post',
        record,
      )
      const rkey = result.uri.split('/').pop()!
      const ref: PostRef = { uri: result.uri, cid: result.cid, rkey }
      results.push(ref)

      if (!root) {
        root = { uri: result.uri, cid: result.cid }
      }

      pass(
        `${user.handle.split('.')[0]}: reply in "${thread.label}"`,
        line.text.substring(0, 50),
      )
      passed++
    } catch (err) {
      fail(
        `${user.handle.split('.')[0]}: reply in "${thread.label}" failed`,
        String(err),
      )
      failed++
    }
  }

  return results
}

async function run() {
  section('Generate Posts')

  const state = await loadState()
  const { rei, sakura, kaoruko, fuyuko, haruki } = state.users

  if (!rei || !sakura || !kaoruko || !fuyuko || !haruki) {
    fail(
      'Missing user state — run setup.ts + test-enrollment.ts first (need rei, sakura, kaoruko, fuyuko, haruki)',
    )
    Deno.exit(1)
  }

  // Standalone posts

  section(`Rei (swordsmith) — ${SWORDSMITH_POSTS.length} posts`)
  const reiResults = await generatePosts(
    rei.did,
    'Rei',
    DOMAINS.swordsmith,
    SWORDSMITH_POSTS,
  )
  info(`Rei: ${reiResults.length} posts created`)

  section(`kaoruko (aekea) — ${AEKEA_POSTS.length} posts`)
  const kaorukoResults = await generatePosts(
    kaoruko.did,
    'kaoruko',
    DOMAINS.aekea,
    AEKEA_POSTS,
  )
  info(`kaoruko: ${kaorukoResults.length} posts created`)

  // Threaded conversations

  for (const thread of SWORDSMITH_THREADS) {
    section(
      `Thread: ${thread.label} (swordsmith) — ${thread.lines.length} posts`,
    )
    const threadResults = await generateThread(thread, state.users)
    info(`Thread "${thread.label}": ${threadResults.length} posts created`)
  }

  for (const thread of AEKEA_THREADS) {
    section(`Thread: ${thread.label} (aekea) — ${thread.lines.length} posts`)
    const threadResults = await generateThread(thread, state.users)
    info(`Thread "${thread.label}": ${threadResults.length} posts created`)
  }

  // Save last standalone post per user to state for reference
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
