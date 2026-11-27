/**
 * Every read site that serves a record together with its boundary rows asks
 * the store once, in chunks of at most 100 for a page, and never pairs a
 * record read with a separate boundary read.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { Cid } from '@atproto/lex-data'
import {
  boundaryToSpaceUri,
  encodeRecord,
  MAX_VISIBLE_RECORD_BATCH,
} from '@northskysocial/stratos-core'

import type { ActorStore } from '../src/actor-store-types.js'
import { getRecord, listRecords } from '../src/api/records/index.js'
import { resolveParentBoundaries } from '../src/api/records/validation.js'
import { ActorStoreRecordResolver } from '../src/features/hydration/adapter.js'
import { listRecordPaths } from '../src/features/pull-sync/recovery.js'
import { HOSTED_SPACE_TYPE } from '../src/shared/space-type-registry.js'
import { createCid } from './helpers/test-env.js'
import {
  asMember,
  HARNESS_ENGINEERING,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'
import { createEmptyLabelLog } from './utils/index.js'

const COLLECTION = 'zone.stratos.feed.post'
const OWNER_DID = 'did:plc:misato-katsuragi'
const MEMBER_DID = 'did:plc:ritsuko-akagi'

const uriOf = (rkey: string) => `at://${OWNER_DID}/${COLLECTION}/${rkey}`

const bodyOf = (text: string) => ({
  $type: COLLECTION,
  text,
  createdAt: new Date().toISOString(),
})

interface RecordedCall {
  method: string
  uriCount: number
}

describe('visible record reads', () => {
  let harness: WriteHarness
  let actorStore: ActorStore

  beforeAll(async () => {
    harness = await startSqliteWriteHarness()
    actorStore = harness.ctx.actorStore
    await harness.enrollBoundaryHolder(MEMBER_DID, [HARNESS_ENGINEERING])
  }, 120_000)

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await actorStore.create(OWNER_DID)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await actorStore.destroy(OWNER_DID)
  })

  async function seedMany(rkeys: string[]) {
    await actorStore.transact(OWNER_DID, async (store) => {
      for (const rkey of rkeys) {
        const body = bodyOf(`sync ratio ${rkey}`)
        const content = encodeRecord(body)
        const cid = await createCid(content)
        await store.record.putRecord({
          uri: uriOf(rkey),
          cid,
          value: body,
          content,
        })
        await store.record.indexRecordInBoundary(
          uriOf(rkey),
          cid,
          body,
          HARNESS_ENGINEERING,
          'update',
          'rev-seed',
        )
      }
    })
  }

  const rkeysOf = (count: number) =>
    Array.from({ length: count }, (_, index) => `eva-${index}`)

  async function storeCallsDuring(
    run: () => Promise<unknown>,
  ): Promise<RecordedCall[]> {
    const calls: RecordedCall[] = []
    const realRead = actorStore.read.bind(actorStore)
    vi.spyOn(actorStore, 'read').mockImplementation((did, fn) =>
      realRead(did, (store) => {
        const reader = store.record
        const forward = <Args extends unknown[], Result>(
          method: string,
          uriCount: (...args: Args) => number,
        ) => {
          const original = (
            reader as unknown as Record<string, (...args: Args) => Result>
          )[method].bind(reader)
          vi.spyOn(
            reader as unknown as Record<string, (...args: Args) => Result>,
            method,
          ).mockImplementation((...args: Args) => {
            calls.push({ method, uriCount: uriCount(...args) })
            return original(...args)
          })
        }
        forward('getRecord', () => 1)
        forward('getRecordBoundaries', () => 1)
        forward('getVisibleRecordWithBoundaries', () => 1)
        forward(
          'getVisibleRecordsWithBoundaries',
          (uris: readonly unknown[]) => uris.length,
        )
        return fn(store)
      }),
    )
    await run()
    return calls
  }

  const combinedReadSizes = (calls: RecordedCall[]) =>
    calls
      .filter((call) => call.method === 'getVisibleRecordsWithBoundaries')
      .map((call) => call.uriCount)

  const methodsOf = (calls: RecordedCall[]) => calls.map((call) => call.method)

  const pageSizes: Array<[number, number[]]> = [
    [MAX_VISIBLE_RECORD_BATCH, [100]],
    [MAX_VISIBLE_RECORD_BATCH + 1, [100, 1]],
    [250, [100, 100, 50]],
  ]

  describe.each(pageSizes)('a page of %i records', (count, expectedChunks) => {
    beforeEach(async () => {
      await seedMany(rkeysOf(count))
    })

    it('listRecords reads the page in chunks, with no per-record boundary read', async () => {
      let listed = 0
      const calls = await storeCallsDuring(async () => {
        const result = await listRecords(
          harness.ctx,
          { repo: OWNER_DID, collection: COLLECTION, limit: count },
          OWNER_DID,
          [],
        )
        listed = result.records.length
      })

      expect(listed).toBe(count)
      expect(combinedReadSizes(calls)).toEqual(expectedChunks)
      expect(methodsOf(calls)).not.toContain('getRecordBoundaries')
      expect(methodsOf(calls)).not.toContain('getRecord')
    })

    it('listRecordPaths reads the page in chunks, with no per-record boundary read', async () => {
      let listed = 0
      const calls = await storeCallsDuring(async () => {
        const result = await listRecordPaths(
          harness.ctx,
          {
            did: OWNER_DID,
            collection: COLLECTION,
            limit: count,
            excludeValues: false,
          },
          new Set([HARNESS_ENGINEERING]),
        )
        listed = result.records.length
      })

      expect(listed).toBe(count)
      expect(combinedReadSizes(calls)).toEqual(expectedChunks)
      expect(methodsOf(calls)).not.toContain('getRecordBoundaries')
      expect(methodsOf(calls)).not.toContain('getRecord')
    })

    it('the hydration batch read chunks its uris, with no per-record boundary read', async () => {
      const resolver = new ActorStoreRecordResolver(
        actorStore,
        createEmptyLabelLog(),
      )
      let resolved = 0
      const calls = await storeCallsDuring(async () => {
        const found = await resolver.getRecords(
          OWNER_DID,
          rkeysOf(count).map(uriOf),
        )
        resolved = found.size
      })

      expect(resolved).toBe(count)
      expect(combinedReadSizes(calls)).toEqual(expectedChunks)
      expect(methodsOf(calls)).not.toContain('getRecordBoundaries')
      expect(methodsOf(calls)).not.toContain('getRecord')
    })
  })

  describe('one record', () => {
    let blob: Cid

    beforeEach(async () => {
      await seedMany(['rei'])
      const bytes = new TextEncoder().encode('blob entry plug')
      blob = await createCid(bytes)
      await actorStore.transact(OWNER_DID, async (store) => {
        await store.blob.trackBlob({
          cid: blob,
          mimeType: 'image/png',
          size: bytes.length,
        })
        await store.blob.associateBlobWithRecord(blob, uriOf('rei'))
      })
    })

    const expectOneCombinedRead = (calls: RecordedCall[]) => {
      expect(methodsOf(calls)).toEqual(['getVisibleRecordWithBoundaries'])
    }

    it('getRecord', async () => {
      const calls = await storeCallsDuring(() =>
        getRecord(
          harness.ctx,
          { repo: OWNER_DID, collection: COLLECTION, rkey: 'rei' },
          OWNER_DID,
          [],
        ),
      )

      expectOneCombinedRead(calls)
    })

    it('the hydration single read', async () => {
      const resolver = new ActorStoreRecordResolver(
        actorStore,
        createEmptyLabelLog(),
      )

      const calls = await storeCallsDuring(() =>
        resolver.getRecord(OWNER_DID, uriOf('rei')),
      )

      expectOneCombinedRead(calls)
    })

    it('the space record read', async () => {
      const space = boundaryToSpaceUri(HARNESS_ENGINEERING, HOSTED_SPACE_TYPE)
      if (!space.ok) throw new Error(space.error.message)

      let status = 0
      const calls = await storeCallsDuring(async () => {
        const result = await harness.query(
          'zone.stratos.space.getRecord',
          asMember(MEMBER_DID),
          {
            space: space.value,
            repo: OWNER_DID,
            collection: COLLECTION,
            rkey: 'rei',
          },
        )
        status = result.status
      })

      expect(status).toBe(200)
      expectOneCombinedRead(calls)
    })

    it('canAccessBlob', async () => {
      let allowed = false
      const calls = await storeCallsDuring(async () => {
        allowed = await harness.ctx.blobAuth.canAccessBlob(
          MEMBER_DID,
          OWNER_DID,
          blob,
        )
      })

      expect(allowed).toBe(true)
      expectOneCombinedRead(calls)
    })

    it('canAccessBlobs', async () => {
      let allowed: boolean | undefined
      const calls = await storeCallsDuring(async () => {
        const results = await harness.ctx.blobAuth.canAccessBlobs(
          MEMBER_DID,
          OWNER_DID,
          [blob],
        )
        allowed = results.get(blob.toString())
      })

      expect(allowed).toBe(true)
      expectOneCombinedRead(calls)
    })

    it('the reply parent lookup', async () => {
      let boundaries: string[] | undefined
      const calls = await storeCallsDuring(async () => {
        boundaries = await resolveParentBoundaries(harness.ctx, {
          reply: { parent: { uri: uriOf('rei') } },
        })
      })

      expect(boundaries).toEqual([HARNESS_ENGINEERING])
      expectOneCombinedRead(calls)
    })
  })
  describe('a record pinned by cid', () => {
    const PILOT_DID = 'did:plc:shinji-ikari'
    const pilotUri = (rkey: string) => `at://${PILOT_DID}/${COLLECTION}/${rkey}`

    beforeAll(async () => {
      await harness.enrollMember(PILOT_DID, [HARNESS_ENGINEERING])
    })

    async function put(rkey: string, text: string): Promise<string> {
      const result = await harness.call(
        'zone.stratos.repo.putRecord',
        asMember(PILOT_DID),
        {
          boundary: HARNESS_ENGINEERING,
          repo: PILOT_DID,
          collection: COLLECTION,
          rkey,
          record: bodyOf(text),
        },
      )
      expect(result.status).toBe(200)
      const rows = await harness.recordRows(pilotUri(rkey))
      return String(rows.record?.cid)
    }

    const readDirect = (rkey: string, cid?: string) =>
      getRecord(
        harness.ctx,
        { repo: PILOT_DID, collection: COLLECTION, rkey, cid },
        PILOT_DID,
        [HARNESS_ENGINEERING],
      )

    const readOverHttp = (rkey: string, cid?: string) =>
      harness.query('com.atproto.repo.getRecord', asMember(PILOT_DID), {
        repo: PILOT_DID,
        collection: COLLECTION,
        rkey,
        ...(cid ? { cid } : {}),
      })

    const notFoundName = async (read: Promise<unknown>) => {
      const error = await read.then(
        () => undefined,
        (thrown: unknown) => thrown,
      )
      return (error as { customErrorName?: string } | undefined)
        ?.customErrorName
    }

    it('returns the record when the pin is its current cid', async () => {
      const cid = await put('unit-01', 'berserk')

      const direct = await readDirect('unit-01', cid)
      const http = await readOverHttp('unit-01', cid)

      expect(direct.cid).toBe(cid)
      expect(http.status).toBe(200)
      expect((http.body as { cid: string }).cid).toBe(cid)
    })

    it('returns the record when no cid is given', async () => {
      const cid = await put('unit-02', 'pattern blue')

      const direct = await readDirect('unit-02')
      const http = await readOverHttp('unit-02')

      expect(direct.cid).toBe(cid)
      expect(http.status).toBe(200)
      expect((http.body as { cid: string }).cid).toBe(cid)
    })

    it('reads a different well-formed cid as not found, like a missing record', async () => {
      await put('unit-03', 'angel')
      const otherCid = await put('unit-04', 'another angel')

      const missing = await readOverHttp('unit-missing')
      const pinned = await readOverHttp('unit-03', otherCid)

      expect(missing.status).toBe(400)
      expect(pinned.status).toBe(missing.status)
      expect(pinned.body).toEqual(missing.body)
      expect((pinned.body as { error: string }).error).toBe('RecordNotFound')
      expect(await notFoundName(readDirect('unit-missing'))).toBe(
        'RecordNotFound',
      )
      expect(await notFoundName(readDirect('unit-03', otherCid))).toBe(
        'RecordNotFound',
      )
    })

    it('finds an updated record by its new cid and no longer by the old one', async () => {
      const oldCid = await put('unit-05', 'first sortie')
      const newCid = await put('unit-05', 'second sortie')
      expect(newCid).not.toBe(oldCid)

      expect(await notFoundName(readDirect('unit-05', oldCid))).toBe(
        'RecordNotFound',
      )
      expect((await readDirect('unit-05', newCid)).cid).toBe(newCid)
      expect((await readOverHttp('unit-05', oldCid)).status).toBe(400)
      const current = await readOverHttp('unit-05', newCid)
      expect(current.status).toBe(200)
      expect((current.body as { cid: string }).cid).toBe(newCid)
    })

    it('listRecords skips a record hidden between the listing and the read', async () => {
      await put('unit-06', 'stays')
      await put('unit-07', 'hidden mid-list')

      const realRead = harness.ctx.actorStore.read.bind(harness.ctx.actorStore)
      vi.spyOn(harness.ctx.actorStore, 'read').mockImplementation((did, fn) =>
        realRead(did, (store) => {
          const reader = store.record
          const listing = reader.listRecordsForCollection.bind(reader)
          vi.spyOn(reader, 'listRecordsForCollection').mockImplementation(
            async (...args) => {
              const listed = await listing(...args)
              const hide = await harness.call(
                'zone.stratos.repo.deleteRecord',
                asMember(PILOT_DID),
                {
                  boundary: HARNESS_ENGINEERING,
                  repo: PILOT_DID,
                  collection: COLLECTION,
                  rkey: 'unit-07',
                },
              )
              expect(hide.status).toBe(200)
              return listed
            },
          )
          return fn(store)
        }),
      )

      const result = await listRecords(
        harness.ctx,
        { repo: PILOT_DID, collection: COLLECTION, limit: 100 },
        PILOT_DID,
        [HARNESS_ENGINEERING],
      )

      const uris = result.records.map((record) => record.uri)
      expect(uris).toContain(pilotUri('unit-06'))
      expect(uris).not.toContain(pilotUri('unit-07'))
    })
  })
})
