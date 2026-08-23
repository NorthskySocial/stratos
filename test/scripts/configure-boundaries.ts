#!/usr/bin/env -S deno run -A
// Configure boundaries — assigns per-user boundary sets through the admin API
// (real admin OAuth login, no direct DB access). Verifies each assignment via
// the admin read-back API AND the rewritten PDS enrollment record. Stores the
// admin session cookie in state so later phases (test-spaces revocation) can
// reuse it without a second browser login.

import { chromium } from 'npm:playwright@1.58.2'
import {
  ADMIN_OPERATOR_KEY,
  RESERVED_DOMAIN,
  TEST_USERS,
} from './lib/config.ts'
import {
  adminGetBoundaries,
  adminSetBoundaries,
  waitForPdsBoundaries,
} from './lib/admin.ts'
import { adminLogin } from './lib/admin-login.ts'
import { loadState, saveState } from './lib/state.ts'
import { fail, finish, info, pass, section } from './lib/log.ts'

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((v) => set.has(v))
}

async function run() {
  section('Phase 3: Configure Boundaries (admin API)')

  const state = await loadState()
  if (Object.keys(state.users).length === 0) {
    fail('No users in state — run setup.ts first')
    Deno.exit(1)
  }

  const operator = state.users[ADMIN_OPERATOR_KEY]
  if (!operator) {
    fail(`Admin operator "${ADMIN_OPERATOR_KEY}" not in state — run setup.ts`)
    Deno.exit(1)
  }

  info('Performing admin OAuth login (no dev bypass)...')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  let sessionCookie: string | null = null
  try {
    sessionCookie = await adminLogin(
      browser,
      operator.handle,
      operator.password,
    )
  } finally {
    await browser.close()
  }

  if (!sessionCookie) {
    fail('Admin OAuth login did not produce a session cookie')
    Deno.exit(1)
  }
  pass('Admin session established')

  state.adminSessionCookie = sessionCookie
  await saveState(state)

  for (const [key, userDef] of Object.entries(TEST_USERS)) {
    const userState = state.users[key]
    if (!userState) {
      fail(`No state for user ${key}`)
      continue
    }

    info(
      `Setting boundaries for ${userDef.name}: [${userDef.boundaries.join(
        ', ',
      )}]`,
    )

    try {
      const res = await adminSetBoundaries(
        userState.did,
        userDef.boundaries,
        sessionCookie,
      )
      // The effective set is the requested boundaries PLUS the force-included
      // reserved domain.
      const expected = [...userDef.boundaries, RESERVED_DOMAIN]
      const resBody = res.body as { boundaries?: string[]; pdsSync?: string }
      const resBoundaries = resBody?.boundaries ?? []

      // The handler returns 200 with pdsSync='failed' when the PDS write
      // fails. Assert it here so the failure names the API call, not the
      // later PDS poll timeout.
      if (
        res.status !== 200 ||
        !sameSet(resBoundaries, expected) ||
        resBody?.pdsSync !== 'ok'
      ) {
        fail(
          `${userDef.name} setBoundaries API call`,
          `status=${res.status}, pdsSync=${resBody?.pdsSync}, boundaries=[${resBoundaries.join(', ')}]`,
        )
        continue
      }

      const readBack = await adminGetBoundaries(userState.did, sessionCookie)
      if (!readBack || !sameSet(readBack, expected)) {
        fail(
          `${userDef.name} boundary read-back mismatch`,
          `expected [${expected.join(', ')}], got [${
            readBack?.join(', ') ?? 'none'
          }]`,
        )
        continue
      }

      const pdsBoundaries = await waitForPdsBoundaries(userState.did, expected)
      if (!pdsBoundaries || !sameSet(pdsBoundaries, expected)) {
        fail(
          `${userDef.name} PDS enrollment record mismatch`,
          `expected [${expected.join(', ')}], got [${
            pdsBoundaries?.join(', ') ?? 'no record'
          }]`,
        )
        continue
      }

      pass(`${userDef.name} boundaries set`, `[${readBack.join(', ')}]`)
    } catch (err) {
      fail(`${userDef.name} boundary setup failed`, String(err))
    }
  }

  finish()
}

run().catch((err) => {
  console.error('\nBoundary configuration failed:', err)
  Deno.exit(1)
})
