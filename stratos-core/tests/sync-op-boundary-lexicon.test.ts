import { Lexicons } from '@atproto/lexicon'
import { describe, expect, it } from 'vitest'
import { stratosLexicons } from '../src/lexicons'

const RECORD_OP = 'zone.stratos.sync.subscribeRecords#recordOp'
const TOKYO_3_BOUNDARY = 'did:web:nerv.tokyo.jp/tokyo-3'

const lexicons = new Lexicons(stratosLexicons)

function createOp(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    action: 'create',
    path: 'zone.stratos.feed.post/3kshinji',
    record: { text: 'Get in the robot, Shinji.' },
    ...extra,
  }
}

describe('sync recordOp boundary', () => {
  it('accepts an op carrying the op-level boundary in the encoded shape', () => {
    const result = lexicons.validate(
      RECORD_OP,
      createOp({ boundary: { values: [{ value: TOKYO_3_BOUNDARY }] } }),
    )
    expect(result.success).toBe(true)
  })

  it('accepts an op written before the op-level boundary existed', () => {
    const result = lexicons.validate(RECORD_OP, createOp({}))
    expect(result.success).toBe(true)
  })

  it('rejects an op whose boundary is a bare string', () => {
    const result = lexicons.validate(
      RECORD_OP,
      createOp({ boundary: TOKYO_3_BOUNDARY }),
    )
    expect(result.success).toBe(false)
  })

  it('rejects an op whose boundary values hold bare strings', () => {
    const result = lexicons.validate(
      RECORD_OP,
      createOp({ boundary: { values: [TOKYO_3_BOUNDARY] } }),
    )
    expect(result.success).toBe(false)
  })
})
