import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { CID, Cid } from '@atproto/lex-data'
import { sha256 } from 'multiformats/hashes/sha2'
import { AtUri } from '@atproto/syntax'

import {
  closeStratosDb,
  createStratosDb,
  migrateStratosDb,
  stratosBacklink,
  StratosDb,
  stratosRecord,
  stratosRecordBoundary,
  StratosRecordTransactor,
} from '../src/index.js'

const decodeRecord = (content: Uint8Array): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(content)) as Record<string, unknown>

const createCid = async (data: unknown): Promise<Cid> => {
  const bytes = new TextEncoder().encode(JSON.stringify(data))
  const hash = await sha256.digest(bytes)
  return CID.createV1(0x55, hash)
}

const ENGINEERING = 'did:web:nerv.tokyo.jp/engineering'
const REI = 'did:plc:rei-ayanami'
const KAWORU = 'did:plc:kaworu-nagisa'

type Index = (
  transactor: StratosRecordTransactor,
  uri: AtUri,
  record: Record<string, unknown>,
  action: 'create' | 'update',
  rev: string,
) => Promise<void>

const indexFromBody: Index = async (transactor, uri, record, action, rev) =>
  transactor.indexRecord(uri, await createCid(record), record, action, rev)

const indexInBoundary: Index = async (transactor, uri, record, action, rev) =>
  transactor.indexRecordInBoundary(
    uri,
    await createCid(record),
    record,
    ENGINEERING,
    action,
    rev,
  )

const follow = (subject: string) => ({
  $type: 'zone.stratos.graph.follow',
  subject,
  boundary: {
    $type: 'zone.stratos.boundary.defs#Domains',
    values: [{ value: ENGINEERING }],
  },
})

describe('record indexing backlinks and boundaries', () => {
  let db: StratosDb
  let transactor: StratosRecordTransactor
  let testDir: string

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `stratos-index-backlinks-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(testDir, { recursive: true })
    db = createStratosDb(join(testDir, 'test.db'))
    await migrateStratosDb(db)
    transactor = new StratosRecordTransactor(db, decodeRecord)
  })

  afterEach(async () => {
    await closeStratosDb(db)
    await rm(testDir, { recursive: true, force: true })
  })

  describe.each([
    ['indexRecord', indexFromBody],
    ['indexRecordInBoundary', indexInBoundary],
  ] as Array<[string, Index]>)('%s', (_name, index) => {
    it('keeps only the backlink of the updated subject', async () => {
      const uri = new AtUri('at://did:plc:misato/zone.stratos.graph.follow/rei')

      await index(transactor, uri, follow(REI), 'create', 'rev1')
      await index(transactor, uri, follow(KAWORU), 'update', 'rev2')

      expect(await db.select().from(stratosBacklink)).toEqual([
        { uri: uri.toString(), path: 'subject', linkTo: KAWORU },
      ])
    })
  })

  it('indexRecord with a null record updates the row and leaves backlinks and boundary rows untouched', async () => {
    const uri = new AtUri('at://did:plc:misato/zone.stratos.graph.follow/asuka')
    const record = follow(REI)
    await transactor.indexRecord(
      uri,
      await createCid(record),
      record,
      'create',
      'rev1',
    )
    const backlinksBefore = await db.select().from(stratosBacklink)
    const boundariesBefore = await db.select().from(stratosRecordBoundary)
    expect(backlinksBefore).toHaveLength(1)
    expect(boundariesBefore).toHaveLength(1)

    await expect(
      transactor.indexRecord(
        uri,
        await createCid(null),
        null,
        'update',
        'rev2',
      ),
    ).resolves.toBeUndefined()

    expect(await db.select().from(stratosBacklink)).toEqual(backlinksBefore)
    expect(await db.select().from(stratosRecordBoundary)).toEqual(
      boundariesBefore,
    )
    const rows = await db.select().from(stratosRecord)
    expect(rows).toHaveLength(1)
    expect(rows[0].repoRev).toBe('rev2')
  })
})
