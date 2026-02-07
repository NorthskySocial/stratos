#!/usr/bin/env -S deno run -A
// Direct enrollment script — bypasses OAuth and enrolls users directly in the database.
// Use this when OAuth flow is not working (e.g., PDS handle resolution issues).

import { TEST_USERS, STRATOS_URL } from './lib/config.ts'
import { enrollUser, createActorStore, setBoundaries } from './lib/db.ts'
import { enrollmentStatus } from './lib/stratos.ts'
import { loadState, saveState } from './lib/state.ts'
import { section, info, pass, fail, warn, dim } from './lib/log.ts'

async function resolvePdsEndpoint(did: string): Promise<string | undefined> {
  try {
    const res = await fetch(`https://plc.directory/${did}`)
    if (!res.ok) return undefined
    const doc = (await res.json()) as {
      service?: Array<{ id: string; serviceEndpoint: string }>
    }
    const pds = doc.service?.find((s) => s.id === '#atproto_pds')
    return pds?.serviceEndpoint
  } catch {
    return undefined
  }
}

async function run() {
  section('Direct Enrollment (bypassing OAuth)')

  const state = await loadState()
  if (!state || Object.keys(state.users).length === 0) {
    fail('No test state found. Run setup.ts first to create PDS accounts.')
    Deno.exit(1)
  }

  info(`Found ${Object.keys(state.users).length} users in state`)

  for (const [key, user] of Object.entries(state.users)) {
    const testUser = TEST_USERS[key]
    if (!testUser) {
      warn(`No TEST_USER config for ${key}, skipping`)
      continue
    }

    info(`Enrolling ${user.handle} (${user.did})...`)

    try {
      // Resolve PDS endpoint from DID document
      const pdsEndpoint = await resolvePdsEndpoint(user.did)
      dim(`  PDS endpoint: ${pdsEndpoint ?? 'unknown'}`)

      // Create actor store (SQLite database for this user)
      await createActorStore(user.did)
      dim(`  Actor store created`)

      // Enroll in service database with boundaries
      enrollUser(user.did, pdsEndpoint, testUser.boundaries)
      dim(`  Enrolled with boundaries: ${testUser.boundaries.join(', ')}`)

      // Verify enrollment via API
      const status = await enrollmentStatus(user.did)
      if (status.enrolled) {
        pass(`Enrolled ${user.handle}`, user.did)
        state.users[key].enrolled = true
      } else {
        fail(`Enrollment verification failed for ${user.handle}`)
      }
    } catch (err) {
      fail(`Failed to enroll ${user.handle}`, String(err))
      throw err
    }
  }

  await saveState(state)
  pass('Direct enrollment complete')
}

run().catch((err) => {
  console.error('\nDirect enrollment failed:', err)
  Deno.exit(1)
})
