import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StubWriterServiceImpl } from '../src/features'
import { NotEnrolledError } from '@northskysocial/stratos-core'

describe('StubWriterServiceImpl', () => {
  const serviceDid = 'did:web:stratos.example.com'
  const userDid = 'did:plc:asuka'
  const mockCid = 'bafyreie5cvv4h45feadgeuwhbcutmh6t7ceseocckahdoe6uat64zmz454'
  const createdAt = new Date().toISOString()

  let mockGetAgent: any
  let service: StubWriterServiceImpl

  beforeEach(() => {
    mockGetAgent = vi.fn()
    service = new StubWriterServiceImpl(mockGetAgent, serviceDid)
  })

  it('throws NotEnrolledError if agent is not found in writeStub', async () => {
    mockGetAgent.mockResolvedValue(null)
    await expect(
      service.writeStub(
        userDid,
        'app.bsky.feed.post',
        'rkey',
        'post',
        mockCid as any,
        createdAt,
      ),
    ).rejects.toThrow(NotEnrolledError)
  })

  it('creates a stub record via PDS agent', async () => {
    const mockAgent = {
      api: {
        com: {
          atproto: {
            repo: {
              createRecord: vi.fn().mockResolvedValue({
                data: {
                  uri: `at://${userDid}/app.bsky.feed.post/rkey`,
                  cid: 'cid-stub',
                },
              }),
            },
          },
        },
      },
    }
    mockGetAgent.mockResolvedValue(mockAgent)

    const result = await service.writeStub(
      userDid,
      'app.bsky.feed.post',
      'rkey',
      'post',
      mockCid as any,
      createdAt,
    )

    expect(result.uri).toBe(`at://${userDid}/app.bsky.feed.post/rkey`)
    expect(result.cid).toBe('cid-stub')
    expect(mockAgent.api.com.atproto.repo.createRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: userDid,
        collection: 'app.bsky.feed.post',
        rkey: 'rkey',
      }),
    )

    const record =
      mockAgent.api.com.atproto.repo.createRecord.mock.calls[0][0].record
    expect(record.source).toEqual({
      subject: {
        uri: `at://${userDid}/app.bsky.feed.post/rkey`,
        cid: mockCid,
      },
      service: serviceDid,
      vary: 'authenticated',
    })
  })

  it('throws NotEnrolledError if agent is not found in deleteStub', async () => {
    mockGetAgent.mockResolvedValue(null)
    await expect(
      service.deleteStub(userDid, 'app.bsky.feed.post', 'rkey'),
    ).rejects.toThrow(NotEnrolledError)
  })

  it('deletes a stub record via PDS agent', async () => {
    const mockAgent = {
      api: {
        com: {
          atproto: {
            repo: {
              deleteRecord: vi.fn().mockResolvedValue(undefined),
            },
          },
        },
      },
    }
    mockGetAgent.mockResolvedValue(mockAgent)

    await service.deleteStub(userDid, 'app.bsky.feed.post', 'rkey')

    expect(mockAgent.api.com.atproto.repo.deleteRecord).toHaveBeenCalledWith({
      repo: userDid,
      collection: 'app.bsky.feed.post',
      rkey: 'rkey',
    })
  })
})
