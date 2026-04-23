import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProfileRecordWriterImpl } from '../src/features/enrollment/internal/profile-record-writer.js'
import { Client, ClientResponseError } from '@atcute/client'
import * as comAtprotoRepoDeleteRecord from '@atcute/atproto/types/repo/deleteRecord'

vi.mock('@atcute/client', async (importOriginal) => {
  const actual: any = await importOriginal()
  return {
    ...actual,
    Client: vi.fn(),
  }
})

describe('ProfileRecordWriterImpl error handling', () => {
  let writer: ProfileRecordWriterImpl
  let mockAgentProvider: any
  let mockClientInstance: any

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
    writer = new ProfileRecordWriterImpl(mockAgentProvider)
  })

  it('rethrows errors from deleteRecord that are not RecordNotFound', async () => {
    const error = new ClientResponseError({
      status: 400,
      data: { error: 'SomeOtherError', message: 'Something went wrong' },
    })

    mockClientInstance.call.mockRejectedValueOnce(error)

    await expect(
      writer.putEnrollmentRecord('did:plc:alice', 'rkey', {}),
    ).rejects.toThrow(
      'Failed to put enrollment record to PDS for did:plc:alice',
    )

    expect(mockClientInstance.call).toHaveBeenCalledTimes(1)
    expect(mockClientInstance.call).toHaveBeenCalledWith(
      comAtprotoRepoDeleteRecord,
      expect.objectContaining({
        input: expect.objectContaining({
          repo: 'did:plc:alice',
          collection: 'zone.stratos.actor.enrollment',
          rkey: 'rkey',
        }),
      }),
    )
  })

  it('continues if deleteRecord fails with InvalidRequest because record is not found', async () => {
    const error = new ClientResponseError({
      status: 400,
      data: { error: 'InvalidRequest', message: 'Record not found' },
    })

    mockClientInstance.call.mockRejectedValueOnce(error)
    // Next call for putRecord should succeed
    mockClientInstance.call.mockResolvedValueOnce({ ok: true })

    await writer.putEnrollmentRecord('did:plc:alice', 'rkey', {})

    expect(mockClientInstance.call).toHaveBeenCalledTimes(2)
  })

  it('continues if deleteRecord fails with RecordNotFound', async () => {
    const error = new ClientResponseError({
      status: 404,
      data: { error: 'RecordNotFound', message: 'Record not found' },
    })

    mockClientInstance.call.mockRejectedValueOnce(error)
    mockClientInstance.call.mockResolvedValueOnce({ ok: true })

    await writer.putEnrollmentRecord('did:plc:alice', 'rkey', {})

    expect(mockClientInstance.call).toHaveBeenCalledTimes(2)
  })
})
