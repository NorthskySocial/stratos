import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createClient, LibsqlError, type Client } from '@libsql/client'
import type { NewLabel } from '@northskysocial/stratos-core'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  type ServiceDb,
} from '../src/db'
import { SqliteLabelStore } from '../src/features/moderation/index.js'
import type { SqliteClientFactory } from '../src/features/moderation/index.js'

const NERV = 'did:plc:nerv-moderation'
const REI = 'did:plc:rei'

function recordLabel(
  rkey: string,
  overrides: Partial<NewLabel> = {},
): NewLabel {
  const uri = `at://${REI}/zone.stratos.feed.post/${rkey}`
  return {
    subjectKey: uri,
    subjectKind: 'record',
    val: '!takedown',
    neg: false,
    boundaries: ['eva-pilots'],
    createdBy: NERV,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('SqliteLabelStore', () => {
  let testDir: string
  let dbPath: string
  let db: ServiceDb
  let store: SqliteLabelStore

  beforeEach(async () => {
    testDir = join(tmpdir(), `stratos-label-${randomBytes(8).toString('hex')}`)
    await mkdir(testDir, { recursive: true })
    dbPath = join(testDir, 'service.sqlite')
    db = createServiceDb(dbPath)
    await migrateServiceDb(db)
    store = new SqliteLabelStore(db, dbPath)
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(testDir, { recursive: true, force: true })
  })

  it('assigns increasing seq values starting from an empty table', async () => {
    const first = await store.appendIfLatest(null, recordLabel('a'))
    const second = await store.appendIfLatest(null, recordLabel('b'))
    const third = await store.appendIfLatest(null, recordLabel('c'))
    if (
      first.kind !== 'appended' ||
      second.kind !== 'appended' ||
      third.kind !== 'appended'
    ) {
      throw new Error('expected every append to succeed')
    }
    expect(first.label.seq).toBe(1)
    expect(second.label.seq).toBe(2)
    expect(third.label.seq).toBe(3)
  })

  it('round trips a record label with every optional field present', async () => {
    const input = recordLabel('full', {
      cid: 'bafyreigendou',
      neg: true,
      ref: 'ticket-0042',
      boundaries: ['zeta', 'alpha', 'zeta', 'mid', 'alpha'],
    })
    const result = await store.appendIfLatest(null, input)
    if (result.kind !== 'appended') throw new Error('expected append')

    const expected = {
      ...input,
      seq: result.label.seq,
      boundaries: ['alpha', 'mid', 'zeta'],
    }
    expect(result.label).toEqual(expected)
    expect(await store.latestForSubject(input.subjectKey)).toEqual(expected)
  })

  it('round trips a record label with optional fields absent', async () => {
    const input = recordLabel('bare')
    const result = await store.appendIfLatest(null, input)
    if (result.kind !== 'appended') throw new Error('expected append')

    const stored = await store.latestForSubject(input.subjectKey)
    expect(stored).toEqual({ ...input, seq: result.label.seq })
    expect(stored?.cid).toBeUndefined()
    expect(stored?.ref).toBeUndefined()
    expect(stored?.neg).toBe(false)
  })

  it('round trips an account label with an empty boundary list', async () => {
    const input: NewLabel = {
      subjectKey: REI,
      subjectKind: 'account',
      val: '!takedown',
      neg: false,
      boundaries: [],
      createdBy: NERV,
      createdAt: '2026-01-02T00:00:00.000Z',
    }
    const result = await store.appendIfLatest(null, input)
    if (result.kind !== 'appended') throw new Error('expected append')
    expect(await store.latestForSubject(REI)).toEqual({
      ...input,
      seq: result.label.seq,
    })
  })

  it('latestForSubject returns the highest seq and ignores other keys', async () => {
    const target = recordLabel('target')
    const first = await store.appendIfLatest(null, target)
    if (first.kind !== 'appended') throw new Error('expected append')
    await store.appendIfLatest(null, recordLabel('other'))
    const retraction = await store.appendIfLatest(
      first.label.seq,
      recordLabel('target', { neg: true }),
    )
    if (retraction.kind !== 'appended') throw new Error('expected append')
    await store.appendIfLatest(null, recordLabel('another'))

    const latest = await store.latestForSubject(target.subjectKey)
    expect(latest?.seq).toBe(retraction.label.seq)
    expect(latest?.neg).toBe(true)
    expect(latest?.subjectKey).toBe(target.subjectKey)
  })

  it('latestForSubject returns undefined for an unknown key', async () => {
    await store.appendIfLatest(null, recordLabel('known'))
    expect(
      await store.latestForSubject(`at://${REI}/zone.stratos.feed.post/nope`),
    ).toBeUndefined()
  })

  describe('a label with every field set', () => {
    const everyField = () =>
      recordLabel('every-field', {
        cid: 'bafyreigendou',
        neg: true,
        ref: 'ticket-0042',
        boundaries: ['eva-pilots', 'nerv-staff'],
      })

    it('returns the full label for appended and for stale, and reads it back', async () => {
      const input = everyField()
      const appended = await store.appendIfLatest(null, input)
      if (appended.kind !== 'appended') throw new Error('expected append')
      const expected = { ...input, seq: appended.label.seq }

      const stale = await store.appendIfLatest(null, input)

      expect(appended.label).toEqual(expected)
      expect(stale).toEqual({ kind: 'stale', latest: expected })
      expect(await store.latestForSubject(input.subjectKey)).toEqual(expected)
      expect(await store.listFrom({ limit: 100 })).toEqual([expected])
    })
  })

  describe('listFrom', () => {
    async function seed(count: number): Promise<number[]> {
      const seqs: number[] = []
      for (let index = 0; index < count; index++) {
        const result = await store.appendIfLatest(
          null,
          recordLabel(`row-${index}`),
        )
        if (result.kind !== 'appended') throw new Error('expected append')
        seqs.push(result.label.seq)
      }
      return seqs
    }

    it('treats the cursor as exclusive and returns ascending rows', async () => {
      const seqs = await seed(5)
      const rows = await store.listFrom({ cursor: seqs[1], limit: 100 })
      expect(rows.map((row) => row.seq)).toEqual(seqs.slice(2))
    })

    it('respects limit', async () => {
      const seqs = await seed(5)
      const rows = await store.listFrom({ limit: 2 })
      expect(rows.map((row) => row.seq)).toEqual(seqs.slice(0, 2))
    })

    it('starts from the beginning without a cursor', async () => {
      const seqs = await seed(3)
      const rows = await store.listFrom({ limit: 100 })
      expect(rows.map((row) => row.seq)).toEqual(seqs)
    })

    it('pages to the end returning every label exactly once', async () => {
      const seqs = await seed(7)
      const seen: number[] = []
      let cursor: number | undefined
      for (let pageCount = 0; pageCount < 20; pageCount++) {
        const page = await store.listFrom({ cursor, limit: 3 })
        if (page.length === 0) break
        seen.push(...page.map((row) => row.seq))
        cursor = page[page.length - 1].seq
      }
      expect(seen).toEqual(seqs)
    })
  })

  describe('listFrom filters and headSeq', () => {
    const EVA_01 = recordLabel('eva-01').subjectKey
    const EVA_02 = recordLabel('eva-02').subjectKey
    const EVA_03 = recordLabel('eva-03').subjectKey

    async function appendAll(rkeys: string[]): Promise<number[]> {
      const seqs: number[] = []
      for (const rkey of rkeys) {
        const result = await store.appendIfLatest(null, recordLabel(rkey))
        if (result.kind !== 'appended') throw new Error('expected append')
        seqs.push(result.label.seq)
      }
      return seqs
    }

    it('returns only labels of the listed subjects, in seq order', async () => {
      const seqs = await appendAll(['eva-01', 'eva-02', 'eva-03', 'eva-04'])
      const rows = await store.listFrom({
        limit: 100,
        subjects: [EVA_03, EVA_01],
      })
      expect(rows.map((row) => row.subjectKey)).toEqual([EVA_01, EVA_03])
      expect(rows.map((row) => row.seq)).toEqual([seqs[0], seqs[2]])
    })

    it('treats upTo as inclusive and cursor as exclusive', async () => {
      const seqs = await appendAll(['eva-01', 'eva-02', 'eva-03', 'eva-04'])
      const rows = await store.listFrom({
        cursor: seqs[0],
        upTo: seqs[2],
        limit: 100,
      })
      expect(rows.map((row) => row.seq)).toEqual([seqs[1], seqs[2]])
    })

    it('combines cursor, upTo, subjects and limit', async () => {
      const seqs = await appendAll(['eva-01', 'eva-02', 'eva-01-b', 'eva-02-b'])
      const rows = await store.listFrom({
        cursor: seqs[0],
        upTo: seqs[3],
        subjects: [EVA_02, recordLabel('eva-02-b').subjectKey],
        limit: 1,
      })
      expect(rows.map((row) => row.seq)).toEqual([seqs[1]])
    })

    it('returns nothing for an empty subjects list', async () => {
      await appendAll(['eva-01', 'eva-02'])
      expect(await store.listFrom({ limit: 100, subjects: [] })).toEqual([])
    })

    it('returns nothing for subjects that have no label', async () => {
      await appendAll(['eva-01'])
      expect(await store.listFrom({ limit: 100, subjects: [EVA_02] })).toEqual(
        [],
      )
    })

    it('reports 0 as the head of an empty log and the last seq afterwards', async () => {
      expect(await store.headSeq()).toBe(0)
      const seqs = await appendAll(['eva-01', 'eva-02', 'eva-03'])
      expect(await store.headSeq()).toBe(seqs[2])
    })

    it('reports the highest seq, not the row count, when seqs have gaps', async () => {
      const [first] = await appendAll(['eva-01'])
      const second = await store.appendIfLatest(first, {
        ...recordLabel('eva-01'),
        neg: true,
      })
      if (second.kind !== 'appended') throw new Error('expected append')
      await db.run(sql`DELETE FROM moderation_label WHERE seq = ${first}`)
      expect(await store.headSeq()).toBe(second.label.seq)
    })

    it('lets a cursor reader see every label while appends run, over 5 runs', async () => {
      for (let run = 0; run < 5; run++) {
        const subjectCount = 10
        const writers = Promise.all(
          Array.from({ length: subjectCount }, async (_, index) => {
            let expected: number | null = null
            for (let step = 0; step < 3; step++) {
              const result = await store.appendIfLatest(
                expected,
                recordLabel(`run-${run}-pilot-${index}`, { neg: step === 1 }),
              )
              if (result.kind !== 'appended') throw new Error('expected append')
              expected = result.label.seq
            }
          }),
        )

        const seen: number[] = []
        let cursor = 0
        const readPage = async (): Promise<number> => {
          const page = await store.listFrom({ cursor, limit: 5 })
          seen.push(...page.map((row) => row.seq))
          if (page.length > 0) cursor = page[page.length - 1].seq
          return page.length
        }
        let writersDone = false
        void writers.then(() => {
          writersDone = true
        })
        while (!writersDone) {
          if ((await readPage()) === 0) await new Promise(setImmediate)
        }
        await writers
        const head = await store.headSeq()
        while (cursor < head) await readPage()

        const everySeq = (await store.listFrom({ limit: 1000 })).map(
          (row) => row.seq,
        )
        expect(everySeq).toHaveLength(subjectCount * 3 * (run + 1))
        expect(seen).toEqual(everySeq)
      }
    })
  })

  describe('appendIfLatest', () => {
    it('returns stale with the current latest and writes nothing', async () => {
      const first = await store.appendIfLatest(null, recordLabel('ikari'))
      if (first.kind !== 'appended') throw new Error('expected append')

      const outcome = await store.appendIfLatest(
        first.label.seq + 99,
        recordLabel('ikari', { neg: true }),
      )
      expect(outcome).toEqual({ kind: 'stale', latest: first.label })
      expect(await store.listFrom({ limit: 100 })).toEqual([first.label])
    })

    it('treats null as right for a new subject and stale once a label exists', async () => {
      const label = recordLabel('asuka')
      const first = await store.appendIfLatest(null, label)
      expect(first.kind).toBe('appended')

      const second = await store.appendIfLatest(null, label)
      expect(second.kind).toBe('stale')
      if (second.kind === 'stale') {
        expect(second.latest?.subjectKey).toBe(label.subjectKey)
      }
      expect(await store.listFrom({ limit: 100 })).toHaveLength(1)
    })

    it('returns stale with no latest when a label is expected but none exists', async () => {
      const outcome = await store.appendIfLatest(5, recordLabel('ghost'))
      expect(outcome).toEqual({ kind: 'stale', latest: undefined })
      expect(await store.listFrom({ limit: 100 })).toEqual([])
    })
  })

  describe('concurrency', () => {
    it('appends identical concurrent requests once, over 10 rounds', async () => {
      for (let round = 0; round < 10; round++) {
        const label = recordLabel(`same-${round}`)
        const outcomes = await Promise.all(
          Array.from({ length: 20 }, () => store.appendIfLatest(null, label)),
        )
        const appended = outcomes.filter((o) => o.kind === 'appended')
        const stale = outcomes.filter((o) => o.kind === 'stale')
        expect(appended).toHaveLength(1)
        expect(stale).toHaveLength(19)

        const rows = (await store.listFrom({ limit: 1000 })).filter(
          (row) => row.subjectKey === label.subjectKey,
        )
        expect(rows).toHaveLength(1)
      }
    })

    it('appends once across store instances sharing one database, over 10 rounds', async () => {
      const stores = Array.from(
        { length: 4 },
        () => new SqliteLabelStore(db, dbPath),
      )
      for (let round = 0; round < 10; round++) {
        const label = recordLabel(`shared-db-${round}`)
        const outcomes = await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            stores[index % stores.length].appendIfLatest(null, label),
          ),
        )
        expect(outcomes.filter((o) => o.kind === 'appended')).toHaveLength(1)
        expect(outcomes.filter((o) => o.kind === 'stale')).toHaveLength(19)
      }
    })

    it('assigns unique ascending seq values to 50 distinct subjects', async () => {
      const outcomes = await Promise.all(
        Array.from({ length: 50 }, (_, index) =>
          store.appendIfLatest(null, recordLabel(`distinct-${index}`)),
        ),
      )
      const seqs = outcomes.map((outcome) => {
        if (outcome.kind !== 'appended') throw new Error('expected append')
        return outcome.label.seq
      })
      expect(new Set(seqs).size).toBe(50)

      const listed = await store.listFrom({ limit: 1000 })
      const listedSeqs = listed.map((row) => row.seq)
      expect(listedSeqs).toHaveLength(50)
      expect(listedSeqs).toEqual([...listedSeqs].sort((a, b) => a - b))
      expect(new Set(listedSeqs)).toEqual(new Set(seqs))
    })
  })

  describe('overlap with another write transaction on the same ServiceDb', () => {
    const OVERLAP_HOLD_MS = 50
    const SQLITE_LOCK_WAIT_PAST_MS = 11_000
    const RESOLVE_AFTER_COMMIT_MS = 2_000

    function countingFactory() {
      const opened: { closed: boolean }[] = []
      const factory: SqliteClientFactory = (config) => {
        const client = createClient(config)
        const entry = { closed: false }
        const closeClient = client.close.bind(client)
        client.close = () => {
          entry.closed = true
          closeClient()
        }
        opened.push(entry)
        return client
      }
      return { factory, opened }
    }

    async function openStateWrite(key: string) {
      const held = await db._client.transaction('write')
      await held.execute({
        sql: 'INSERT INTO oauth_state (key, state, createdAt) VALUES (?, ?, ?)',
        args: [key, 'tokyo-3', '2026-01-01T00:00:00.000Z'],
      })
      return held
    }

    async function countLabels(client: Client, subjectKey: string) {
      const result = await client.execute({
        sql: 'SELECT count(*) AS n FROM moderation_label WHERE subjectKey = ?',
        args: [subjectKey],
      })
      return Number(result.rows[0].n)
    }

    async function writeStateRow(client: Pick<Client, 'execute'>, key: string) {
      await client.execute({
        sql: 'INSERT INTO oauth_state (key, state, createdAt) VALUES (?, ?, ?)',
        args: [key, 'nerv-hq', '2026-01-01T00:00:00.000Z'],
      })
    }

    async function expectNoLockLeftBehind(subjectKey: string, tag: string) {
      const independent = createClient({ url: `file:${dbPath}` })
      try {
        expect(await countLabels(independent, subjectKey)).toBe(1)
        await writeStateRow(independent, `independent-${tag}`)
      } finally {
        independent.close()
      }

      const later = await db._client.transaction('write')
      await writeStateRow(later, `later-${tag}`)
      await later.commit()
      later.close()

      const verifier = createClient({ url: `file:${dbPath}` })
      try {
        expect(await countLabels(verifier, subjectKey)).toBe(1)
      } finally {
        verifier.close()
      }
    }

    async function timeOutWhileHeld(
      appendStore: SqliteLabelStore,
      label: NewLabel,
      key: string,
    ) {
      vi.useFakeTimers({ toFake: ['Date'] })
      const held = await openStateWrite(key)
      try {
        const timedOut = appendStore.appendIfLatest(null, label).then(
          () => undefined,
          (err: unknown) => err,
        )
        await new Promise((resolve) => setTimeout(resolve, OVERLAP_HOLD_MS))
        vi.setSystemTime(Date.now() + SQLITE_LOCK_WAIT_PAST_MS)
        expect(await timedOut).toMatchObject({ code: 'SQLITE_BUSY' })
      } finally {
        vi.useRealTimers()
      }
      return held
    }

    it('waits for the other transaction and appends once', async () => {
      const { factory, opened } = countingFactory()
      const countedStore = new SqliteLabelStore(db, dbPath, factory)
      const held = await openStateWrite('shinji')
      const label = recordLabel('overlap')
      const appending = countedStore.appendIfLatest(null, label)
      await new Promise((resolve) => setTimeout(resolve, OVERLAP_HOLD_MS))
      await held.commit()
      held.close()
      const committedAt = Date.now()

      const outcome = await appending
      expect(Date.now() - committedAt).toBeLessThan(RESOLVE_AFTER_COMMIT_MS)
      expect(outcome.kind).toBe('appended')
      const rows = await store.listFrom({ limit: 100 })
      expect(
        rows.filter((row) => row.subjectKey === label.subjectKey),
      ).toHaveLength(1)
      expect(rows).toHaveLength(1)

      await expectNoLockLeftBehind(label.subjectKey, 'shinji')
      expect(opened.length).toBeGreaterThan(0)
      expect(opened.every((client) => client.closed)).toBe(true)
    })

    it('fails after the lock wait without writing or leaving a lock', async () => {
      const { factory, opened } = countingFactory()
      const countedStore = new SqliteLabelStore(db, dbPath, factory)
      const label = recordLabel('too-long')
      const held = await timeOutWhileHeld(countedStore, label, 'rei')
      try {
        const independent = createClient({ url: `file:${dbPath}` })
        try {
          expect(await countLabels(independent, label.subjectKey)).toBe(0)
        } finally {
          independent.close()
        }
        expect(await store.listFrom({ limit: 100 })).toEqual([])
      } finally {
        await held.rollback()
        held.close()
      }

      const independent = createClient({ url: `file:${dbPath}` })
      try {
        await writeStateRow(independent, 'after-rollback')
      } finally {
        independent.close()
      }
      expect(opened.length).toBeGreaterThan(0)
      expect(opened.every((client) => client.closed)).toBe(true)
    })

    it('appends again promptly after an append timed out', async () => {
      const { factory, opened } = countingFactory()
      const countedStore = new SqliteLabelStore(db, dbPath, factory)
      const held = await timeOutWhileHeld(
        countedStore,
        recordLabel('gave-up'),
        'misato',
      )
      await held.commit()
      held.close()

      const independent = createClient({ url: `file:${dbPath}` })
      try {
        await writeStateRow(independent, 'right-after-commit')
      } finally {
        independent.close()
      }

      const retryLabel = recordLabel('retry')
      const startedAt = Date.now()
      const outcome = await countedStore.appendIfLatest(null, retryLabel)
      expect(Date.now() - startedAt).toBeLessThan(RESOLVE_AFTER_COMMIT_MS)
      expect(outcome.kind).toBe('appended')

      await expectNoLockLeftBehind(retryLabel.subjectKey, 'misato')
      expect(opened.length).toBeGreaterThan(0)
      expect(opened.every((client) => client.closed)).toBe(true)
    })
  })

  describe('a non-busy failure from the guarded insert', () => {
    const FAIL_FAST_MS = 500

    it('rejects at once with that error, runs the statement once, writes nothing and closes the client', async () => {
      const failure = new LibsqlError('disk is full', 'SQLITE_FULL')
      const executeCalls: unknown[] = []
      const closed: boolean[] = []
      const factory: SqliteClientFactory = (config) => {
        const client = createClient(config)
        const closeClient = client.close.bind(client)
        client.execute = (...args: Parameters<Client['execute']>) => {
          executeCalls.push(args[0])
          return Promise.reject(failure)
        }
        client.close = () => {
          closed.push(true)
          closeClient()
        }
        return client
      }
      const failingStore = new SqliteLabelStore(db, dbPath, factory)

      const startedAt = Date.now()
      const outcome = await failingStore
        .appendIfLatest(null, recordLabel('full-disk'))
        .then(
          () => undefined,
          (err: unknown) => err,
        )

      expect(Date.now() - startedAt).toBeLessThan(FAIL_FAST_MS)
      expect(outcome).toBe(failure)
      expect(executeCalls).toHaveLength(1)
      expect(closed).toEqual([true])
      expect(await store.listFrom({ limit: 100 })).toEqual([])
    })
  })

  it('migration is idempotent and keeps rows', async () => {
    const first = await store.appendIfLatest(null, recordLabel('keep'))
    if (first.kind !== 'appended') throw new Error('expected append')

    await migrateServiceDb(db)
    await migrateServiceDb(db)

    expect(await store.listFrom({ limit: 100 })).toEqual([first.label])
  })
})
