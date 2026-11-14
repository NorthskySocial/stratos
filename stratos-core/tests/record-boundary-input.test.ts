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
const LEADERSHIP = 'did:web:nerv.tokyo.jp/leadership'
const PILOT = 'did:web:nerv.tokyo.jp/pilot'

describe('indexRecordInBoundary', () => {
  let db: StratosDb
  let transactor: StratosRecordTransactor
  let testDir: string

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `stratos-boundary-input-${randomBytes(8).toString('hex')}`,
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

  const boundaryRows = () =>
    db
      .select()
      .from(stratosRecordBoundary)
      .orderBy(stratosRecordBoundary.boundary)

  const boundaryBody = (text: string, ...boundaries: string[]) => ({
    $type: 'zone.stratos.feed.post',
    text,
    boundary: {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: boundaries.map((value) => ({ value })),
    },
  })

  it('writes exactly one row for the given boundary when the body has none', async () => {
    const uri = new AtUri('at://did:plc:misato/zone.stratos.feed.post/rei')
    const record = { $type: 'zone.stratos.feed.post', text: 'Unit-00' }

    await transactor.indexRecordInBoundary(
      uri,
      await createCid(record),
      record,
      ENGINEERING,
      'create',
      'rev1',
    )

    expect(await boundaryRows()).toEqual([
      { recordUri: uri.toString(), boundary: ENGINEERING },
    ])
  })

  it('writes only the given boundary when the body names a different one', async () => {
    const uri = new AtUri('at://did:plc:misato/zone.stratos.feed.post/asuka')
    const record = boundaryBody('Unit-02', LEADERSHIP, PILOT)

    await transactor.indexRecordInBoundary(
      uri,
      await createCid(record),
      record,
      ENGINEERING,
      'create',
      'rev1',
    )

    expect(await boundaryRows()).toEqual([
      { recordUri: uri.toString(), boundary: ENGINEERING },
    ])
  })

  it('replaces the boundary rows on update', async () => {
    const uri = new AtUri('at://did:plc:misato/zone.stratos.feed.post/kaworu')
    const record = boundaryBody('Unit-03', LEADERSHIP)

    await transactor.indexRecordInBoundary(
      uri,
      await createCid(record),
      record,
      ENGINEERING,
      'create',
      'rev1',
    )
    const edited = boundaryBody('Unit-03 edited', LEADERSHIP)
    await transactor.indexRecordInBoundary(
      uri,
      await createCid(edited),
      edited,
      PILOT,
      'update',
      'rev2',
    )

    expect(await boundaryRows()).toEqual([
      { recordUri: uri.toString(), boundary: PILOT },
    ])
  })

  it('still writes backlinks from the record body', async () => {
    const uri = new AtUri('at://did:plc:misato/zone.stratos.feed.post/gendo')
    const record = {
      $type: 'zone.stratos.graph.follow',
      subject: 'did:plc:rei-ayanami',
    }

    await transactor.indexRecordInBoundary(
      uri,
      await createCid(record),
      record,
      ENGINEERING,
      'create',
      'rev1',
    )

    const backlinks = await db.select().from(stratosBacklink)
    expect(backlinks).toEqual([
      {
        uri: uri.toString(),
        path: 'subject',
        linkTo: 'did:plc:rei-ayanami',
      },
    ])
  })
})
