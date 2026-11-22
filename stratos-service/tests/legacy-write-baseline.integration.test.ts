import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { applyWritesBatch, createRecord } from '../src/api/records/index.js'
import { decodeEvent, eventInScope } from '../src/subscription/index.js'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'
import {
  asMember,
  HARNESS_DESIGN,
  HARNESS_ENGINEERING,
  startPostgresWriteHarness,
  startSqliteWriteHarness,
  withCredential,
  type SequencedOp,
  type WriteHarness,
} from './helpers/write-harness.js'

const COLLECTION = 'zone.stratos.feed.post'
const MISATO = 'did:plc:misato-katsuragi'
const RITSUKO = 'did:plc:ritsuko-akagi'
const GHOST = 'did:plc:kaworu-nagisa'
const SEELE = 'did:web:seele.tokyo.jp'
const KAJI = 'did:plc:ryoji-kaji'
const CREATE_RECORD = 'com.atproto.repo.createRecord'
const DELETE_RECORD = 'com.atproto.repo.deleteRecord'
const APPLY_WRITES = 'com.atproto.repo.applyWrites'
const WRITE_CREATE = 'com.atproto.repo.applyWrites#create'

const uriOf = (did: string, rkey: string) => `at://${did}/${COLLECTION}/${rkey}`
const pathOf = (rkey: string) => `${COLLECTION}/${rkey}`

function post(text: string, boundary = HARNESS_ENGINEERING) {
  return {
    $type: COLLECTION,
    text,
    createdAt: '1996-10-04T00:00:00.000Z',
    boundary: {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: [{ value: boundary }],
    },
  }
}

function expectedOp(
  seq: number,
  action: string | undefined,
  rkey: string,
  scope: string[],
  exclude: string[] = [],
): SequencedOp {
  return { seq, action, path: pathOf(rkey), scope, exclude } as SequencedOp
}

