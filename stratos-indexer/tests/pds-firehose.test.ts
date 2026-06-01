import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type EnrollmentCallback,
  type FirehoseWork,
  PdsFirehose,
  type PdsFirehoseOptions,
  processFirehoseWork,
} from '../src/pds/pds-firehose.js'
import type { CursorManager, WorkerPool } from '../src/index.ts'
import type { IndexingService } from '@atproto/bsky/dist/data-plane/server/indexing/index.js'
// Re-import mocked functions to use in tests
import {
  type BackgroundQueue,
  decodeCommitOps,
  ENROLLMENT_COLLECTION,
  parseEnrollmentRecord,
} from '@northskysocial/stratos-core'
import type { HandleDedup } from '../src/util/handle-dedup.js'
import { WriteOpAction } from '@atproto/repo'

// Mock external libraries
vi.mock('@atcute/firehose', () => {
  return {
    FirehoseSubscription: function () {
      return {
        [Symbol.asyncIterator]: async function* () {
          yield {
            $type: 'com.atproto.sync.subscribeRepos#identity',
            did: 'did:plc:shinji',
            time: 'now',
            seq: 1,
          }
        },
      }
    },
  }
})

vi.mock('@atcute/cbor', () => ({
  fromBytes: vi.fn((b) => b),
}))

vi.mock('@atcute/car', () => ({
  fromUint8Array: vi.fn(() => ({
    header: {
      data: {
        roots: ['bafkreiehpv7un6z4b3kndj5l66j3q3c4f7yq2f4v4v4v4v4v4v4v4v4v4u'],
      },
    },
  })),
}))

// Mock the core functions used in processCommit
vi.mock('@northskysocial/stratos-core', async () => {
  const actual = (await vi.importActual(
    '@northskysocial/stratos-core',
  )) as object
  return {
    ...actual,
    decodeCommitOps: vi.fn(),
    parseCid: vi.fn((cid) => cid),
    jsonToLex: vi.fn((json) => json),
    parseEnrollmentRecord: vi.fn(),
  }
})

describe('PdsFirehose', () => {
  let opts: PdsFirehoseOptions
  let cursorManager: CursorManager
  let workerPool: WorkerPool<FirehoseWork>
  let firehose: PdsFirehose

  beforeEach(() => {
    cursorManager = {
      getPdsCursor: vi.fn().mockReturnValue(0),
      updatePdsCursor: vi.fn(),
    } as unknown as CursorManager

    workerPool = {
      trySubmit: vi.fn().mockReturnValue(true),
    } as unknown as WorkerPool<FirehoseWork>

    opts = {
      repoProvider: 'wss://pds.example.com',
      cursorManager,
      workerPool,
      onWork: vi.fn(),
      onError: vi.fn(),
    }

    firehose = new PdsFirehose(opts)
  })

  it('can be instantiated', () => {
    expect(firehose).toBeDefined()
  })

  it('reports connection status correctly', () => {
    expect(firehose.isConnected()).toBe(false)
  })

  it('classifies messages correctly', () => {
    // Accessing private method for unit testing
    const classifyMessage = (firehose as any).classifyMessage.bind(firehose)

    const commitMsg = {
      $type: 'com.atproto.sync.subscribeRepos#commit',
      repo: 'did:plc:shinji',
      time: 'now',
    }
    const commitWork = classifyMessage(commitMsg)
    expect(commitWork.type).toBe('commit')
    expect(commitWork.message).toBe(commitMsg)
    expect(commitWork.traceId).toBeDefined()

    const identityMsg = {
      $type: 'com.atproto.sync.subscribeRepos#identity',
      did: 'did:plc:asuka',
      time: 'now',
    }
    const identityWork = classifyMessage(identityMsg)
    expect(identityWork.type).toBe('identity')
    expect(identityWork.message).toBe(identityMsg)

    const accountMsg = {
      $type: 'com.atproto.sync.subscribeRepos#account',
      did: 'did:plc:rei',
      time: 'now',
      active: true,
    }
    const accountWork = classifyMessage(accountMsg)
    expect(accountWork.type).toBe('account')
    expect(accountWork.message).toBe(accountMsg)

    const syncMsg = {
      $type: 'com.atproto.sync.subscribeRepos#sync',
      did: 'did:plc:misato',
      time: 'now',
    }
    const syncWork = classifyMessage(syncMsg)
    expect(syncWork.type).toBe('sync')
    expect(syncWork.message).toBe(syncMsg)

    const infoMsg = {
      $type: 'com.atproto.sync.subscribeRepos#info',
      name: 'info',
    }
    expect(classifyMessage(infoMsg)).toBeNull()

    const unknownMsg = { $type: 'unknown' }
    expect(classifyMessage(unknownMsg)).toBeNull()
  })

  it('starts and stops correctly', async () => {
    firehose.start()
    // Internal state should be updated
    expect((firehose as any).running).toBe(true)

    firehose.stop()
    // Internal state should be updated, subscription cleared
    expect((firehose as any).running).toBe(false)
    expect((firehose as any).subscription).toBeNull()
  })
})

