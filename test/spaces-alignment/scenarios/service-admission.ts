import type { AssertionResult, ScenarioSuite } from '../rules.js'

const requiredAssertions = [
  'never-enrolled-denied',
  'active-all-boundary',
  'active-second-boundary',
  'deactivated-denied',
  'reactivated-admitted',
] as const

// This script runs inside the disposable Stratos container. It uses its own
// sandbox signing identity and database, and emits assertion IDs only.
const exerciseAdmission = String.raw`
import assert from 'node:assert/strict'
import { Secp256k1Keypair } from '@atproto/crypto'
import { createServiceJwt } from '@atproto/xrpc-server'
import { createServiceDb, closeServiceDb } from './dist/db/index.js'
import { SqliteEnrollmentStore } from './dist/storage/sqlite/enrollment-store.js'
import { ReservedDomainEnrollmentStore } from './dist/infra/storage/reserved-domain-enrollment-store.js'

const authority = process.env.STRATOS_SERVICE_DID
assert.ok(authority)
const caller = 'did:web:feedgen-e2e.' + process.env.SANDBOX_DOMAIN
const signingKey = process.env.ADMISSION_SIGNING_KEY
assert.ok(signingKey)
const all = authority + '/all'
const other = authority + '/other'
const keypair = await Secp256k1Keypair.import(signingKey)
const db = createServiceDb('/app/data/service.sqlite')
const store = new ReservedDomainEnrollmentStore(new SqliteEnrollmentStore(db), all)
const methods = ['zone.stratos.sync.listRepoOps', 'zone.stratos.sync.listRecordPaths', 'zone.stratos.space.listRepos']
const passed = []

async function call(method, did, boundary = all) {
  const token = await createServiceJwt({ iss: caller, aud: authority, lxm: method, keypair })
  const params = method === 'zone.stratos.space.listRepos'
    ? 'space=' + encodeURIComponent('at://' + authority + '/space/zone.stratos.space.feed/' + boundary.slice(authority.length + 1))
    : 'did=' + encodeURIComponent(did)
  const response = await fetch('http://localhost:3100/xrpc/' + method + '?' + params, {
    headers: { Authorization: 'Bearer ' + token },
  })
  const body = await response.json()
  return { status: response.status, body }
}

async function checkDenied(did) {
  for (const method of methods) {
    const result = await call(method, did)
    assert.ok([401, 403].includes(result.status), method + ' admitted an unenrolled service')
    assert.equal(result.body.ops, undefined)
    assert.equal(result.body.records, undefined)
    assert.equal(result.body.repos, undefined)
  }
}

async function checkAdmitted(did) {
  for (const method of methods) {
    const result = await call(method, did)
    assert.equal(result.status, 200, method + ' rejected an active service')
  }
}

try {
  const members = await store.listEnrollmentsByBoundary(all, { limit: 100 })
  const actor = members.find((entry) => entry.did !== caller && entry.custody === 'stratos')
  assert.ok(actor, 'Baseline left no Stratos-custody actor')
  await store.unenroll(caller)
  await store.setBoundaries(caller, [other])
  assert.equal(await store.getEnrollment(caller), null)
  assert.deepEqual(new Set(await store.getBoundaries(caller)), new Set([all, other]))
  await checkDenied(actor.did)
  passed.push('never-enrolled-denied')

  await store.enroll({
    did: caller,
    enrolledAt: new Date().toISOString(),
    active: true,
    signingKeyDid: keypair.did(),
    isService: true,
    boundaries: [other],
  })
  await checkAdmitted(actor.did)
  const allRepos = await call('zone.stratos.space.listRepos', actor.did)
  assert.ok(allRepos.body.repos.some((entry) => entry.did === actor.did))
  passed.push('active-all-boundary')

  const otherRepos = await call('zone.stratos.space.listRepos', actor.did, other)
  assert.equal(otherRepos.status, 200)
  assert.ok(otherRepos.body.repos.every((entry) => entry.did !== actor.did))
  assert.ok(otherRepos.body.repos.length > 0, 'Second boundary has no members')
  passed.push('active-second-boundary')

  await store.updateEnrollment(caller, { active: false })
  assert.deepEqual(new Set(await store.getBoundaries(caller)), new Set([all, other]))
  await checkDenied(actor.did)
  passed.push('deactivated-denied')

  await store.updateEnrollment(caller, { active: true })
  await checkAdmitted(actor.did)
  passed.push('reactivated-admitted')
  process.stdout.write(JSON.stringify({ suite: 'service-admission', assertions: passed.map((id) => ({ id, status: 'passed' })) }) + '\n')
} finally {
  await closeServiceDb(db)
}
`

export const suite: ScenarioSuite = {
  id: 'service-admission',
  requiredAssertions,
  async run(context): Promise<AssertionResult[]> {
    const signingKey = (
      await context.runCommand(
        'docker',
        [
          'compose',
          '--project-name',
          context.projectName,
          '--project-directory',
          context.sandboxDirectory,
          'exec',
          '-T',
          'feedgen-e2e-rust',
          'cat',
          '/tmp/feedgen-signing-key',
        ],
        context.sandboxDirectory,
      )
    ).trim()
    if (!/^[0-9a-f]{64}$/i.test(signingKey)) {
      throw new Error('Sandbox signing key was unavailable')
    }
    const output = await context.runCommand(
      'docker',
      [
        'compose',
        '--project-name',
        context.projectName,
        '--project-directory',
        context.sandboxDirectory,
        'exec',
        '-T',
        '-e',
        `ADMISSION_SIGNING_KEY=${signingKey}`,
        'feedgen-e2e-stratos',
        'node',
        '--input-type=module',
        '-e',
        exerciseAdmission,
      ],
      context.sandboxDirectory,
    )
    const receipt = output
      .split('\n')
      .map((line) => line.trim())
      .findLast((line) => line.startsWith('{"suite":"service-admission",'))
    if (!receipt)
      throw new Error('Service admission returned no assertion receipt')
    const parsed = JSON.parse(receipt) as {
      suite?: string
      assertions?: AssertionResult[]
    }
    if (
      parsed.suite !== 'service-admission' ||
      !Array.isArray(parsed.assertions)
    ) {
      throw new Error('Service admission returned an invalid assertion receipt')
    }
    return parsed.assertions
  },
}
