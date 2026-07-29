#!/usr/bin/env -S deno run -A
// Spaces (permissioned-data) phase — validates the 0016-shaped user flow:
// a PDS user who is a MEMBER of a space obtains a space credential and uses
// it to read and sync records hosted only in Stratos (Reading A: Stratos is
// the repo host and permanent space owner).
//
// Flow under test:
//   1. Membership → credential: an enrolled member obtains a space credential.
//   2. Non-membership → denial: a non-member is refused (NotEnrolled).
//   3. Addressing: foreign/malformed space URIs are rejected — pins the
//      merged-spec `at://{spaceDid}/space/{spaceType}/{skey}` grammar.
//   4. Credential-authed read: the credential (no user identity) admits reads
//      of records in ITS space, and fails closed on records outside it.
//   5. Syncer flow: listRepoOps with a credential returns boundary-gated ops
//      and a signed caught-up commit; an out-of-space credential sees nothing.
//   6. Writes never accept a credential (read/sync capability only).
//   7. Revocation: losing the boundary invalidates future credential issuance.
//   8. Migration anchors: single-boundary records, no post records on the
//      user's PDS (no stubs), a did:key signingKey on the enrollment, and a
//      durable signed-commit proof for the record.

import {
  createRecord,
  createRecordWithCredential,
  deleteRecord,
  enrollmentStatus,
  getRecord,
  getSpaceCredential,
  getSpaceRecord,
  getRepoCar,
  hydrateRecordWithCredential,
  listPdsRecords,
  listRepoOpsWithCredential,
} from './lib/stratos.ts'
import { getBoundaries, setBoundaries } from './lib/backend.ts'
import { DOMAINS, PDS_URL, SERVICE_DID, SPACES } from './lib/config.ts'
import { loadState } from './lib/state.ts'
import { fail, info, pass, section, summary } from './lib/log.ts'

const POST_COLLECTION = 'zone.stratos.feed.post'

let passed = 0
let failed = 0

function assert(condition: unknown, name: string, detail?: string): void {
  if (condition) {
    pass(name, detail)
    passed++
  } else {
    fail(name, detail)
    failed++
  }
}

function post(text: string, domain: string) {
  return {
    $type: POST_COLLECTION,
    text,
    createdAt: new Date().toISOString(),
    boundary: { values: [{ value: domain }] },
  }
}

