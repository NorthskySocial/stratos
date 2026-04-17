import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProfileRecordWriterImpl } from '../src/features/enrollment/internal/profile-record-writer.js'
import { Client } from '@atcute/client'
import * as comAtprotoRepoDeleteRecord from '@atcute/atproto/types/repo/deleteRecord'
import * as comAtprotoRepoPutRecord from '@atcute/atproto/types/repo/putRecord'

vi.mock('@atcute/client', async (importOriginal) => {
  const actual: any = await importOriginal()
  return {
    ...actual,
    Client: vi.fn(),
  }
})

describe('ProfileRecordWriterImpl comprehensive tests', () => {
  let writer: ProfileRecordWriterImpl
  let mockAgentProvider: any
  let mockClientInstance: any
  let mockLogger: any

  const ALICE_DID = 'did:plc:alice'
  const RKEY = 'test-rkey'

  beforeEach(() => {
    vi.clearAllMocks()
    mockAgentProvider = vi.fn().mockResolvedValue({
      handler: vi.fn(),
    })
    mockClientInstance = {
      call: vi.fn().mockResolvedValue({}),
    }
    vi.mocked(Client).mockImplementation(function () {
      return mockClientInstance
    } as any)
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    }
    writer = new ProfileRecordWriterImpl(mockAgentProvider, mockLogger)
  })

  describe('putEnrollmentRecord', () => {
    it('successfully puts a record after deleting existing one', async () => {
      const record = { foo: 'bar' }
      await writer.putEnrollmentRecord(ALICE_DID, RKEY, record)

      expect(mockAgentProvider).toHaveBeenCalledWith(ALICE_DID)
      expect(mockClientInstance.call).toHaveBeenCalledTimes(2)

      // First call: deleteRecord
      expect(mockClientInstance.call).toHaveBeenNthCalledWith(
        1,
        comAtprotoRepoDeleteRecord,
        expect.objectContaining({
          input: {
            repo: ALICE_DID,
            collection: 'zone.stratos.actor.enrollment',
            rkey: RKEY,
          },
        }),
      )

      // Second call: putRecord
      expect(mockClientInstance.call).toHaveBeenNthCalledWith(
        2,
        comAtprotoRepoPutRecord,
        expect.objectContaining({
          input: {
            repo: ALICE_DID,
            collection: 'zone.stratos.actor.enrollment',
            rkey: RKEY,
            record: record,
            validate: false,
          },
        }),
      )

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.anything(),
        'successfully put enrollment record to PDS',
      )
    })

    it('throws error if agentProvider fails', async () => {
      mockAgentProvider.mockRejectedValue(new Error('PDS not found'))

      await expect(
        writer.putEnrollmentRecord(ALICE_DID, RKEY, {}),
      ).rejects.toThrow(`Failed to get PDS agent for ${ALICE_DID}`)

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ did: ALICE_DID }),
        'failed to get PDS agent',
      )
    })

    it('throws error if agentProvider returns null', async () => {
      mockAgentProvider.mockResolvedValue(null)

      await expect(
        writer.putEnrollmentRecord(ALICE_DID, RKEY, {}),
      ).rejects.toThrow(`Failed to get PDS agent for ${ALICE_DID}`)

      expect(mockLogger.error).toHaveBeenCalledWith(
        { did: ALICE_DID },
        'PDS agent not found',
      )
    })

    it('rethrows error if putRecord fails', async () => {
      mockClientInstance.call
        .mockResolvedValueOnce({}) // deleteRecord success
        .mockRejectedValueOnce(new Error('PDS Write failed')) // putRecord failure

      await expect(
        writer.putEnrollmentRecord(ALICE_DID, RKEY, {}),
      ).rejects.toThrow(
        `Failed to put enrollment record to PDS for ${ALICE_DID}`,
      )

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ did: ALICE_DID, rkey: RKEY }),
        'failed to put enrollment record to PDS',
      )
    })
  })

  describe('deleteEnrollmentRecord', () => {
    it('successfully deletes a record', async () => {
      await writer.deleteEnrollmentRecord(ALICE_DID, RKEY)

      expect(mockAgentProvider).toHaveBeenCalledWith(ALICE_DID)
      expect(mockClientInstance.call).toHaveBeenCalledTimes(1)
      expect(mockClientInstance.call).toHaveBeenCalledWith(
        comAtprotoRepoDeleteRecord,
        expect.objectContaining({
          input: {
            repo: ALICE_DID,
            collection: 'zone.stratos.actor.enrollment',
            rkey: RKEY,
          },
        }),
      )
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.anything(),
        'successfully deleted enrollment record from PDS',
      )
    })

    it('throws error if agentProvider fails', async () => {
      mockAgentProvider.mockRejectedValue(new Error('PDS connection error'))

      await expect(
        writer.deleteEnrollmentRecord(ALICE_DID, RKEY),
      ).rejects.toThrow(`Failed to get PDS agent for ${ALICE_DID}`)
    })

    it('throws error if delete fails', async () => {
      mockClientInstance.call.mockRejectedValue(new Error('PDS Delete failed'))

      await expect(
        writer.deleteEnrollmentRecord(ALICE_DID, RKEY),
      ).rejects.toThrow(
        `Failed to delete enrollment record from PDS for ${ALICE_DID}`,
      )

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ did: ALICE_DID, rkey: RKEY }),
        'failed to delete enrollment record from PDS',
      )
    })
  })

  describe('transformRecord internal logic', () => {
    it('transforms nested Uint8Array to base64url $bytes', async () => {
      const sig = new Uint8Array([0, 1, 2, 255])
      // 00 01 02 ff in base64 is AAEB/w==
      // base64url no padding is AAEC_w
      // Wait, 00 01 02 FF:
      // 00000000 00000001 00000010 11111111
      // 000000 000000 010000 001011 111111
      // 0      0      16     11     63
      // A      A      Q      L      /
      // So it should be AAEL/w in base64, AAEL_w in base64url.
      // Let me just use a simpler one. [1, 2, 3]
      // 00000001 00000010 00000011
      // 000000 010000 001000 000011
      // 0      16     8      3
      // A      Q      I      D
      // AQID
      const data = new Uint8Array([1, 2, 3])
      const expectedBase64 = 'AQID'

      const record = {
        nested: {
          data: data,
        },
        array: [data],
      }

      await writer.putEnrollmentRecord(ALICE_DID, RKEY, record as any)

      const putCall = mockClientInstance.call.mock.calls[1]
      const transformed = putCall[1].input.record

      expect(transformed.nested.data).toEqual({ $bytes: expectedBase64 })
      expect(transformed.array[0]).toEqual({ $bytes: expectedBase64 })
    })

    it('handles null and other types correctly', async () => {
      const record = {
        n: null,
        s: 'string',
        b: true,
        num: 123,
      }

      await writer.putEnrollmentRecord(ALICE_DID, RKEY, record as any)

      const putCall = mockClientInstance.call.mock.calls[1]
      const transformed = putCall[1].input.record

      expect(transformed).toEqual(record)
    })
  })
})
