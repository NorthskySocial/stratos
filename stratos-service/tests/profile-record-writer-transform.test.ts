import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProfileRecordWriterImpl } from '../src/features/enrollment/internal/profile-record-writer.js'
import { Client } from '@atcute/client'

vi.mock('@atcute/client', () => {
  const callMock = vi.fn().mockResolvedValue({})
  return {
    Client: vi.fn().mockImplementation(function () {
      return {
        call: callMock,
      }
    }),
  }
})

describe('ProfileRecordWriterImpl', () => {
  let writer: ProfileRecordWriterImpl
  let mockAgentProvider: any

  beforeEach(() => {
    mockAgentProvider = vi.fn().mockResolvedValue({
      handler: vi.fn(),
    })
    writer = new ProfileRecordWriterImpl(mockAgentProvider)
    vi.clearAllMocks()
  })

  it('transforms Uint8Array to $bytes object in putEnrollmentRecord', async () => {
    const did = 'did:plc:alice'
    const rkey = 'some-service'
    const sig = new Uint8Array([1, 2, 3, 4, 5, 255])
    const record = {
      service: 'http://example.com',
      attestation: {
        sig: sig,
        signingKey: 'did:key:zQ3sh...',
      },
    }

    await writer.putEnrollmentRecord(did, rkey, record)

    const clientInstance = vi.mocked(Client).mock.results[0].value
    const calls = clientInstance.call.mock.calls

    // We expect 2 calls: deleteRecord and putRecord
    expect(calls.length).toBe(2)

    const putRecordCall = calls[1]
    const transformedRecord = putRecordCall[1].input.record
    expect(transformedRecord.attestation.sig).toEqual({
      $bytes: Buffer.from(sig)
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_'),
    })
    expect(transformedRecord.service).toBe('http://example.com')
  })
})
