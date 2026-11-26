#!/usr/bin/env -S deno run -A
/*
 * WP0 findings:
 * Q1: invite creation plus com.atproto.server.createAccount creates the local
 * did:plc accounts; PDS_INVITE_REQUIRED and the admin password are in compose.
 * Q2: Stratos accepts the member DID as the authorize input; this phase drives
 * that real OAuth enrollment before it reads the PDS enrollment record.
 * Q3: STRATOS_DEV_MODE enables OAuth allowHttp. The alpha PDS only preserves
 * plain HTTP and its configured port for PDS_HOSTNAME=localhost, so it shares
 * Stratos's network namespace and uses http://localhost:3010 from every
 * identity-bearing path. PDS_DEV_MODE enables its local development flow, and
 * open enrollment admits the fixture DID without a PDS endpoint allowlist.
 * Password sessions bypass the alpha PDS space-scope check. Their access JWTs
 * are not Stratos credentials, so this phase asserts that auth boundary and
 * separately uses the dev-DID seam to reach the PDS-custody write guard.
 */

import { Secp256k1Keypair } from 'npm:@atproto/crypto'
import { createServiceJwt } from 'npm:@atproto/xrpc-server'
import { chromium } from 'npm:playwright@1.65.1'
import {
  DOMAINS,
  SERVICE_DID,
  STRATOS_URL,
  TEST_ROOT,
  spaceUriFor,
} from './lib/config.ts'
import { adminList, adminSetBoundaries } from './lib/admin.ts'
import { FEEDGEN_DID, FEEDGEN_SIGNING_KEY } from './lib/feedgen.ts'
import { assert, fail, finish, info, pass, section } from './lib/log.ts'
import {
  createPdsSession,
  createPdsSpaceRecord,
  ENROLLMENT_COLLECTION,
  getPdsSpaceRecord,
  parseSpaceRecordUri,
  PDS_SPACES_URL,
  SPACE_DECLARATION_COLLECTION,
  SPACE_DECLARATION_RKEY,
  verifyPdsRecord,
  verifyPdsSpaceDeclaration,
} from './lib/mixed-mode-pds.ts'
import { fillSignInForm, submitSignInAndConsent } from './lib/oauth-flow.ts'
import { loadState, saveState } from './lib/state.ts'
import {
  enrollmentStatus,
  isRecordNotFound,
  tryGetRecord,
} from './lib/stratos.ts'

const COLLECTION = 'zone.stratos.feed.post'
const DNS_DECLARATION_NAME = '_lexicon.space.stratos.zone'
const SPACE_DECLARATION_AUTHORITY_DID = 'did:plc:6uxgo3ypovauub7nblwylqyv'
const PLC_DIRECTORY_URL =
  Deno.env.get('PLC_DIRECTORY') ?? 'https://plc.directory'
interface ListReposBody {
  repos?: Array<{
    did?: string
    custody?: string
    host?: string
    hostSource?: string
    rev?: string
  }>
}

async function enrollSpacesMember(
  did: string,
  handle: string,
  password: string,
): Promise<boolean> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  try {
    const authorizeUrl = `${STRATOS_URL}/oauth/authorize?handle=${encodeURIComponent(did)}`
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await page.goto(authorizeUrl, { waitUntil: 'load', timeout: 30_000 })
      const callbackUrl = new URL(page.url())
      const oauthError = callbackUrl.searchParams.get('error')
      if (oauthError) {
        const description =
          callbackUrl.searchParams.get('error_description') ?? oauthError
        if (attempt === 2) {
          throw new Error(`OAuth authorization failed: ${description}`)
        }
        info(`spaces member: Retrying OAuth after ${oauthError}`)
        continue
      }

      await fillSignInForm(page, handle, password, 'spaces member')
      break
    }
    await submitSignInAndConsent(page, 'spaces member', (url) =>
      url.includes(`${STRATOS_URL}/oauth/callback`),
    )
    const response = await page
      .textContent('pre')
      .catch(() => page.textContent('body'))
    const body = response ? (JSON.parse(response) as { success?: boolean }) : {}
    return body.success === true
  } finally {
    await context.close()
    await browser.close()
  }
}

async function resolveAuthorityPdsEndpoint(did: string): Promise<string> {
  const document = await resolveDidDocument(did)
  const service = document.service?.find(
    (entry) => entry.id === '#atproto_pds' || entry.id === `${did}#atproto_pds`,
  )
  if (!service || typeof service.serviceEndpoint !== 'string') {
    throw new Error(`authority DID has no #atproto_pds endpoint: ${did}`)
  }
  return service.serviceEndpoint
}

