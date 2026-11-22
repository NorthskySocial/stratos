import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatRecordUri } from '@northskysocial/stratos-core'
import { HOSTED_SPACE_TYPE } from '../src/shared/space-type-registry.js'
import {
  asMember,
  HARNESS_DESIGN,
  HARNESS_ENGINEERING,
  HARNESS_SERVICE_DID,
  startSqliteWriteHarness,
  type CallResult,
  type WriteHarness,
} from './helpers/write-harness.js'

const WRITER = 'did:plc:shinji-ikari'
const PDS_MEMBER = 'did:plc:asuka-langley'
const HELD_PDS_MEMBER = 'did:plc:rei-ayanami'
const DESIGN_PDS_MEMBER = 'did:plc:kaworu-nagisa'
const STRATOS_MEMBER = 'did:plc:toji-suzuhara'
const NOT_A_MEMBER = 'did:plc:kensuke-aida'
const POST = 'zone.stratos.feed.post'
const PARENT_CID = 'bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a'
const CREATE = 'zone.stratos.repo.createRecord'
const APPLY_WRITES = 'zone.stratos.repo.applyWrites'
const ESCALATION_MESSAGE =
  "Reply boundaries must be a subset of the parent's boundaries"

function spaceParentUri(
  author: string,
  overrides: { spaceType?: string; collection?: string } = {},
): string {
  const formatted = formatRecordUri({
    spaceDid: HARNESS_SERVICE_DID,
    spaceType: overrides.spaceType ?? HOSTED_SPACE_TYPE,
    skey: 'engineering',
    authorDid: author,
    collection: overrides.collection ?? POST,
    rkey: 'eva02',
  })
  if (!formatted.ok) throw new Error(formatted.error.message)
  return formatted.value
}

function replyTo(parentUri: string) {
  const parent = { uri: parentUri, cid: PARENT_CID }
  return {
    $type: POST,
    text: 'Roger that',
    createdAt: '1996-10-04T00:00:00.000Z',
    reply: { root: parent, parent },
  }
}

interface Procedure {
  name: string
  send(harness: WriteHarness, record: unknown): Promise<CallResult>
}

const PROCEDURES: Procedure[] = [
  {
    name: 'createRecord',
    send: (harness, record) =>
      harness.call(CREATE, asMember(WRITER), {
        boundary: HARNESS_ENGINEERING,
        repo: WRITER,
        collection: POST,
        rkey: 'eva-re',
        record,
      }),
  },
  {
    name: 'applyWrites',
    send: (harness, record) =>
      harness.call(APPLY_WRITES, asMember(WRITER), {
        boundary: HARNESS_ENGINEERING,
        repo: WRITER,
        writes: [
          {
            $type: `${APPLY_WRITES}#create`,
            collection: POST,
            rkey: 'eva-re',
            value: record,
          },
        ],
      }),
  },
]

const INELIGIBLE_PARENTS: Array<[string, () => string]> = [
  ['by an author who is not enrolled', () => spaceParentUri(NOT_A_MEMBER)],
  ['by an author who is held', () => spaceParentUri(HELD_PDS_MEMBER)],
  [
    'by an author who is a member of another boundary only',
    () => spaceParentUri(DESIGN_PDS_MEMBER),
  ],
  [
    'by a stratos-custody author named in space form',
    () => spaceParentUri(STRATOS_MEMBER),
  ],
  [
    'in a space of another type',
    () => spaceParentUri(PDS_MEMBER, { spaceType: 'zone.stratos.space.eva' }),
  ],
  [
    'a record that is not a post',
    () => spaceParentUri(PDS_MEMBER, { collection: 'zone.stratos.feed.angel' }),
  ],
]

describe('a reply whose parent is named in space form', () => {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
    await harness.enrollMember(WRITER, [HARNESS_ENGINEERING])
    await harness.enrollPdsCustodyMember(PDS_MEMBER, [HARNESS_ENGINEERING])
    await harness.enrollPdsCustodyMember(HELD_PDS_MEMBER, [HARNESS_ENGINEERING])
    await harness.holdMember(HELD_PDS_MEMBER)
    await harness.enrollPdsCustodyMember(DESIGN_PDS_MEMBER, [HARNESS_DESIGN])
    await harness.enrollMember(STRATOS_MEMBER, [HARNESS_ENGINEERING])
  })

  afterEach(async () => {
    await harness.close()
  })

  describe.each(PROCEDURES)('through $name', (procedure) => {
    it.each(INELIGIBLE_PARENTS)(
      'is refused when the parent is %s',
      async (_name, parentUri) => {
        const before = await harness.repoRoot(WRITER)

        const response = await procedure.send(harness, replyTo(parentUri()))

        expect(response.status).toBe(400)
        expect(response.body).toMatchObject({
          error: 'InvalidRecord',
          message: expect.stringContaining(ESCALATION_MESSAGE),
        })
        expect(await harness.repoRoot(WRITER)).toEqual(before)
      },
    )

    it('is accepted when the parent is a post by an active pds-custody member of the boundary', async () => {
      const response = await procedure.send(
        harness,
        replyTo(spaceParentUri(PDS_MEMBER)),
      )

      expect(response.status).toBe(200)
      const rows = await harness.recordRows(`at://${WRITER}/${POST}/eva-re`)
      expect(rows.boundaries).toEqual([HARNESS_ENGINEERING])
    })
  })
})
