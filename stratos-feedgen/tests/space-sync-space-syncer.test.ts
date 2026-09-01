import { describe, expect, it, vi } from 'vitest'
import type { PostUpsert } from '../src/db/index.js'
import {
  MalformedCursorError,
  RepoNotFoundError,
  SpaceHostClient,
  SpaceSyncer,
  type GetRecordOptions,
  type GetRecordResult,
  type ListRepoOpsOptions,
  type ListRepoOpsResult,
  type PollTarget,
  type RepoOpEntry,
  type SpaceSyncerDeps,
  type SpaceSyncResult,
  type SpaceSyncSuccess,
} from '../src/space-sync/index.js'

// 90s-anime crew DIDs and boundaries — `{serviceDid}/{domainName}`.
const STRATOS_DID = 'did:web:stratos.test'
const BEBOP_BOUNDARY = `${STRATOS_DID}/bebop-crew`
const SPACE_URI = `at://${STRATOS_DID}/space/zone.stratos.space.feed/bebop-crew`
const SPIKE_DID = 'did:plc:spikespiegel'
const HOST = 'https://spike.example'
const POST_COLLECTION = 'zone.stratos.feed.post'
const FIXED_NOW = '2024-06-01T00:00:00.000Z'
const CID_ONE = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const CID_TWO = 'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzvev6wt667vyrp7k4p72e'

function makeTarget(overrides: Partial<PollTarget> = {}): PollTarget {
  return {
    spaceUri: SPACE_URI,
    boundary: BEBOP_BOUNDARY,
    did: SPIKE_DID,
    host: HOST,
    ...overrides,
  }
}

function makePostRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    $type: POST_COLLECTION,
    text: 'see you space cowboy',
    createdAt: FIXED_NOW,
    ...overrides,
  }
}

/**
 * Omits `value` entirely rather than accepting a boolean flag to control its
 * presence — callers that want an inline value spread it in explicitly;
 * callers that want the `getRecord` fallback path just omit it.
 */
function baseOp(overrides: Partial<RepoOpEntry> = {}): RepoOpEntry {
  return {
    rev: '1',
    collection: POST_COLLECTION,
    rkey: '3jxyz',
    cid: CID_ONE,
    ...overrides,
  }
}

function makePage(
  overrides: Partial<ListRepoOpsResult> = {},
): ListRepoOpsResult {
  return {
    ops: [],
    ...overrides,
  }
}

function fakeStore() {
  return {
    upsertPost: vi.fn(async (_input: PostUpsert): Promise<void> => {}),
    deletePost: vi.fn(async (_uri: string): Promise<void> => {}),
    getSpaceCursor: vi.fn(
      async (_spaceUri: string, _did: string): Promise<string | null> => null,
    ),
    upsertSpaceCursor: vi.fn(
      async (
        _spaceUri: string,
        _did: string,
        _cursor: string,
        _updatedAt: string,
      ): Promise<void> => {},
    ),
    deleteSpaceCursor: vi.fn(
      async (_spaceUri: string, _did: string): Promise<number> => 1,
    ),
  }
}

function fakeCredentialManager() {
  return {
    getCredential: vi.fn(async (boundary: string) => ({
      boundary,
      spaceUri: SPACE_URI,
      credential: `cred-${boundary}`,
      expiresAt: new Date(Date.now() + 3_600_000),
      createPresentationProof: async () => 'proof',
    })),
  }
}

function fakeHostClient() {
  return {
    listRepoOps: vi.fn<
      (opts: ListRepoOpsOptions) => Promise<ListRepoOpsResult>
    >(async () => makePage()),
    getRecord: vi.fn<(opts: GetRecordOptions) => Promise<GetRecordResult>>(
      async () => {
        throw new Error('getRecord not stubbed for this test')
      },
    ),
  }
}

function passThroughMutationFence(): SpaceSyncerDeps['mutationFence'] {
  return {
    mutate: async (_target, signal, mutation) => {
      signal?.throwIfAborted()
      return mutation()
    },
    compensate: async (_target, mutation) => mutation(),
  }
}

interface BuildSyncerOptions {
  store?: ReturnType<typeof fakeStore>
  client?: ReturnType<typeof fakeHostClient>
  credentialManager?: SpaceSyncerDeps['credentialManager']
  maxRecordBytes?: number
  maxPages?: number
  maxRecordsPerMember?: number
  pageLimit?: number
  mutationFence?: SpaceSyncerDeps['mutationFence']
  onError?: (target: PollTarget, err: unknown) => void
}