async function run(): Promise<void> {
  section('Spaces: membership, credentials, sync, revocation')

  const state = await loadState()
  const rei = state.users['rei']
  const sakura = state.users['sakura']
  const kaoruko = state.users['kaoruko']
  if (!rei || !sakura || !kaoruko) {
    fail('Missing user state — run setup/enrollment phases first')
    Deno.exit(1)
  }

  // ── Setup: Rei writes a swordsmith post (lives ONLY in Stratos) ──────────
  section('Setup: member post in the swordsmith space')
  const created = await createRecord(
    rei.did,
    POST_COLLECTION,
    post('a members-only transmission', DOMAINS.swordsmith),
  )
  const rkey = created.uri.split('/').pop() as string
  pass('Rei created a swordsmith post', created.uri)

  // ── 1. Membership → credential ───────────────────────────────────────────
  section('Test 1: member obtains a space credential')
  const reiCred = await getSpaceCredential(rei.did, SPACES.swordsmith)
  assert(
    reiCred.status === 200 && typeof reiCred.body.credential === 'string',
    'Rei (member) obtains a swordsmith space credential',
    `status=${reiCred.status}`,
  )
  const expiresAt = Date.parse(String(reiCred.body.expiresAt ?? ''))
  const ttlMs = expiresAt - Date.now()
  assert(
    Number.isFinite(expiresAt) && ttlMs > 0 && ttlMs <= 3 * 60 * 60 * 1000,
    'Credential expiry is bounded (0 < ttl ≤ 3h)',
    `expiresAt=${reiCred.body.expiresAt}`,
  )
  const swordsmithCred = String(reiCred.body.credential)

  // ── 2. Non-membership → denial ───────────────────────────────────────────
  section('Test 2: non-member is denied a credential')
  const kaorukoCred = await getSpaceCredential(kaoruko.did, SPACES.swordsmith)
  assert(
    kaorukoCred.status === 400 && kaorukoCred.body.error === 'NotEnrolled',
    'kaoruko (non-member) denied a swordsmith credential (NotEnrolled)',
    `status=${kaorukoCred.status}, error=${kaorukoCred.body.error}`,
  )

  // ── 3. Addressing guards (merged-spec at://…/space/… grammar) ────────────
  section('Test 3: space addressing guards')
  const foreign = await getSpaceCredential(
    rei.did,
    `at://did:web:elsewhere.example/space/zone.stratos.space.feed/swordsmith`,
  )
  assert(
    foreign.status === 400 && foreign.body.error === 'UnknownSpace',
    'Foreign-DID space URI rejected (UnknownSpace)',
    `status=${foreign.status}, error=${foreign.body.error}`,
  )
  const legacy = await getSpaceCredential(
    rei.did,
    `ats://${SERVICE_DID}/swordsmith`,
  )
  assert(
    legacy.status === 400,
    'Legacy ats:// scheme rejected',
    `status=${legacy.status}, error=${legacy.body.error}`,
  )

  // ── 4. Credential-authed read ────────────────────────────────────────────
  section('Test 4: credential-authed read (no user identity)')
  const hydrated = await hydrateRecordWithCredential(
    swordsmithCred,
    created.uri,
  )
  assert(
    hydrated.status === 200,
    "Swordsmith credential reads Rei's swordsmith post",
    `status=${hydrated.status}`,
  )

  // Out-of-space fail-closed: kaoruko's aekea post is invisible to the
  // swordsmith credential.
  const aekeaPost = await createRecord(
    kaoruko.did,
    POST_COLLECTION,
    post('aekea internal', DOMAINS.aekea),
  )
  const crossRead = await hydrateRecordWithCredential(
    swordsmithCred,
    aekeaPost.uri,
  )
  assert(
    crossRead.status !== 200,
    'Swordsmith credential CANNOT read an aekea post (fail closed)',
    `status=${crossRead.status}, error=${crossRead.body.error}`,
  )

  // Spec-shaped space read (mirror of com.atproto.space.getRecord): both the
  // member session and the space credential read the record via the space
  // surface; a credential for a different space is refused.
  const spaceReadUser = await getSpaceRecord(
    rei.did,
    SPACES.swordsmith,
    rei.did,
    POST_COLLECTION,
    rkey,
  )
  assert(
    spaceReadUser.status === 200 &&
      (spaceReadUser.body.value as { text?: string })?.text ===
        'a members-only transmission',
    'space.getRecord: member session reads the record',
    `status=${spaceReadUser.status}`,
  )
  const spaceReadCred = await getSpaceRecord(
    swordsmithCred,
    SPACES.swordsmith,
    rei.did,
    POST_COLLECTION,
    rkey,
  )
  assert(
    spaceReadCred.status === 200,
    'space.getRecord: space credential reads the record',
    `status=${spaceReadCred.status}`,
  )
  const spaceReadWrongCred = await getSpaceRecord(
    swordsmithCred,
    SPACES.aekea,
    rei.did,
    POST_COLLECTION,
    rkey,
  )
  assert(
    spaceReadWrongCred.status === 401,
    'space.getRecord: credential for another space is refused',
    `status=${spaceReadWrongCred.status}, error=${spaceReadWrongCred.body.error}`,
  )

  // ── 5. Syncer flow: pull sync with a credential ──────────────────────────
  section('Test 5: pull sync (listRepoOps) with a space credential')
  const sync = await listRepoOpsWithCredential(swordsmithCred, rei.did)
  const opForPost = sync.body.ops?.find((op) => op.rkey === rkey)
  assert(
    sync.status === 200 && opForPost !== undefined,
    "listRepoOps returns the member post's op",
    `status=${sync.status}, ops=${sync.body.ops?.length ?? 0}`,
  )
  assert(
    sync.body.caughtUp === true &&
      sync.body.commit !== undefined &&
      sync.body.commit.did === rei.did &&
      typeof sync.body.commit.rev === 'string' &&
      sync.body.commit.sig !== undefined,
    'Caught-up response carries a signed commit (did/rev/sig)',
    `caughtUp=${sync.body.caughtUp}, commit.did=${sync.body.commit?.did}`,
  )

  // Boundary gating: an aekea credential sees NOTHING of Rei's swordsmith
  // repo — not even the existence of ops.
  const aekeaCredRes = await getSpaceCredential(kaoruko.did, SPACES.aekea)
  assert(
    aekeaCredRes.status === 200,
    'kaoruko (member) obtains an aekea credential',
    `status=${aekeaCredRes.status}`,
  )
  const aekeaCred = String(aekeaCredRes.body.credential)
  const crossSync = await listRepoOpsWithCredential(aekeaCred, rei.did)
  assert(
    crossSync.status === 200 && (crossSync.body.ops?.length ?? -1) === 0,
    "Aekea credential sees zero ops in Rei's repo (no existence leak)",
    `status=${crossSync.status}, ops=${crossSync.body.ops?.length}`,
  )

  // ── 6. Writes never accept a credential ──────────────────────────────────
  section('Test 6: credentials are read/sync-only')
  const credWrite = await createRecordWithCredential(
    swordsmithCred,
    rei.did,
    POST_COLLECTION,
    post('should never land', DOMAINS.swordsmith),
  )
  assert(
    credWrite.status === 401 || credWrite.status === 400,
    'createRecord with a space credential is rejected',
    `status=${credWrite.status}, error=${credWrite.body.error}`,
  )

  // ── 7. Revocation invalidates future issuance ────────────────────────────
  section('Test 7: revocation → credential issuance denied')
  const sakuraBefore = await getBoundaries(sakura.did)
  const sakuraCredBefore = await getSpaceCredential(
    sakura.did,
    SPACES.swordsmith,
  )
  assert(
    sakuraCredBefore.status === 200,
    'Sakura (member) obtains a credential pre-revocation',
    `status=${sakuraCredBefore.status}`,
  )
  try {
    await setBoundaries(
      sakura.did,
      sakuraBefore.filter((b) => b !== DOMAINS.swordsmith),
    )
    const sakuraCredAfter = await getSpaceCredential(
      sakura.did,
      SPACES.swordsmith,
    )
    assert(
      sakuraCredAfter.status === 400 &&
        sakuraCredAfter.body.error === 'NotEnrolled',
      'Post-revocation credential issuance denied (NotEnrolled)',
      `status=${sakuraCredAfter.status}, error=${sakuraCredAfter.body.error}`,
    )
  } finally {
    // Restore so later phases see the original membership.
    await setBoundaries(sakura.did, sakuraBefore)
  }

  // ── 8. Migration-path anchors ────────────────────────────────────────────
  section('Test 8: migration-path anchors')

  // 8a. One-record-one-space (D-14): exactly one boundary value on the post.
  const record = await getRecord(rei.did, POST_COLLECTION, rkey, rei.did)
  const boundaryValues = (
    record.value as {
      boundary?: { values?: Array<{ value?: string }> }
    }
  ).boundary?.values
  assert(
    Array.isArray(boundaryValues) && boundaryValues.length === 1,
    'Post carries exactly ONE boundary (one-record-one-space)',
    `values=${JSON.stringify(boundaryValues)}`,
  )

  // 8b. No post records on the user's PDS: the record lives ONLY in Stratos;
  // the sole PDS artifact is the enrollment record (discovery + key anchor).
  const pdsPosts = await listPdsRecords(PDS_URL, rei.did, POST_COLLECTION)
  assert(
    pdsPosts.records.length === 0,
    "No post records on Rei's PDS (no stubs; Stratos is the repo host)",
    `count=${pdsPosts.records.length}`,
  )

  // 8c. Key-binding anchor: the enrollment exposes a did:key signing key —
  // the seam for the future convergence onto the account #atproto key.
  const status = await enrollmentStatus(rei.did)
  assert(
    typeof status.signingKey === 'string' &&
      status.signingKey.startsWith('did:key:'),
    'Enrollment exposes a did:key signing key (key-binding anchor)',
    status.signingKey,
  )

  // 8d. Durable signed-commit proof exists for the repo (MST v3 today;
  // re-derivable state at the LtHash cutover). The full-repo CAR carries the
  // signed commit, MST nodes, and record blocks.
  const proof = await getRepoCar(rei.did, rei.did)
  assert(
    proof.status === 200 && proof.bytes > 0,
    'Repo CAR (signed commit + MST + records) is served',
    `status=${proof.status}, bytes=${proof.bytes}`,
  )

  // ── Cleanup ──────────────────────────────────────────────────────────────
  info('Cleaning up phase records...')
  await deleteRecord(rei.did, POST_COLLECTION, rkey).catch(() => {})
  const aekeaRkey = aekeaPost.uri.split('/').pop() as string
  await deleteRecord(kaoruko.did, POST_COLLECTION, aekeaRkey).catch(() => {})

  section('Spaces Phase Summary')
  summary(passed, failed)
  if (failed > 0) Deno.exit(1)
}

run().catch((err) => {
  console.error('\nSpaces phase failed:', err)
  Deno.exit(1)
})
