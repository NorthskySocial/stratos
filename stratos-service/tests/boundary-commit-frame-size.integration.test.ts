import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoundarySettings } from '@northskysocial/stratos-core'
import { BOUNDARY_WRITE_JSON_LIMIT_BYTES } from '../src/api/handlers.js'
import {
  applyBoundaryWrites,
  type BoundaryWrite,
} from '../src/api/records/boundary-writes.js'
import { MAX_COMMIT_FRAME_BYTES } from '../src/subscription/index.js'
import {
  asMember,
  HARNESS_SERVICE_DID,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'
import {
  startSyncSubscriber,
  type SyncSubscriber,
} from './helpers/sync-subscriber.js'

const PILOT = 'did:plc:shinji-ikari'
const MAGI = 'did:web:magi.tokyo.jp'
const COLLECTION = 'zone.stratos.feed.post'
// Every op repeats the boundary, so the test uses the longest bare name a
// boundary may have.
const LONGEST_NAME = 'a'.repeat(128)
const LONGEST_BOUNDARY = `${HARNESS_SERVICE_DID}/${LONGEST_NAME}`
const MAX_WRITES = 200
// An integer at or above 2^32 written this way is 3 bytes of JSON and 9 of
// CBOR, the largest growth any JSON value has on its way into a frame.
const WIDEST_INTEGER_JSON = '5e9'

const OPEN_SETTINGS: BoundarySettings = {
  displayName: 'Terminal Dogma',
  description: '',
  listed: false,
  joinable: false,
  autoEnroll: false,
  appAccess: 'open',
  clientIds: [],
}

/**
 * A boundary applyWrites body of 200 creates without record keys, each record
 * packed with wide integers. JSON.stringify would expand the integers, so the
 * body is written as text.
 */
function applyWritesBodyText(integersPerRecord: number): string {
  const integers = Array(integersPerRecord).fill(WIDEST_INTEGER_JSON).join(',')
  const value = `{"$type":"${COLLECTION}","text":"Unit-01","createdAt":"1997-07-19T00:00:00.000Z","wide":[${integers}]}`
  const write = `{"$type":"zone.stratos.repo.applyWrites#create","collection":"${COLLECTION}","value":${value}}`
  const writes = Array(MAX_WRITES).fill(write).join(',')
  return `{"boundary":"${LONGEST_BOUNDARY}","repo":"${PILOT}","validate":false,"writes":[${writes}]}`
}

/** The widest such body the boundary write limit admits. */
function largestAcceptedBodyText(): string {
  let integersPerRecord = 0
  while (
    Buffer.byteLength(applyWritesBodyText(integersPerRecord + 1)) <=
    BOUNDARY_WRITE_JSON_LIMIT_BYTES
  ) {
    integersPerRecord += 1
  }
  return applyWritesBodyText(integersPerRecord)
}

function paddedPost(integers: number) {
  return {
    $type: COLLECTION,
    text: 'Unit-01',
    createdAt: '1997-07-19T00:00:00.000Z',
    wide: Array.from({ length: integers }, () => 5e9),
  }
}

describe('the size of a boundary commit frame', () => {
  let harness: WriteHarness
  let magi: SyncSubscriber

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
    await harness.ctx.boundaryManager!.create(LONGEST_NAME, OPEN_SETTINGS)
    await harness.enrollMember(PILOT, [LONGEST_BOUNDARY])
    magi = await startSyncSubscriber(harness, MAGI, [LONGEST_BOUNDARY])
  })

  afterEach(async () => {
    await magi.close()
    await harness.close()
  })

  it('keeps the largest applyWrites the service accepts within the stream limit', async () => {
    const body = largestAcceptedBodyText()
    expect(Buffer.byteLength(body)).toBeGreaterThan(
      BOUNDARY_WRITE_JSON_LIMIT_BYTES - 4 * MAX_WRITES,
    )

    const response = await fetch(
      `${harness.baseUrl}/xrpc/zone.stratos.repo.applyWrites`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: asMember(PILOT)!,
        },
        body,
      },
    )
    expect(response.status).toBe(200)

    const [frame] = await magi.readCommitFrames(PILOT, 0, () => true)
    expect(frame.ops).toHaveLength(MAX_WRITES)
    // The frame is more than twice the body, which a limit read off the body
    // size would not carry.
    expect(frame.bytes).toBeGreaterThan(2 * BOUNDARY_WRITE_JSON_LIMIT_BYTES)
    expect(frame.bytes).toBeLessThanOrEqual(MAX_COMMIT_FRAME_BYTES)
  })

  it('refuses a commit whose frame would exceed the stream limit and stores nothing', async () => {
    const emit = vi.spyOn(harness.ctx.sequenceEvents, 'emit')
    const rootBefore = await harness.repoRoot(PILOT)
    const rkeys = ['eva00', 'eva01', 'eva02']
    const oversized: BoundaryWrite[] = rkeys.map((rkey) => ({
      kind: 'create',
      collection: COLLECTION,
      rkey,
      record: paddedPost(MAX_COMMIT_FRAME_BYTES / 9 / 2),
    }))

    const refusal = applyBoundaryWrites(
      harness.ctx,
      PILOT,
      LONGEST_BOUNDARY,
      oversized,
    )

    await expect(refusal).rejects.toMatchObject({
      statusCode: 413,
      error: 'PayloadTooLarge',
    })
    expect(await harness.repoRoot(PILOT)).toEqual(rootBefore)
    expect(await harness.sequencedOps(PILOT)).toEqual([])
    for (const rkey of rkeys) {
      const rows = await harness.recordRows(
        `at://${PILOT}/${COLLECTION}/${rkey}`,
      )
      expect(rows.record).toBeNull()
    }
    expect(emit).not.toHaveBeenCalled()
  })
})
