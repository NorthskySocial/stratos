import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import type { Cid } from '@atproto/lex-data'
import {
  encodeRecord,
  type BlobAuthService,
} from '@northskysocial/stratos-core'

import type { ActorStore } from '../src/actor-store-types.js'
import {
  createCid,
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'
import {
  startPostgresWriteHarness,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'

const SERVICE_DID = 'did:web:nerv.tokyo.jp'
const ENGINEERING = `${SERVICE_DID}/engineering`
const DESIGN = `${SERVICE_DID}/design`
const LEADERSHIP = `${SERVICE_DID}/leadership`
const COLLECTION = 'zone.stratos.feed.post'
const OWNER_DID = 'did:plc:misato-katsuragi'
const ENGINEERING_VIEWER_DID = 'did:plc:ritsuko-akagi'
const DESIGN_VIEWER_DID = 'did:plc:shigeru-aoba'
const LEADERSHIP_VIEWER_DID = 'did:plc:gendo-ikari'

const VIEWER_BOUNDARIES: Record<string, string[]> = {
  [ENGINEERING_VIEWER_DID]: [ENGINEERING],
  [DESIGN_VIEWER_DID]: [DESIGN],
  [LEADERSHIP_VIEWER_DID]: [LEADERSHIP],
}

function uriOf(rkey: string) {
  return `at://${OWNER_DID}/${COLLECTION}/${rkey}`
}

function bodyClaiming(text: string, boundaries: string[]) {
  const body: Record<string, unknown> = {
    $type: COLLECTION,
    text,
    createdAt: new Date().toISOString(),
  }
  if (boundaries.length > 0) {
    body.boundary = {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: boundaries.map((value) => ({ value })),
    }
  }
  return body
}

interface StoreHarness {
  write: WriteHarness
  cleanup: () => Promise<void>
}

function describeBlobAccessFromBoundaryRows(
  label: string,
  openStore: () => Promise<StoreHarness>,
) {
  describe(label, () => {
    let harness: StoreHarness
    let actorStore: ActorStore
    let service: BlobAuthService

    beforeAll(async () => {
      harness = await openStore()
      actorStore = harness.write.ctx.actorStore
      service = harness.write.ctx.blobAuth
      for (const [viewerDid, boundaries] of Object.entries(VIEWER_BOUNDARIES)) {
        await harness.write.enrollBoundaryHolder(viewerDid, boundaries)
      }
    }, 120_000)

    afterAll(async () => {
      await harness.cleanup()
    })

    beforeEach(async () => {
      await actorStore.create(OWNER_DID)
    })

    afterEach(async () => {
      await actorStore.destroy(OWNER_DID)
    })

    async function seedBlob(name: string): Promise<Cid> {
      const bytes = new TextEncoder().encode(`blob ${name}`)
      const cid = await createCid(bytes)
      await actorStore.transact(OWNER_DID, async (store) => {
        await store.blob.trackBlob({
          cid,
          mimeType: 'image/png',
          size: bytes.length,
        })
      })
      return cid
    }

    async function seedRecord(
      rkey: string,
      body: Record<string, unknown>,
      rowBoundary: string | null,
      blob: Cid,
    ) {
      const content = encodeRecord(body)
      const cid = await createCid(content)
      await actorStore.transact(OWNER_DID, async (store) => {
        await store.record.putRecord({
          uri: uriOf(rkey),
          cid,
          value: body,
          content,
        })
        if (rowBoundary !== null) {
          await store.record.indexRecordInBoundary(
            uriOf(rkey),
            cid,
            body,
            rowBoundary,
            'update',
            'rev-seed',
          )
        }
        await store.blob.associateBlobWithRecord(blob, uriOf(rkey))
      })
    }

    async function takeDown(rkey: string) {
      await actorStore.transact(OWNER_DID, async (store) => {
        await store.record.updateRecordTakedown(uriOf(rkey), {
          applied: true,
          ref: `case-${rkey}`,
        })
      })
    }

    async function canAccessSingle(viewerDid: string, blob: Cid) {
      return service.canAccessBlob(viewerDid, OWNER_DID, blob)
    }

    async function canAccessBatch(viewerDid: string, blob: Cid) {
      const results = await service.canAccessBlobs(viewerDid, OWNER_DID, [blob])
      return results.get(blob.toString())
    }

    const accessPaths = [
      ['canAccessBlob', canAccessSingle],
      ['canAccessBlobs', canAccessBatch],
    ] as const

    describe.each(accessPaths)('%s', (_name, canAccess) => {
      it('grants a viewer in the row boundary when the body has none', async () => {
        const blob = await seedBlob('sachiel')
        await seedRecord(
          'angel',
          bodyClaiming('Sachiel', []),
          ENGINEERING,
          blob,
        )
        expect(await canAccess(ENGINEERING_VIEWER_DID, blob)).toBe(true)
      })

      it('refuses a viewer outside the row boundary when the body has none', async () => {
        const blob = await seedBlob('sachiel')
        await seedRecord(
          'angel',
          bodyClaiming('Sachiel', []),
          ENGINEERING,
          blob,
        )
        expect(await canAccess(DESIGN_VIEWER_DID, blob)).toBe(false)
      })

      it('follows the row when the body claims another boundary', async () => {
        const blob = await seedBlob('zeruel')
        await seedRecord(
          'shito',
          bodyClaiming('Zeruel', [LEADERSHIP]),
          ENGINEERING,
          blob,
        )
        expect(await canAccess(ENGINEERING_VIEWER_DID, blob)).toBe(true)
        expect(await canAccess(LEADERSHIP_VIEWER_DID, blob)).toBe(false)
      })

      it('refuses every non-owner when the record has no row and no body boundary', async () => {
        const blob = await seedBlob('adam')
        await seedRecord('lilith', bodyClaiming('Adam', []), null, blob)
        expect(await canAccess(ENGINEERING_VIEWER_DID, blob)).toBe(false)
        expect(await canAccess(DESIGN_VIEWER_DID, blob)).toBe(false)
      })

      it('refuses a viewer in the row boundary when the record is taken down', async () => {
        const blob = await seedBlob('leliel')
        await seedRecord(
          'leliel',
          bodyClaiming('Leliel', []),
          ENGINEERING,
          blob,
        )
        await takeDown('leliel')
        expect(await canAccess(ENGINEERING_VIEWER_DID, blob)).toBe(false)
      })

      it('grants through the live record and refuses through the taken-down one', async () => {
        const blob = await seedBlob('shared')
        await seedRecord('live', bodyClaiming('Ramiel', []), ENGINEERING, blob)
        await seedRecord('gone', bodyClaiming('Bardiel', []), DESIGN, blob)
        await takeDown('gone')
        expect(await canAccess(ENGINEERING_VIEWER_DID, blob)).toBe(true)
        expect(await canAccess(DESIGN_VIEWER_DID, blob)).toBe(false)
      })
    })
  })
}

describeBlobAccessFromBoundaryRows('SQLite store', async () => {
  const write = await startSqliteWriteHarness()
  return { write, cleanup: () => write.close() }
})

describeBlobAccessFromBoundaryRows('runtime Postgres store', async () => {
  const write = await startPostgresWriteHarness(await startPostgresContainer())
  return {
    write,
    cleanup: async () => {
      await write.close()
      await stopPostgresContainer()
    },
  }
})
