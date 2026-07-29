#!/usr/bin/env -S deno run -A
import { loadState, saveState } from './lib/state.ts'
import { error, fail, info, pass, section } from './lib/log.ts'
import { enrollmentStatus, unenroll } from './lib/stratos.ts'
import { getEnrollmentRecord } from './lib/pds.ts'
import { STRATOS_URL } from './lib/config.ts'

async function run() {
  section('Phase 6: Unenrollment')

  const state = await loadState()
  if (Object.keys(state.users).length === 0) {
    fail('No users in state — run setup.ts and test-enrollment.ts first')
    Deno.exit(1)
  }

  let passed = 0
  let failed = 0

  // We'll pick one user to unenroll for this test - Rei
  const testUserKey = 'rei'
  const userState = state.users[testUserKey]

  if (!userState) {
    fail(`User ${testUserKey} not found in state`)
    Deno.exit(1)
  }

  if (!userState.enrolled) {
    fail(`User ${testUserKey} is not enrolled — skipping`)
    Deno.exit(1)
  }

  info(`Unenrolling ${testUserKey} (${userState.did})...`)

  // Direct (DB-only) enrollment never writes the PDS enrollment record, so
  // the PDS-record existence/deletion checks only apply to the OAuth flow.
  const directMode = Deno.env.get('STRATOS_E2E_DIRECT') === 'true'

  try {
    // 1. Verify user IS enrolled in Stratos and HAS a record on PDS
    const statusBefore = await enrollmentStatus(userState.did)
    if (!statusBefore.enrolled || statusBefore.active === false) {
      throw new Error(
        `User is not active in Stratos before unenrollment (enrolled: ${statusBefore.enrolled}, active: ${statusBefore.active})`,
      )
    }
    pass(`User ${testUserKey} is active in Stratos`)

    if (directMode) {
      info('Direct mode: skipping PDS enrollment-record existence check')
    } else {
      const recordBefore = await getEnrollmentRecord(userState.did)
      if (!recordBefore.exists) {
        throw new Error(
          'Enrollment record not found on PDS before unenrollment',
        )
      }
      pass('Enrollment record exists on PDS')
    }

    // 2. Perform unenrollment
    await unenroll(userState.did)
    pass('Unenrollment request succeeded')

    // 3. Verify Stratos status
    const statusAfter = await enrollmentStatus(userState.did)
    if (statusAfter.active !== false) {
      throw new Error('User is still active in Stratos after unenrollment')
    }
    pass('User is inactive in Stratos')

    // 4. Verify PDS record deletion (OAuth flow only - see above)
    if (directMode) {
      info('Direct mode: skipping PDS enrollment-record deletion check')
    } else {
      const recordAfter = await getEnrollmentRecord(userState.did)
      if (recordAfter.exists) {
        throw new Error(
          'Enrollment record still exists on PDS after unenrollment',
        )
      }
      pass('Enrollment record deleted from PDS')
    }

    // 5. Verify subsequent authenticated requests fail
    // (using Bearer bypass which checks isEnrolled)
    const res = await fetch(
      `${STRATOS_URL}/xrpc/com.atproto.repo.createRecord`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userState.did}`,
        },
        body: JSON.stringify({
          repo: userState.did,
          // Must be a VALID stratos collection: a stale/invalid NSID would be
          // rejected for the wrong reason (InvalidCollection) and this check
          // would pass even if enrollment gating were broken.
          collection: 'zone.stratos.feed.post',
          record: { text: 'should fail', createdAt: new Date().toISOString() },
        }),
      },
    )

    if (res.ok) {
      throw new Error('Authenticated request succeeded after unenrollment')
    }
    pass('Authenticated request failed as expected after unenrollment')

    userState.enrolled = false
    passed++
  } catch (err) {
    error(`Unenrollment test failed for ${testUserKey}`, { error: String(err) })
    failed++
  }

  await saveState(state)

  section('Unenrollment Summary')
  info(`${passed} unenrolled, ${failed} failed`)

  if (failed > 0) {
    Deno.exit(1)
  }
}

run().catch((err) => {
  console.error('\nUnenrollment test failed:', err)
  Deno.exit(1)
})
