#!/usr/bin/env -S deno run -A
// Admin API phase — proves boundary management through the *admin API* (real
// OAuth login, not a dev Bearer shortcut, which the verifier rejects by design).
//
// Exercises:
//   1. a genuine admin OAuth login via Playwright → captures the session cookie
//   2. boundary mutations via zone.stratos.admin.* using that cookie
//   3. a two-way cross-check: the admin read-back API reflects the change AND
//      the user's PDS enrollment record was rewritten
//   4. a negative case: the same mutation without the cookie → 401

import { chromium } from 'npm:playwright@1.58.2'
import {
  ADMIN_OPERATOR_KEY,
  ADMIN_TARGET_KEY,
  DOMAINS,
  RESERVED_DOMAIN,
} from './lib/config.ts'
import {
  adminFetch,
  adminGetBoundaries,
  adminList,
  waitForPdsBoundaries,
} from './lib/admin.ts'
import { adminLogin } from './lib/admin-login.ts'
import { enrollmentStatus } from './lib/stratos.ts'
import { loadState, type UserState } from './lib/state.ts'
import { assert, fail, finish, info, section } from './lib/log.ts'

interface BoundaryResponse {
  did: string
  boundaries: string[]
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((v) => set.has(v))
}

async function run(): Promise<void> {
  section('Admin API: Boundary Management')

  const state = await loadState()
  const operator = state.users[ADMIN_OPERATOR_KEY]
  const target = state.users[ADMIN_TARGET_KEY]

  if (!operator || !target) {
    fail(
      'Missing operator/target user state',
      `operator=${ADMIN_OPERATOR_KEY}, target=${ADMIN_TARGET_KEY} — run setup.ts first`,
    )
    Deno.exit(1)
  }

  // Precondition: both users must be enrolled from the earlier phase.
  for (const [label, user] of [
    ['operator', operator],
    ['target', target],
  ] as Array<[string, UserState]>) {
    const status = await enrollmentStatus(user.did).catch(() => null)
    if (!status?.enrolled) {
      fail(
        `${label} not enrolled`,
        `${user.handle} (${user.did}) must be enrolled before the admin phase`,
      )
      Deno.exit(1)
    }
  }

  info('Performing real admin OAuth login (no dev bypass)...')
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

  assert(
    sessionCookie,
    'Captured admin session cookie from OAuth login',
    sessionCookie ? 'cookie present' : 'no cookie — STOP-worthy per plan 003',
  )
  if (!sessionCookie) {
    // Per plan 003 STOP condition: do not fall back to a Bearer shortcut.
    finish()
  }

  // 1. "User appears in the admin panel" — lookup the enrolled target by DID.
  const lookup = await enrollmentStatus(target.did)
  assert(
    lookup.enrolled,
    'Admin lookup: target user appears as enrolled',
    `${target.handle} (${target.did})`,
  )

  // 1b. The member list surfaces the target without knowing its DID up front.
  const listed = await adminList(
    'zone.stratos.admin.listEnrollments',
    sessionCookie,
  )
  const listedBody = listed.body as {
    enrollments?: Array<{ did: string; boundaries: string[] }>
    total?: number
  }
  assert(
    listed.status === 200 &&
      listedBody.enrollments?.some((e) => e.did === target.did) === true,
    'listEnrollments includes the enrolled target',
    `status=${listed.status}, returned=${
      listedBody.enrollments?.length ?? 0
    }, total=${listedBody.total ?? '?'}`,
  )

  const unauthList = await adminList('zone.stratos.admin.listEnrollments', null)
  assert(
    unauthList.status === 401,
    'listEnrollments without session cookie is rejected (401)',
    `status=${unauthList.status}`,
  )

  const pdsFixture = state.mixedMode?.member
  const pdsMembers = await adminList(
    'zone.stratos.admin.listEnrollments?custody=pds',
    sessionCookie,
  )
  const pdsMembersBody = pdsMembers.body as {
    enrollments?: Array<{ did?: string; custody?: string }>
  }
  assert(
    pdsMembers.status === 200 &&
      (pdsMembersBody.enrollments?.length ?? 0) === 1 &&
      pdsMembersBody.enrollments?.[0]?.did === pdsFixture?.did &&
      pdsMembersBody.enrollments?.[0]?.custody === 'pds',
    'listEnrollments returns the one PDS-custody fixture',
    `status=${pdsMembers.status}, returned=${pdsMembersBody.enrollments?.length ?? 0}`,
  )

  // 2. addBoundary via the admin API.
  const add = await adminFetch(
    'zone.stratos.admin.addBoundary',
    { did: target.did, boundary: DOMAINS.aekea },
    sessionCookie,
  )
  const addBody = add.body as BoundaryResponse
  assert(
    add.status === 200 && addBody?.boundaries?.includes(DOMAINS.aekea),
    'addBoundary returns the added boundary',
    `status=${add.status}, boundaries=[${
      addBody?.boundaries?.join(', ') ?? ''
    }]`,
  )

  // 3a. Service read-back cross-check via listEnrollments.
  const svcAfterAdd =
    (await adminGetBoundaries(target.did, sessionCookie)) ?? []
  assert(
    svcAfterAdd.includes(DOMAINS.aekea),
    'listEnrollments reflects the added boundary',
    `[${svcAfterAdd.join(', ')}]`,
  )

  // 3b. PDS cross-check — proves the enrollment-record rewrite side effect.
  const pdsAfterAdd = await waitForPdsBoundaries(target.did, svcAfterAdd)
  assert(
    pdsAfterAdd !== null && pdsAfterAdd.includes(DOMAINS.aekea),
    'PDS enrollment record rewritten with the added boundary',
    pdsAfterAdd ? `[${pdsAfterAdd.join(', ')}]` : 'no PDS record found',
  )

  // 4. setBoundaries via the admin API to a single known boundary. The
  // EFFECTIVE set is always `requested ∪ {RESERVED_DOMAIN}`: the service
  // force-includes the reserved all-members domain on every write and read.
  const set = await adminFetch(
    'zone.stratos.admin.setBoundaries',
    { did: target.did, boundaries: [DOMAINS.swordsmith] },
    sessionCookie,
  )
  const setExpected = [DOMAINS.swordsmith, RESERVED_DOMAIN]
  const setBody = set.body as BoundaryResponse
  assert(
    set.status === 200 && sameSet(setBody?.boundaries ?? [], setExpected),
    'setBoundaries replaces the boundary set (reserved domain retained)',
    `status=${set.status}, boundaries=[${
      setBody?.boundaries?.join(', ') ?? ''
    }]`,
  )

  const svcAfterSet =
    (await adminGetBoundaries(target.did, sessionCookie)) ?? []
  assert(
    sameSet(svcAfterSet, setExpected),
    'listEnrollments reflects setBoundaries',
    `[${svcAfterSet.join(', ')}]`,
  )
  const pdsAfterSet = await waitForPdsBoundaries(target.did, setExpected)
  assert(
    pdsAfterSet !== null && sameSet(pdsAfterSet, setExpected),
    'PDS enrollment record reflects setBoundaries',
    pdsAfterSet ? `[${pdsAfterSet.join(', ')}]` : 'no PDS record found',
  )

  // 5. removeBoundary via the admin API.
  const remove = await adminFetch(
    'zone.stratos.admin.removeBoundary',
    { did: target.did, boundary: DOMAINS.swordsmith },
    sessionCookie,
  )
  const removeBody = remove.body as BoundaryResponse
  assert(
    remove.status === 200 &&
      !removeBody?.boundaries?.includes(DOMAINS.swordsmith),
    'removeBoundary drops the boundary',
    `status=${remove.status}, boundaries=[${
      removeBody?.boundaries?.join(', ') ?? ''
    }]`,
  )

  // 6. Negative case: same mutation with no session cookie → 401.
  const unauth = await adminFetch(
    'zone.stratos.admin.addBoundary',
    { did: target.did, boundary: DOMAINS.aekea },
    null,
  )
  assert(
    unauth.status === 401,
    'addBoundary without session cookie is rejected (401)',
    `status=${unauth.status}`,
  )

  // 7. Deactivate and reactivate the target, checking the change is persisted
  // and visible in the admin listing.
  const deactivated = await adminFetch(
    'zone.stratos.admin.setActive',
    { did: target.did, active: false },
    sessionCookie,
  )
  assert(
    deactivated.status === 200,
    'setActive deactivates the target',
    `status=${deactivated.status}`,
  )

  const afterDeactivate = await enrollmentStatus(target.did)
  assert(
    afterDeactivate.active === false,
    'enrollment status reports the target as deactivated',
    `active=${afterDeactivate.active}`,
  )

  // The listing is the surface an operator actually reads, so assert there
  // too rather than only on the single-record status.
  const listedInactive = await adminList(
    'zone.stratos.admin.listEnrollments',
    sessionCookie,
    { active: 'false' },
  )
  const inactiveDids = (
    listedInactive.body as { enrollments?: Array<{ did: string }> }
  ).enrollments?.map((e) => e.did)
  assert(
    inactiveDids?.includes(target.did) === true,
    'listEnrollments filtered to deactivated includes the target',
    `dids=[${inactiveDids?.join(', ') ?? ''}]`,
  )

  const reactivated = await adminFetch(
    'zone.stratos.admin.setActive',
    { did: target.did, active: true },
    sessionCookie,
  )
  const afterReactivate = await enrollmentStatus(target.did)
  assert(
    reactivated.status === 200 && afterReactivate.active === true,
    'setActive reactivates the target',
    `status=${reactivated.status}, active=${afterReactivate.active}`,
  )

  // 8. Admin management: the operator is listed, grants are revocable, and
  // config-provided admins are not.
  const admins = await adminList('zone.stratos.admin.listAdmins', sessionCookie)
  const adminsBody = admins.body as {
    admins?: Array<{ did: string; source: string }>
  }
  const operatorEntry = adminsBody.admins?.find((a) => a.did === operator.did)
  assert(
    admins.status === 200 && operatorEntry?.source === 'config',
    'listAdmins reports the operator as a config admin',
    `status=${admins.status}, source=${operatorEntry?.source}`,
  )

  const granted = await adminFetch(
    'zone.stratos.admin.addAdmin',
    { did: target.did },
    sessionCookie,
  )
  assert(
    granted.status === 200,
    'addAdmin grants access to the target',
    `status=${granted.status}`,
  )

  const configRevoke = await adminFetch(
    'zone.stratos.admin.removeAdmin',
    { did: operator.did },
    sessionCookie,
  )
  assert(
    configRevoke.status === 400,
    'removeAdmin refuses to revoke a config admin',
    `status=${configRevoke.status}`,
  )

  const revoked = await adminFetch(
    'zone.stratos.admin.removeAdmin',
    { did: target.did },
    sessionCookie,
  )
  assert(
    revoked.status === 200,
    'removeAdmin revokes the granted admin',
    `status=${revoked.status}`,
  )

  const unauthAdmins = await adminList('zone.stratos.admin.listAdmins', null)
  assert(
    unauthAdmins.status === 401,
    'listAdmins without session cookie is rejected (401)',
    `status=${unauthAdmins.status}`,
  )

  finish()
}

run().catch((err) => {
  console.error('\nAdmin API phase failed:', err)
  Deno.exit(1)
})
