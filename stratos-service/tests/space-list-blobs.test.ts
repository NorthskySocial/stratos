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
  let reiBlob: string
  let asukaBlob: string

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
    const capturedMethods = new Map<
      string,
      { type?: string; handler: unknown }
    >()
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
    reiBlob = await seedRecordWithBlob('rei', BOUNDARY_S.value, 'rei blob')
    asukaBlob = await seedRecordWithBlob(
      'asuka',
      BOUNDARY_S.value,
      'asuka blob',
    )
    blobsInS = [reiBlob, asukaBlob].sort()
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
    const blobCid = parseCid((await computeCid({ seed: blobSeed })).toString())
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
    // The wire error name must match the `AuthRequired` error the lexicon
    // declares, not the library default `AuthenticationRequired`.
    await expect(call({}, credAuth(SPACE_T))).rejects.toMatchObject({
      errorMessage: expect.stringMatching(/Not admitted/),
      customErrorName: 'AuthRequired',
    })
  })

  it('a non-member user is refused', async () => {
    await expect(call({}, userAuth(outsiderDid))).rejects.toMatchObject({
      errorMessage: expect.stringMatching(/Not admitted/),
      customErrorName: 'AuthRequired',
    })
  })

  it('an anonymous caller is refused', async () => {
    await expect(
      call({}, { credentials: {} as Record<string, unknown> }),
    ).rejects.toMatchObject({
      errorMessage: expect.stringMatching(/Authentication required/),
      customErrorName: 'AuthRequired',
    })
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

  it('clamps limit to the lexicon declared range 1..1000 (default 500)', async () => {
    // Params reach the handler without schema validation, so the clamp is the
    // only guard. A scripted store captures the limit the query receives.
    const seen: number[] = []
    const scriptedCtx = {
      serviceDid: SERVICE_DID,
      enrollmentStore,
      actorStore: {
        exists: async () => true,
        read: async (_did: string, fn: (store: unknown) => unknown) =>
          fn({
            blob: {
              listBlobsForBoundary: async (query: { limit: number }) => {
                seen.push(query.limit)
                return []
              },
            },
          }),
      },
      authVerifier: { standardOrSpaceCredential: vi.fn() },
      logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    }
    const captured = new Map<string, { handler: unknown }>()
    const scriptedServer = {
      method: (name: string, cfgArg: { handler: unknown }) =>
        captured.set(name, cfgArg),
    }
    registerSpaceReadHandlers(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scriptedServer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scriptedCtx as any,
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scripted: any = captured.get('zone.stratos.space.listBlobs')!.handler
    const invoke = (limit?: unknown) =>
      scripted({
        params: { space: SPACE_S, repo: repoDid, limit },
        auth: credAuth(SPACE_S),
        req: {},
        res: {},
      })

    await invoke(0)
    await invoke(5000)
    await invoke(undefined)
    // A raw query value arrives as a string; an integer string is accepted.
    await invoke('200')
    expect(seen).toEqual([1, 1000, 500, 200])
  })

  it('rejects a non-integer limit (InvalidRequest)', async () => {
    // '+5' and '5e2' would coerce via Number(); ['5'] via String(). All three
    // must fail the strict integer-string gate, not sneak through coercion.
    for (const bad of ['invalid', 2.5, '2.5', '', '+5', '5e2', ['5']]) {
      await expect(
        call({ limit: bad }, userAuth(memberDid)),
      ).rejects.toMatchObject({
        errorMessage: expect.stringMatching(/limit must be an integer/),
        customErrorName: 'InvalidRequest',
      })
    }
  })

  it("a moved record's blob leaves the old space (no stale residence)", async () => {
    const moved: Record<string, unknown> = {
      $type: COLLECTION,
      text: 'hello',
      boundary: {
        $type: 'zone.stratos.boundary.defs#Domains',
        values: [{ value: BOUNDARY_T.value }],
      },
    }
    const movedCid = parseCid((await computeCid(moved)).toString())
    const uri = `at://${repoDid}/${COLLECTION}/rei`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await actorStore.transact(repoDid, async (store: any) => {
      await store.record.indexRecord(uri, movedCid, moved, 'update', '')
    })

    const res = await call({}, userAuth(memberDid))
    expect(res.body.cids).toEqual([asukaBlob])
    expect(res.body.cids).not.toContain(reiBlob)
  })

  it("a deleted record's blob leaves the space (no stale residence)", async () => {
    const uri = `at://${repoDid}/${COLLECTION}/rei`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await actorStore.transact(repoDid, async (store: any) => {
      await store.record.deleteRecord(uri)
      await store.blob.removeRecordBlobAssociations(uri)
    })

    const res = await call({}, userAuth(memberDid))
    expect(res.body.cids).toEqual([asukaBlob])
    expect(res.body.cids).not.toContain(reiBlob)
  })
})