function buildSyncer(opts: BuildSyncerOptions = {}): {
  syncer: SpaceSyncer
  store: ReturnType<typeof fakeStore>
  client: ReturnType<typeof fakeHostClient>
} {
  const store = opts.store ?? fakeStore()
  const client = opts.client ?? fakeHostClient()
  const syncer = new SpaceSyncer({
    store,
    credentialManager: opts.credentialManager ?? fakeCredentialManager(),
    mutationFence: opts.mutationFence ?? passThroughMutationFence(),
    createHostClient: () => client,
    maxRecordBytes: opts.maxRecordBytes,
    maxPages: opts.maxPages,
    maxRecordsPerMember: opts.maxRecordsPerMember,
    pageLimit: opts.pageLimit,
    now: () => FIXED_NOW,
    onError: opts.onError,
  })
  return { syncer, store, client }
}

function expectSuccess(result: SpaceSyncResult): SpaceSyncSuccess {
  if (!result.ok) {
    throw new Error(`expected success, got failure: ${String(result.error)}`)
  }
  return result
}

describe('SpaceSyncer', () => {
  describe('create and delete propagation', () => {
    it('indexes a created post from an inline op value', async () => {
      const { syncer, store, client } = buildSyncer({
        client: (() => {
          const c = fakeHostClient()
          c.listRepoOps.mockResolvedValue(
            makePage({ ops: [baseOp({ value: makePostRecord() })] }),
          )
          return c
        })(),
      })

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(result.recordsIndexed).toBe(1)
      expect(result.recordsDeleted).toBe(0)
      expect(result.pagesFetched).toBe(1)
      expect(result.stopReason).toBe('complete')
      expect(store.upsertPost).toHaveBeenCalledWith({
        uri: `${SPACE_URI}/${SPIKE_DID}/${POST_COLLECTION}/3jxyz`,
        did: SPIKE_DID,
        cid: CID_ONE,
        sortAt: FIXED_NOW,
        indexedAt: FIXED_NOW,
        record: makePostRecord(),
        blobRefs: [],
        boundaries: [BEBOP_BOUNDARY],
      })
      expect(client.getRecord).not.toHaveBeenCalled()
    })

    it('deletes a post when the op cid is null', async () => {
      const { syncer, store, client } = buildSyncer()
      client.listRepoOps.mockResolvedValue(
        makePage({ ops: [baseOp({ cid: null })] }),
      )

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(result.recordsDeleted).toBe(1)
      expect(result.recordsIndexed).toBe(0)
      expect(store.deletePost).toHaveBeenCalledWith(
        `${SPACE_URI}/${SPIKE_DID}/${POST_COLLECTION}/3jxyz`,
      )
      expect(store.upsertPost).not.toHaveBeenCalled()
    })

    it('updates an existing post the same way it creates one', async () => {
      const { syncer, store, client } = buildSyncer()
      client.listRepoOps.mockResolvedValue(
        makePage({
          ops: [
            baseOp({ cid: CID_TWO, value: makePostRecord({ text: 'v2' }) }),
          ],
        }),
      )

      await syncer.syncTarget(makeTarget())

      expect(store.upsertPost).toHaveBeenCalledWith(
        expect.objectContaining({
          cid: CID_TWO,
          record: expect.objectContaining({ text: 'v2' }),
        }),
      )
    })
  })

  describe('superseded-op coalescing', () => {
    it('elides the getRecord fetch for a superseded op on the same path', async () => {
      const { syncer, store, client } = buildSyncer()
      client.listRepoOps.mockResolvedValue(
        makePage({
          ops: [
            baseOp({ cid: CID_ONE }),
            baseOp({ cid: CID_TWO, value: makePostRecord() }),
          ],
        }),
      )

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(client.getRecord).not.toHaveBeenCalled()
      expect(store.upsertPost).toHaveBeenCalledTimes(1)
      expect(store.upsertPost).toHaveBeenCalledWith(
        expect.objectContaining({ cid: CID_TWO }),
      )
      expect(result.recordsIndexed).toBe(1)
    })
  })

  describe('getRecord fallback', () => {
    it('fetches the record when the op carries no inline value', async () => {
      const { syncer, store, client } = buildSyncer()
      client.listRepoOps.mockResolvedValue(makePage({ ops: [baseOp()] }))
      client.getRecord.mockResolvedValue({
        uri: `${SPACE_URI}/${SPIKE_DID}/${POST_COLLECTION}/3jxyz`,
        cid: CID_ONE,
        value: makePostRecord(),
      })

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(client.getRecord).toHaveBeenCalledWith({
        space: SPACE_URI,
        repo: SPIKE_DID,
        collection: POST_COLLECTION,
        rkey: '3jxyz',
      })
      expect(store.upsertPost).toHaveBeenCalledWith(
        expect.objectContaining({ cid: CID_ONE, record: makePostRecord() }),
      )
      expect(result.recordsIndexed).toBe(1)
    })

    it('aborts the target when getRecord fails', async () => {
      const { syncer, store, client } = buildSyncer({ onError: vi.fn() })
      client.listRepoOps.mockResolvedValue(makePage({ ops: [baseOp()] }))
      client.getRecord.mockRejectedValue(
        new RepoNotFoundError({ status: 404, body: '', url: HOST }),
      )

      const result = await syncer.syncTarget(makeTarget())

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('member-skip')
      expect(store.upsertPost).not.toHaveBeenCalled()
      expect(store.upsertSpaceCursor).not.toHaveBeenCalled()
    })

    it.each([
      {
        field: 'uri',
        uri: `${SPACE_URI}/${SPIKE_DID}/${POST_COLLECTION}/different`,
        cid: CID_ONE,
      },
      {
        field: 'cid',
        uri: `${SPACE_URI}/${SPIKE_DID}/${POST_COLLECTION}/3jxyz`,
        cid: CID_TWO,
      },
    ])(
      'skips a fallback whose returned $field does not match the requested op',
      async ({ uri, cid }) => {
        const { syncer, store, client } = buildSyncer()
        client.listRepoOps.mockResolvedValue(makePage({ ops: [baseOp()] }))
        client.getRecord.mockResolvedValue({
          uri,
          cid,
          value: makePostRecord(),
        })

        const result = expectSuccess(await syncer.syncTarget(makeTarget()))

        expect(result.skippedMalformed).toBe(1)
        expect(result.recordsIndexed).toBe(0)
        expect(store.upsertPost).not.toHaveBeenCalled()
      },
    )
  })

  describe('cursor handling', () => {
    it('resumes from a previously stored cursor', async () => {
      const store = fakeStore()
      store.getSpaceCursor.mockResolvedValue('resume-cursor')
      const { syncer, client } = buildSyncer({ store })

      await syncer.syncTarget(makeTarget())

      expect(client.listRepoOps).toHaveBeenCalledWith(
        expect.objectContaining({
          space: SPACE_URI,
          repo: SPIKE_DID,
          cursor: 'resume-cursor',
        }),
      )
    })

    it('starts cold when no cursor is stored', async () => {
      const { syncer, client } = buildSyncer()

      await syncer.syncTarget(makeTarget())

      expect(client.listRepoOps).toHaveBeenCalledWith(
        expect.objectContaining({
          space: SPACE_URI,
          repo: SPIKE_DID,
          cursor: undefined,
        }),
      )
    })

    it('persists the page cursor only while a page is non-terminal', async () => {
      const { syncer, store, client } = buildSyncer()
      client.listRepoOps
        .mockResolvedValueOnce(makePage({ ops: [], cursor: 'page-2' }))
        .mockResolvedValueOnce(makePage({ ops: [] }))

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(store.upsertSpaceCursor).toHaveBeenCalledTimes(1)
      expect(store.upsertSpaceCursor).toHaveBeenCalledWith(
        SPACE_URI,
        SPIKE_DID,
        'page-2',
        FIXED_NOW,
      )
      expect(result.pagesFetched).toBe(2)
      expect(result.stopReason).toBe('complete')
    })

    it('drops the cursor and reports malformed-cursor when the host rejects it', async () => {
      const store = fakeStore()
      store.getSpaceCursor.mockResolvedValue('stale-cursor')
      const onError = vi.fn()
      const { syncer, client } = buildSyncer({ store, onError })
      const err = new MalformedCursorError({ status: 400, body: '', url: HOST })
      client.listRepoOps.mockRejectedValue(err)

      const result = await syncer.syncTarget(makeTarget())

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('malformed-cursor')
        expect(result.error).toBe(err)
      }
      expect(store.deleteSpaceCursor).toHaveBeenCalledWith(SPACE_URI, SPIKE_DID)
      expect(onError).toHaveBeenCalledWith(makeTarget(), err)
    })

    it('leaves the cursor untouched on any other failure (member-skip)', async () => {
      const store = fakeStore()
      const onError = vi.fn()
      const { syncer, client } = buildSyncer({ store, onError })
      const err = new RepoNotFoundError({ status: 404, body: '', url: HOST })
      client.listRepoOps.mockRejectedValue(err)

      const result = await syncer.syncTarget(makeTarget())

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('member-skip')
        expect(result.error).toBe(err)
      }
      expect(store.deleteSpaceCursor).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledWith(makeTarget(), err)
    })
  })

  describe('record size cap', () => {
    it('skips an oversized decoded record without indexing it', async () => {
      const { syncer, store, client } = buildSyncer({ maxRecordBytes: 10 })
      client.listRepoOps.mockResolvedValue(
        makePage({ ops: [baseOp({ value: makePostRecord() })] }),
      )

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(result.skippedOversized).toBe(1)
      expect(result.recordsIndexed).toBe(0)
      expect(store.upsertPost).not.toHaveBeenCalled()
    })

    it('accepts a record exactly at the byte cap', async () => {
      const value = makePostRecord()
      const exactSize = Buffer.byteLength(JSON.stringify(value), 'utf8')
      const { syncer, store, client } = buildSyncer({
        maxRecordBytes: exactSize,
      })
      client.listRepoOps.mockResolvedValue(
        makePage({ ops: [baseOp({ value })] }),
      )

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(result.skippedOversized).toBe(0)
      expect(result.recordsIndexed).toBe(1)
      expect(store.upsertPost).toHaveBeenCalled()
    })
  })

  describe('createdAt clamp', () => {
    it('passes through a plausible past createdAt unchanged', async () => {
      const { syncer, store, client } = buildSyncer()
      client.listRepoOps.mockResolvedValue(
        makePage({
          ops: [
            baseOp({
              value: makePostRecord({ createdAt: '2020-01-01T00:00:00.000Z' }),
            }),
          ],
        }),
      )

      await syncer.syncTarget(makeTarget())

      expect(store.upsertPost).toHaveBeenCalledWith(
        expect.objectContaining({ sortAt: '2020-01-01T00:00:00.000Z' }),
      )
    })

    it('clamps a future createdAt to now', async () => {
      const { syncer, store, client } = buildSyncer()
      client.listRepoOps.mockResolvedValue(
        makePage({
          ops: [
            baseOp({
              value: makePostRecord({ createdAt: '2999-01-01T00:00:00.000Z' }),
            }),
          ],
        }),
      )

      await syncer.syncTarget(makeTarget())

      expect(store.upsertPost).toHaveBeenCalledWith(
        expect.objectContaining({ sortAt: FIXED_NOW }),
      )
    })

    it('clamps an unparseable createdAt to now', async () => {
      const { syncer, store, client } = buildSyncer()
      client.listRepoOps.mockResolvedValue(
        makePage({
          ops: [baseOp({ value: makePostRecord({ createdAt: 'not-a-date' }) })],
        }),
      )

      await syncer.syncTarget(makeTarget())

      expect(store.upsertPost).toHaveBeenCalledWith(
        expect.objectContaining({ sortAt: FIXED_NOW }),
      )
    })

    it('passes through a createdAt exactly at now unchanged, not clamped', async () => {
      const { syncer, store, client } = buildSyncer()
      // Same instant as FIXED_NOW, spelled without the milliseconds group, so
      // it is a distinct string that parses to an equal millisecond value.
      const sameInstantDifferentSpelling = '2024-06-01T00:00:00Z'
      client.listRepoOps.mockResolvedValue(
        makePage({
          ops: [
            baseOp({
              value: makePostRecord({
                createdAt: sameInstantDifferentSpelling,
              }),
            }),
          ],
        }),
      )

      await syncer.syncTarget(makeTarget())

      expect(store.upsertPost).toHaveBeenCalledWith(
        expect.objectContaining({ sortAt: sameInstantDifferentSpelling }),
      )
    })
  })

  describe('malformed op rejection', () => {
    it('skips a post op with a malformed CID', async () => {
      const { syncer, store, client } = buildSyncer()
      client.listRepoOps.mockResolvedValue(
        makePage({
          ops: [baseOp({ cid: 'not-a-cid', value: makePostRecord() })],
        }),
      )

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(result.skippedMalformed).toBe(1)
      expect(result.recordsIndexed).toBe(0)
      expect(store.upsertPost).not.toHaveBeenCalled()
    })

    it.each([
      ['missing', { text: 'not typed' }],
      ['wrong', { $type: 'zone.stratos.actor.profile', text: 'wrong type' }],
    ] as const)(
      'skips an inline post record with a %s $type',
      async (_label, value) => {
        const { syncer, store, client } = buildSyncer()
        client.listRepoOps.mockResolvedValue(
          makePage({ ops: [baseOp({ value })] }),
        )

        const result = expectSuccess(await syncer.syncTarget(makeTarget()))

        expect(result.skippedMalformed).toBe(1)
        expect(result.recordsIndexed).toBe(0)
        expect(store.upsertPost).not.toHaveBeenCalled()
      },
    )

    it('skips a fallback post record with the wrong $type', async () => {
      const { syncer, store, client } = buildSyncer()
      client.listRepoOps.mockResolvedValue(makePage({ ops: [baseOp()] }))
      client.getRecord.mockResolvedValue({
        uri: `${SPACE_URI}/${SPIKE_DID}/${POST_COLLECTION}/3jxyz`,
        cid: CID_ONE,
        value: { $type: 'zone.stratos.actor.profile' },
      })

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(result.skippedMalformed).toBe(1)
      expect(result.recordsIndexed).toBe(0)
      expect(store.upsertPost).not.toHaveBeenCalled()
    })

    it('rejects an op with an invalid collection NSID', async () => {
      const { syncer, store, client } = buildSyncer()
      client.listRepoOps.mockResolvedValue(
        makePage({
          ops: [
            baseOp({
              collection: 'zone/stratos.feed.post',
              value: makePostRecord(),
            }),
          ],
        }),
      )

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(result.skippedMalformed).toBe(1)
      expect(result.recordsIndexed).toBe(0)
      expect(store.upsertPost).not.toHaveBeenCalled()
    })

    it('rejects an op with an invalid rkey', async () => {
      const { syncer, store, client } = buildSyncer()
      client.listRepoOps.mockResolvedValue(
        makePage({
          ops: [baseOp({ rkey: 'bad/rkey', value: makePostRecord() })],
        }),
      )

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(result.skippedMalformed).toBe(1)
      expect(store.upsertPost).not.toHaveBeenCalled()
    })

    it('ignores a non-post collection without counting it as malformed', async () => {
      const { syncer, store, client } = buildSyncer()
      client.listRepoOps
        .mockResolvedValueOnce(
          makePage({
            ops: [
              baseOp({
                collection: 'zone.stratos.actor.profile',
                value: { $type: 'zone.stratos.actor.profile' },
              }),
            ],
            cursor: 'page-2',
          }),
        )
        .mockResolvedValueOnce(makePage({ ops: [] }))

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(result.skippedMalformed).toBe(0)
      expect(result.recordsIndexed).toBe(0)
      expect(store.upsertPost).not.toHaveBeenCalled()
      expect(store.upsertSpaceCursor).toHaveBeenCalledWith(
        SPACE_URI,
        SPIKE_DID,
        'page-2',
        FIXED_NOW,
      )
    })

    it('treats a non-object inline value as malformed without calling getRecord', async () => {
      const { syncer, store, client } = buildSyncer()
      client.listRepoOps.mockResolvedValue(
        makePage({ ops: [baseOp({ value: ['not-a-record'] })] }),
      )

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(result.skippedMalformed).toBe(1)
      expect(client.getRecord).not.toHaveBeenCalled()
      expect(store.upsertPost).not.toHaveBeenCalled()
    })

    it('treats a null inline value as malformed without calling getRecord', async () => {
      const { syncer, store, client } = buildSyncer()
      client.listRepoOps.mockResolvedValue(
        makePage({ ops: [baseOp({ value: null })] }),
      )

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(result.skippedMalformed).toBe(1)
      expect(client.getRecord).not.toHaveBeenCalled()
      expect(store.upsertPost).not.toHaveBeenCalled()
    })

    it('treats a scalar inline value as malformed without calling getRecord', async () => {
      const { syncer, store, client } = buildSyncer()
      client.listRepoOps.mockResolvedValue(
        makePage({ ops: [baseOp({ value: 'not-a-record' })] }),
      )

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(result.skippedMalformed).toBe(1)
      expect(client.getRecord).not.toHaveBeenCalled()
      expect(store.upsertPost).not.toHaveBeenCalled()
    })
  })

  describe('boundary claim strip', () => {
    it('always stamps the poll target boundary, ignoring any boundary claim in the record', async () => {
      const { syncer, store, client } = buildSyncer()
      client.listRepoOps.mockResolvedValue(
        makePage({
          ops: [
            baseOp({
              value: makePostRecord({
                boundary: 'attacker-supplied-boundary',
                boundaries: ['attacker-supplied-boundary'],
              }),
            }),
          ],
        }),
      )

      await syncer.syncTarget(makeTarget())

      expect(store.upsertPost).toHaveBeenCalledWith(
        expect.objectContaining({ boundaries: [BEBOP_BOUNDARY] }),
      )
    })
  })

  describe('per-member cap', () => {
    it('rejects a host response that exceeds the requested remaining capacity before applying it', async () => {
      const onError = vi.fn()
      const { syncer, store, client } = buildSyncer({
        maxRecordsPerMember: 1,
        onError,
      })
      client.listRepoOps.mockResolvedValue(
        makePage({
          ops: [
            baseOp({ rkey: 'one', value: makePostRecord() }),
            baseOp({ rkey: 'two', value: makePostRecord() }),
          ],
          cursor: 'page-2',
        }),
      )

      const result = await syncer.syncTarget(makeTarget())

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('member-skip')
      expect(store.upsertPost).not.toHaveBeenCalled()
      expect(client.listRepoOps).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1 }),
      )
      expect(client.listRepoOps).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenCalledTimes(1)
    })

    it('stops when recordsIndexed lands exactly on the cap', async () => {
      const { syncer, client } = buildSyncer({ maxRecordsPerMember: 2 })
      client.listRepoOps.mockResolvedValue(
        makePage({
          ops: [
            baseOp({ rkey: 'one', value: makePostRecord() }),
            baseOp({ rkey: 'two', value: makePostRecord() }),
          ],
          cursor: 'page-2',
        }),
      )

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(result.recordsIndexed).toBe(2)
      expect(result.stopReason).toBe('per-member-cap')
      expect(client.listRepoOps).toHaveBeenCalledTimes(1)
    })

    it('reports complete when an exact-cap page is genuinely terminal', async () => {
      const { syncer, client } = buildSyncer({ maxRecordsPerMember: 1 })
      client.listRepoOps.mockResolvedValue(
        makePage({ ops: [baseOp({ value: makePostRecord() })] }),
      )

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(result.recordsIndexed).toBe(1)
      expect(result.stopReason).toBe('complete')
      expect(client.listRepoOps).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1 }),
      )
    })
  })

  describe('max pages bound', () => {
    it('stops after maxPages and retains its resumable progress', async () => {
      const { syncer, store, client } = buildSyncer({ maxPages: 2 })
      client.listRepoOps
        .mockResolvedValueOnce(makePage({ ops: [], cursor: 'page-2' }))
        .mockResolvedValueOnce(makePage({ ops: [], cursor: 'page-3' }))

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(client.listRepoOps).toHaveBeenCalledTimes(2)
      expect(result.pagesFetched).toBe(2)
      expect(result.stopReason).toBe('max-pages')
      expect(store.upsertSpaceCursor).toHaveBeenLastCalledWith(
        SPACE_URI,
        SPIKE_DID,
        'page-3',
        FIXED_NOW,
      )
      expect(store.deleteSpaceCursor).not.toHaveBeenCalled()
    })
  })

  describe('finalCommit', () => {
    it('surfaces the commit envelope from the terminal page', async () => {
      const { syncer, client } = buildSyncer()
      client.listRepoOps.mockResolvedValue(
        makePage({ ops: [], commit: { sig: 'abc' } }),
      )

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(result.finalCommit).toEqual({ sig: 'abc' })
    })

    it('omits finalCommit when the terminal page carries none', async () => {
      const { syncer, client } = buildSyncer()
      client.listRepoOps.mockResolvedValue(makePage({ ops: [] }))

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(result.finalCommit).toBeUndefined()
      expect('finalCommit' in result).toBe(false)
    })

    it('ignores a commit envelope on a non-terminal page', async () => {
      const { syncer, client } = buildSyncer()
      client.listRepoOps
        .mockResolvedValueOnce(
          makePage({ ops: [], cursor: 'page-2', commit: { sig: 'ignored' } }),
        )
        .mockResolvedValueOnce(makePage({ ops: [] }))

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(result.finalCommit).toBeUndefined()
    })
  })

  describe('failure logging', () => {
    it('logs the failed target to console.error when no onError override is given', async () => {
      const consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {})
      const { syncer, client } = buildSyncer()
      const err = new RepoNotFoundError({ status: 404, body: '', url: HOST })
      client.listRepoOps.mockRejectedValue(err)

      await syncer.syncTarget(makeTarget())

      expect(consoleError).toHaveBeenCalledWith(
        `space sync failed for ${SPIKE_DID} in ${SPACE_URI}:`,
        err,
      )
      consoleError.mockRestore()
    })
  })

  describe('blob ref wiring', () => {
    it('extracts blob refs from an embed on the resolved record', async () => {
      const { syncer, store, client } = buildSyncer()
      client.listRepoOps.mockResolvedValue(
        makePage({
          ops: [
            baseOp({
              value: makePostRecord({
                embed: {
                  $type: 'app.bsky.embed.images',
                  images: [
                    {
                      image: {
                        ref: { $link: 'bafkreicid' },
                        mimeType: 'image/jpeg',
                      },
                    },
                  ],
                },
              }),
            }),
          ],
        }),
      )

      await syncer.syncTarget(makeTarget())

      expect(store.upsertPost).toHaveBeenCalledWith(
        expect.objectContaining({
          blobRefs: [{ cid: 'bafkreicid', mimeType: 'image/jpeg' }],
        }),
      )
    })
  })

  describe('mixed page', () => {
    it('applies every op kind on one page and reports combined counts', async () => {
      const { syncer, store, client } = buildSyncer()
      client.listRepoOps.mockResolvedValue(
        makePage({
          ops: [
            // Create via inline value.
            baseOp({ rkey: 'created', value: makePostRecord() }),
            // Delete.
            baseOp({ rkey: 'deleted', cid: null }),
            // Malformed collection — grammar-invalid, always skipped.
            baseOp({
              rkey: 'bad-collection',
              collection: 'zone/stratos.feed.post',
              value: makePostRecord(),
            }),
            // Non-post collection — silently ignored, not malformed.
            baseOp({
              rkey: 'other-collection',
              collection: 'zone.stratos.actor.profile',
              value: { $type: 'zone.stratos.actor.profile' },
            }),
            // Superseded pair on the same path — only the second is applied.
            baseOp({ rkey: 'superseded', cid: CID_ONE }),
            baseOp({
              rkey: 'superseded',
              cid: CID_TWO,
              value: makePostRecord(),
            }),
          ],
        }),
      )

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(result.recordsIndexed).toBe(2)
      expect(result.recordsDeleted).toBe(1)
      expect(result.skippedMalformed).toBe(1)
      expect(client.getRecord).not.toHaveBeenCalled()
      expect(store.upsertPost).toHaveBeenCalledTimes(2)
      expect(store.upsertPost).toHaveBeenCalledWith(
        expect.objectContaining({
          uri: `${SPACE_URI}/${SPIKE_DID}/${POST_COLLECTION}/superseded`,
          cid: CID_TWO,
        }),
      )
    })
  })

  describe('host client construction', () => {
    it('creates the host client with the target host and minted credential', async () => {
      const client = fakeHostClient()
      const createHostClient = vi.fn(() => client)
      const credential = {
        boundary: BEBOP_BOUNDARY,
        spaceUri: SPACE_URI,
        credential: 'cred-fixed',
        expiresAt: new Date('2024-06-01T01:00:00.000Z'),
        createPresentationProof: async () => 'proof',
      }

      const syncer = new SpaceSyncer({
        store: fakeStore(),
        credentialManager: { getCredential: vi.fn(async () => credential) },
        mutationFence: passThroughMutationFence(),
        createHostClient,
        now: () => FIXED_NOW,
      })

      await syncer.syncTarget(makeTarget())

      expect(createHostClient).toHaveBeenCalledWith({
        hostOrigin: HOST,
        credentialProof: credential,
      })
    })

    it('falls back to a real SpaceHostClient when no factory override is given', async () => {
      const listRepoOps = vi
        .spyOn(SpaceHostClient.prototype, 'listRepoOps')
        .mockResolvedValue(makePage({ ops: [] }))

      const syncer = new SpaceSyncer({
        store: fakeStore(),
        credentialManager: fakeCredentialManager(),
        mutationFence: passThroughMutationFence(),
        now: () => FIXED_NOW,
      })

      const result = expectSuccess(await syncer.syncTarget(makeTarget()))

      expect(listRepoOps).toHaveBeenCalledTimes(1)
      expect(result.stopReason).toBe('complete')
      listRepoOps.mockRestore()
    })
  })

  describe('default clock', () => {
    it('stamps a record with a real timestamp when no clock override is given', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(FIXED_NOW))
      try {
        const client = fakeHostClient()
        client.listRepoOps.mockResolvedValue(
          makePage({ ops: [baseOp({ value: makePostRecord() })] }),
        )
        const store = fakeStore()
        const syncer = new SpaceSyncer({
          store,
          credentialManager: fakeCredentialManager(),
          mutationFence: passThroughMutationFence(),
          createHostClient: () => client,
        })

        await syncer.syncTarget(makeTarget())

        expect(store.upsertPost).toHaveBeenCalledWith(
          expect.objectContaining({ indexedAt: FIXED_NOW }),
        )
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('page limit forwarding', () => {
    it('forwards pageLimit as listRepoOps limit', async () => {
      const { syncer, client } = buildSyncer({ pageLimit: 50 })
      client.listRepoOps.mockResolvedValue(makePage({ ops: [] }))

      await syncer.syncTarget(makeTarget())

      expect(client.listRepoOps).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50 }),
      )
    })
  })

  describe('cancellation', () => {
    it('restores an absent starting cursor when the signal aborts mid-sync', async () => {
      const { syncer, store, client } = buildSyncer()
      const controller = new AbortController()
      client.listRepoOps
        .mockImplementationOnce(async () =>
          makePage({
            ops: [baseOp({ value: makePostRecord() })],
            cursor: 'page-2',
          }),
        )
        .mockImplementationOnce(async () => {
          controller.abort()
          return makePage({
            ops: [baseOp({ rkey: 'never', value: makePostRecord() })],
          })
        })

      const result = await syncer.syncTarget(makeTarget(), controller.signal)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('aborted')
      expect(store.upsertPost).toHaveBeenCalledTimes(1)
      expect(store.upsertSpaceCursor).toHaveBeenCalledWith(
        SPACE_URI,
        SPIKE_DID,
        'page-2',
        FIXED_NOW,
      )
      expect(store.deleteSpaceCursor).toHaveBeenCalledExactlyOnceWith(
        SPACE_URI,
        SPIKE_DID,
      )
    })

    it('restores an existing starting cursor when the signal aborts mid-sync', async () => {
      const store = fakeStore()
      store.getSpaceCursor.mockResolvedValue('resume-cursor')
      const { syncer, client } = buildSyncer({ store })
      const controller = new AbortController()
      client.listRepoOps
        .mockResolvedValueOnce(makePage({ ops: [], cursor: 'page-2' }))
        .mockImplementationOnce(async () => {
          controller.abort()
          return makePage({ ops: [] })
        })

      const result = await syncer.syncTarget(makeTarget(), controller.signal)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('aborted')
      expect(store.upsertSpaceCursor).toHaveBeenNthCalledWith(
        1,
        SPACE_URI,
        SPIKE_DID,
        'page-2',
        FIXED_NOW,
      )
      expect(store.upsertSpaceCursor).toHaveBeenLastCalledWith(
        SPACE_URI,
        SPIKE_DID,
        'resume-cursor',
        FIXED_NOW,
      )
      expect(store.deleteSpaceCursor).not.toHaveBeenCalled()
    })

    it('returns an aborted result immediately when the signal is already aborted before the first checkpoint', async () => {
      const { syncer, store, client } = buildSyncer()
      client.listRepoOps.mockResolvedValue(
        makePage({ ops: [baseOp({ value: makePostRecord() })] }),
      )
      const controller = new AbortController()
      controller.abort()

      const result = await syncer.syncTarget(makeTarget(), controller.signal)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('aborted')
      expect(store.upsertPost).not.toHaveBeenCalled()
      expect(store.deleteSpaceCursor).not.toHaveBeenCalled()
    })

    it('reports an aborted host request as caller cancellation', async () => {
      const { syncer, client } = buildSyncer()
      const controller = new AbortController()
      client.listRepoOps.mockImplementation(async () => {
        controller.abort()
        throw new DOMException('aborted', 'AbortError')
      })

      const result = await syncer.syncTarget(makeTarget(), controller.signal)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('aborted')
    })

    it('forwards the signal to listRepoOps and getRecord', async () => {
      const { syncer, client } = buildSyncer()
      const controller = new AbortController()
      client.listRepoOps.mockResolvedValue(makePage({ ops: [baseOp()] }))
      client.getRecord.mockResolvedValue({
        uri: `${SPACE_URI}/${SPIKE_DID}/${POST_COLLECTION}/3jxyz`,
        cid: CID_ONE,
        value: makePostRecord(),
      })

      await syncer.syncTarget(makeTarget(), controller.signal)

      expect(client.listRepoOps).toHaveBeenCalledWith(
        expect.objectContaining({ signal: controller.signal }),
      )
      expect(client.getRecord).toHaveBeenCalledWith(
        expect.objectContaining({ signal: controller.signal }),
      )
    })
  })
})
