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
import { chromium } from 'npm:playwright@1.58.2'
import {
  DOMAINS,
  SERVICE_DID,
  STRATOS_URL,
  TEST_ROOT,
  spaceUriFor,
} from './lib/config.ts'
import { adminList, adminSetBoundaries } from './lib/admin.ts'
import {
  buildFeedgen,
  FEEDGEN_DID,
  FEEDGEN_SIGNING_KEY,
  FeedgenHarness,
  type FeedgenStartOptions,
  SPACE_COMMIT_TAMPER_MODULE,
} from './lib/feedgen.ts'
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
import { createSession, getServiceAuth } from './lib/pds.ts'
import { fillSignInForm, submitSignInAndConsent } from './lib/oauth-flow.ts'
import { loadState, saveState } from './lib/state.ts'
import {
  createRecord,
  enrollmentStatus,
  isRecordNotFound,
  tryGetRecord,
} from './lib/stratos.ts'

const FEEDGEN_PORT = 3301
const FEEDGEN_URL = `http://127.0.0.1:${FEEDGEN_PORT}`
const COLLECTION = 'zone.stratos.feed.post'
const GET_FEED_LXM = 'zone.stratos.feedgen.getFeed'
const DNS_DECLARATION_NAME = '_lexicon.space.stratos.zone'
const SPACE_DECLARATION_AUTHORITY_DID = 'did:plc:6uxgo3ypovauub7nblwylqyv'
const PLC_DIRECTORY_URL =
  Deno.env.get('STRATOS_PLC_URL') ?? 'https://plc.directory'
const MIXED_MODE_FEEDS = [
  { id: 'swordsmith', boundary: DOMAINS.swordsmith },
  { id: 'aekea', boundary: DOMAINS.aekea },
]
const SPACE_SYNC_ENV = {
  FEEDGEN_SPACE_SYNC_ENABLED: 'true',
  FEEDGEN_SPACE_SYNC_INTERVAL_MS: '500',
  FEEDGEN_SPACE_SYNC_ALLOW_HTTP_HOSTS: PDS_SPACES_URL,
}

interface ListReposBody {
  repos?: Array<{
    did?: string
    custody?: string
    host?: string
    hostSource?: string
    rev?: string
  }>
}

interface PostView {
  uri?: string
  cid?: string
  author?: { did?: string; handle?: string }
  record?: Record<string, unknown>
  boundaries?: string[]
}

interface GetFeedBody {
  error?: string
  feed?: Array<{ post?: PostView }>
}

interface GetFeedResponse {
  status: number
  body: GetFeedBody
}

interface FeedStateResult {
  matches: boolean
  response: GetFeedResponse
}

interface FeedPostsResult {
  posts: PostView[] | null
  response: GetFeedResponse
}

function feedgenStartOptions(
  additionalEnv: Record<string, string> = {},
): FeedgenStartOptions {
  return {
    port: FEEDGEN_PORT,
    feeds: MIXED_MODE_FEEDS,
    env: { ...SPACE_SYNC_ENV, ...additionalEnv },
  }
}

function isSpaceSyncPass(event: {
  fields: Readonly<Record<string, unknown>>
}): boolean {
  return event.fields['msg'] === 'space sync pass completed'
}

function isMembershipPass(event: {
  fields: Readonly<Record<string, unknown>>
}): boolean {
  return event.fields['msg'] === 'space membership pass completed'
}

