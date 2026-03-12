#!/usr/bin/env -S deno run -A
// Multi-enrollment verification tests.
//
// Verifies that service-DID-based enrollment records are correctly created and
// accessible via the enrollment status API and on the user's PDS.
//
// Tests:
//   1. Enrollment status API returns enrollmentRkey for enrolled users
//   2. PDS enrollment records use service DID rkeys
//   3. PDS enrollment records contain correct service URL
//   4. Each enrolled user's PDS record matches their enrollment status rkey

import { enrollmentStatus, listPdsRecords } from './lib/stratos.ts'
import { loadState } from './lib/state.ts'
import { PDS_URL } from './lib/config.ts'
import { section, pass, fail, info, summary } from './lib/log.ts'

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

const TID_REGEX = /^[a-z2-7]{13}$/
const SERVICE_DID_RKEY_REGEX = /^did:(web|plc):/

async function run() {
  section('Phase: Multi-Enrollment Verification')

  const state = await loadState()
  const rei = state.users.rei
  const sakura = state.users.sakura
  const kaoruko = state.users.kaoruko

  if (!rei || !sakura || !kaoruko) {
    fail('Missing user state — run setup + enrollment first')
    Deno.exit(1)
  }

  const testUsers = [
    { name: 'Rei', ...rei },
    { name: 'Sakura', ...sakura },
    { name: 'kaoruko', ...kaoruko },
  ]

  // ─────────────────────────────────────────────────────────────
  // Test 1: Enrollment status API returns enrollmentRkey
  // ─────────────────────────────────────────────────────────────
  section('Test 1: Enrollment status includes enrollmentRkey')

  for (const user of testUsers) {
    try {
      const status = await enrollmentStatus(user.did)
      assert(status.enrolled, `${user.name} is enrolled`)
      assert(
        status.enrollmentRkey !== undefined && status.enrollmentRkey !== null,
        `${user.name} has enrollmentRkey`,
        `rkey=${status.enrollmentRkey}`,
      )

      if (status.enrollmentRkey) {
        assert(
          SERVICE_DID_RKEY_REGEX.test(status.enrollmentRkey) ||
            TID_REGEX.test(status.enrollmentRkey) ||
            status.enrollmentRkey === 'self',
          `${user.name} enrollmentRkey is valid service DID, TID, or legacy self`,
          `rkey=${status.enrollmentRkey}`,
        )
      }
    } catch (err) {
      fail(`${user.name} enrollment status check failed`, String(err))
      failed++
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Test 2: PDS enrollment records use TID rkeys
  // ─────────────────────────────────────────────────────────────
  section('Test 2: PDS enrollment records have valid rkeys')

  for (const user of testUsers) {
    try {
      const pdsRecords = await listPdsRecords(
        PDS_URL,
        user.did,
        'zone.stratos.actor.enrollment',
      )

      assert(
        pdsRecords.records.length > 0,
        `${user.name} has enrollment record(s) on PDS`,
        `count=${pdsRecords.records.length}`,
      )

      for (const record of pdsRecords.records) {
        const rkey = record.uri.split('/').pop()!
        assert(
          SERVICE_DID_RKEY_REGEX.test(rkey) ||
            TID_REGEX.test(rkey) ||
            rkey === 'self',
          `${user.name} PDS record rkey is service DID, TID, or legacy`,
          `rkey=${rkey}`,
        )
      }
    } catch (err) {
      fail(`${user.name} PDS listRecords failed`, String(err))
      failed++
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Test 3: PDS enrollment records contain correct service URL
  // ─────────────────────────────────────────────────────────────
  section('Test 3: PDS enrollment records contain service URL')

  for (const user of testUsers) {
    try {
      const pdsRecords = await listPdsRecords(
        PDS_URL,
        user.did,
        'zone.stratos.actor.enrollment',
      )

      for (const record of pdsRecords.records) {
        const value = record.value as Record<string, unknown>
        assert(
          typeof value.service === 'string' && value.service.startsWith('http'),
          `${user.name} enrollment record has valid service URL`,
          `service=${value.service}`,
        )
      }
    } catch (err) {
      fail(`${user.name} PDS record service check failed`, String(err))
      failed++
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Test 4: Status rkey matches PDS record rkey
  // ─────────────────────────────────────────────────────────────
  section('Test 4: Enrollment status rkey matches PDS record')

  for (const user of testUsers) {
    try {
      const status = await enrollmentStatus(user.did)
      const pdsRecords = await listPdsRecords(
        PDS_URL,
        user.did,
        'zone.stratos.actor.enrollment',
      )

      if (status.enrollmentRkey && pdsRecords.records.length > 0) {
        const pdsRkeys = pdsRecords.records.map((r) => r.uri.split('/').pop()!)
        assert(
          pdsRkeys.includes(status.enrollmentRkey),
          `${user.name} status rkey matches a PDS record`,
          `statusRkey=${status.enrollmentRkey}, pdsRkeys=[${pdsRkeys.join(', ')}]`,
        )
      } else {
        info(
          `${user.name}: skipping rkey match (statusRkey=${status.enrollmentRkey}, pdsRecords=${pdsRecords.records.length})`,
        )
      }
    } catch (err) {
      fail(`${user.name} rkey match check failed`, String(err))
      failed++
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────
  summary(passed, failed)

  if (failed > 0) {
    Deno.exit(1)
  }
}

run().catch((err) => {
  console.error('\nMulti-enrollment tests failed:', err)
  Deno.exit(1)
})
