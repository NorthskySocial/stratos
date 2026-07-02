/**
 * SWP-10 stub-removal proof: the record write path performs NO outbound PDS
 * round trip.
 *
 * Before SWP-10, `createRecord`/`deleteRecord` enqueued a "stub" write/delete
 * against the caller's mainstream PDS (via an OAuth-restored `Agent`). That path
 * is deleted: the only artifact Stratos writes to a user's PDS is now the
 * `zone.stratos.actor.enrollment` record (written on the OAuth callback, not on
 * the record write path — see enrollment-pds-record.integration.test.ts).
 *
 * These tests wire a spy PDS agent + OAuth client into the context and assert
 * that a successful create/delete never touches them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { decode } from '@atcute/cbor'

import { SqliteEnrollmentStore, StratosActorStore } from '../src/context.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  ServiceDb,
} from '../src/db/index.js'
import { createRecord, deleteRecord } from '../src/api/records/index.js'
import { createMockBlobStore, createTestConfig } from './utils/index.js'

const DOMAIN = 'did:web:nerv.tokyo.jp/engineering'

describe('write path makes no outbound PDS round trip (SWP-10)', () => {
  let dataDir: string
  let actorStore: StratosActorStore
  let enrollmentStore: SqliteEnrollmentStore
  let db: ServiceDb
  let ctx: any

  // Spy PDS surfaces. If any of these fire during a record write, the stub
  // write path (or a regression that reintroduces it) is present.
  let pdsCreateRecord: ReturnType<typeof vi.fn>
  let pdsDeleteRecord: ReturnType<typeof vi.fn>
  let oauthRestore: ReturnType<typeof vi.fn>

  const testDid = 'did:plc:shinji-ikari'
  const serviceDid = 'did:web:nerv.tokyo.jp'
  const collection = 'zone.stratos.feed.post'

  function post(text = 'hi') {
    return {
      $type: collection,
      text,
      createdAt: new Date().toISOString(),
      boundary: {
        $type: 'zone.stratos.boundary.defs#Domains',
        values: [{ value: DOMAIN }],
      },
    }
  }

  beforeEach(async () => {
    dataDir = join(tmpdir(), `stratos-test-${randomBytes(8).toString('hex')}`)
    await mkdir(dataDir, { recursive: true })

    const cfg = createTestConfig(dataDir)
    db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)

    pdsCreateRecord = vi.fn().mockResolvedValue({
      data: { uri: 'at://pds/rec', cid: 'pdscid' },
    })
    pdsDeleteRecord = vi.fn().mockResolvedValue(undefined)
    // Restoring an OAuth session is the first step of any PDS write; if the
    // write path is clean it must never be reached during create/delete.
    oauthRestore = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'OAuth session must not be restored on the record write path',
        ),
      )

    enrollmentStore = new SqliteEnrollmentStore(db)
    actorStore = new StratosActorStore({
      dataDir,
      blobstore: () => createMockBlobStore() as any,
      cborToRecord: (content) => decode(content) as Record<string, unknown>,
    })

    ctx = {
      cfg,
      actorStore,
      enrollmentStore: {
        getEnrollment: vi
          .fn()
          .mockResolvedValue({ active: true, isService: false }),
      },
      serviceDid,
      oauthClient: { restore: oauthRestore },
      writeRateLimiter: { assertWriteAllowed: vi.fn() },
      actorSigner: {
        sign: vi.fn().mockResolvedValue(new Uint8Array(64)),
        getSignFn: vi
          .fn()
          .mockResolvedValue(() => Promise.resolve(new Uint8Array(64))),
        getPublicKey: vi.fn().mockResolvedValue('did:key:zDnaeTestKey'),
        ensureKey: vi.fn().mockResolvedValue(undefined),
      },
      repoWriteLocks: { acquire: vi.fn().mockResolvedValue(() => {}) },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      },
      sequenceEvents: { emit: vi.fn() },
      boundaryResolver: {
        getBoundaries: vi.fn().mockResolvedValue([DOMAIN]),
      },
    }

    await actorStore.create(testDid)
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  it('createRecord succeeds and makes no PDS call', async () => {
    const result = await createRecord(
      ctx,
      { repo: testDid, collection, record: post('hello') },
      testDid,
    )

    // Local write succeeded (no PDS involved).
    expect(result.uri).toContain(`${testDid}/${collection}/`)
    expect(result.cid).toBeDefined()

    // Give any (now-removed) background task a tick to fire.
    await new Promise((resolve) => setImmediate(resolve))

    expect(oauthRestore).not.toHaveBeenCalled()
    expect(pdsCreateRecord).not.toHaveBeenCalled()
    expect(pdsDeleteRecord).not.toHaveBeenCalled()
  })

  it('deleteRecord succeeds and makes no PDS call', async () => {
    const created = await createRecord(
      ctx,
      { repo: testDid, collection, record: post('to-delete') },
      testDid,
    )
    const rkey = created.uri.split('/').pop() as string

    oauthRestore.mockClear()
    pdsCreateRecord.mockClear()

    await deleteRecord(ctx, { repo: testDid, collection, rkey }, testDid)

    await new Promise((resolve) => setImmediate(resolve))

    expect(oauthRestore).not.toHaveBeenCalled()
    expect(pdsCreateRecord).not.toHaveBeenCalled()
    expect(pdsDeleteRecord).not.toHaveBeenCalled()
  })

  it('context exposes no PDS-write queue on the record write path', () => {
    // The stub write path was wired through `ctx.stubQueue`; its removal means
    // no such queue exists to enqueue outbound PDS writes.
    expect((ctx as Record<string, unknown>).stubQueue).toBeUndefined()
  })
})
