#!/usr/bin/env -S deno run -A
// Configure boundaries — adjusts per-user boundary assignments after enrollment.
// Rei → [swordsmith], Sakura → [swordsmith], kaoruko → [aekea]

import { TEST_USERS } from './lib/config.ts'
import { setBoundaries, getBoundaries } from './lib/db.ts'
import { loadState } from './lib/state.ts'
import { section, info, pass, fail } from './lib/log.ts'

async function run() {
  section('Phase 3: Configure Boundaries')

  const state = await loadState()
  if (Object.keys(state.users).length === 0) {
    fail('No users in state — run setup.ts first')
    Deno.exit(1)
  }

  let passed = 0
  let failed = 0

  for (const [key, userDef] of Object.entries(TEST_USERS)) {
    const userState = state.users[key]
    if (!userState) {
      fail(`No state for user ${key}`)
      failed++
      continue
    }

    info(
      `Setting boundaries for ${userDef.name}: [${userDef.boundaries.join(', ')}]`,
    )

    try {
      setBoundaries(userState.did, userDef.boundaries)

      // Verify
      const actual = getBoundaries(userState.did)
      const expected = new Set(userDef.boundaries)
      const actualSet = new Set(actual)

      if (
        expected.size === actualSet.size &&
        [...expected].every((b) => actualSet.has(b))
      ) {
        pass(`${userDef.name} boundaries set`, `[${actual.join(', ')}]`)
        passed++
      } else {
        fail(
          `${userDef.name} boundary mismatch`,
          `expected [${userDef.boundaries.join(', ')}], got [${actual.join(', ')}]`,
        )
        failed++
      }
    } catch (err) {
      fail(`${userDef.name} boundary setup failed`, String(err))
      failed++
    }
  }

  section('Boundary Configuration Summary')
  info(`${passed} configured, ${failed} failed`)

  if (failed > 0) {
    Deno.exit(1)
  }
}

run().catch((err) => {
  console.error('\nBoundary configuration failed:', err)
  Deno.exit(1)
})
