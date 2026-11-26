import { Lexicons } from '@atproto/lexicon'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const MODERATION_DIR = new URL(
  '../../lexicons/zone/stratos/moderation/',
  import.meta.url,
)

function loadLexicons(): Lexicons {
  const docs = ['defs.json', 'createLabel.json', 'queryLabels.json'].map(
    (name) =>
      JSON.parse(
        readFileSync(fileURLToPath(new URL(name, MODERATION_DIR)), 'utf8'),
      ),
  )
  return new Lexicons(docs)
}

const CREATE_LABEL = 'zone.stratos.moderation.createLabel'
const QUERY_LABELS = 'zone.stratos.moderation.queryLabels'
const RECORD_SUBJECT = 'zone.stratos.moderation.defs#recordSubject'
const ACCOUNT_SUBJECT = 'zone.stratos.moderation.defs#accountSubject'

const SPIKE_DID = 'did:plc:spikespiegel7777'
const REPO_URI = `at://${SPIKE_DID}/zone.stratos.feed.post/3kbebop`
const SPACE_URI = `at:space/did:web:bebop.example/zone.stratos.space.feed/3kswordfish/${SPIKE_DID}/zone.stratos.feed.post/3kbebop`

describe('zone.stratos.moderation lexicons', () => {
  let lex: Lexicons

  beforeAll(() => {
    lex = loadLexicons()
  })

  const validateInput = (body: unknown) =>
    lex.assertValidXrpcInput(CREATE_LABEL, body)

  it('accepts a record subject in repo form', () => {
    expect(() =>
      validateInput({
        subject: { $type: RECORD_SUBJECT, uri: REPO_URI },
        val: '!takedown',
      }),
    ).not.toThrow()
  })

  it('accepts a record subject in seven-segment space form', () => {
    expect(() =>
      validateInput({
        subject: { $type: RECORD_SUBJECT, uri: SPACE_URI },
        val: '!takedown',
      }),
    ).not.toThrow()
  })

  it('accepts an account subject', () => {
    expect(() =>
      validateInput({
        subject: { $type: ACCOUNT_SUBJECT, did: SPIKE_DID },
        val: '!takedown',
        neg: true,
      }),
    ).not.toThrow()
  })

  it('rejects input with no subject', () => {
    expect(() => validateInput({ val: '!takedown' })).toThrow(/subject/)
  })

  it('rejects a subject with an unknown $type', () => {
    expect(() =>
      validateInput({
        subject: {
          $type: 'zone.stratos.moderation.defs#bountySubject',
          uri: REPO_URI,
        },
        val: '!takedown',
      }),
    ).toThrow(/\$type must be one of/)
  })

  it('rejects an account subject whose did is not a DID', () => {
    expect(() =>
      validateInput({
        subject: { $type: ACCOUNT_SUBJECT, did: 'faye-valentine' },
        val: '!takedown',
      }),
    ).toThrow(/did/i)
  })

  it('rejects a ref over maxLength', () => {
    expect(() =>
      validateInput({
        subject: { $type: ACCOUNT_SUBJECT, did: SPIKE_DID },
        val: '!takedown',
        ref: 'x'.repeat(513),
      }),
    ).toThrow(/ref/)
  })

  it('accepts a label response with all fields', () => {
    expect(() =>
      lex.assertValidXrpcOutput(CREATE_LABEL, {
        label: {
          seq: 7,
          subject: {
            $type: RECORD_SUBJECT,
            uri: SPACE_URI,
            cid: 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
          },
          val: '!takedown',
          neg: false,
          ref: 'case-ein-42',
          createdAt: '2026-11-12T00:00:00.000Z',
        },
      }),
    ).not.toThrow()
  })

  it('accepts a label response whose subject has an unknown $type', () => {
    expect(() =>
      lex.assertValidXrpcOutput(CREATE_LABEL, {
        label: {
          seq: 8,
          subject: {
            $type: 'zone.stratos.moderation.defs#futureSubject',
            bounty: 'swordfish-ii',
          },
          val: '!takedown',
          createdAt: '2026-11-12T00:00:00.000Z',
        },
      }),
    ).not.toThrow()
  })

  it('accepts an empty response when nothing changed and no label exists', () => {
    expect(() => lex.assertValidXrpcOutput(CREATE_LABEL, {})).not.toThrow()
  })
})

describe('zone.stratos.moderation.queryLabels', () => {
  let lex: Lexicons

  beforeAll(() => {
    lex = loadLexicons()
  })

  const validateParams = (params: Record<string, unknown>) =>
    lex.assertValidXrpcParams(QUERY_LABELS, params)
  const validateOutput = (body: unknown) =>
    lex.assertValidXrpcOutput(QUERY_LABELS, body)

  const createdAt = '2026-11-12T00:00:00.000Z'
  const recordLabel = {
    seq: 1,
    subject: { $type: RECORD_SUBJECT, uri: REPO_URI },
    val: '!takedown',
    createdAt,
  }
  const accountLabel = {
    seq: 2,
    subject: { $type: ACCOUNT_SUBJECT, did: SPIKE_DID },
    val: '!takedown',
    createdAt,
  }

  it('accepts params with cursor, limit, and subjects', () => {
    expect(() =>
      validateParams({
        cursor: '41',
        limit: 250,
        subjects: [REPO_URI, SPACE_URI, SPIKE_DID],
      }),
    ).not.toThrow()
  })

  it('accepts no params', () => {
    expect(() => validateParams({})).not.toThrow()
  })

  it.each([0, 251])('rejects limit %i', (limit) => {
    expect(() => validateParams({ limit })).toThrow(/limit/)
  })

  it('rejects more than 100 subjects', () => {
    expect(() =>
      validateParams({
        subjects: Array.from({ length: 101 }, () => SPIKE_DID),
      }),
    ).toThrow(/subjects/)
  })

  it('rejects a subjects item over 2048 characters', () => {
    expect(() => validateParams({ subjects: ['x'.repeat(2049)] })).toThrow(
      /subjects/,
    )
  })

  it('accepts a page with a record label and an account label', () => {
    expect(() =>
      validateOutput({ cursor: '2', labels: [recordLabel, accountLabel] }),
    ).not.toThrow()
  })

  it('rejects an output without a cursor', () => {
    expect(() => validateOutput({ labels: [recordLabel] })).toThrow(/cursor/)
  })

  it('accepts an empty page with a cursor', () => {
    expect(() => validateOutput({ cursor: '0', labels: [] })).not.toThrow()
  })
})