async function resolveDidDocument(did: string): Promise<{
  service?: Array<{ id?: string; serviceEndpoint?: unknown }>
}> {
  let url: string
  if (did.startsWith('did:web:')) {
    url = didWebDocumentUrl(did)
  } else if (did.startsWith('did:plc:')) {
    url = `${PLC_DIRECTORY_URL}/${encodeURIComponent(did)}`
  } else {
    throw new Error(`unsupported authority DID method: ${did}`)
  }
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`DID resolution failed: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as {
    service?: Array<{ id?: string; serviceEndpoint?: unknown }>
  }
}

function didWebDocumentUrl(did: string): string {
  const segments = did
    .slice('did:web:'.length)
    .split(':')
    .map(decodeURIComponent)
  const [host, ...path] = segments
  if (!host) throw new Error(`invalid did:web identifier: ${did}`)
  const documentPath =
    path.length === 0
      ? '/.well-known/did.json'
      : `/${path.map(encodeURIComponent).join('/')}/did.json`
  return `https://${host}${documentPath}`
}

async function declarationStage<T>(
  stage: string,
  remediation: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (err) {
    throw new Error(`${stage} failed; ${remediation}`, { cause: err })
  }
}

function requireDeclaration(
  condition: unknown,
  stage: string,
  remediation: string,
  detail?: string,
): asserts condition {
  if (condition) {
    pass(stage, detail)
    return
  }
  fail(stage, `${detail ?? 'unexpected declaration state'}; ${remediation}`)
  throw new Error(`${stage} failed; ${remediation}`)
}

async function fetchListRepos(space: string): Promise<ListReposBody> {
  const keypair = await Secp256k1Keypair.import(FEEDGEN_SIGNING_KEY)
  const token = await createServiceJwt({
    iss: FEEDGEN_DID,
    aud: SERVICE_DID,
    lxm: 'zone.stratos.space.listRepos',
    keypair,
  })
  const res = await fetch(
    `${STRATOS_URL}/xrpc/zone.stratos.space.listRepos?${new URLSearchParams({ space })}`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  assert(res.status === 200, 'listRepos returns the current space members')
  return (await res.json()) as ListReposBody
}

async function postStratosRecord(
  did: string,
  authorization: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${STRATOS_URL}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      authorization,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      repo: did,
      collection: COLLECTION,
      record: { $type: COLLECTION, text: 'Stratos must not own this write' },
    }),
  })
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  }
}

async function assertPdsPasswordSessionRejected(
  did: string,
  accessJwt: string,
): Promise<void> {
  const { status, body } = await postStratosRecord(did, `Bearer ${accessJwt}`)
  assert(
    status === 401 &&
      body['error'] === 'AuthenticationRequired' &&
      body['message'] === 'Authorization failed',
    'Stratos rejects the PDS password-session JWT as a Stratos credential',
    `status=${status} error=${body['error']} message=${body['message']}`,
  )
}

async function assertPdsCustodyWriteRejected(did: string): Promise<void> {
  const { status, body } = await postStratosRecord(did, `Bearer ${did}`)
  assert(
    status === 400 && body['error'] === 'PdsCustodyWriteForbidden',
    'Stratos rejects its authenticated write path for a PDS-custody member',
    `status=${status} error=${body['error']}`,
  )
}

