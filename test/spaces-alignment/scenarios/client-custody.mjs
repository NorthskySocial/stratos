import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  createServiceFetchHandler,
  getEnrollmentByServiceDid,
  resolveRepositoryTarget,
  resolveServiceUrl,
} from './client-custody-sdk.mjs'

const domain = process.env.SANDBOX_DOMAIN
assert.equal(domain, 'atmosbox.test')
const authorityDid = `did:web:stratos-e2e.${domain}`
const authorityUrl = 'https://stratos-e2e.atmosbox.internal'
const spacesPdsUrl = `https://spaces-pds-e2e.${domain}`
const ordinaryPdsUrl = `https://pds1.${domain}`

async function session(url, identifier, password) {
  const response = await fetch(`${url}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  })
  assert.equal(response.status, 200, 'Synthetic PDS session failed')
  return response.json()
}

async function main() {
  const space = `at://${authorityDid}/space/zone.stratos.space.feed/general`
  const serviceJwt = (
    await readFile('/runner/client-custody-service-jwt', 'utf8')
  ).trim()
  const reposUrl = new URL(`${authorityUrl}/xrpc/zone.stratos.space.listRepos`)
  reposUrl.searchParams.set('space', space)
  reposUrl.searchParams.set('limit', '1000')
  const reposResponse = await fetch(reposUrl, {
    headers: { authorization: `Bearer ${serviceJwt}` },
  })
  assert.equal(reposResponse.status, 200, 'Authority repo lookup failed')
  const authorityRepos = (await reposResponse.json()).repos
  assert.ok(Array.isArray(authorityRepos))

  const ordinary = JSON.parse(
    await readFile('/sandbox-state/accounts.json', 'utf8'),
  ).accounts[`user1.pds1.${domain}`]
  assert.ok(ordinary?.did && ordinary?.password)
  const spacesPassword = (
    await readFile('/run/sandbox-secrets/browser-password', 'utf8')
  ).trim()
  const spacesSession = await session(
    spacesPdsUrl,
    `motoko.spaces-pds-e2e.${domain}`,
    spacesPassword,
  )
  const ordinarySession = await session(
    ordinaryPdsUrl,
    `user1.pds1.${domain}`,
    ordinary.password,
  )

  const [pdsEnrollment, stratosEnrollment] = await Promise.all([
    getEnrollmentByServiceDid(spacesSession.did, spacesPdsUrl, authorityDid),
    getEnrollmentByServiceDid(
      ordinarySession.did,
      ordinaryPdsUrl,
      authorityDid,
    ),
  ])
  assert.equal(pdsEnrollment?.custody, 'pds')
  assert.equal(stratosEnrollment?.custody, 'stratos')
  assert.equal(pdsEnrollment.repoHost, spacesPdsUrl)
  const pdsAuthorityRepo = authorityRepos.find(
    (entry) => entry.did === spacesSession.did,
  )
  const stratosAuthorityRepo = authorityRepos.find(
    (entry) => entry.did === ordinarySession.did,
  )
  assert.ok(pdsAuthorityRepo, 'PDS member missing from authority repo list')
  assert.ok(
    stratosAuthorityRepo,
    'Stratos member missing from authority repo list',
  )
  assert.equal(pdsAuthorityRepo.custody, pdsEnrollment.custody)
  assert.equal(stratosAuthorityRepo.custody, stratosEnrollment.custody)
  assert.equal(pdsAuthorityRepo.host, spacesPdsUrl)
  assert.equal(pdsAuthorityRepo.hostSource, 'authority-override')
  assert.equal(pdsEnrollment.repoHost, pdsAuthorityRepo.host)
  const assertions = [{ id: 'sdk-discovers-both-custodies', status: 'passed' }]

  for (const [did, enrollment] of [
    [spacesSession.did, pdsEnrollment],
    [ordinarySession.did, stratosEnrollment],
  ]) {
    const response = await fetch(
      `${authorityUrl}/xrpc/zone.stratos.enrollment.status?did=${encodeURIComponent(did)}`,
    )
    assert.equal(response.status, 200)
    const status = await response.json()
    assert.equal(status.enrolled, true)
    assert.equal(status.active, true)
    assert.equal(status.enrollmentRkey, enrollment.rkey)
    assert.equal(status.signingKey, enrollment.signingKey)
  }
  assert.equal(
    resolveServiceUrl(pdsEnrollment, ordinaryPdsUrl),
    pdsEnrollment.service,
  )
  const pdsTarget = resolveRepositoryTarget(pdsEnrollment, {
    authoritativeRepoHost: pdsAuthorityRepo.host,
    sessionPdsUrl: spacesPdsUrl,
  })
  const stratosTarget = resolveRepositoryTarget(stratosEnrollment, {
    authorityServiceUrl: authorityUrl,
  })
  assert.deepEqual(pdsTarget, { kind: 'pds', url: spacesPdsUrl })
  assert.deepEqual(stratosTarget, { kind: 'stratos', url: authorityUrl })
  assert.deepEqual(
    resolveRepositoryTarget(pdsEnrollment, {
      authoritativeRepoHost: pdsAuthorityRepo.host,
      sessionPdsUrl: ordinaryPdsUrl,
    }),
    { kind: 'unresolved', reason: 'host-mismatch' },
  )
  assertions.push({ id: 'authority-and-host-agree', status: 'passed' })

  const text = `Client custody ${randomUUID()}`
  const write = await fetch(
    `${pdsTarget.url}/xrpc/com.atproto.space.createRecord`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${spacesSession.accessJwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        space,
        repo: spacesSession.did,
        collection: 'zone.stratos.feed.post',
        record: {
          $type: 'zone.stratos.feed.post',
          text,
          createdAt: new Date().toISOString(),
        },
      }),
    },
  )
  assert.equal(write.status, 200, 'Selected PDS space write failed')
  const result = await write.json()
  assert.ok(
    result.uri?.startsWith(
      `${space}/${spacesSession.did}/zone.stratos.feed.post/`,
    ),
  )
  const segments = result.uri.slice('at://'.length).split('/')
  assert.equal(segments.length, 7)
  assertions.push({ id: 'selected-space-write', status: 'passed' })

  const publicUrl = new URL(`${spacesPdsUrl}/xrpc/com.atproto.repo.getRecord`)
  publicUrl.searchParams.set('repo', spacesSession.did)
  publicUrl.searchParams.set('collection', 'zone.stratos.feed.post')
  publicUrl.searchParams.set('rkey', segments[6])
  const publicRead = await fetch(publicUrl)
  assert.ok(publicRead.status === 400 || publicRead.status === 404)
  assertions.push({ id: 'space-write-is-private', status: 'passed' })

  const forwardedRequests = []
  const authenticatedHandler = async (url, init) => {
    forwardedRequests.push({
      url,
      authorization: new Headers(init.headers).get('authorization'),
    })
    return new Response(null, { status: 204 })
  }
  const attemptAuthenticatedWrite = async (enrollment, hosts) => {
    const target = resolveRepositoryTarget(enrollment, hosts)
    if (target.kind === 'unresolved') return target
    const handler = createServiceFetchHandler(authenticatedHandler, target.url)
    await handler.handle('/xrpc/com.atproto.space.createRecord', {
      method: 'POST',
      headers: { authorization: 'Bearer synthetic-credential' },
    })
    return target
  }

  assert.deepEqual(
    await attemptAuthenticatedWrite(
      { custody: 'pds' },
      { sessionPdsUrl: spacesPdsUrl },
    ),
    { kind: 'pds', url: spacesPdsUrl },
  )
  assert.deepEqual(forwardedRequests, [
    {
      url: `${spacesPdsUrl}/xrpc/com.atproto.space.createRecord`,
      authorization: 'Bearer synthetic-credential',
    },
  ])
  forwardedRequests.length = 0

  for (const [enrollment, hosts, reason] of [
    [{ custody: 'pds' }, {}, 'missing-trusted-host'],
    [
      { custody: 'pds' },
      { sessionPdsUrl: 'http://invalid.example' },
      'invalid-trusted-host',
    ],
    [
      { custody: 'future' },
      { sessionPdsUrl: spacesPdsUrl },
      'unsupported-custody',
    ],
    [
      { custody: 'pds' },
      {
        authoritativeRepoHost: pdsAuthorityRepo.host,
        sessionPdsUrl: ordinaryPdsUrl,
      },
      'host-mismatch',
    ],
  ]) {
    assert.deepEqual(await attemptAuthenticatedWrite(enrollment, hosts), {
      kind: 'unresolved',
      reason,
    })
    assert.equal(forwardedRequests.length, 0)
  }
  assertions.push({
    id: 'unresolved-custody-sends-no-credentials',
    status: 'passed',
  })
  console.log(JSON.stringify({ suite: 'client-custody', assertions }))
}

await main()