async function assertFeedgenWarmup(
  feedgen: FeedgenHarness,
  phase: string,
): Promise<void> {
  const warmup = await feedgen.waitForWarmup(30_000)
  assert(
    warmup.attempted === 2,
    `${phase} credential warm-up attempts both configured boundaries`,
    String(warmup.attempted),
  )
  assert(
    warmup.acquired === 2,
    `${phase} credential warm-up acquires both configured boundaries`,
    String(warmup.acquired),
  )
  assert(
    warmup.failed === 0,
    `${phase} credential warm-up has no failed boundary`,
    String(warmup.failed),
  )
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

async function getFeed(token: string, feed: string): Promise<GetFeedResponse> {
  const res = await fetch(
    `${FEEDGEN_URL}/xrpc/zone.stratos.feedgen.getFeed?${new URLSearchParams({ feed })}`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as GetFeedBody,
  }
}

async function waitForFeedPost(
  token: string,
  feed: string,
  uri: string,
  matchesState: (found: boolean) => boolean,
): Promise<FeedStateResult> {
  const deadline = Date.now() + 30_000
  let response: GetFeedResponse = { status: 0, body: {} }
  while (Date.now() < deadline) {
    response = await getFeed(token, feed)
    const found =
      response.body.feed?.some((item) => item.post?.uri === uri) ?? false
    if (response.status === 200 && matchesState(found)) {
      return { matches: true, response }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return { matches: false, response }
}

function describeFeedState(response: GetFeedResponse): string {
  const uris =
    response.body.feed
      ?.flatMap((item) => (item.post?.uri ? [item.post.uri] : []))
      .join(', ') ?? ''
  return `status=${response.status} error=${response.body.error ?? 'none'} uris=${uris}`
}

function describeFeedgenLogs(feedgen: FeedgenHarness): string {
  return feedgen.recentLogLines().join('\n')
}

async function waitForFeedPosts(
  token: string,
  feed: string,
  uris: string[],
): Promise<FeedPostsResult> {
  const deadline = Date.now() + 30_000
  let response: GetFeedResponse = { status: 0, body: {} }
  while (Date.now() < deadline) {
    response = await getFeed(token, feed)
    const posts = response.body.feed?.flatMap((item) =>
      item.post ? [item.post] : [],
    )
    if (
      response.status === 200 &&
      posts &&
      uris.every((uri) => posts.some((post) => post.uri === uri))
    ) {
      return { posts, response }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return { posts: null, response }
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
  const viewer = state.users.sakura
  const stratosAuthor = state.users.rei
  const otherViewer = state.users.kaoruko
  if (
    !fixture ||
    !viewer?.enrolled ||
    !stratosAuthor?.enrolled ||
    !otherViewer?.enrolled ||
    !state.adminSessionCookie
  ) {
    fail(
      'Missing mixed-mode fixtures, users, or admin session — run prior phases',
    )
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
  const claimedPost = await createPdsSpaceRecord(memberSession, space, {
    $type: COLLECTION,
    text: 'Motoko claims a boundary outside the admitted space',
    boundary: { values: [{ value: DOMAINS.aekea }] },
    createdAt: new Date().toISOString(),
  })
  const stratosPost = await createRecord(stratosAuthor.did, COLLECTION, {
    $type: COLLECTION,
    text: 'Rei keeps the Stratos-custody record in the service',
    boundary: { values: [{ value: DOMAINS.swordsmith }] },
    createdAt: new Date().toISOString(),
  })
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

  if (!(await buildFeedgen())) {
    fail('stratos-feedgen bundle')
    finish()
  }
  const feedgen = await FeedgenHarness.create()
  try {
    await feedgen.start(feedgenStartOptions())
    await assertFeedgenWarmup(feedgen, 'initial mixed-mode')
    assert(
      await feedgen.waitForHealth(FEEDGEN_PORT, 30_000),
      'mixed-mode feedgen is healthy',
    )
    const firstMembershipPass = await feedgen.waitForLog(
      isMembershipPass,
      30_000,
      1,
    )
    assert(
      firstMembershipPass.fields['successfulBoundaries'] ===
        MIXED_MODE_FEEDS.length &&
        firstMembershipPass.fields['failedBoundaries'] === 0 &&
        firstMembershipPass.fields['pollTargets'] === 1 &&
        firstMembershipPass.fields['skippedNoHost'] === 0 &&
        firstMembershipPass.fields['removed'] === 0,
      'the membership pass processes both boundaries and produces one poll target',
    )
    const firstPass = await feedgen.waitForLog(isSpaceSyncPass, 30_000, 1)
    assert(
      firstPass.fields['targets'] === 1 &&
        firstPass.fields['succeeded'] === 1 &&
        firstPass.fields['failed'] === 0 &&
        firstPass.fields['abandoned'] === 0 &&
        firstPass.fields['halted'] === 0,
      'the completed pass targets and syncs only the admitted PDS member',
    )
    const secondPass = await feedgen.waitForLog(isSpaceSyncPass, 30_000, 2)
    assert(
      secondPass.fields['targets'] === 1 &&
        secondPass.fields['succeeded'] === 1 &&
        secondPass.fields['failed'] === 0 &&
        secondPass.fields['abandoned'] === 0 &&
        secondPass.fields['halted'] === 0,
      'the next completed pass keeps the hostile writer out',
    )

    const viewerSession = await createSession(viewer.handle, viewer.password)
    const viewerToken = await getServiceAuth(
      viewerSession.accessJwt,
      FEEDGEN_DID,
      GET_FEED_LXM,
    )
    const otherViewerSession = await createSession(
      otherViewer.handle,
      otherViewer.password,
    )
    const otherViewerToken = await getServiceAuth(
      otherViewerSession.accessJwt,
      FEEDGEN_DID,
      GET_FEED_LXM,
    )
    const swordsmithFeed = await waitForFeedPosts(viewerToken, 'swordsmith', [
      memberPost.uri,
      claimedPost.uri,
      stratosPost.uri,
    ])
    const swordsmithPosts = swordsmithFeed.posts
    assert(
      swordsmithPosts !== null,
      'the shared viewer swordsmith feed contains both custody classes',
      `${describeFeedState(swordsmithFeed.response)}\n${describeFeedgenLogs(feedgen)}`,
    )
    const memberFeedPost = swordsmithPosts?.find(
      (post) => post.uri === memberPost.uri,
    )
    const stratosFeedPost = swordsmithPosts?.find(
      (post) => post.uri === stratosPost.uri,
    )
    const claimedFeedPost = swordsmithPosts?.find(
      (post) => post.uri === claimedPost.uri,
    )
    assert(
      memberFeedPost?.author?.did === fixture.member.did &&
        memberFeedPost?.author?.handle === fixture.member.handle &&
        stratosFeedPost?.author?.did === stratosAuthor.did,
      'the feed returns the PDS author handle and both custody authors',
    )
    assert(
      claimedFeedPost?.boundaries?.length === 1 &&
        claimedFeedPost.boundaries[0] === DOMAINS.swordsmith &&
        !claimedFeedPost.boundaries.includes(DOMAINS.aekea),
      'the indexed claimed-boundary post carries only its derived boundary',
      claimedFeedPost?.boundaries?.join(', '),
    )
    assert(
      !swordsmithPosts?.some((post) => post.uri === hostilePost.uri),
      'the feedgen does not index the hostile non-member post',
    )
    const otherBoundaryFeed = await getFeed(otherViewerToken, 'aekea')
    assert(
      otherBoundaryFeed.status === 200 &&
        !otherBoundaryFeed.body.feed?.some(
          (item) => item.post?.uri === claimedPost.uri,
        ),
      'the claimed PDS boundary does not place the record in the aekea feed',
    )
    const deniedSwordsmithFeed = await getFeed(otherViewerToken, 'swordsmith')
    assert(
      deniedSwordsmithFeed.status === 400 &&
        deniedSwordsmithFeed.body.error === 'BoundaryMismatch',
      'a viewer without swordsmith cannot access either custody record',
    )

    await feedgen.stop()
    await feedgen.start(
      feedgenStartOptions({
        NODE_OPTIONS: `--import=${SPACE_COMMIT_TAMPER_MODULE}`,
        FEEDGEN_E2E_TAMPER_COMMIT_REPO: fixture.member.did,
        FEEDGEN_E2E_TAMPER_COMMIT_SPACE: space,
        FEEDGEN_E2E_COMMIT_RESPONSE_MODE: 'omit',
      }),
    )
    await assertFeedgenWarmup(feedgen, 'commit-fallback mixed-mode')
    assert(
      await feedgen.waitForHealth(FEEDGEN_PORT, 30_000),
      'the feedgen with a commit-less terminal page is healthy',
    )
    const fallbackPass = await feedgen.waitForLog(isSpaceSyncPass, 30_000, 1)
    assert(
      fallbackPass.fields['targets'] === 1 &&
        fallbackPass.fields['succeeded'] === 1 &&
        fallbackPass.fields['failed'] === 0,
      'the live feedgen fetches the latest commit when terminal ops omit it',
    )
    const fallbackViewerToken = await getServiceAuth(
      viewerSession.accessJwt,
      FEEDGEN_DID,
      GET_FEED_LXM,
    )
    const fallbackFeedState = await waitForFeedPost(
      fallbackViewerToken,
      'swordsmith',
      memberPost.uri,
      (found) => found,
    )
    assert(
      fallbackFeedState.matches,
      'the separately verified latest commit promotes the PDS post',
      `${describeFeedState(fallbackFeedState.response)}\n${describeFeedgenLogs(feedgen)}`,
    )

    await feedgen.stop()
    await feedgen.start(
      feedgenStartOptions({
        NODE_OPTIONS: `--import=${SPACE_COMMIT_TAMPER_MODULE}`,
        FEEDGEN_E2E_TAMPER_COMMIT_REPO: fixture.member.did,
        FEEDGEN_E2E_TAMPER_COMMIT_SPACE: space,
      }),
    )
    await assertFeedgenWarmup(feedgen, 'quarantine mixed-mode')
    assert(
      await feedgen.waitForHealth(FEEDGEN_PORT, 30_000),
      'the feedgen under a tampered PDS response is healthy',
    )
    const verificationFailure = await feedgen.waitForLog(
      (event) => event.fields['msg'] === 'space commit verification failed',
      30_000,
    )
    const failedTarget = verificationFailure.fields['target'] as
      | Record<string, unknown>
      | undefined
    assert(
      verificationFailure.fields['reason'] === 'mac-mismatch' &&
        failedTarget?.['spaceUri'] === space &&
        failedTarget['boundary'] === DOMAINS.swordsmith &&
        failedTarget['did'] === fixture.member.did &&
        failedTarget['host'] === PDS_SPACES_URL,
      'the live feedgen quarantines the tampered PDS commit',
    )
    const retriedPass = await feedgen.waitForLog(isSpaceSyncPass, 30_000, 2)
    assert(
      retriedPass.fields['targets'] === 1 &&
        retriedPass.fields['succeeded'] === 0 &&
        retriedPass.fields['failed'] === 1 &&
        retriedPass.fields['halted'] === 0,
      'the live feedgen retries the quarantined PDS target after membership refresh',
    )
    const quarantinedFeedState = await waitForFeedPost(
      viewerToken,
      'swordsmith',
      memberPost.uri,
      (found) => !found,
    )
    assert(
      quarantinedFeedState.matches,
      'commit quarantine removes the PDS-custody post from the boundary feed',
      `${describeFeedState(quarantinedFeedState.response)}\n${describeFeedgenLogs(feedgen)}`,
    )

    await feedgen.stop()
    await feedgen.start(feedgenStartOptions())
    await assertFeedgenWarmup(feedgen, 'cold-restart mixed-mode')
    assert(
      await feedgen.waitForHealth(FEEDGEN_PORT, 30_000),
      'cold-restarted mixed-mode feedgen is healthy',
    )
    const restartMembershipPass = await feedgen.waitForLog(
      isMembershipPass,
      30_000,
      1,
    )
    assert(
      restartMembershipPass.fields['successfulBoundaries'] ===
        MIXED_MODE_FEEDS.length &&
        restartMembershipPass.fields['failedBoundaries'] === 0 &&
        restartMembershipPass.fields['pollTargets'] === 1 &&
        restartMembershipPass.fields['skippedNoHost'] === 0 &&
        restartMembershipPass.fields['removed'] === 0,
      'the cold restart rebuilds the PDS poll target for both boundaries',
    )
    const restartPass = await feedgen.waitForLog(isSpaceSyncPass, 30_000, 1)
    assert(
      restartPass.fields['targets'] === 1 &&
        restartPass.fields['succeeded'] === 1 &&
        restartPass.fields['failed'] === 0 &&
        restartPass.fields['abandoned'] === 0 &&
        restartPass.fields['halted'] === 0,
      'the cold restart syncs the rebuilt PDS poll target',
    )
    const restartViewerToken = await getServiceAuth(
      viewerSession.accessJwt,
      FEEDGEN_DID,
      GET_FEED_LXM,
    )
    const restartFeedState = await waitForFeedPost(
      restartViewerToken,
      'swordsmith',
      memberPost.uri,
      (found) => found,
    )
    assert(
      restartFeedState.matches,
      'the cold restart retains the PDS-custody post in its boundary feed',
      `${describeFeedState(restartFeedState.response)}\n${describeFeedgenLogs(feedgen)}`,
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
    const purgePass = await feedgen.waitForLog(
      (event) =>
        isSpaceSyncPass(event) &&
        event.fields['targets'] === 0 &&
        event.fields['succeeded'] === 0 &&
        event.fields['failed'] === 0,
      30_000,
    )
    assert(
      purgePass.fields['targets'] === 0 &&
        purgePass.fields['succeeded'] === 0 &&
        purgePass.fields['failed'] === 0,
      'the completed removal pass has no PDS target',
    )
    const removalViewerSession = await createSession(
      viewer.handle,
      viewer.password,
    )
    const removalViewerToken = await getServiceAuth(
      removalViewerSession.accessJwt,
      FEEDGEN_DID,
      GET_FEED_LXM,
    )
    const removedFeedState = await waitForFeedPost(
      removalViewerToken,
      'swordsmith',
      memberPost.uri,
      (found) => !found,
    )
    assert(
      removedFeedState.matches,
      'the feedgen purges the removed member post',
      `${describeFeedState(removedFeedState.response)}\n${describeFeedgenLogs(feedgen)}`,
    )
  } finally {
    await feedgen.cleanup()
  }
  finish()
}

run().catch((err) => {
  console.error('\nMixed-mode test failed:', err)
  Deno.exit(1)
})
