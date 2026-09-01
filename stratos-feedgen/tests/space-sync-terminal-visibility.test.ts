import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSqliteDb,
  migrateSqliteDb,
  SqliteFeedgenStore,
  type FeedgenStore,
} from '../src/db/index.js'
import { SpaceMutationFence } from '../src/mutation-fence.js'
import { Purger } from '../src/purge/index.js'
import {
  SpaceSyncer,
  SpaceSyncRunner,
  type CommitVerifyResult,
  type ListRepoOpsOptions,
  type ListRepoOpsResult,
  type PollTarget,
} from '../src/space-sync/index.js'

const STRATOS_DID = 'did:web:stratos.test'
const BOUNDARY = `${STRATOS_DID}/bebop-crew`
const SPACE_URI = `at://${STRATOS_DID}/space/zone.stratos.space.feed/bebop-crew`
const SPIKE_DID = 'did:plc:spikespiegel'
const HOST = 'https://spike.example'
const POST_COLLECTION = 'zone.stratos.feed.post'
const POST_URI = `${SPACE_URI}/${SPIKE_DID}/${POST_COLLECTION}/3jxyz`
const TERMINAL_POST_URI = `${SPACE_URI}/${SPIKE_DID}/${POST_COLLECTION}/3jabc`
const FRESH_POST_URI = `${SPACE_URI}/${SPIKE_DID}/${POST_COLLECTION}/3jfresh`
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const NOW = '2024-06-01T00:00:00.000Z'

let store: FeedgenStore
const tempDirs: string[] = []

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feedgen-terminal-visibility-'))
  tempDirs.push(dir)
  const db = createSqliteDb(join(dir, 'feedgen.sqlite'))
  await migrateSqliteDb(db)
  store = new SqliteFeedgenStore(db)
})

afterEach(async () => {
  await store.close()
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true })
  }
  tempDirs.length = 0
})

