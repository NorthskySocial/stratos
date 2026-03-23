import { describe, it, expect, vi, beforeEach } from 'vitest'
import { migrateEnrollmentRkey, serviceDIDToRkey } from '../src/oauth/routes.js'
import type { EnrollmentStore } from '../src/oauth/routes.js'
import type { NodeOAuthClient } from '@atproto/oauth-client-node'

vi.mock('@atproto/api', () => {
  const MockAgent = vi.fn()
  return { Agent: MockAgent }
})

import { Agent } from '@atproto/api'

function createMockEnrollmentStore(
  enrollment: Record<string, unknown> | null = null,
): EnrollmentStore {
  return {
    isEnrolled: vi.fn(async () => !!enrollment),
    getEnrollment: vi.fn(
      async () =>
        enrollment as ReturnType<
          EnrollmentStore['getEnrollment']
        > extends Promise<infer T>
          ? T
          : never,
    ),
    enroll: vi.fn(async () => {}),
    unenroll: vi.fn(async () => {}),
    updateEnrollment: vi.fn(async () => {}),
    getBoundaries: vi.fn(async () => []),
    setBoundaries: vi.fn(async () => {}),
    addBoundary: vi.fn(async () => {}),
    removeBoundary: vi.fn(async () => {}),
  }
}

const SERVICE_ENDPOINT = 'https://stratos.example.com'
const SERVICE_DID = 'did:web:stratos.example.com'
const SERVICE_DID_RKEY = serviceDIDToRkey(SERVICE_DID)
const TEST_DID = 'did:plc:ayanamireimigration'

function createMockAgent(records: Array<{ uri: string; value: unknown }> = []) {
  return {
    com: {
      atproto: {
        repo: {
          listRecords: vi.fn(async () => ({
            data: { records },
          })),
          putRecord: vi.fn(async () => ({
            data: {
              uri: `at://did:plc:test/zone.stratos.actor.enrollment/${SERVICE_DID_RKEY}`,
              cid: 'bafynew',
            },
          })),
          deleteRecord: vi.fn(async () => {}),
        },
      },
    },
  }
}

function createMockOAuthClient(
  records: Array<{ uri: string; value: unknown }> = [],
) {
  const mockAgent = createMockAgent(records)

  vi.mocked(Agent).mockImplementation(function () {
    return mockAgent as unknown as InstanceType<typeof Agent>
  } as unknown as (...args: unknown[]) => InstanceType<typeof Agent>)

  return {
    client: {
      restore: vi.fn(async () => ({})),
    } as unknown as NodeOAuthClient,
    agent: mockAgent,
  }
}

const SELF_RECORD = {
  uri: `at://${TEST_DID}/zone.stratos.actor.enrollment/self`,
  cid: 'bafyold',
  value: {
    service: SERVICE_ENDPOINT,
    boundaries: [{ value: 'swordsmith' }],
    signingKey: 'did:key:zDnaeTestKey123',
    createdAt: '2025-01-01T00:00:00Z',
  },
}

const TID_RECORD = {
  uri: `at://${TEST_DID}/zone.stratos.actor.enrollment/3jzfcijpj2z2a`,
  cid: 'bafytid',
  value: {
    service: SERVICE_ENDPOINT,
    boundaries: [{ value: 'swordsmith' }],
    signingKey: 'did:key:zDnaeTestKey123',
    createdAt: '2025-01-01T00:00:00Z',
  },
}

const CORRECT_RKEY_RECORD = {
  uri: `at://${TEST_DID}/zone.stratos.actor.enrollment/${SERVICE_DID_RKEY}`,
  cid: 'bafycorrect',
  value: {
    service: SERVICE_ENDPOINT,
    boundaries: [{ value: 'swordsmith' }],
    signingKey: 'did:key:zDnaeTestKey123',
    createdAt: '2025-01-01T00:00:00Z',
  },
}

