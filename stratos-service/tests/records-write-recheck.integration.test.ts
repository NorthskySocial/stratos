import http from 'node:http'
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
import express from 'express'
import { Secp256k1Keypair } from '@atproto/crypto'
import type { IdResolver } from '@atproto/identity'
import { createServiceJwt, Server as XrpcServer } from '@atproto/xrpc-server'
import { stratosLexicons } from '@northskysocial/stratos-core'
import type { AppContext } from '../src/context.js'
import { applyWritesBatch } from '../src/api/records/batch.js'
import { createRecord } from '../src/api/records/create.js'
import { updateRecord } from '../src/api/records/update.js'
import {
  CREATE_LABEL_METHOD,
  registerModerationHandlers,
} from '../src/features/moderation/index.js'
import { createModerationServiceVerifier } from '../src/infra/auth/verifiers.js'
import {
  HARNESS_DESIGN,
  HARNESS_ENGINEERING,
  startPostgresWriteHarness,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'

const PILOT = 'did:plc:shinji-ikari'
const COLLECTION = 'zone.stratos.feed.post'
const EXISTING_RKEY = 'unit-00'
const NEW_RKEY = 'unit-01'

const uriOf = (rkey: string) => `at://${PILOT}/${COLLECTION}/${rkey}`

function post(text: string) {
  return {
    $type: COLLECTION,
    text,
    createdAt: '1996-10-04T00:00:00.000Z',
    boundary: {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: [{ value: HARNESS_DESIGN }],
    },
  }
}

interface LabelRoute {
  takeDownAccount(did: string): Promise<number>
  close(): Promise<void>
}

/**
 * The real createLabel route and moderation-service verifier over the harness's
 * stores. The moderator's signing key is local and its DID document is served
 * by a resolver that forwards every other DID to the real one.
 */
async function startLabelRoute(harness: WriteHarness): Promise<LabelRoute> {
  const moderator = await Secp256k1Keypair.create({ exportable: true })
  const document = {
    id: moderator.did(),
    verificationMethod: [
      {
        id: `${moderator.did()}#key`,
        type: 'Multikey',
        controller: moderator.did(),
        publicKeyMultibase: moderator.did().slice('did:key:'.length),
      },
    ],
  }
  const realResolver = harness.ctx.idResolver
  const resolver = {
    did: {
      resolve: (did: string) =>
        did === moderator.did()
          ? Promise.resolve(document)
          : realResolver.did.resolve(did),
    },
  } as unknown as IdResolver
  const ctx: AppContext = {
    ...harness.ctx,
    authVerifier: {
      ...harness.ctx.authVerifier,
      moderationService: createModerationServiceVerifier({
        serviceDid: harness.ctx.serviceDid,
        idResolver: resolver,
        allowedIssuers: [moderator.did()],
      }),
    },
  }
  const server = new XrpcServer(stratosLexicons)
  registerModerationHandlers(server, ctx)
  const app = express()
  app.use(server.router)
  const listening: http.Server = await new Promise((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started))
  })
  const { port } = listening.address() as { port: number }

  return {
    async takeDownAccount(did) {
      const jwt = await createServiceJwt({
        iss: moderator.did(),
        aud: harness.ctx.serviceDid,
        lxm: CREATE_LABEL_METHOD,
        keypair: moderator,
      })
      const response = await fetch(
        `http://127.0.0.1:${port}/xrpc/${CREATE_LABEL_METHOD}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({
            subject: {
              $type: 'zone.stratos.moderation.defs#accountSubject',
              did,
            },
            val: '!takedown',
          }),
        },
      )
      return response.status
    },
    close: () =>
      new Promise<void>((resolve) => {
        listening.close(() => resolve())
      }),
  }
}

interface Mutation {
  name: string
  expectedError: string
  /** Whether the mutation itself takes the member's repo lock. */
  takesRepoLock: boolean
  apply(harness: WriteHarness, labels: LabelRoute): Promise<void>
}

const MUTATIONS: Mutation[] = [
  {
    name: 'an operator hold',
    expectedError: 'NotEnrolled',
    takesRepoLock: true,
    apply: (harness) => harness.holdMember(PILOT),
  },
  {
    name: 'an account takedown label',
    expectedError: 'NotEnrolled',
    takesRepoLock: true,
    apply: async (_harness, labels) => {
      expect(await labels.takeDownAccount(PILOT)).toBe(200)
    },
  },
  {
    name: 'a boundary removal',
    expectedError: 'ForbiddenBoundary',
    takesRepoLock: false,
    apply: async (harness) => {
      expect((await harness.removeBoundary(PILOT, HARNESS_DESIGN)).status).toBe(
        200,
      )
    },
  },
]

interface Writer {
  name: string
  /** The record the write targets. */
  rkey: string
  seed(harness: WriteHarness): Promise<void>
  write(ctx: AppContext): Promise<unknown>
}

const WRITERS: Writer[] = [
  {
    name: 'a legacy create',
    rkey: NEW_RKEY,
    seed: async () => {},
    write: (ctx) =>
      createRecord(
        ctx,
        {
          repo: PILOT,
          collection: COLLECTION,
          rkey: NEW_RKEY,
          record: post('Sortie'),
        },
        PILOT,
      ),
  },
  {
    name: 'a legacy update',
    rkey: EXISTING_RKEY,
    seed: async (harness) => {
      await createRecord(
        harness.ctx,
        {
          repo: PILOT,
          collection: COLLECTION,
          rkey: EXISTING_RKEY,
          record: post('Standby'),
        },
        PILOT,
      )
    },
    write: (ctx) =>
      updateRecord(
        ctx,
        {
          repo: PILOT,
          collection: COLLECTION,
          rkey: EXISTING_RKEY,
          record: post('Sortie'),
        },
        PILOT,
      ),
  },
  {
    name: 'a legacy batch',
    rkey: NEW_RKEY,
    seed: async () => {},
    write: (ctx) =>
      applyWritesBatch(ctx, PILOT, [
        {
          action: 'create',
          collection: COLLECTION,
          rkey: NEW_RKEY,
          record: post('Sortie'),
        },
      ]),
  },
]

function defineRecheckScenarios(getHarness: () => WriteHarness) {
  let harness: WriteHarness
  let labels: LabelRoute
  let acquire: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    harness = getHarness()
    labels = await startLabelRoute(harness)
    await harness.enrollMember(PILOT, [HARNESS_ENGINEERING, HARNESS_DESIGN])
  })

  afterEach(async () => {
    acquire?.mockRestore()
    await labels.close()
  })

  /**
   * Runs `mutate` just before the next write takes the member's repo lock, so
   * it lands after every up-front check. Returns how many lock acquisitions the
   * mutation itself made through the same lock object.
   */
  function mutateBeforeNextAcquire(mutate: () => Promise<void>) {
    const realLocks = harness.ctx.repoWriteLocks
    const realAcquire = realLocks.acquire.bind(realLocks)
    let armed = true
    const nested = { acquisitions: 0 }
    acquire = vi
      .spyOn(realLocks, 'acquire')
      .mockImplementation(async (did: string) => {
        if (!armed) {
          nested.acquisitions += 1
          return realAcquire(did)
        }
        armed = false
        await mutate()
        return realAcquire(did)
      })
    return nested
  }

  describe.each(WRITERS)('$name', (writer) => {
    it.each(MUTATIONS)(
      'is refused when $name lands before the lock is taken',
      async (mutation) => {
        await writer.seed(harness)
        const rowsBefore = await harness.recordRows(uriOf(writer.rkey))
        const rootBefore = await harness.repoRoot(PILOT)
        const opsBefore = await harness.sequencedOps(PILOT)
        const nested = mutateBeforeNextAcquire(() =>
          mutation.apply(harness, labels),
        )

        await expect(writer.write(harness.ctx)).rejects.toMatchObject({
          customErrorName: mutation.expectedError,
        })

        expect(nested.acquisitions > 0).toBe(mutation.takesRepoLock)
        expect(await harness.recordRows(uriOf(writer.rkey))).toEqual(rowsBefore)
        expect(await harness.repoRoot(PILOT)).toEqual(rootBefore)
        expect(await harness.sequencedOps(PILOT)).toEqual(opsBefore)
      },
    )

    it('succeeds when nothing changes before the lock is taken', async () => {
      await writer.seed(harness)
      const opsBefore = await harness.sequencedOps(PILOT)
      const rootBefore = await harness.repoRoot(PILOT)
      mutateBeforeNextAcquire(async () => {})

      await writer.write(harness.ctx)

      const rows = await harness.recordRows(uriOf(writer.rkey))
      expect(rows.boundaries).toEqual([HARNESS_DESIGN])
      expect(await harness.repoRoot(PILOT)).not.toEqual(rootBefore)
      expect(await harness.sequencedOps(PILOT)).toHaveLength(
        opsBefore.length + 1,
      )
    })
  })
}

describe('write recheck under the repo lock on sqlite', () => {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  defineRecheckScenarios(() => harness)
})

describe('write recheck under the repo lock on postgres', () => {
  let connectionString: string
  let harness: WriteHarness

  beforeAll(async () => {
    connectionString = await startPostgresContainer()
  }, 120_000)

  afterAll(async () => {
    await stopPostgresContainer()
  }, 60_000)

  beforeEach(async () => {
    harness = await startPostgresWriteHarness(connectionString)
  }, 60_000)

  afterEach(async () => {
    await harness.close()
  })

  defineRecheckScenarios(() => harness)
})
