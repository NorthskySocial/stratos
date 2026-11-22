import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { updateRecord } from '../src/api/records/index.js'
import { parentBoundaryCache } from '../src/api/records/validation.js'
import {
  asMember,
  HARNESS_DESIGN,
  HARNESS_ENGINEERING,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'

const WRITER = 'did:plc:shinji-ikari'
const AUTHOR = 'did:plc:misato-katsuragi'
const NOT_HOSTED = 'did:plc:ryoji-kaji'
const POST = 'zone.stratos.feed.post'
const UNKNOWN_CID =
  'bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a'
const ESCALATION_MESSAGE = `Reply boundaries must be a subset of the parent's boundaries. Domains not in parent: ${HARNESS_ENGINEERING}`

const parentUriOf = (author: string, rkey: string) =>
  `at://${author}/${POST}/${rkey}`

function body(text: string, extra: Record<string, unknown> = {}) {
  return {
    $type: POST,
    text,
    createdAt: '1995-10-04T00:00:00.000Z',
    ...extra,
  }
}

function replyTo(parentUri: string, parentCid = UNKNOWN_CID) {
  const parent = { uri: parentUri, cid: parentCid }
  return body('Roger that', { reply: { root: parent, parent } })
}

interface RawResponse {
  status: number
  text: string
}

interface Procedure {
  name: string
  send(
    harness: WriteHarness,
    rkey: string,
    record: unknown,
  ): Promise<RawResponse>
}

async function rawCall(
  harness: WriteHarness,
  nsid: string,
  input: unknown,
): Promise<RawResponse> {
  const response = await fetch(`${harness.baseUrl}/xrpc/${nsid}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: asMember(WRITER) ?? '',
    },
    body: JSON.stringify(input),
  })
  return { status: response.status, text: await response.text() }
}

const PROCEDURES: Procedure[] = [
  {
    name: 'createRecord',
    send: (harness, rkey, record) =>
      rawCall(harness, 'zone.stratos.repo.createRecord', {
        boundary: HARNESS_ENGINEERING,
        repo: WRITER,
        collection: POST,
        rkey,
        record,
      }),
  },
  {
    name: 'putRecord',
    send: (harness, rkey, record) =>
      rawCall(harness, 'zone.stratos.repo.putRecord', {
        boundary: HARNESS_ENGINEERING,
        repo: WRITER,
        collection: POST,
        rkey,
        record,
      }),
  },
  {
    name: 'applyWrites',
    send: (harness, rkey, record) =>
      rawCall(harness, 'zone.stratos.repo.applyWrites', {
        boundary: HARNESS_ENGINEERING,
        repo: WRITER,
        writes: [
          {
            $type: 'zone.stratos.repo.applyWrites#create',
            collection: POST,
            rkey,
            value: record,
          },
        ],
      }),
  },
]

describe('a reply whose parent is a record this service hosts', () => {
  let harness: WriteHarness

  beforeEach(async () => {
    parentBoundaryCache.clear()
    harness = await startSqliteWriteHarness()
    await harness.enrollMember(WRITER, [HARNESS_ENGINEERING, HARNESS_DESIGN])
    await harness.enrollMember(AUTHOR, [HARNESS_ENGINEERING, HARNESS_DESIGN])
  })

  afterEach(async () => {
    await harness.close()
  })

  async function writeParent(rkey: string, boundary: string): Promise<string> {
    const response = await harness.call(
      'zone.stratos.repo.createRecord',
      asMember(AUTHOR),
      {
        boundary,
        repo: AUTHOR,
        collection: POST,
        rkey,
        record: body('Third Impact briefing'),
      },
    )
    expect(response.status).toBe(200)
    return (response.body as { cid: string }).cid
  }

  async function takeDown(rkey: string): Promise<void> {
    await harness.ctx.actorStore.transact(AUTHOR, (store) =>
      store.record.updateRecordTakedown(parentUriOf(AUTHOR, rkey), {
        applied: true,
        ref: `case-${rkey}`,
      }),
    )
  }

  async function moveParent(rkey: string, boundary: string): Promise<void> {
    await updateRecord(
      harness.ctx,
      {
        repo: AUTHOR,
        collection: POST,
        rkey,
        record: body('Third Impact briefing, moved', {
          boundary: {
            $type: 'zone.stratos.boundary.defs#Domains',
            values: [{ value: boundary }],
          },
        }),
      },
      AUTHOR,
    )
  }

  describe.each(PROCEDURES)('through $name', (procedure) => {
    it('accepts a reply to a visible parent in the same boundary', async () => {
      const cid = await writeParent('sachiel', HARNESS_ENGINEERING)

      const response = await procedure.send(
        harness,
        'reply-one',
        replyTo(parentUriOf(AUTHOR, 'sachiel'), cid),
      )

      expect(response.status).toBe(200)
      const rows = await harness.recordRows(`at://${WRITER}/${POST}/reply-one`)
      expect(rows.boundaries).toEqual([HARNESS_ENGINEERING])
    })

    it('refuses the next reply at once after the parent moved to another boundary', async () => {
      const cid = await writeParent('shamshel', HARNESS_ENGINEERING)
      const parentUri = parentUriOf(AUTHOR, 'shamshel')
      const first = await procedure.send(
        harness,
        'reply-one',
        replyTo(parentUri, cid),
      )
      expect(first.status).toBe(200)

      await moveParent('shamshel', HARNESS_DESIGN)
      const before = await harness.repoRoot(WRITER)
      const second = await procedure.send(
        harness,
        'reply-two',
        replyTo(parentUri, cid),
      )

      expect(second.status).toBe(400)
      expect(JSON.parse(second.text)).toEqual({
        error: 'InvalidRecord',
        message: ESCALATION_MESSAGE,
      })
      expect(await harness.repoRoot(WRITER)).toEqual(before)
    })

    it('answers a taken-down or missing parent byte for byte as a parent in another boundary', async () => {
      const designCid = await writeParent('ramiel', HARNESS_DESIGN)
      const takenDownCid = await writeParent('leliel', HARNESS_ENGINEERING)
      await takeDown('leliel')
      const before = await harness.repoRoot(WRITER)

      const inAnotherBoundary = await procedure.send(
        harness,
        'reply-one',
        replyTo(parentUriOf(AUTHOR, 'ramiel'), designCid),
      )
      const takenDown = await procedure.send(
        harness,
        'reply-one',
        replyTo(parentUriOf(AUTHOR, 'leliel'), takenDownCid),
      )
      const missing = await procedure.send(
        harness,
        'reply-one',
        replyTo(parentUriOf(AUTHOR, 'ghost')),
      )
      const missingWithNoRepo = await procedure.send(
        harness,
        'reply-one',
        replyTo(parentUriOf(NOT_HOSTED, 'ghost')),
      )

      expect(inAnotherBoundary.status).toBe(400)
      expect(JSON.parse(inAnotherBoundary.text)).toEqual({
        error: 'InvalidRecord',
        message: ESCALATION_MESSAGE,
      })
      expect(takenDown).toEqual(inAnotherBoundary)
      expect(missing).toEqual(inAnotherBoundary)
      expect(missingWithNoRepo).toEqual(inAnotherBoundary)
      expect(await harness.repoRoot(WRITER)).toEqual(before)
    })
  })
})
