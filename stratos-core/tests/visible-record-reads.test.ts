import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { CID, Cid } from '@atproto/lex-data'
import { sha256 } from 'multiformats/hashes/sha2'
import { AtUri } from '@atproto/syntax'

import {
  closeStratosDb,
  createStratosDb,
  MAX_VISIBLE_RECORD_BATCH,
  migrateStratosDb,
  StratosDb,
  StratosRecordReader,
  StratosRecordTransactor,
} from '../src/index.js'

const encodeRecord = (data: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(data))

const decodeRecord = (content: Uint8Array): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(content)) as Record<string, unknown>

const createCid = async (data: unknown): Promise<Cid> =>
  CID.createV1(0x55, await sha256.digest(encodeRecord(data)))

describe('visible record reads', () => {
  let db: StratosDb
  let reader: StratosRecordReader
  let transactor: StratosRecordTransactor
  let testDir: string

  const ENGINEERING = 'did:web:nerv.tokyo.jp/engineering'
  const LEADERSHIP = 'did:web:nerv.tokyo.jp/leadership'
  const OPERATIONS = 'did:web:nerv.tokyo.jp/operations'

  const uriOf = (rkey: string) =>
    new AtUri(`at://did:plc:misato/zone.stratos.feed.post/${rkey}`)

  const bodyClaiming = (text: string, ...boundaries: string[]) => ({
    $type: 'zone.stratos.feed.post',
    text,
    boundary: {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: boundaries.map((value) => ({ value })),
    },
  })

  const seed = async (
    rkey: string,
    claimed: string[],
    stored: string[],
  ): Promise<Record<string, unknown>> => {
    const body = bodyClaiming(`sync ratio ${rkey}`, ...claimed)
    await transactor.putRecord({
      uri: uriOf(rkey).toString(),
      cid: await createCid(body),
      value: body,
      content: encodeRecord(body),
    })
    await transactor.replaceRecordBoundaries(uriOf(rkey), stored)
    return body
  }

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `stratos-visible-record-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(testDir, { recursive: true })
    db = createStratosDb(join(testDir, 'test.db'))
    await migrateStratosDb(db)
    reader = new StratosRecordReader(db, decodeRecord)
    transactor = new StratosRecordTransactor(db, decodeRecord)
  })

  afterEach(async () => {
    await closeStratosDb(db)
    await rm(testDir, { recursive: true, force: true })
  })

  describe('statement shape', () => {
    const statementsDuring = async (
      read: () => Promise<unknown>,
    ): Promise<string[]> => {
      const statements: string[] = []
      const realExecute = db._client.execute.bind(db._client)
      db._client.execute = ((statement: string | { sql: string }) => {
        statements.push(
          typeof statement === 'string' ? statement : statement.sql,
        )
        return realExecute(statement as Parameters<typeof realExecute>[0])
      }) as typeof db._client.execute
      try {
        await read()
      } finally {
        db._client.execute = realExecute
      }
      return statements
    }

    it('reads one record in a single statement', async () => {
      await seed('rei', [], [ENGINEERING])

      const statements = await statementsDuring(() =>
        reader.getVisibleRecordWithBoundaries(uriOf('rei')),
      )

      expect(statements).toHaveLength(1)
    })

    it('reads a batch in a single statement', async () => {
      await seed('rei', [], [ENGINEERING])
      await seed('shinji', [], [OPERATIONS])

      const statements = await statementsDuring(() =>
        reader.getVisibleRecordsWithBoundaries([uriOf('rei'), uriOf('shinji')]),
      )

      expect(statements).toHaveLength(1)
    })

    it('orders the boundaries in the statement, not by index luck', async () => {
      await seed('rei', [], [ENGINEERING])

      const [statement] = await statementsDuring(() =>
        reader.getVisibleRecordWithBoundaries(uriOf('rei')),
      )

      expect(statement).toMatch(
        /order by "stratos_record_boundary"\."boundary"\)/,
      )
    })

    it('filters out taken-down records in the statement', async () => {
      const [statement] = await statementsDuring(() =>
        reader.getVisibleRecordWithBoundaries(uriOf('rei')),
      )

      expect(statement).toMatch(/"stratos_record"\."takedownRef" is null/)
    })
  })

  describe('getVisibleRecordWithBoundaries', () => {
    it('returns the record exactly as getRecord does, with its rows sorted ascending', async () => {
      const body = await seed('rei', [ENGINEERING], [OPERATIONS, ENGINEERING])

      const found = await reader.getVisibleRecordWithBoundaries(uriOf('rei'))

      expect(found).toEqual({
        record: await reader.getRecord(uriOf('rei'), null),
        boundaries: [ENGINEERING, OPERATIONS],
      })
      expect(found?.record.value).toEqual(body)
    })

    it('returns [] for a record without rows', async () => {
      await seed('shinji', [], [])

      const found = await reader.getVisibleRecordWithBoundaries(uriOf('shinji'))

      expect(found?.boundaries).toEqual([])
      expect(found?.record.uri).toBe(uriOf('shinji').toString())
    })

    it('returns null for a missing record', async () => {
      expect(
        await reader.getVisibleRecordWithBoundaries(uriOf('kaworu')),
      ).toBeNull()
    })

    it('returns null for a taken-down record', async () => {
      await seed('gendo', [LEADERSHIP], [LEADERSHIP])
      await transactor.updateRecordTakedown(uriOf('gendo').toString(), {
        applied: true,
        ref: 'TD-GENDO',
      })

      expect(
        await reader.getVisibleRecordWithBoundaries(uriOf('gendo')),
      ).toBeNull()
      expect(await reader.getRecord(uriOf('gendo'), null)).toBeNull()
    })

    it('never returns the boundary the body claims', async () => {
      await seed('asuka', [LEADERSHIP], [ENGINEERING])

      const found = await reader.getVisibleRecordWithBoundaries(uriOf('asuka'))

      expect(found?.boundaries).toEqual([ENGINEERING])
    })

    it('accepts the uri as a string', async () => {
      await seed('maya', [], [ENGINEERING])

      const found = await reader.getVisibleRecordWithBoundaries(
        uriOf('maya').toString(),
      )

      expect(found?.boundaries).toEqual([ENGINEERING])
    })

    it('does not mix in the rows of another record', async () => {
      await seed('ritsuko', [], [ENGINEERING])
      await seed('kaji', [], [LEADERSHIP])

      const found = await reader.getVisibleRecordWithBoundaries(
        uriOf('ritsuko'),
      )

      expect(found?.boundaries).toEqual([ENGINEERING])
    })
  })

  describe('getVisibleRecordsWithBoundaries', () => {
    it('keeps visible records keyed by uri and omits missing and taken-down ones', async () => {
      await seed('rei', [], [OPERATIONS, ENGINEERING])
      await seed('shinji', [], [])
      await seed('gendo', [], [LEADERSHIP])
      await transactor.updateRecordTakedown(uriOf('gendo').toString(), {
        applied: true,
        ref: 'TD-GENDO',
      })

      const found = await reader.getVisibleRecordsWithBoundaries([
        uriOf('rei'),
        uriOf('shinji').toString(),
        uriOf('gendo'),
        uriOf('kaworu'),
      ])

      expect([...found.keys()].sort()).toEqual(
        [uriOf('rei').toString(), uriOf('shinji').toString()].sort(),
      )
      expect(found.get(uriOf('rei').toString())?.boundaries).toEqual([
        ENGINEERING,
        OPERATIONS,
      ])
      expect(found.get(uriOf('shinji').toString())?.boundaries).toEqual([])
    })

    it('returns each record with its own rows, never the claimed boundary', async () => {
      await seed('misato', [LEADERSHIP], [ENGINEERING])
      await seed('ritsuko', [ENGINEERING], [LEADERSHIP, OPERATIONS])

      const found = await reader.getVisibleRecordsWithBoundaries([
        uriOf('misato'),
        uriOf('ritsuko'),
      ])

      expect(found.get(uriOf('misato').toString())?.boundaries).toEqual([
        ENGINEERING,
      ])
      expect(found.get(uriOf('ritsuko').toString())?.boundaries).toEqual([
        LEADERSHIP,
        OPERATIONS,
      ])
    })

    it('returns an empty map for no uris', async () => {
      expect((await reader.getVisibleRecordsWithBoundaries([])).size).toBe(0)
    })

    it('answers a repeated uri once', async () => {
      await seed('toji', [], [ENGINEERING])

      const found = await reader.getVisibleRecordsWithBoundaries([
        uriOf('toji'),
        uriOf('toji').toString(),
      ])

      expect(found.size).toBe(1)
    })

    it('accepts exactly the bound', async () => {
      const uris = Array.from({ length: MAX_VISIBLE_RECORD_BATCH }, (_, i) =>
        uriOf(`angel-${i}`),
      )

      expect((await reader.getVisibleRecordsWithBoundaries(uris)).size).toBe(0)
    })

    it('throws above the bound', async () => {
      const uris = Array.from(
        { length: MAX_VISIBLE_RECORD_BATCH + 1 },
        (_, i) => uriOf(`angel-${i}`),
      )

      await expect(
        reader.getVisibleRecordsWithBoundaries(uris),
      ).rejects.toThrow(/at most 100/)
    })

    it('states the bound as 100', () => {
      expect(MAX_VISIBLE_RECORD_BATCH).toBe(100)
    })
  })
})