describe('serviceDIDToRkey', () => {
  it('should pass through a did:web without percent encoding', () => {
    expect(serviceDIDToRkey('did:web:stratos.example.com')).toBe(
      'did:web:stratos.example.com',
    )
  })

  it('should replace %3A with colon for port-encoded did:web', () => {
    expect(serviceDIDToRkey('did:web:localhost%3A3100')).toBe(
      'did:web:localhost:3100',
    )
  })

  it('should handle case-insensitive percent encoding', () => {
    expect(serviceDIDToRkey('did:web:localhost%3a3100')).toBe(
      'did:web:localhost:3100',
    )
  })

  it('should handle did:plc unchanged', () => {
    expect(serviceDIDToRkey('did:plc:xyz123abc')).toBe('did:plc:xyz123abc')
  })
})

describe('migrateEnrollmentRkey', () => {
  describe('when enrollment already has the correct service DID rkey', () => {
    it('should skip migration', async () => {
      const store = createMockEnrollmentStore({
        did: TEST_DID,
        enrolledAt: '2025-01-01T00:00:00Z',
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
        enrollmentRkey: SERVICE_DID_RKEY,
      })
      const { client } = createMockOAuthClient()

      await migrateEnrollmentRkey(
        TEST_DID,
        store,
        client,
        SERVICE_ENDPOINT,
        SERVICE_DID,
      )

      expect(client.restore).not.toHaveBeenCalled()
      expect(store.updateEnrollment).not.toHaveBeenCalled()
    })
  })

  describe('when enrollment has a self-keyed record', () => {
    let store: EnrollmentStore
    let agent: ReturnType<typeof createMockOAuthClient>['agent']
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }

    beforeEach(async () => {
      vi.mocked(Agent).mockReset()
      store = createMockEnrollmentStore({
        did: TEST_DID,
        enrolledAt: '2025-01-01T00:00:00Z',
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
      })
      const mock = createMockOAuthClient([SELF_RECORD])
      agent = mock.agent

      await migrateEnrollmentRkey(
        TEST_DID,
        store,
        mock.client,
        SERVICE_ENDPOINT,
        SERVICE_DID,
        mockLogger,
      )
    })

    it('should write a new record with service DID rkey via putRecord', () => {
      expect(agent.com.atproto.repo.putRecord).toHaveBeenCalledWith({
        repo: TEST_DID,
        collection: 'zone.stratos.actor.enrollment',
        rkey: SERVICE_DID_RKEY,
        record: SELF_RECORD.value,
      })
    })

    it('should delete the old self-keyed record', () => {
      expect(agent.com.atproto.repo.deleteRecord).toHaveBeenCalledWith({
        repo: TEST_DID,
        collection: 'zone.stratos.actor.enrollment',
        rkey: 'self',
      })
    })

    it('should update the DB with the service DID rkey', () => {
      expect(store.updateEnrollment).toHaveBeenCalledWith(TEST_DID, {
        enrollmentRkey: SERVICE_DID_RKEY,
      })
    })
  })

  describe('when enrollment has a TID-keyed record', () => {
    let store: EnrollmentStore
    let agent: ReturnType<typeof createMockOAuthClient>['agent']

    beforeEach(async () => {
      vi.mocked(Agent).mockReset()
      store = createMockEnrollmentStore({
        did: TEST_DID,
        enrolledAt: '2025-01-01T00:00:00Z',
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
        enrollmentRkey: '3jzfcijpj2z2a',
      })
      const mock = createMockOAuthClient([TID_RECORD])
      agent = mock.agent

      await migrateEnrollmentRkey(
        TEST_DID,
        store,
        mock.client,
        SERVICE_ENDPOINT,
        SERVICE_DID,
      )
    })

    it('should write a new record with service DID rkey', () => {
      expect(agent.com.atproto.repo.putRecord).toHaveBeenCalledWith({
        repo: TEST_DID,
        collection: 'zone.stratos.actor.enrollment',
        rkey: SERVICE_DID_RKEY,
        record: TID_RECORD.value,
      })
    })

    it('should delete the old TID-keyed record', () => {
      expect(agent.com.atproto.repo.deleteRecord).toHaveBeenCalledWith({
        repo: TEST_DID,
        collection: 'zone.stratos.actor.enrollment',
        rkey: '3jzfcijpj2z2a',
      })
    })

    it('should update the DB with the service DID rkey', () => {
      expect(store.updateEnrollment).toHaveBeenCalledWith(TEST_DID, {
        enrollmentRkey: SERVICE_DID_RKEY,
      })
    })
  })

  describe('when PDS record already has the correct rkey but DB does not', () => {
    it('should sync the DB without rewriting the PDS record', async () => {
      vi.mocked(Agent).mockReset()
      const store = createMockEnrollmentStore({
        did: TEST_DID,
        enrolledAt: '2025-01-01T00:00:00Z',
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
      })
      const { client, agent } = createMockOAuthClient([CORRECT_RKEY_RECORD])

      await migrateEnrollmentRkey(
        TEST_DID,
        store,
        client,
        SERVICE_ENDPOINT,
        SERVICE_DID,
      )

      expect(agent.com.atproto.repo.putRecord).not.toHaveBeenCalled()
      expect(agent.com.atproto.repo.deleteRecord).not.toHaveBeenCalled()
      expect(store.updateEnrollment).toHaveBeenCalledWith(TEST_DID, {
        enrollmentRkey: SERVICE_DID_RKEY,
      })
    })
  })

  describe('when no matching record exists on PDS', () => {
    it('should not create or delete anything', async () => {
      vi.mocked(Agent).mockReset()
      const otherServiceRecord = {
        ...SELF_RECORD,
        value: {
          ...SELF_RECORD.value,
          service: 'https://other-stratos.example.com',
        },
      }
      const store = createMockEnrollmentStore({
        did: TEST_DID,
        enrolledAt: '2025-01-01T00:00:00Z',
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
      })
      const { client, agent } = createMockOAuthClient([otherServiceRecord])

      await migrateEnrollmentRkey(
        TEST_DID,
        store,
        client,
        SERVICE_ENDPOINT,
        SERVICE_DID,
      )

      expect(agent.com.atproto.repo.putRecord).not.toHaveBeenCalled()
      expect(agent.com.atproto.repo.deleteRecord).not.toHaveBeenCalled()
      expect(store.updateEnrollment).not.toHaveBeenCalled()
    })
  })

  describe('when enrollment is not found', () => {
    it('should skip migration', async () => {
      const store = createMockEnrollmentStore(null)
      const { client } = createMockOAuthClient()

      await migrateEnrollmentRkey(
        TEST_DID,
        store,
        client,
        SERVICE_ENDPOINT,
        SERVICE_DID,
      )

      expect(client.restore).not.toHaveBeenCalled()
      expect(store.updateEnrollment).not.toHaveBeenCalled()
    })
  })

  describe('when PDS API call fails', () => {
    it('should not throw and not update the DB', async () => {
      const store = createMockEnrollmentStore({
        did: TEST_DID,
        enrolledAt: '2025-01-01T00:00:00Z',
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
      })
      const client = {
        restore: vi.fn(async () => {
          throw new Error('OAuth session expired')
        }),
      } as unknown as NodeOAuthClient

      await expect(
        migrateEnrollmentRkey(
          TEST_DID,
          store,
          client,
          SERVICE_ENDPOINT,
          SERVICE_DID,
        ),
      ).resolves.not.toThrow()

      expect(store.updateEnrollment).not.toHaveBeenCalled()
    })
  })

  describe('trailing slash normalization', () => {
    it('should match service URLs with trailing slash differences', async () => {
      vi.mocked(Agent).mockReset()
      const recordWithSlash = {
        ...SELF_RECORD,
        value: {
          ...SELF_RECORD.value,
          service: 'https://stratos.example.com/',
        },
      }
      const store = createMockEnrollmentStore({
        did: TEST_DID,
        enrolledAt: '2025-01-01T00:00:00Z',
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
      })
      const { client, agent } = createMockOAuthClient([recordWithSlash])

      await migrateEnrollmentRkey(
        TEST_DID,
        store,
        client,
        SERVICE_ENDPOINT,
        SERVICE_DID,
      )

      expect(agent.com.atproto.repo.putRecord).toHaveBeenCalled()
      expect(store.updateEnrollment).toHaveBeenCalledWith(TEST_DID, {
        enrollmentRkey: SERVICE_DID_RKEY,
      })
    })
  })
})
