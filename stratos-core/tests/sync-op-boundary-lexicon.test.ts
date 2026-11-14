import { Lexicons } from '@atproto/lexicon'
import { describe, expect, it } from 'vitest'
import { stratosLexicons } from '../src/lexicons'

const RECORD_OP = 'zone.stratos.sync.subscribeRecords#recordOp'
const POST = 'zone.stratos.feed.post'
const TOKYO_3_BOUNDARY = 'did:web:nerv.tokyo.jp/tokyo-3'
const GEOFRONT_BOUNDARY = 'did:web:nerv.tokyo.jp/geofront'

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

  it('accepts a removal op whose boundary lists two values', () => {
    const result = lexicons.validate(RECORD_OP, {
      action: 'delete',
      path: 'zone.stratos.feed.post/3kmisato',
      boundary: {
        values: [{ value: TOKYO_3_BOUNDARY }, { value: GEOFRONT_BOUNDARY }],
      },
    })
    expect(result.success).toBe(true)
  })

  it('accepts a removal op that names the boundary the record moved into', () => {
    const result = lexicons.validate(RECORD_OP, {
      action: 'delete',
      path: 'zone.stratos.feed.post/3kmisato',
      boundary: { values: [{ value: TOKYO_3_BOUNDARY }] },
      excludeBoundary: { values: [{ value: GEOFRONT_BOUNDARY }] },
    })
    expect(result.success).toBe(true)
  })

  it('rejects an op whose excludeBoundary is a bare string', () => {
    const result = lexicons.validate(RECORD_OP, {
      action: 'delete',
      path: 'zone.stratos.feed.post/3kmisato',
      boundary: { values: [{ value: TOKYO_3_BOUNDARY }] },
      excludeBoundary: GEOFRONT_BOUNDARY,
    })
    expect(result.success).toBe(false)
  })

  it('still rejects a record whose boundary lists two values', () => {
    const result = lexicons.validate(POST, {
      $type: POST,
      text: 'Pilots report to the Geofront.',
      createdAt: '2026-01-01T00:00:00.000Z',
      boundary: {
        $type: 'zone.stratos.boundary.defs#Domains',
        values: [{ value: TOKYO_3_BOUNDARY }, { value: GEOFRONT_BOUNDARY }],
      },
    })
    expect(result.success).toBe(false)
  })
})