function makeTarget(overrides: Partial<PollTarget> = {}): PollTarget {
  return {
    spaceUri: SPACE_URI,
    boundary: BOUNDARY,
    did: SPIKE_DID,
    host: HOST,
    ...overrides,
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function issueRunTarget(
  mutationFence: SpaceMutationFence,
): Promise<PollTarget> {
  const target = makeTarget()
  const leases = await mutationFence.authorizeSnapshot({
    boundary: target.boundary,
    spaceUri: target.spaceUri,
    dids: [target.did],
    revocationEpoch: mutationFence.captureRevocationEpoch(),
  })
  return mutationFence.issueRunLease({
    ...target,
    lease: leases.get(target.did),
  })
}

function buildRunner(
  mutationFence: SpaceMutationFence,
  verifier: { verify: (...args: never[]) => Promise<CommitVerifyResult> },
  pages: readonly ListRepoOpsResult[] = [
    {
      ops: [
        {
          rev: '1',
          collection: POST_COLLECTION,
          rkey: '3jxyz',
          cid: CID,
          value: {
            $type: POST_COLLECTION,
            text: 'See you, space cowboy.',
            createdAt: NOW,
          },
        },
      ],
      commit: { sig: 'terminal' },
    },
  ],
  onListRepoOps?: (options: ListRepoOpsOptions) => void,
): SpaceSyncRunner {
  let pageIndex = 0
  const syncer = new SpaceSyncer({
    store,
    credentialManager: {
      getCredential: vi.fn(async (boundary: string) => ({
        boundary,
        spaceUri: SPACE_URI,
        credential: 'credential',
        expiresAt: new Date('2024-06-01T01:00:00.000Z'),
        createPresentationProof: async () => 'proof',
      })),
    },
    mutationFence,
    createHostClient: () => ({
      listRepoOps: vi.fn(async (options: ListRepoOpsOptions) => {
        onListRepoOps?.(options)
        return pages[pageIndex++] ?? { ops: [] }
      }),
      getRecord: vi.fn(),
    }),
    now: () => NOW,
  })
  return new SpaceSyncRunner({
    syncer,
    verifier,
    purger: new Purger({ store, mutationFence, audit: () => {} }),
    mutationFence,
    onError: () => {},
  })
}

describe('space sync terminal visibility', () => {
  it('keeps a terminal page unserved until its commit verifies', async () => {
    const mutationFence = new SpaceMutationFence()
    const verificationStarted = deferred<void>()
    const verification = deferred<CommitVerifyResult>()
    const verifier = {
      verify: vi.fn(async () => {
        verificationStarted.resolve()
        return verification.promise
      }),
    }
    const runner = buildRunner(mutationFence, verifier)
    const target = await issueRunTarget(mutationFence)

    const run = runner.runTarget(target)
    await verificationStarted.promise

    expect(await store.getPost(POST_URI)).toBeNull()
    expect(
      await store.listPostsByBoundary({ boundary: BOUNDARY, limit: 10 }),
    ).toEqual({ posts: [] })

    verification.resolve({ ok: true })
    expect(await run).toMatchObject({ ok: true })
    expect(await store.getPost(POST_URI)).toMatchObject({
      uri: POST_URI,
      boundaries: [BOUNDARY],
    })
  })

  it('keeps a verified terminal page unserved when its exact run lease is stale', async () => {
    const mutationFence = new SpaceMutationFence()
    const verificationStarted = deferred<void>()
    const verification = deferred<CommitVerifyResult>()
    const verifier = {
      verify: vi.fn(async () => {
        verificationStarted.resolve()
        return verification.promise
      }),
    }
    const runner = buildRunner(mutationFence, verifier)
    const target = await issueRunTarget(mutationFence)

    const run = runner.runTarget(target)
    await verificationStarted.promise
    await mutationFence.issueRunLease(target)
    verification.resolve({ ok: true })

    await expect(run).resolves.toMatchObject({
      ok: false,
      reason: 'member-skip',
    })
    expect(await store.getPost(POST_URI)).toBeNull()
  })

  it('does not let a fresh run promote a terminal stage awaiting stale verification', async () => {
    const mutationFence = new SpaceMutationFence()
    const verificationStarted = deferred<void>()
    const staleVerification = deferred<CommitVerifyResult>()
    const staleVerifier = {
      verify: vi.fn(async () => {
        verificationStarted.resolve()
        return staleVerification.promise
      }),
    }
    const staleRunner = buildRunner(mutationFence, staleVerifier, [
      {
        ops: [
          {
            rev: '1',
            collection: POST_COLLECTION,
            rkey: '3jxyz',
            cid: CID,
            value: {
              $type: POST_COLLECTION,
              text: 'The stale page stays unserved.',
              createdAt: NOW,
            },
          },
        ],
        cursor: 'page-2',
      },
      {
        ops: [
          {
            rev: '2',
            collection: POST_COLLECTION,
            rkey: '3jabc',
            cid: CID,
            value: {
              $type: POST_COLLECTION,
              text: 'The stale terminal page stays unserved.',
              createdAt: NOW,
            },
          },
        ],
        commit: { sig: 'stale-terminal' },
      },
    ])
    const target = await issueRunTarget(mutationFence)

    const staleRun = staleRunner.runTarget(target)
    await verificationStarted.promise

    const cursors: Array<string | undefined> = []
    const freshVerifier = {
      verify: vi.fn(async (): Promise<CommitVerifyResult> => ({ ok: true })),
    }
    const freshRunner = buildRunner(
      mutationFence,
      freshVerifier,
      [
        {
          ops: [
            {
              rev: '3',
              collection: POST_COLLECTION,
              rkey: '3jfresh',
              cid: CID,
              value: {
                $type: POST_COLLECTION,
                text: 'The fresh terminal page is served.',
                createdAt: NOW,
              },
            },
          ],
          commit: { sig: 'fresh-terminal' },
        },
      ],
      (options) => cursors.push(options.cursor),
    )

    await expect(freshRunner.runTarget(target)).resolves.toMatchObject({
      ok: true,
    })
    expect(cursors).toEqual([undefined])
    expect(await store.getPost(POST_URI)).toBeNull()
    expect(await store.getPost(TERMINAL_POST_URI)).toBeNull()
    expect(await store.getPost(FRESH_POST_URI)).toMatchObject({
      uri: FRESH_POST_URI,
      boundaries: [BOUNDARY],
    })

    staleVerification.resolve({
      ok: false,
      reason: 'mac-mismatch',
      transient: false,
    })
    await expect(staleRun).resolves.toMatchObject({
      ok: false,
      reason: 'member-skip',
    })
    expect(await store.getPost(FRESH_POST_URI)).toMatchObject({
      uri: FRESH_POST_URI,
    })
  })

  it('never serves a prior staged page when terminal commit verification fails', async () => {
    const mutationFence = new SpaceMutationFence()
    const verificationStarted = deferred<void>()
    const verification = deferred<CommitVerifyResult>()
    const verifier = {
      verify: vi.fn(async () => {
        verificationStarted.resolve()
        return verification.promise
      }),
    }
    const runner = buildRunner(mutationFence, verifier, [
      {
        ops: [
          {
            rev: '1',
            collection: POST_COLLECTION,
            rkey: '3jxyz',
            cid: CID,
            value: {
              $type: POST_COLLECTION,
              text: 'Page one stays staged.',
              createdAt: NOW,
            },
          },
        ],
        cursor: 'page-2',
      },
      {
        ops: [
          {
            rev: '2',
            collection: POST_COLLECTION,
            rkey: '3jabc',
            cid: CID,
            value: {
              $type: POST_COLLECTION,
              text: 'The terminal page also stays staged.',
              createdAt: NOW,
            },
          },
        ],
        commit: { sig: 'terminal' },
      },
    ])
    const target = await issueRunTarget(mutationFence)

    const run = runner.runTarget(target)
    await verificationStarted.promise

    expect(await store.getPost(POST_URI)).toBeNull()
    expect(await store.getPost(TERMINAL_POST_URI)).toBeNull()

    verification.resolve({
      ok: false,
      reason: 'mac-mismatch',
      transient: false,
    })
    await expect(run).resolves.toMatchObject({
      ok: false,
      reason: 'commit-verify-failed',
    })
    await store.promoteSpaceSyncStage(SPACE_URI, SPIKE_DID)

    expect(await store.getPost(POST_URI)).toBeNull()
    expect(await store.getPost(TERMINAL_POST_URI)).toBeNull()
    expect(await store.getSpaceCursor(SPACE_URI, SPIKE_DID)).toBeNull()
  })
})
