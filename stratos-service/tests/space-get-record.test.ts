/**
 * Contract tests for `zone.stratos.space.getRecord` — the spec-shaped mirror
 * of `com.atproto.space.getRecord` (atproto#5187).
 *
 * Contract under test (from the quoted reference lexicon):
 *   - callable with standard user auth (member of the space) OR a space
 *     credential for that space;
 *   - the record must belong to the requested space; records outside it —
 *     including domainless records — resolve to RecordNotFound (no leak);
 *   - a credential admits exactly its own space (fail closed);
 *   - malformed / foreign space URIs → UnknownSpace.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { decode } from '@atcute/cbor'
import {
  computeCid,
  encodeRecord,
  parseCid,
  spaceUriToBoundary,
} from '@northskysocial/stratos-core'

import { SqliteEnrollmentStore, StratosActorStore } from '../src/context.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  ServiceDb,
} from '../src/db/index.js'
import { registerSpaceReadHandlers } from '../src/features/space-read/handler.js'
import { createMockBlobStore, createTestConfig } from './utils/index.js'
import { makeSpaceUri } from './helpers/space-uri.js'

const SERVICE_DID = 'did:web:nerv.tokyo.jp'
const SPACE_S = makeSpaceUri(SERVICE_DID, 'zone.stratos.space.feed', 'alpha')
const SPACE_T = makeSpaceUri(SERVICE_DID, 'zone.stratos.space.feed', 'beta')
const BOUNDARY_S = spaceUriToBoundary(SPACE_S, SERVICE_DID)
const BOUNDARY_T = spaceUriToBoundary(SPACE_T, SERVICE_DID)
if (!BOUNDARY_S.ok || !BOUNDARY_T.ok) throw new Error('bad test boundary')

const repoDid = 'did:plc:shinji-ikari'
const memberDid = 'did:plc:rei-ayanami'
const outsiderDid = 'did:plc:kaworu-nagisa'
const COLLECTION = 'zone.stratos.feed.post'

describe('zone.stratos.space.getRecord', () => {
  let dataDir: string
  let actorStore: StratosActorStore
  let enrollmentStore: SqliteEnrollmentStore
  let db: ServiceDb
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handler: any

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `stratos-spaceread-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(dataDir, { recursive: true })
    const cfg = createTestConfig(dataDir)
    db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)

    enrollmentStore = new SqliteEnrollmentStore(db)
    actorStore = new StratosActorStore({
      dataDir,
      blobstore: () => createMockBlobStore(),
      cborToRecord: (content) => decode(content) as Record<string, unknown>,
    })

    const ctx = {
      cfg,
      actorStore,
      enrollmentStore,
      serviceDid: SERVICE_DID,
      authVerifier: { standardOrSpaceCredential: vi.fn() },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      },
    }
    // Capture the registered handler directly (method-level contract test).
    const methods = new Map<string, { handler: unknown }>()
    const server = {
      method: (name: string, cfgArg: { handler: unknown }) =>
        methods.set(name, cfgArg),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerSpaceReadHandlers(server as any, ctx as any)
    handler = methods.get('zone.stratos.space.getRecord')!.handler

    // Enrollments: member holds S; outsider holds only T.
    for (const [did, boundary] of [
      [memberDid, BOUNDARY_S.value],
      [outsiderDid, BOUNDARY_T.value],
    ] as const) {
      await enrollmentStore.enroll({
        did,
        enrolledAt: new Date().toISOString(),
        active: true,
        signingKeyDid: 'did:key:zTest',
      })
      await enrollmentStore.setBoundaries(did, [boundary])
    }

    await actorStore.create(repoDid)
    await seedRecord('inS', BOUNDARY_S.value)
    await seedRecord('inT', BOUNDARY_T.value)
    await seedRecord('domainless', null)
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  async function seedRecord(rkey: string, boundary: string | null) {
    const record: Record<string, unknown> = {
      $type: COLLECTION,
      text: 'hello',
    }
    if (boundary !== null) {
      record.boundary = {
        $type: 'zone.stratos.boundary.defs#Domains',
        values: [{ value: boundary }],
      }
    }
    const cid = parseCid((await computeCid(record)).toString())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await actorStore.transact(repoDid, async (store: any) => {
      await store.record.putRecord({
        uri: `at://${repoDid}/${COLLECTION}/${rkey}`,
        cid,
        value: record,
        content: encodeRecord(record),
      })
    })
  }

  function call(
    rkey: string,
    auth: { credentials: Record<string, unknown> },
    space: string = SPACE_S,
  ) {
    return handler({
      params: { space, repo: repoDid, collection: COLLECTION, rkey },
      auth,
      req: {},
      res: {},
    })
  }

  const userAuth = (did: string) => ({ credentials: { type: 'user', did } })
  const credAuth = (spaceUri: string) => ({
    credentials: { type: 'space-credential', spaceUri },
  })

  it('a member reads a record in the space (user auth)', async () => {
    const res = await call('inS', userAuth(memberDid))
    expect(res.body).toMatchObject({
      uri: `at://${repoDid}/${COLLECTION}/inS`,
    })
    expect(res.body.cid).toBeDefined()
    expect(res.body.value).toMatchObject({ text: 'hello' })
  })

  it('a space credential for S reads S-records', async () => {
    const res = await call('inS', credAuth(SPACE_S))
    expect(res.body.value).toMatchObject({ text: 'hello' })
  })

  it('a credential for a DIFFERENT space is refused (fail closed)', async () => {
    await expect(call('inS', credAuth(SPACE_T))).rejects.toThrow(/Not admitted/)
  })

  it('a non-member user is refused', async () => {
    await expect(call('inS', userAuth(outsiderDid))).rejects.toThrow(
      /Not admitted/,
    )
  })

  it('a record OUTSIDE the space resolves to RecordNotFound (no leak)', async () => {
    await expect(call('inT', userAuth(memberDid))).rejects.toThrow(
      /Record not found/,
    )
  })

  it('a DOMAINLESS record resolves to RecordNotFound (space reads fail closed)', async () => {
    await expect(call('domainless', userAuth(memberDid))).rejects.toThrow(
      /Record not found/,
    )
    await expect(call('domainless', credAuth(SPACE_S))).rejects.toThrow(
      /Record not found/,
    )
  })

  it('a missing record resolves to RecordNotFound', async () => {
    await expect(call('nope', userAuth(memberDid))).rejects.toThrow(
      /Record not found/,
    )
  })

  it('a foreign-DID space URI is rejected (UnknownSpace)', async () => {
    await expect(
      call(
        'inS',
        userAuth(memberDid),
        makeSpaceUri(
          'did:web:elsewhere.example',
          'zone.stratos.space.feed',
          'alpha',
        ),
      ),
    ).rejects.toThrow(/Unknown space/)
  })

  it('a malformed space URI is rejected (UnknownSpace)', async () => {
    await expect(
      call('inS', userAuth(memberDid), `ats://${SERVICE_DID}/alpha`),
    ).rejects.toThrow(/Unknown space/)
  })

  it('missing params are rejected', async () => {
    await expect(
      handler({ params: { space: SPACE_S }, auth: userAuth(memberDid) }),
    ).rejects.toThrow(/required/)
  })

  it('an anonymous caller is refused', async () => {
    await expect(
      call('inS', { credentials: {} as Record<string, unknown> }),
    ).rejects.toThrow(/Authentication required/)
  })

  it('revocation is honored on the next read (live membership)', async () => {
    await call('inS', userAuth(memberDid))
    await enrollmentStore.setBoundaries(memberDid, [])
    await expect(call('inS', userAuth(memberDid))).rejects.toThrow(
      /Not admitted/,
    )
  })
})
