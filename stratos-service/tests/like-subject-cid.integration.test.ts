import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseCid } from '@northskysocial/stratos-core'
import { validateRecordInBoundary } from '../src/api/records/validation.js'
import {
  asMember,
  HARNESS_ENGINEERING,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'

const SHINJI = 'did:plc:shinji-ikari'
const POST = 'zone.stratos.feed.post'
const LIKE = 'app.bsky.feed.like'
const CREATE = 'zone.stratos.repo.createRecord'
const SUBJECT_ERROR = {
  customErrorName: 'InvalidRecord',
  message: 'The subject must be a post in this boundary',
}

describe('a like whose subject cid is not a string', () => {
  let harness: WriteHarness
  let postUri: string
  let postCid: string

  beforeAll(async () => {
    harness = await startSqliteWriteHarness()
    await harness.enrollMember(SHINJI, [HARNESS_ENGINEERING])
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
    ;({ uri: postUri, cid: postCid } = created.body as {
      uri: string
      cid: string
    })
  })

  afterAll(async () => {
    await harness.close()
  })

  const likeOf = (cid: unknown) => ({
    $type: LIKE,
    subject: { uri: postUri, cid },
    createdAt: '1996-10-04T00:00:00.000Z',
  })

  it('matches the stored post when the cid is that string', async () => {
    await expect(
      validateRecordInBoundary(
        harness.ctx,
        LIKE,
        likeOf(postCid),
        HARNESS_ENGINEERING,
      ),
    ).resolves.toBeUndefined()
  })

  it.each([
    ['the stored cid as a cid value', () => parseCid(postCid)],
    ['the stored cid in a list', () => [postCid]],
    ['the stored cid in a wrapper', () => ({ toString: () => postCid })],
    ['a number', () => 7],
  ])('never matches with %s', async (_name, cidOf) => {
    await expect(
      validateRecordInBoundary(
        harness.ctx,
        LIKE,
        likeOf(cidOf()),
        HARNESS_ENGINEERING,
      ),
    ).rejects.toMatchObject(SUBJECT_ERROR)
  })
})
