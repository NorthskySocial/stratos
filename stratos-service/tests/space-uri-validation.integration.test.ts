import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatRecordUri } from '@northskysocial/stratos-core'
import { HOSTED_SPACE_TYPE } from '../src/shared/space-type-registry.js'
import {
  asMember,
  HARNESS_ENGINEERING,
  HARNESS_SERVICE_DID,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'

const WRITER = 'did:plc:shinji-ikari'
const PDS_MEMBER = 'did:plc:asuka-langley'
const POST = 'zone.stratos.feed.post'
const CREATE = 'zone.stratos.repo.createRecord'
const LEGACY_CREATE = 'com.atproto.repo.createRecord'
const POST_CID = 'bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a'
const OVER_GRAPHEME_LIMIT_RKEY = 'a'.repeat(200)

function spaceUriOf(rkey: string): string {
  const formatted = formatRecordUri({
    spaceDid: HARNESS_SERVICE_DID,
    spaceType: HOSTED_SPACE_TYPE,
    skey: 'engineering',
    authorDid: PDS_MEMBER,
    collection: POST,
    rkey,
  })
  if (!formatted.ok) throw new Error(formatted.error.message)
  return formatted.value
}

const strongRef = (uri: string) => ({ uri, cid: POST_CID })

function post(text: string, extra: Record<string, unknown> = {}) {
  return {
    $type: POST,
    text,
    createdAt: '1996-10-04T00:00:00.000Z',
    ...extra,
  }
}

function replyTo(uri: string) {
  return { reply: { root: strongRef(uri), parent: strongRef(uri) } }
}

describe('space-form record uris in a lexicon-checked record', () => {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
    await harness.enrollMember(WRITER, [HARNESS_ENGINEERING])
    await harness.enrollPdsCustodyMember(PDS_MEMBER, [HARNESS_ENGINEERING])
  })

  afterEach(async () => {
    await harness.close()
  })

  const create = (
    record: unknown,
    fields: { validate?: boolean } = {},
    rkey = 'eva01',
  ) =>
    harness.call(CREATE, asMember(WRITER), {
      boundary: HARNESS_ENGINEERING,
      repo: WRITER,
      collection: POST,
      rkey,
      record,
      ...fields,
    })

  it('accepts a reply to a pds-custody member post and reports it valid', async () => {
    const parent = spaceUriOf('eva02')

    const response = await create(post('Sortie', replyTo(parent)))

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ validationStatus: 'valid' })
  })

  it('accepts a space-form reply under validate true', async () => {
    const response = await create(
      post('Sortie', replyTo(spaceUriOf('eva02'))),
      {
        validate: true,
      },
    )

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ validationStatus: 'valid' })
  })

  it('accepts a space-form embedded record', async () => {
    const response = await create(
      post('Sortie', {
        embed: {
          $type: 'app.bsky.embed.record',
          record: strongRef(spaceUriOf('eva02')),
        },
      }),
    )

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ validationStatus: 'valid' })
  })

  it('stores the space-form uri the client sent, not the one the library checked', async () => {
    const parent = spaceUriOf('eva02')
    expect((await create(post('Sortie', replyTo(parent)))).status).toBe(200)

    const rows = await harness.recordRows(`at://${WRITER}/${POST}/eva01`)
    const read = await harness.query(
      'com.atproto.repo.getRecord',
      asMember(WRITER),
      { repo: WRITER, collection: POST, rkey: 'eva01' },
    )

    expect(rows.record?.value).toMatchObject(replyTo(parent))
    expect(read.status).toBe(200)
    expect(read.body).toMatchObject({ value: replyTo(parent) })
  })

  it.each([
    [
      'a collection that is not an nsid',
      `at:space/${HARNESS_SERVICE_DID}/${HOSTED_SPACE_TYPE}/engineering/${PDS_MEMBER}/NotAnNsid/eva02`,
    ],
    [
      'an author that is not a did',
      `at:space/${HARNESS_SERVICE_DID}/${HOSTED_SPACE_TYPE}/engineering/asuka.nerv.tokyo.jp/${POST}/eva02`,
    ],
    [
      'the at:// scheme instead of at:space/',
      `at://${HARNESS_SERVICE_DID}/spaces/${HOSTED_SPACE_TYPE}/engineering/${PDS_MEMBER}/${POST}/eva02`,
    ],
    ['a trailing slash', `${spaceUriOf('eva02')}/`],
  ])('still refuses a record uri with %s', async (_name, uri) => {
    const response = await create(post('Sortie', replyTo(uri)))

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: 'InvalidRecord' })
  })

  it('does not rewrite a string that is not a uri property', async () => {
    const uriAsText = spaceUriOf(OVER_GRAPHEME_LIMIT_RKEY)

    const response = await create(post(uriAsText))

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: 'InvalidRecord' })
  })

  it('leaves validate false as it was: no lexicon check and no status', async () => {
    const response = await create(
      post('Sortie', replyTo(spaceUriOf('eva02'))),
      {
        validate: false,
      },
    )

    expect(response.status).toBe(200)
    expect(response.body).not.toHaveProperty('validationStatus')
  })

  it('answers a legacy create of the same reply as it always did', async () => {
    const response = await harness.call(LEGACY_CREATE, asMember(WRITER), {
      repo: WRITER,
      collection: POST,
      rkey: 'eva01',
      record: post('Sortie', {
        ...replyTo(spaceUriOf('eva02')),
        boundary: {
          $type: 'zone.stratos.boundary.defs#Domains',
          values: [{ value: HARNESS_ENGINEERING }],
        },
      }),
    })

    expect(response.status).toBe(200)
    expect(response.body).not.toHaveProperty('validationStatus')
  })
})
