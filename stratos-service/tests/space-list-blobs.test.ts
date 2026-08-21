/**
 * Contract tests for `zone.stratos.space.listBlobs` — the spec-shaped mirror
 * of `com.atproto.space.listBlobs` (atproto#5187).
 *
 * Contract under test (from the quoted reference lexicon):
 *   - callable with standard user auth (member of the space) OR a space
 *     credential for that space;
 *   - only blobs referenced by records carrying the space's boundary are
 *     enumerated;
 *   - a credential admits exactly its own space (fail closed);
 *   - malformed / foreign space URIs → UnknownSpace;
 *   - a missing repo → RepoNotFound;
 *   - a full page yields a cursor, a partial page does not.
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

describe('zone.stratos.space.listBlobs', () => {
  let dataDir: string
  let actorStore: StratosActorStore
  let enrollmentStore: SqliteEnrollmentStore
  let db: ServiceDb
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handler: any
  let methods: Map<string, { type?: string; handler: unknown }>
  let blobsInS: string[]
  let blobInT: string

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `stratos-spaceblobs-${randomBytes(8).toString('hex')}`,
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
    const capturedMethods = new Map<string, { type?: string; handler: unknown }>()
    const server = {
      method: (name: string, cfgArg: { type?: string; handler: unknown }) =>
        capturedMethods.set(name, cfgArg),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerSpaceReadHandlers(server as any, ctx as any)
    methods = capturedMethods
    handler = capturedMethods.get('zone.stratos.space.listBlobs')!.handler

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
    blobsInS = [
      await seedRecordWithBlob('rei', BOUNDARY_S.value, 'rei blob'),
      await seedRecordWithBlob('asuka', BOUNDARY_S.value, 'asuka blob'),
    ].sort()
    blobInT = await seedRecordWithBlob('gendo', BOUNDARY_T.value, 'gendo blob')
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  async function seedRecordWithBlob(
    rkey: string,
    boundary: string,
    blobSeed: string,
  ): Promise<string> {
    const record: Record<string, unknown> = {
      $type: COLLECTION,
      text: 'hello',
      boundary: {
        $type: 'zone.stratos.boundary.defs#Domains',
        values: [{ value: boundary }],
      },
    }
    const recordCid = parseCid((await computeCid(record)).toString())
    const blobBytes = new TextEncoder().encode(blobSeed)
    const blobCid = parseCid(
      (await computeCid({ seed: blobSeed })).toString(),
    )
    const uri = `at://${repoDid}/${COLLECTION}/${rkey}`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await actorStore.transact(repoDid, async (store: any) => {
      await store.record.putRecord({
        uri,
        cid: recordCid,
        value: record,
        content: encodeRecord(record),
      })
      await store.blob.trackBlob({
        cid: blobCid,
        mimeType: 'image/png',
        size: blobBytes.length,
      })
      await store.blob.associateBlobWithRecord(blobCid, uri)
      await store.blob.associateBlobWithBoundary(blobCid, boundary)
    })
    return blobCid.toString()
  }

  function call(
    params: Record<string, unknown>,
    auth: { credentials: Record<string, unknown> },
  ) {
    return handler({
      params: { space: SPACE_S, repo: repoDid, ...params },
      auth,
      req: {},
      res: {},
    })
  }

  const userAuth = (did: string) => ({ credentials: { type: 'user', did } })
  const credAuth = (spaceUri: string) => ({
    credentials: { type: 'space-credential', spaceUri },
  })

  it('a member lists only the blobs behind the space (user auth)', async () => {
    const res = await call({}, userAuth(memberDid))
    expect(res.body.cids).toEqual(blobsInS)
    expect(res.body.cids).not.toContain(blobInT)
    expect(res.body.cursor).toBeUndefined()
  })

  it('a space credential for S lists S-blobs', async () => {
    const res = await call({}, credAuth(SPACE_S))
    expect(res.body.cids).toEqual(blobsInS)
  })

  it('a credential for a DIFFERENT space is refused (fail closed)', async () => {
    await expect(call({}, credAuth(SPACE_T))).rejects.toThrow(/Not admitted/)
  })

  it('a non-member user is refused', async () => {
    await expect(call({}, userAuth(outsiderDid))).rejects.toThrow(
      /Not admitted/,
    )
  })

  it('an anonymous caller is refused', async () => {
    await expect(
      call({}, { credentials: {} as Record<string, unknown> }),
    ).rejects.toThrow(/Authentication required/)
  })

  it('registers as a query method', () => {
    expect(methods.get('zone.stratos.space.listBlobs')!.type).toBe('query')
  })

  it('a foreign-DID space URI is rejected (UnknownSpace)', async () => {
    await expect(
      call(
        {
          space: makeSpaceUri(
            'did:web:elsewhere.example',
            'zone.stratos.space.feed',
            'alpha',
          ),
        },
        userAuth(memberDid),
      ),
    ).rejects.toMatchObject({
      errorMessage: expect.stringMatching(/Unknown space/),
      customErrorName: 'UnknownSpace',
    })
  })

  it('a malformed space URI is rejected (UnknownSpace)', async () => {
    await expect(
      call({ space: `ats://${SERVICE_DID}/alpha` }, userAuth(memberDid)),
    ).rejects.toMatchObject({
      errorMessage: expect.stringMatching(/Unknown space/),
      customErrorName: 'UnknownSpace',
    })
  })

  it('missing params are rejected', async () => {
    await expect(
      handler({ params: { space: SPACE_S }, auth: userAuth(memberDid) }),
    ).rejects.toMatchObject({
      errorMessage: expect.stringMatching(/required/),
      customErrorName: 'InvalidRequest',
    })
  })

  it('an unknown repo resolves to RepoNotFound', async () => {
    await expect(
      call({ repo: 'did:plc:pen-pen' }, userAuth(memberDid)),
    ).rejects.toMatchObject({
      errorMessage: expect.stringMatching(/Could not find repo/),
      customErrorName: 'RepoNotFound',
    })
  })

  it('a full page yields a cursor, the next page drains', async () => {
    const firstPage = await call({ limit: 1 }, userAuth(memberDid))
    expect(firstPage.body.cids).toEqual(blobsInS.slice(0, 1))
    expect(firstPage.body.cursor).toBe(blobsInS[0])

    const secondPage = await call(
      { limit: 10, cursor: firstPage.body.cursor },
      userAuth(memberDid),
    )
    expect(secondPage.body.cids).toEqual(blobsInS.slice(1))
    expect(secondPage.body.cursor).toBeUndefined()
  })

  it('revocation is honored on the next call (live membership)', async () => {
    await call({}, userAuth(memberDid))
    await enrollmentStore.setBoundaries(memberDid, [])
    await expect(call({}, userAuth(memberDid))).rejects.toThrow(/Not admitted/)
  })
})