describe('processFirehoseWork', () => {
  let indexingService: IndexingService
  let background: BackgroundQueue
  let enrollmentCallback: EnrollmentCallback
  let handleDedup: HandleDedup

  const validCid = 'bafkreiehpv7un6z4b3kndj5l66j3q3c4f7yq2f4v4v4v4v4v4v4v4v4v4u'

  beforeEach(() => {
    indexingService = {
      indexHandle: vi.fn(),
      deleteActor: vi.fn(),
      updateActorStatus: vi.fn(),
      setCommitLastSeen: vi.fn(),
      indexRecord: vi.fn(),
      deleteRecord: vi.fn(),
    } as unknown as IndexingService

    background = {
      add: vi.fn((key, fn) => fn()),
    } as unknown as BackgroundQueue

    enrollmentCallback = {
      onEnrollmentDiscovered: vi.fn(),
      onEnrollmentRemoved: vi.fn(),
    }

    handleDedup = {
      shouldIndex: vi.fn().mockReturnValue(true),
    } as unknown as HandleDedup
  })

  it('processes identity work', async () => {
    const work: FirehoseWork = {
      type: 'identity',
      traceId: 'trace-1',
      message: {
        $type: 'com.atproto.sync.subscribeRepos#identity',
        did: 'did:plc:shinji',
        time: '2026-04-12T12:00:00Z',
        seq: 100,
      } as any,
    }

    await processFirehoseWork(
      work,
      indexingService,
      background,
      enrollmentCallback,
      handleDedup,
    )

    expect(indexingService.indexHandle).toHaveBeenCalledWith(
      'did:plc:shinji',
      '2026-04-12T12:00:00Z',
      true,
    )
  })

  it('processes account work (active)', async () => {
    const work: FirehoseWork = {
      type: 'account',
      traceId: 'trace-2',
      message: {
        $type: 'com.atproto.sync.subscribeRepos#account',
        did: 'did:plc:asuka',
        time: '2026-04-12T12:00:00Z',
        active: true,
        status: 'active',
        seq: 101,
      } as any,
    }

    await processFirehoseWork(
      work,
      indexingService,
      background,
      enrollmentCallback,
      handleDedup,
    )

    expect(indexingService.updateActorStatus).toHaveBeenCalledWith(
      'did:plc:asuka',
      true,
      'active',
    )
  })

  it('processes account work (deleted)', async () => {
    const work: FirehoseWork = {
      type: 'account',
      traceId: 'trace-3',
      message: {
        $type: 'com.atproto.sync.subscribeRepos#account',
        did: 'did:plc:asuka',
        time: '2026-04-12T12:00:00Z',
        active: false,
        status: 'deleted',
        seq: 102,
      } as any,
    }

    await processFirehoseWork(
      work,
      indexingService,
      background,
      enrollmentCallback,
      handleDedup,
    )

    expect(indexingService.deleteActor).toHaveBeenCalledWith('did:plc:asuka')
  })

  it('processes sync work', async () => {
    const work: FirehoseWork = {
      type: 'sync',
      traceId: 'trace-4',
      message: {
        $type: 'com.atproto.sync.subscribeRepos#sync',
        did: 'did:plc:misato',
        rev: 'rev-1',
        time: '2026-04-12T12:00:00Z',
        blocks: new Uint8Array([1, 2, 3]),
      } as any,
    }

    await processFirehoseWork(
      work,
      indexingService,
      background,
      enrollmentCallback,
      handleDedup,
    )

    expect(indexingService.setCommitLastSeen).toHaveBeenCalled()
    expect(indexingService.indexHandle).toHaveBeenCalledWith(
      'did:plc:misato',
      '2026-04-12T12:00:00Z',
    )
  })

  it('processes commit work with record creation', async () => {
    const message = {
      $type: 'com.atproto.sync.subscribeRepos#commit',
      repo: 'did:plc:shinji',
      time: '2026-04-12T12:00:00Z',
      commit: validCid,
      rev: 'rev-1',
      blocks: new Uint8Array([]),
      ops: [],
    } as any

    const decodedOps = [
      {
        action: 'create',
        collection: 'app.bsky.feed.post',
        rkey: 'rkey-1',
        cid: validCid,
        record: { text: 'hello' },
      },
    ]

    vi.mocked(decodeCommitOps).mockReturnValue(decodedOps as any)

    const work: FirehoseWork = {
      type: 'commit',
      traceId: 'trace-5',
      message,
    }

    await processFirehoseWork(
      work,
      indexingService,
      background,
      enrollmentCallback,
      handleDedup,
    )

    expect(indexingService.indexHandle).toHaveBeenCalledWith(
      'did:plc:shinji',
      '2026-04-12T12:00:00Z',
    )
    expect(indexingService.setCommitLastSeen).toHaveBeenCalledWith(
      'did:plc:shinji',
      expect.anything(),
      'rev-1',
    )
    expect(indexingService.indexRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { text: 'hello' },
      WriteOpAction.Create,
      '2026-04-12T12:00:00Z',
    )
  })

  it('processes enrollment record creation', async () => {
    const message = {
      $type: 'com.atproto.sync.subscribeRepos#commit',
      repo: 'did:plc:rei',
      time: '2026-04-12T12:00:00Z',
      commit: validCid,
      rev: 'rev-1',
      blocks: new Uint8Array([]),
      ops: [],
    } as any

    const decodedOps = [
      {
        action: 'create',
        collection: ENROLLMENT_COLLECTION,
        rkey: 'rkey-2',
        cid: validCid,
        record: { service: 'https://stratos.example.com' },
      },
    ]

    vi.mocked(decodeCommitOps).mockReturnValue(decodedOps as any)
    vi.mocked(parseEnrollmentRecord).mockReturnValue({
      service: 'https://stratos.example.com',
      boundaries: [{ value: 'boundary-1' }],
    } as any)

    const work: FirehoseWork = {
      type: 'commit',
      traceId: 'trace-6',
      message,
    }

    await processFirehoseWork(
      work,
      indexingService,
      background,
      enrollmentCallback,
      handleDedup,
    )

    expect(enrollmentCallback.onEnrollmentDiscovered).toHaveBeenCalledWith(
      'did:plc:rei',
      'https://stratos.example.com',
      ['boundary-1'],
    )
  })

  it('processes enrollment record deletion', async () => {
    const message = {
      $type: 'com.atproto.sync.subscribeRepos#commit',
      repo: 'did:plc:asuka',
      time: '2026-04-12T12:00:00Z',
      commit: validCid,
      rev: 'rev-1',
      blocks: new Uint8Array([]),
      ops: [],
    } as any

    const decodedOps = [
      {
        action: 'delete',
        collection: ENROLLMENT_COLLECTION,
        rkey: 'rkey-3',
      },
    ]

    vi.mocked(decodeCommitOps).mockReturnValue(decodedOps as any)

    const work: FirehoseWork = {
      type: 'commit',
      traceId: 'trace-7',
      message,
    }

    await processFirehoseWork(
      work,
      indexingService,
      background,
      enrollmentCallback,
      handleDedup,
    )

    expect(enrollmentCallback.onEnrollmentRemoved).toHaveBeenCalledWith(
      'did:plc:asuka',
    )
  })
})
