import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { formatRecordUri } from '@northskysocial/stratos-core'
import {
  isWellFormedStrongRef,
  withRepoFormUris,
} from '../src/api/records/lexicon-validation.js'
import { HOSTED_SPACE_TYPE } from '../src/shared/space-type-registry.js'
import {
  asMember,
  HARNESS_ENGINEERING,
  HARNESS_SERVICE_DID,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'

const POST = 'zone.stratos.feed.post'
const CREATE = 'zone.stratos.repo.createRecord'
const ASUKA = 'did:plc:asuka-langley'
const MISATO = 'did:plc:misato-katsuragi'
const POST_CID = 'bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a'
const DEEPEST_REWRITTEN_LEVEL = 16
const REPO_URI = `at://${ASUKA}/${POST}/eva02`

function spaceUri(): string {
  const formatted = formatRecordUri({
    spaceDid: HARNESS_SERVICE_DID,
    spaceType: HOSTED_SPACE_TYPE,
    skey: 'engineering',
    authorDid: ASUKA,
    collection: POST,
    rkey: 'eva02',
  })
  if (!formatted.ok) throw new Error(formatted.error.message)
  return formatted.value
}

const SPACE_URI = spaceUri()

function nestedUnder(levels: number, leaf: unknown): Record<string, unknown> {
  let value: unknown = leaf
  for (let level = 0; level < levels; level++) value = { pilot: value }
  return value as Record<string, unknown>
}

function leafUnder(value: unknown, levels: number): unknown {
  let current = value
  for (let level = 0; level < levels; level++) {
    current = (current as { pilot: unknown }).pilot
  }
  return current
}

describe('the repo-form copy the lexicon check reads', () => {
  it('rewrites a space-form uri held at the deepest rewritten level', () => {
    const record = nestedUnder(DEEPEST_REWRITTEN_LEVEL, { uri: SPACE_URI })

    const copy = withRepoFormUris(record)

    expect(leafUnder(copy, DEEPEST_REWRITTEN_LEVEL)).toEqual({ uri: REPO_URI })
  })

  it('leaves a space-form uri one level deeper as sent', () => {
    const levels = DEEPEST_REWRITTEN_LEVEL + 1
    const record = nestedUnder(levels, { uri: SPACE_URI })

    const copy = withRepoFormUris(record)

    expect(leafUnder(copy, levels)).toEqual({ uri: SPACE_URI })
  })

  it('rewrites the uri of every object in an array', () => {
    const record = { entries: [{ uri: SPACE_URI }, { uri: SPACE_URI }] }

    expect(withRepoFormUris(record)).toEqual({
      entries: [{ uri: REPO_URI }, { uri: REPO_URI }],
    })
  })

  it('rewrites the uri of an object with no prototype', () => {
    const entry = Object.assign(Object.create(null) as object, {
      uri: SPACE_URI,
    })

    expect(withRepoFormUris({ entry })).toEqual({ entry: { uri: REPO_URI } })
  })

  it('passes a class instance through as the same value', () => {
    class Entry {
      uri = SPACE_URI
    }
    const entry = new Entry()
    const bytes = new Uint8Array([3, 0, 1])

    const copy = withRepoFormUris({ entry, bytes })

    expect(copy.entry).toBe(entry)
    expect(entry.uri).toBe(SPACE_URI)
    expect(copy.bytes).toBe(bytes)
  })

  it('leaves the record it was given unchanged', () => {
    const record = {
      subject: { uri: SPACE_URI, cid: POST_CID },
      entries: [{ uri: SPACE_URI }],
    }
    const sent = structuredClone(record)

    withRepoFormUris(record)

    expect(record).toEqual(sent)
  })

  it('reads a strong reference with no prototype in repo form', () => {
    const subject = Object.assign(Object.create(null) as object, {
      uri: SPACE_URI,
      cid: POST_CID,
    })

    expect(isWellFormedStrongRef(subject)).toBe(true)
  })
})

describe('a record nested past the rewritten levels', () => {
  let harness: WriteHarness
  let counter = 0

  beforeAll(async () => {
    harness = await startSqliteWriteHarness()
    await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
  })

  afterAll(async () => {
    await harness.close()
  })

  const createPost = (extra: Record<string, unknown>, fields: object) => {
    const rkey = `eva-n${counter++}`
    return {
      rkey,
      response: harness.call(CREATE, asMember(MISATO), {
        boundary: HARNESS_ENGINEERING,
        repo: MISATO,
        collection: POST,
        rkey,
        record: {
          $type: POST,
          text: 'Third Impact',
          createdAt: '1996-10-04T00:00:00.000Z',
          ...extra,
        },
        ...fields,
      }),
    }
  }

  it.each([DEEPEST_REWRITTEN_LEVEL, DEEPEST_REWRITTEN_LEVEL + 1, 2_000])(
    'is stored as sent with a space-form uri %i levels down, under every validate value',
    async (levels) => {
      const extra = { log: nestedUnder(levels, { uri: SPACE_URI }) }
      for (const fields of [{}, { validate: true }, { validate: false }]) {
        const { rkey, response } = createPost(extra, fields)

        expect((await response).status).toBe(200)
        const rows = await harness.recordRows(`at://${MISATO}/${POST}/${rkey}`)
        expect(
          leafUnder((rows.record?.value as { log: unknown }).log, levels),
        ).toEqual({ uri: SPACE_URI })
      }
    },
  )

  it('accepts fields the decoder turns into class instances', async () => {
    const extra = {
      link: { $link: POST_CID },
      bytes: { $bytes: 'bmVydg' },
    }
    for (const fields of [{}, { validate: true }, { validate: false }]) {
      const { response } = createPost(extra, fields)

      expect((await response).status).toBe(200)
    }
  })
})
