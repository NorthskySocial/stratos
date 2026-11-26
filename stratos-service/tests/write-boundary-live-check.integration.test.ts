import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { XRPCError } from '@atproto/xrpc-server'
import { applyWritesBatch, updateRecord } from '../src/api/records/index.js'
import { authorizeBoundary } from '../src/api/records/validation.js'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'
import {
  asMember,
  HARNESS_DESIGN,
  HARNESS_ENGINEERING,
  startPostgresWriteHarness,
  type CallResult,
  type WriteHarness,
} from './helpers/write-harness.js'

const POST = 'zone.stratos.feed.post'
const WARM_RKEY = 'sortie-one'
const NEXT_RKEY = 'sortie-two'

function post(text: string, boundary: string) {
  return {
    $type: POST,
    text,
    createdAt: '1995-10-04T00:00:00.000Z',
    boundary: {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: [{ value: boundary }],
    },
  }
}

/** The HTTP status and error name of a refusal, or null when the write lands. */
type Outcome = string | null

function outcomeOf(response: CallResult): Outcome {
  if (response.status === 200) return null
  const body = response.body as { error?: string } | null
  return `${response.status} ${body?.error ?? ''}`
}

function settle(write: () => Promise<unknown>): Promise<Outcome> {
  return write().then(
    () => null,
    (err: unknown) =>
      err instanceof XRPCError
        ? `${err.statusCode} ${err.error ?? ''}`
        : `thrown ${String(err)}`,
  )
}

interface Procedure {
  name: string
  member: string
  send(instance: WriteHarness, did: string): Promise<Outcome>
}

function callProcedure(
  nsid: string,
  instance: WriteHarness,
  did: string,
  body: Record<string, unknown>,
): Promise<Outcome> {
  return instance
    .call(nsid, asMember(did), { repo: did, ...body })
    .then(outcomeOf)
}

// Each case writes as its own member: the write cache of instance A outlives a
// test, so a member reused across cases would start with a warm entry.
const PROCEDURES: Procedure[] = [
  {
    name: 'zone.stratos.repo.createRecord',
    member: 'did:plc:shinji-ikari',
    send: (instance, did) =>
      callProcedure('zone.stratos.repo.createRecord', instance, did, {
        boundary: HARNESS_DESIGN,
        collection: POST,
        rkey: NEXT_RKEY,
        record: post('Unit-01 second sortie', HARNESS_DESIGN),
      }),
  },
  {
    name: 'zone.stratos.repo.putRecord',
    member: 'did:plc:asuka-langley',
    send: (instance, did) =>
      callProcedure('zone.stratos.repo.putRecord', instance, did, {
        boundary: HARNESS_DESIGN,
        collection: POST,
        rkey: WARM_RKEY,
        record: post('Unit-02 sortie, revised', HARNESS_DESIGN),
      }),
  },
  {
    name: 'zone.stratos.repo.deleteRecord',
    member: 'did:plc:rei-ayanami',
    send: (instance, did) =>
      callProcedure('zone.stratos.repo.deleteRecord', instance, did, {
        boundary: HARNESS_DESIGN,
        collection: POST,
        rkey: WARM_RKEY,
      }),
  },
  {
    name: 'zone.stratos.repo.applyWrites',
    member: 'did:plc:toji-suzuhara',
    send: (instance, did) =>
      callProcedure('zone.stratos.repo.applyWrites', instance, did, {
        boundary: HARNESS_DESIGN,
        writes: [
          {
            $type: 'zone.stratos.repo.applyWrites#create',
            collection: POST,
            rkey: NEXT_RKEY,
            value: post('Unit-03 sortie', HARNESS_DESIGN),
          },
        ],
      }),
  },
  {
    name: 'com.atproto.repo.createRecord',
    member: 'did:plc:kaworu-nagisa',
    send: (instance, did) =>
      callProcedure('com.atproto.repo.createRecord', instance, did, {
        collection: POST,
        rkey: NEXT_RKEY,
        record: post('Unit-13 sortie', HARNESS_DESIGN),
      }),
  },
  // The legacy update and batch are called as their handlers call them: the
  // legacy HTTP applyWrites answers a typed write with 500 before it writes.
  {
    name: 'the legacy update',
    member: 'did:plc:mari-makinami',
    send: (instance, did) =>
      settle(() =>
        updateRecord(
          instance.ctx,
          {
            repo: did,
            collection: POST,
            rkey: WARM_RKEY,
            record: post('Unit-08 sortie, revised', HARNESS_DESIGN),
          },
          did,
        ),
      ),
  },
  {
    name: 'the legacy batch',
    member: 'did:plc:kensuke-aida',
    send: (instance, did) =>
      settle(() =>
        applyWritesBatch(instance.ctx, did, [
          {
            action: 'create',
            collection: POST,
            rkey: NEXT_RKEY,
            record: post('Unit-04 sortie', HARNESS_DESIGN),
          },
        ]),
      ),
  },
]

describe('a boundary removed on another instance', () => {
  let instanceA: WriteHarness
  let instanceB: WriteHarness

  beforeAll(async () => {
    const connectionString = await startPostgresContainer()
    instanceA = await startPostgresWriteHarness(connectionString)
    instanceB = await startPostgresWriteHarness(connectionString)
  }, 120_000)

  afterAll(async () => {
    await instanceB?.close()
    await instanceA?.close()
    await stopPostgresContainer()
  }, 60_000)

  async function warmInstanceA(did: string): Promise<void> {
    await instanceA.enrollMember(did, [HARNESS_ENGINEERING, HARNESS_DESIGN])
    const warm = await callProcedure(
      'zone.stratos.repo.createRecord',
      instanceA,
      did,
      {
        boundary: HARNESS_DESIGN,
        collection: POST,
        rkey: WARM_RKEY,
        record: post('First sortie', HARNESS_DESIGN),
      },
    )
    expect(warm).toBeNull()
  }

  async function removeDesignThroughB(did: string): Promise<void> {
    const removal = await instanceB.removeBoundary(did, HARNESS_DESIGN)
    expect(removal.status).toBe(200)
  }

  async function repoState(did: string) {
    return {
      root: await instanceA.repoRoot(did),
      ops: await instanceA.sequencedOps(did),
      warm: await instanceA.recordRows(`at://${did}/${POST}/${WARM_RKEY}`),
      next: await instanceA.recordRows(`at://${did}/${POST}/${NEXT_RKEY}`),
    }
  }

  describe.each(PROCEDURES)('through $name', (procedure) => {
    it('is refused on instance A at once and stores nothing', async () => {
      const did = procedure.member
      await warmInstanceA(did)
      await removeDesignThroughB(did)
      const before = await repoState(did)

      const outcome = await procedure.send(instanceA, did)

      expect(outcome).toBe('400 ForbiddenBoundary')
      expect(await repoState(did)).toEqual(before)
      expect(before.next.record).toBeNull()
    })
  })

  it('still passes the check before the lock from the cache of instance A', async () => {
    const did = 'did:plc:hikari-horaki'
    await warmInstanceA(did)
    await removeDesignThroughB(did)

    await expect(
      authorizeBoundary(instanceA.ctx, did, HARNESS_DESIGN),
    ).resolves.toBe(HARNESS_DESIGN)
    await expect(
      authorizeBoundary(instanceB.ctx, did, HARNESS_DESIGN),
    ).rejects.toMatchObject({ error: 'ForbiddenBoundary' })
  })
})