async function run(): Promise<void> {
  section('Phase 4g: Mixed mode — spaces PDS custody')
  const state = await loadState()
  const fixture = state.mixedMode
  if (!fixture || !state.adminSessionCookie) {
    fail('Missing mixed-mode fixtures or admin session — run prior phases')
    finish()
  }
  assert(
    fixture.member.did.startsWith('did:plc:') &&
      fixture.hostile.did.startsWith('did:plc:'),
    'the invite-backed spaces PDS account APIs created did:plc fixtures',
  )

  const space = spaceUriFor('swordsmith')
  const dnsRemediation = `republish ${DNS_DECLARATION_NAME} TXT as did=${SPACE_DECLARATION_AUTHORITY_DID}`
  const txtRecords = await declarationStage(
    `space declaration DNS check for ${DNS_DECLARATION_NAME}`,
    dnsRemediation,
    () => Deno.resolveDns(DNS_DECLARATION_NAME, 'TXT'),
  )
  const authorityDids = txtRecords
    .flat()
    .filter((record) => record.startsWith('did='))
    .map((record) => record.slice('did='.length))
  requireDeclaration(
    authorityDids.length === 1 &&
      authorityDids[0] === SPACE_DECLARATION_AUTHORITY_DID,
    'space declaration DNS authority check',
    dnsRemediation,
    `dns=${authorityDids.join(', ') || '<none>'} expected=${SPACE_DECLARATION_AUTHORITY_DID}`,
  )
  const authorityDid = authorityDids[0]
  const authorityRemediation = `repair ${authorityDid}'s DID document #atproto_pds service endpoint`
  const authorityPdsEndpoint = await declarationStage(
    'space declaration authority repo discovery',
    authorityRemediation,
    () => resolveAuthorityPdsEndpoint(authorityDid),
  )
  pass('space declaration authority repo discovery', authorityPdsEndpoint)
  const recordRemediation = `republish ${SPACE_DECLARATION_COLLECTION}/${SPACE_DECLARATION_RKEY} to ${authorityDid}'s repo`
  const declaration = await declarationStage(
    'space declaration record verification',
    recordRemediation,
    () => verifyPdsSpaceDeclaration(authorityPdsEndpoint, authorityDid),
  )
  pass('space declaration record verification')
  requireDeclaration(
    (declaration as { id?: string }).id === SPACE_DECLARATION_RKEY &&
      (declaration as { defs?: { main?: { type?: string } } }).defs?.main
        ?.type === 'space',
    'space declaration record shape check',
    recordRemediation,
    `expected id=${SPACE_DECLARATION_RKEY} and defs.main.type=space`,
  )

  const didDocumentRemediation =
    'republish the Stratos DID document with #atproto beside #atproto_pns'
  const didDocument = await declarationStage(
    'Stratos credential DID document check',
    didDocumentRemediation,
    async () => {
      const res = await fetch(`${STRATOS_URL}/.well-known/did.json`)
      if (!res.ok) {
        throw new Error(
          `DID document returned ${res.status}: ${await res.text()}`,
        )
      }
      return (await res.json()) as {
        verificationMethod?: Array<{ id?: string }>
        service?: Array<{ id?: string }>
      }
    },
  )
  const methodIds =
    didDocument.verificationMethod?.map((method) => method.id) ?? []
  requireDeclaration(
    methodIds.includes(`${SERVICE_DID}#atproto`) &&
      methodIds.includes(`${SERVICE_DID}#atproto_pns`),
    'Stratos credential signing-fragment check',
    didDocumentRemediation,
    methodIds.join(', '),
  )
  requireDeclaration(
    didDocument.service?.some((service) => service.id === '#stratos') === true,
    'Stratos service endpoint check',
    'republish the Stratos DID document #stratos service endpoint',
  )

  const enrolled = await enrollSpacesMember(
    fixture.member.did,
    fixture.member.handle,
    fixture.member.password,
  )
  assert(
    enrolled,
    'bare-DID OAuth enrollment succeeds for the spaces PDS member',
  )
  const status = await enrollmentStatus(fixture.member.did)
  assert(status.enrolled, 'the spaces PDS member has a Stratos enrollment')
  if (!status.enrollmentRkey) {
    fail('the spaces PDS enrollment has no record key')
    finish()
  }
  const enrollmentRecord = await verifyPdsRecord(
    PDS_SPACES_URL,
    fixture.member.did,
    ENROLLMENT_COLLECTION,
    status.enrollmentRkey,
  )
  assert(
    (enrollmentRecord as { custody?: string; repoHost?: string }).custody ===
      'pds' &&
      (enrollmentRecord as { repoHost?: string }).repoHost === PDS_SPACES_URL,
    'the verified PDS enrollment record records PDS custody and host',
  )
  fixture.member.enrolled = status.enrolled
  await saveState(state)

  const boundaryUpdate = await adminSetBoundaries(
    fixture.member.did,
    [DOMAINS.swordsmith],
    state.adminSessionCookie,
  )
  assert(
    boundaryUpdate.status === 200,
    'admin assigns the local space boundary',
  )

  const repos = await fetchListRepos(space)
  const memberRow = repos.repos?.find((row) => row.did === fixture.member.did)
  const hostileRow = repos.repos?.find((row) => row.did === fixture.hostile.did)
  assert(
    memberRow?.custody === 'pds' &&
      memberRow.host === PDS_SPACES_URL &&
      memberRow.hostSource === 'authority-override' &&
      memberRow.rev === undefined,
    'listRepos returns the PDS member host and omits a Stratos revision',
  )
  assert(hostileRow === undefined, 'listRepos excludes the hostile non-member')

  const adminMirror = await adminList(
    'zone.stratos.admin.listEnrollments?custody=pds',
    state.adminSessionCookie,
  )
  const adminRows = (
    adminMirror.body as {
      enrollments?: Array<{ did?: string; custody?: string }>
    }
  ).enrollments
  assert(
    adminMirror.status === 200 &&
      adminRows?.length === 1 &&
      adminRows[0]?.did === fixture.member.did &&
      adminRows[0]?.custody === 'pds',
    'the admin enrollment mirror reports the one PDS-custody member',
  )

  const memberSession = await createPdsSession(
    fixture.member.handle,
    fixture.member.password,
  )
  const hostileSession = await createPdsSession(
    fixture.hostile.handle,
    fixture.hostile.password,
  )
  const memberPost = await createPdsSpaceRecord(memberSession, space, {
    $type: COLLECTION,
    text: 'Motoko keeps the local space record in the PDS',
    createdAt: new Date().toISOString(),
  })
  const hostilePost = await createPdsSpaceRecord(hostileSession, space, {
    $type: COLLECTION,
    text: 'Batou must not enter the boundary feed',
    createdAt: new Date().toISOString(),
  })
  const memberPath = parseSpaceRecordUri(memberPost.uri, space)
  const hostilePath = parseSpaceRecordUri(hostilePost.uri, space)
  assert(
    memberPath.did === fixture.member.did,
    'the PDS return URI identifies the admitted member',
  )
  assert(
    hostilePath.did === fixture.hostile.did,
    'the PDS return URI identifies the hostile writer',
  )
  const pdsRecord = await getPdsSpaceRecord(
    memberSession,
    space,
    memberPath.did,
    memberPath.collection,
    memberPath.rkey,
  )
  assert(
    pdsRecord.uri === memberPost.uri &&
      pdsRecord.cid === memberPost.cid &&
      pdsRecord.value['text'] ===
        'Motoko keeps the local space record in the PDS',
    'the PDS space read returns the PDS-custody record',
  )
  const stratosRead = await tryGetRecord(
    memberPath.did,
    memberPath.collection,
    memberPath.rkey,
    fixture.member.did,
  )
  assert(
    isRecordNotFound(stratosRead),
    'the PDS-custody record is absent from Stratos with RecordNotFound',
    stratosRead.ok
      ? 'unexpected record'
      : `status=${stratosRead.status} body=${stratosRead.error}`,
  )
  await assertPdsPasswordSessionRejected(
    fixture.member.did,
    memberSession.accessJwt,
  )
  await assertPdsCustodyWriteRejected(fixture.member.did)

  const repoHost = await adminList(
    'zone.stratos.admin.getRepoHost',
    state.adminSessionCookie,
    { did: fixture.member.did },
  )
  const repoHostBody = repoHost.body as {
    custody?: string
    resolutions?: Array<{ boundary?: string; host?: string; source?: string }>
  }
  const swordsmithResolution = repoHostBody.resolutions?.find(
    (resolution) => resolution.boundary === DOMAINS.swordsmith,
  )
  assert(
    repoHost.status === 200 &&
      repoHostBody.custody === 'pds' &&
      swordsmithResolution?.host === PDS_SPACES_URL &&
      swordsmithResolution.source === 'authority-override',
    'admin resolves the PDS member swordsmith host before removal',
  )

  const removal = await adminSetBoundaries(
    fixture.member.did,
    [],
    state.adminSessionCookie,
  )
  assert(removal.status === 200, 'admin removes the member space boundary')
  const enrollmentAfterRemoval = await verifyPdsRecord(
    PDS_SPACES_URL,
    fixture.member.did,
    ENROLLMENT_COLLECTION,
    status.enrollmentRkey,
  )
  assert(
    (enrollmentAfterRemoval as { custody?: string; repoHost?: string })
      .custody === 'pds' &&
      (enrollmentAfterRemoval as { repoHost?: string }).repoHost ===
        PDS_SPACES_URL,
    'boundary removal preserves PDS custody and host in the enrollment record',
  )
  finish()
}

run().catch((err) => {
  console.error('\nMixed-mode test failed:', err)
  Deno.exit(1)
})