function defineLegacyWriteBaseline(getHarness: () => WriteHarness) {
  let harness: WriteHarness

  beforeEach(() => {
    harness = getHarness()
  })

  const createViaHttp = (
    did: string,
    rkey: string,
    text: string,
    boundary = HARNESS_ENGINEERING,
  ) =>
    harness.call(CREATE_RECORD, asMember(did), {
      repo: did,
      collection: COLLECTION,
      rkey,
      record: post(text, boundary),
    })

  const deleteViaHttp = (did: string, rkey: string) =>
    harness.call(DELETE_RECORD, asMember(did), {
      repo: did,
      collection: COLLECTION,
      rkey,
    })

  const applyWritesViaHttp = (did: string, writes: unknown[]) =>
    harness.call(APPLY_WRITES, asMember(did), { repo: did, writes })

  const recordCount = (did: string) =>
    harness.ctx.actorStore.read(did, (store) => store.record.recordCount())

  /** The ops of the events a subscriber holding `boundaries` receives. */
  async function opsDeliveredTo(did: string, boundaries: string[]) {
    const events = await harness.ctx.actorStore.read(did, async (store) => {
      const rows = await store.sequence.getEventsSince(0, 1000)
      return rows.map((row) => ({
        seq: row.seq,
        did: row.did,
        time: row.sequencedAt,
        rev: '',
        event: row.event,
      }))
    })
    return events.flatMap((event) => {
      const decoded = decodeEvent(event)
      return eventInScope(decoded, new Set(boundaries))
        ? decoded.ops.map((op) => `${event.seq} ${op.action} ${op.path}`)
        : []
    })
  }

  describe('createRecord over HTTP', () => {
    it('returns the uri, cid and commit of a created record', async () => {
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])

      const created = await createViaHttp(MISATO, 'unit-01', 'Sortie')

      expect(created.status).toBe(200)
      const body = created.body as {
        uri: string
        cid: string
        commit: { cid: string; rev: string }
      }
      expect(Object.keys(body).sort()).toEqual(['cid', 'commit', 'uri'])
      expect(Object.keys(body.commit).sort()).toEqual(['cid', 'rev'])
      expect(body.uri).toBe(uriOf(MISATO, 'unit-01'))
      expect(await harness.repoRoot(MISATO)).toEqual(body.commit)
    })

    it('stores one row in the claimed boundary and sequences one scoped create op', async () => {
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])

      const created = await createViaHttp(MISATO, 'unit-01', 'Sortie')

      const rows = await harness.recordRows(uriOf(MISATO, 'unit-01'))
      expect(rows.record?.cid).toBe((created.body as { cid: string }).cid)
      expect(rows.record?.value).toMatchObject({ text: 'Sortie' })
      expect(rows.boundaries).toEqual([HARNESS_ENGINEERING])
      expect(rows.takedown).toEqual({ applied: false })
      expect(await recordCount(MISATO)).toBe(1)
      expect(await harness.sequencedOps(MISATO)).toEqual([
        expectedOp(1, 'create', 'unit-01', [HARNESS_ENGINEERING]),
      ])
    })

    it('replaces an existing record at the same rkey and returns a new cid', async () => {
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
      const first = await createViaHttp(MISATO, 'unit-01', 'Sortie')

      const second = await createViaHttp(MISATO, 'unit-01', 'Sortie again')

      expect(second.status).toBe(200)
      const firstBody = first.body as {
        cid: string
        commit: { rev: string }
      }
      const secondBody = second.body as {
        cid: string
        commit: { rev: string }
      }
      expect(secondBody.cid).not.toBe(firstBody.cid)
      expect(secondBody.commit.rev).not.toBe(firstBody.commit.rev)
      const rows = await harness.recordRows(uriOf(MISATO, 'unit-01'))
      expect(rows.record?.cid).toBe(secondBody.cid)
      expect(rows.record?.value).toMatchObject({ text: 'Sortie again' })
      expect(await recordCount(MISATO)).toBe(1)
      expect(await harness.sequencedOps(MISATO)).toEqual([
        expectedOp(1, 'create', 'unit-01', [HARNESS_ENGINEERING]),
        expectedOp(2, 'create', 'unit-01', [HARNESS_ENGINEERING]),
      ])
    })
  })

  describe('deleteRecord over HTTP', () => {
    it('returns only the commit of a deleted record and removes its rows', async () => {
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
      await createViaHttp(MISATO, 'unit-01', 'Sortie')

      const deleted = await deleteViaHttp(MISATO, 'unit-01')

      expect(deleted.status).toBe(200)
      const body = deleted.body as { commit: { cid: string; rev: string } }
      expect(Object.keys(body)).toEqual(['commit'])
      expect(await harness.repoRoot(MISATO)).toEqual(body.commit)
      expect(await harness.recordRows(uriOf(MISATO, 'unit-01'))).toEqual({
        record: null,
        boundaries: [],
        takedown: null,
      })
    })

    it('sequences a plain delete op with no scope and then a delete op scoped to the stored boundary', async () => {
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
      await createViaHttp(MISATO, 'unit-01', 'Sortie')

      await deleteViaHttp(MISATO, 'unit-01')

      expect(await harness.sequencedOps(MISATO)).toEqual([
        expectedOp(1, 'create', 'unit-01', [HARNESS_ENGINEERING]),
        expectedOp(2, 'delete', 'unit-01', []),
        expectedOp(3, 'delete', 'unit-01', [HARNESS_ENGINEERING]),
      ])
    })

    it('returns a commit for a record that does not exist and advances the repo revision', async () => {
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
      await createViaHttp(MISATO, 'unit-01', 'Sortie')
      const before = await harness.repoRoot(MISATO)

      const deleted = await deleteViaHttp(MISATO, 'unit-99')

      expect(deleted.status).toBe(200)
      const body = deleted.body as { commit: { cid: string; rev: string } }
      expect(Object.keys(body)).toEqual(['commit'])
      expect(Object.keys(body.commit).sort()).toEqual(['cid', 'rev'])
      const after = await harness.repoRoot(MISATO)
      expect(after).toEqual(body.commit)
      expect(after?.rev).not.toBe(before?.rev)
      expect(after!.rev > before!.rev).toBe(true)
    })

    it('sequences a plain delete op and no scoped removal for a record that does not exist', async () => {
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
      await createViaHttp(MISATO, 'unit-01', 'Sortie')

      await deleteViaHttp(MISATO, 'unit-99')

      expect(await harness.sequencedOps(MISATO)).toEqual([
        expectedOp(1, 'create', 'unit-01', [HARNESS_ENGINEERING]),
        expectedOp(2, 'delete', 'unit-99', []),
      ])
      expect(await recordCount(MISATO)).toBe(1)
    })
  })

  describe('applyWrites over HTTP', () => {
    it('answers 400 InvalidRequest to writes in the action, collection, rkey, record shape', async () => {
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
      const before = await harness.repoRoot(MISATO)

      const applied = await applyWritesViaHttp(MISATO, [
        {
          action: 'create',
          collection: COLLECTION,
          rkey: 'unit-02',
          record: post('Sortie'),
        },
      ])

      expect(applied.status).toBe(400)
      expect(applied.body).toEqual({
        error: 'InvalidRequest',
        message:
          'Input/writes/0 must be an object which includes the "$type" property',
      })
      expect(await harness.recordRows(uriOf(MISATO, 'unit-02'))).toEqual({
        record: null,
        boundaries: [],
        takedown: null,
      })
      expect(await harness.sequencedOps(MISATO)).toEqual([])
      expect(await harness.repoRoot(MISATO)).toEqual(before)
    })

    it('answers 400 InvalidRequest to a typed write that carries record instead of value', async () => {
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])

      const applied = await applyWritesViaHttp(MISATO, [
        {
          $type: WRITE_CREATE,
          action: 'create',
          collection: COLLECTION,
          rkey: 'unit-02',
          record: post('Sortie'),
        },
      ])

      expect(applied.status).toBe(400)
      expect(applied.body).toEqual({
        error: 'InvalidRequest',
        message: 'Input/writes/0 must have the property "value"',
      })
      expect(await harness.sequencedOps(MISATO)).toEqual([])
    })

    it('answers 500 InternalServerError to a typed create with value, and changes nothing', async () => {
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
      const before = await harness.repoRoot(MISATO)

      const applied = await applyWritesViaHttp(MISATO, [
        {
          $type: WRITE_CREATE,
          collection: COLLECTION,
          rkey: 'unit-02',
          value: post('Sortie'),
        },
      ])

      expect(applied.status).toBe(500)
      expect(applied.body).toEqual({
        error: 'InternalServerError',
        message: 'Internal Server Error',
      })
      expect(await harness.recordRows(uriOf(MISATO, 'unit-02'))).toEqual({
        record: null,
        boundaries: [],
        takedown: null,
      })
      expect(await harness.sequencedOps(MISATO)).toEqual([])
      expect(await harness.repoRoot(MISATO)).toEqual(before)
    })

    it('answers the same 500 to a typed create with value when it also names action create', async () => {
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])

      const applied = await applyWritesViaHttp(MISATO, [
        {
          $type: WRITE_CREATE,
          action: 'create',
          collection: COLLECTION,
          rkey: 'unit-02',
          value: post('Sortie'),
        },
      ])

      expect(applied.status).toBe(500)
      expect(applied.body).toEqual({
        error: 'InternalServerError',
        message: 'Internal Server Error',
      })
      expect(await harness.recordRows(uriOf(MISATO, 'unit-02'))).toEqual({
        record: null,
        boundaries: [],
        takedown: null,
      })
      expect(await harness.sequencedOps(MISATO)).toEqual([])
    })

    it('answers 500 but commits the write when a typed create carries both value and record, sequencing the op without an action', async () => {
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])

      const applied = await applyWritesViaHttp(MISATO, [
        {
          $type: WRITE_CREATE,
          collection: COLLECTION,
          rkey: 'unit-02',
          value: post('Sortie'),
          record: post('Sortie'),
        },
      ])

      expect(applied.status).toBe(500)
      expect(applied.body).toEqual({
        error: 'InternalServerError',
        message: 'Internal Server Error',
      })
      const rows = await harness.recordRows(uriOf(MISATO, 'unit-02'))
      expect(rows.record?.value).toMatchObject({ text: 'Sortie' })
      expect(rows.boundaries).toEqual([HARNESS_ENGINEERING])
      expect(await harness.sequencedOps(MISATO)).toEqual([
        expectedOp(1, undefined, 'unit-02', [HARNESS_ENGINEERING]),
      ])
    })

    it('answers 500 but commits the write when the same typed create names action create', async () => {
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])

      const applied = await applyWritesViaHttp(MISATO, [
        {
          $type: WRITE_CREATE,
          action: 'create',
          collection: COLLECTION,
          rkey: 'unit-02',
          value: post('Sortie'),
          record: post('Sortie'),
        },
      ])

      expect(applied.status).toBe(500)
      expect(
        (await harness.recordRows(uriOf(MISATO, 'unit-02'))).boundaries,
      ).toEqual([HARNESS_ENGINEERING])
      expect(await harness.sequencedOps(MISATO)).toEqual([
        expectedOp(1, 'create', 'unit-02', [HARNESS_ENGINEERING]),
      ])
    })

    it('answers 500 InternalServerError to an empty list of writes but commits an empty revision and sequences nothing', async () => {
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
      const before = await harness.repoRoot(MISATO)

      const applied = await applyWritesViaHttp(MISATO, [])

      expect(applied.status).toBe(500)
      expect(applied.body).toEqual({
        error: 'InternalServerError',
        message: 'Internal Server Error',
      })
      expect(await harness.sequencedOps(MISATO)).toEqual([])
      expect(before).toBeNull()
      expect(await harness.repoRoot(MISATO)).toEqual({
        cid: expect.any(String),
        rev: expect.any(String),
      })
    })
  })

  describe('a direct batch of update then delete on one record', () => {
    it('sequences the update, the move removal, the plain delete and the scoped delete in that order', async () => {
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING, HARNESS_DESIGN])
      await createViaHttp(MISATO, 'unit-01', 'Sortie')

      const result = await applyWritesBatch(harness.ctx, MISATO, [
        {
          action: 'update',
          collection: COLLECTION,
          rkey: 'unit-01',
          record: post('Sortie moved', HARNESS_DESIGN),
        },
        { action: 'delete', collection: COLLECTION, rkey: 'unit-01' },
      ])

      expect(result.results).toHaveLength(2)
      expect(result.results[0]).toMatchObject({
        uri: uriOf(MISATO, 'unit-01'),
      })
      expect(result.results[1]).toEqual({})
      expect(await harness.sequencedOps(MISATO)).toEqual([
        expectedOp(1, 'create', 'unit-01', [HARNESS_ENGINEERING]),
        expectedOp(2, 'update', 'unit-01', [HARNESS_DESIGN]),
        expectedOp(
          3,
          'delete',
          'unit-01',
          [HARNESS_ENGINEERING],
          [HARNESS_DESIGN],
        ),
        expectedOp(4, 'delete', 'unit-01', []),
        expectedOp(5, 'delete', 'unit-01', [HARNESS_ENGINEERING]),
      ])
      expect(await harness.recordRows(uriOf(MISATO, 'unit-01'))).toEqual({
        record: null,
        boundaries: [],
        takedown: null,
      })
    })

    it('delivers the update and no delete to a subscriber of the new boundary', async () => {
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING, HARNESS_DESIGN])
      await createViaHttp(MISATO, 'unit-01', 'Sortie')

      await applyWritesBatch(harness.ctx, MISATO, [
        {
          action: 'update',
          collection: COLLECTION,
          rkey: 'unit-01',
          record: post('Sortie moved', HARNESS_DESIGN),
        },
        { action: 'delete', collection: COLLECTION, rkey: 'unit-01' },
      ])

      expect(await opsDeliveredTo(MISATO, [HARNESS_DESIGN])).toEqual([
        `2 update ${pathOf('unit-01')}`,
      ])
      expect(await opsDeliveredTo(MISATO, [HARNESS_ENGINEERING])).toEqual([
        `1 create ${pathOf('unit-01')}`,
        `3 delete ${pathOf('unit-01')}`,
        `5 delete ${pathOf('unit-01')}`,
      ])
    })
  })

  describe('a direct batch update of a taken-down record', () => {
    async function takeDown(rkey: string, ref: string) {
      await harness.ctx.actorStore.transact(MISATO, async (store) => {
        await store.record.updateRecordTakedown(uriOf(MISATO, rkey), {
          applied: true,
          ref,
        })
      })
    }

    const updateBatch = () =>
      applyWritesBatch(harness.ctx, MISATO, [
        {
          action: 'update',
          collection: COLLECTION,
          rkey: 'unit-01',
          record: post('Sortie revised'),
        },
      ])

    it('keeps the takedown reference on the updated row', async () => {
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
      await createViaHttp(MISATO, 'unit-01', 'Sortie')
      await takeDown('unit-01', 'case-angel')

      await updateBatch()

      const rows = await harness.recordRows(uriOf(MISATO, 'unit-01'))
      expect(rows.record?.takedownRef).toBe('case-angel')
      expect(rows.takedown).toEqual({ applied: true, ref: 'case-angel' })
      expect(rows.record?.value).toMatchObject({ text: 'Sortie revised' })
    })

    it('still hides the updated record from a read that excludes taken-down records', async () => {
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
      await createViaHttp(MISATO, 'unit-01', 'Sortie')
      await takeDown('unit-01', 'case-angel')

      await updateBatch()

      const visible = await harness.ctx.actorStore.read(MISATO, (store) =>
        store.record.getRecord(uriOf(MISATO, 'unit-01'), null, false),
      )
      expect(visible).toBeNull()
    })
  })

  describe('createRecord over HTTP for callers the legacy path refuses', () => {
    it('answers 400 NotEnrolled to a caller with no enrollment', async () => {
      const refused = await createViaHttp(GHOST, 'unit-03', 'Sortie')

      expect(refused.status).toBe(400)
      expect(refused.body).toEqual({
        error: 'NotEnrolled',
        message: 'User is not enrolled in this Stratos service',
      })
    })

    it('answers 400 NotEnrolled to a held member authenticated with the development bearer', async () => {
      await harness.enrollMember(RITSUKO, [HARNESS_ENGINEERING])
      await harness.holdMember(RITSUKO)

      const refused = await createViaHttp(RITSUKO, 'unit-03', 'Sortie')

      expect(refused.status).toBe(400)
      expect(refused.body).toEqual({
        error: 'NotEnrolled',
        message: 'User is not enrolled in this Stratos service',
      })
      expect(await harness.sequencedOps(RITSUKO)).toEqual([])
    })

    it('rejects a held member with NotEnrolled when the write function is called directly', async () => {
      await harness.enrollMember(RITSUKO, [HARNESS_ENGINEERING])
      await harness.holdMember(RITSUKO)

      await expect(
        createRecord(
          harness.ctx,
          {
            repo: RITSUKO,
            collection: COLLECTION,
            rkey: 'unit-03',
            record: post('Sortie'),
          },
          RITSUKO,
        ),
      ).rejects.toMatchObject({ customErrorName: 'NotEnrolled' })
    })

    it('answers 400 ServiceWriteForbidden to a service identity', async () => {
      await harness.enrollServiceIdentity(SEELE, [HARNESS_ENGINEERING])

      const refused = await createViaHttp(SEELE, 'unit-03', 'Sortie')

      expect(refused.status).toBe(400)
      expect(refused.body).toEqual({
        error: 'ServiceWriteForbidden',
        message: 'Service identities cannot create records',
      })
    })

    it('answers 400 PdsCustodyWriteForbidden to a member whose records live on their own PDS', async () => {
      await harness.enrollPdsCustodyMember(KAJI, [HARNESS_ENGINEERING])

      const refused = await createViaHttp(KAJI, 'unit-03', 'Sortie')

      expect(refused.status).toBe(400)
      expect(refused.body).toEqual({
        error: 'PdsCustodyWriteForbidden',
        message: 'This actor writes records to their own PDS',
      })
    })
  })

  describe('createRecord over HTTP with a space credential', () => {
    it('answers 401 AuthenticationRequired to a valid space credential and writes nothing', async () => {
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
      const credential = await harness.mintSpaceCredential(
        MISATO,
        HARNESS_ENGINEERING,
      )

      const refused = await harness.call(
        CREATE_RECORD,
        withCredential(credential),
        {
          repo: MISATO,
          collection: COLLECTION,
          rkey: 'unit-04',
          record: post('Sortie'),
        },
      )

      expect(refused.status).toBe(401)
      expect(refused.body).toEqual({
        error: 'AuthenticationRequired',
        message: 'Authorization failed',
      })
      expect(await harness.sequencedOps(MISATO)).toEqual([])
      expect(await harness.recordRows(uriOf(MISATO, 'unit-04'))).toEqual({
        record: null,
        boundaries: [],
        takedown: null,
      })
    })
  })
}

describe('legacy write baseline on sqlite', () => {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  defineLegacyWriteBaseline(() => harness)
})

describe('legacy write baseline on postgres', () => {
  let connectionString: string
  let harness: WriteHarness

  beforeAll(async () => {
    connectionString = await startPostgresContainer()
  }, 120_000)

  afterAll(async () => {
    await stopPostgresContainer()
  })

  beforeEach(async () => {
    harness = await startPostgresWriteHarness(connectionString)
  }, 60_000)

  afterEach(async () => {
    await harness.close()
  })

  defineLegacyWriteBaseline(() => harness)
})
