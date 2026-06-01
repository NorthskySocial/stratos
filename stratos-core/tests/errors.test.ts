import { describe, expect, it } from 'vitest'
import {
  BlobAccessDeniedError,
  BoundaryNotAllowedError,
  EnrollmentDeniedError,
  InvalidIdentifierError,
  MstError,
  NotEnrolledError,
  RecordNotFoundError,
  StratosError,
} from '../src'

describe('Domain Errors', () => {
  it('StratosError should have correct properties', () => {
    const error = new StratosError('Explosion in Tokyo-3', 'TEST_ERROR', {
      cause: 'Angel attack',
    })
    expect(error.message).toBe('Explosion in Tokyo-3')
    expect(error.code).toBe('TEST_ERROR')
    expect(error.cause).toBe('Angel attack')
    expect(error.name).toBe('StratosError')
  })

  it('NotEnrolledError should format message correctly', () => {
    const error = new NotEnrolledError('did:plc:shinji')
    expect(error.message).toBe('User did:plc:shinji is not enrolled')
    expect(error.code).toBe('NotEnrolled')
    expect(error.name).toBe('NotEnrolledError')
  })

  it('EnrollmentDeniedError should store reason', () => {
    const error = new EnrollmentDeniedError('Denied', 'NotInAllowlist')
    expect(error.message).toBe('Denied')
    expect(error.reason).toBe('NotInAllowlist')
    expect(error.code).toBe('EnrollmentDenied')
  })

  it('BoundaryNotAllowedError should format message correctly', () => {
    const error = new BoundaryNotAllowedError('geo:tokyo-2')
    expect(error.message).toBe("Boundary 'geo:tokyo-2' not allowed")
    expect(error.code).toBe('ForbiddenBoundary')
  })

  it('RecordNotFoundError should format message correctly', () => {
    const error = new RecordNotFoundError(
      'at://did:plc:rei/zone.stratos.feed.post/123',
    )
    expect(error.message).toBe(
      'Record not found: at://did:plc:rei/zone.stratos.feed.post/123',
    )
    expect(error.code).toBe('RecordNotFound')
  })

  it('InvalidIdentifierError should have correct code', () => {
    const error = new InvalidIdentifierError('Bad CID')
    expect(error.message).toBe('Bad CID')
    expect(error.code).toBe('InvalidIdentifier')
  })

  it('MstError should have correct code', () => {
    const error = new MstError('MST failure')
    expect(error.message).toBe('MST failure')
    expect(error.code).toBe('MstError')
  })

  it('BlobAccessDeniedError should format message correctly', () => {
    const error = new BlobAccessDeniedError('bafybeig')
    expect(error.message).toBe('Access denied to blob: bafybeig')
    expect(error.code).toBe('BlobAccessDenied')
  })
})
