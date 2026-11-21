import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatRecordUri } from '@northskysocial/stratos-core'
import { resolveReferencedRecord } from '../src/api/records/references.js'
import { HOSTED_SPACE_TYPE } from '../src/shared/space-type-registry.js'
import {
  asMember,
  HARNESS_ENGINEERING,
  HARNESS_SERVICE_DID,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'

const SHINJI = 'did:plc:shinji-ikari'
const ASUKA = 'did:plc:asuka-langley'
const MISATO = 'did:plc:misato-katsuragi'
const POST = 'zone.stratos.feed.post'
const LIKE = 'app.bsky.feed.like'
const CREATE = 'zone.stratos.repo.createRecord'
const STALE_CID = 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const SUBJECT_BODY = {
  error: 'InvalidRecord',
  message: 'The subject must be a post in this boundary',
}

function spaceUriOf(author: string, rkey: string): string {
  const formatted = formatRecordUri({
    spaceDid: HARNESS_SERVICE_DID,
    spaceType: HOSTED_SPACE_TYPE,
    skey: 'engineering',
    authorDid: author,
    collection: POST,
    rkey,
  })
  if (!formatted.ok) throw new Error(formatted.error.message)
  return formatted.value
}

/**
 * Serves the author's enrollment as a row written before custody existed,
 * which carries no custody value; every other read is the store's own.
 */
function readAuthorWithoutCustody(harness: WriteHarness, author: string) {
  const store = harness.ctx.enrollmentStore
  const getEnrollment = store.getEnrollment.bind(store)
  vi.spyOn(store, 'getEnrollment').mockImplementation(async (did) => {
    const enrollment = await getEnrollment(did)
    if (did !== author || !enrollment) return enrollment
    return { ...enrollment, custody: undefined }
  })
}

describe('the author of a subject whose enrollment has no custody value', () => {
  let harness: WriteHarness
  let postCid: string

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
    await harness.enrollMember(SHINJI, [HARNESS_ENGINEERING])
    await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
    await harness.enrollPdsCustodyMember(ASUKA, [HARNESS_ENGINEERING])
    const created = await harness.call(CREATE, asMember(SHINJI), {
      boundary: HARNESS_ENGINEERING,
      repo: SHINJI,
      collection: POST,
      rkey: 'eva01',
      record: {
        $type: POST,
        text: 'Get in the robot',
        createdAt: '1996-10-04T00:00:00.000Z',
      },
    })
    expect(created.status).toBe(200)
    postCid = (created.body as { cid: string }).cid
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await harness.close()
  })

  const like = (subject: unknown) =>
    harness.call(CREATE, asMember(MISATO), {
      boundary: HARNESS_ENGINEERING,
      repo: MISATO,
      collection: LIKE,
      rkey: 'eva-like',
      record: {
        $type: LIKE,
        subject,
        createdAt: '1996-10-04T00:00:00.000Z',
      },
    })

  it('is read as stratos custody for a repo-form subject, which may be liked', async () => {
    readAuthorWithoutCustody(harness, SHINJI)
    const subject = { uri: `at://${SHINJI}/${POST}/eva01`, cid: postCid }

    const facts = await resolveReferencedRecord(harness.ctx, subject)
    const response = await like(subject)

    expect(facts).toMatchObject({ form: 'repo', authorCustody: 'stratos' })
    expect(response.status).toBe(200)
  })

  it('is read as stratos custody for a space-form subject, which is refused', async () => {
    readAuthorWithoutCustody(harness, ASUKA)
    const subject = { uri: spaceUriOf(ASUKA, 'eva02'), cid: STALE_CID }

    const facts = await resolveReferencedRecord(harness.ctx, subject)
    const response = await like(subject)

    expect(facts).toMatchObject({ form: 'space', authorCustody: 'stratos' })
    expect(response).toEqual({ status: 400, body: SUBJECT_BODY })
  })
})
