import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Secp256k1Keypair } from '@atproto/crypto'
import type { Keypair } from '@atproto/crypto'
import { handleCallback } from '../src/oauth/handlers/callback.js'
import { buildSpaceScope } from '../src/oauth/index.js'
import { buildRoomCatalog } from '../src/oauth/room-catalog.js'
import { encodeRoomOAuthState } from '../src/oauth/room-oauth-state.js'
import { RepoWriteLocks } from '../src/shared/repo-write-lock.js'

/** Minimal Express request the callback handler reads. */
interface MockRequest {
  url: string
  cookies?: Record<string, string>
  headers?: Record<string, string>
}

/** Minimal Express response the callback handler writes. */
interface MockResponse {
  status: ReturnType<typeof vi.fn>
  json: ReturnType<typeof vi.fn>
  // Not every case exercises the redirect or cookie branches.
  redirect?: ReturnType<typeof vi.fn>
  clearCookie?: ReturnType<typeof vi.fn>
}

function makeReq(
  url = 'http://localhost:3100/oauth/callback?code=foo&state=bar',
): MockRequest {
  return { url }
}

function makeRes(): MockResponse {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
    redirect: vi.fn(),
  }
}

/**
 * The handler wants Express types; these mocks carry only what it touches.
 * The cast is confined here so no test needs `any` at the call site.
 */
function callHandler(
  handler: ReturnType<typeof handleCallback>,
  req: MockRequest,
  res: MockResponse,
): Promise<unknown> {
  const invoke = handler as unknown as (
    req: MockRequest,
    res: MockResponse,
  ) => unknown
  return Promise.resolve(invoke(req, res))
}

/**
 * A minimal OAuth session double. `scope` defaults to the base grant only,
 * i.e. a PDS that ignored the requested space scope — the common case for
 * tests unrelated to spaces-capability detection.
 */
function sessionFor(sub: string, scope = 'atproto') {
  return { sub, getTokenInfo: vi.fn().mockResolvedValue({ scope }) }
}

/** A DID document exposing `keypair` as the DID's `#atproto` signing method. */
function atprotoDidDoc(did: string, keypair: Keypair) {
  return {
    id: did,
    verificationMethod: [
      {
        id: `${did}#atproto`,
        type: 'Multikey',
        controller: did,
        publicKeyMultibase: keypair.did().slice('did:key:'.length),
      },
    ],
    service: [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: 'https://pds.example.com',
      },
    ],
  }
}

describe('handleCallback', () => {
  let mockOauthClient: any
  let mockEnrollmentStore: any
  let mockIdResolver: any
  let mockProfileRecordWriter: any
  let mockLogger: any
  let mockEnrollmentConfig: any
  let mockEnrollmentValidator: any
  let config: any

  beforeEach(() => {
    mockOauthClient = {
      callback: vi.fn(),
      revoke: vi.fn(),
    }
    mockEnrollmentStore = {
      isEnrolled: vi.fn(),
      enroll: vi.fn(),
      getEnrollment: vi.fn(),
      getBoundaries: vi.fn(),
      setBoundaries: vi.fn(),
      addBoundary: vi.fn(),
      updateEnrollment: vi.fn(),
    }
    mockIdResolver = {
      did: {
        resolve: vi.fn(),
      },
    }
    mockEnrollmentValidator = {
      validate: vi.fn().mockResolvedValue({ allowed: true }),
    }
    mockProfileRecordWriter = {
      putEnrollmentRecord: vi.fn().mockResolvedValue(undefined),
      deleteEnrollmentRecord: vi.fn().mockResolvedValue(undefined),
    }
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }
    mockEnrollmentConfig = {
      mode: 'open',
    }
    config = {
      oauthClient: mockOauthClient,
      enrollmentStore: mockEnrollmentStore,
      idResolver: mockIdResolver,
      enrollmentConfig: mockEnrollmentConfig,
      enrollmentValidator: mockEnrollmentValidator,
      profileRecordWriter: mockProfileRecordWriter,
      logger: mockLogger,
      enrollmentEvents: { emit: vi.fn() },
      baseUrl: 'http://localhost:3100',
      allowedRedirectOrigins: [],
      serviceEndpoint: 'http://localhost:3100',
      serviceDid: 'did:web:localhost%3A3100',
      initRepo: vi.fn(),
      createSigningKey: vi.fn().mockResolvedValue('did:key:zQ3sh...'),
      createAttestation: vi.fn().mockResolvedValue({
        sig: new Uint8Array(),
        signingKey: 'did:key:zQ3sh...',
      }),
      repoWriteLocks: {
        acquire: vi.fn().mockResolvedValue(() => undefined),
      },
    }
  })

  it('handles successful new enrollment', async () => {
    const session = sessionFor('did:plc:alice')
    mockOauthClient.callback.mockResolvedValue({ session })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)

    const handler = handleCallback(config)
    const req = makeReq(
      'http://localhost:3100/oauth/callback?code=foo&state=bar',
    )
    const res = makeRes()

    await callHandler(handler, req, res)

    expect(mockOauthClient.callback).toHaveBeenCalled()
    expect(mockEnrollmentStore.enroll).toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        enrolled: true,
        did: 'did:plc:alice',
      }),
    )
  })

  describe('selected-room enrollment', () => {
    const roomA = 'did:web:localhost%3A3100/nebula'
    const roomB = 'did:web:localhost%3A3100/after-school'
    const reserved = 'did:web:localhost%3A3100/general'

    beforeEach(() => {
      config.roomCatalog = buildRoomCatalog([
        {
          id: 'nebula',
          boundary: roomA,
          displayName: 'Nebula',
          description: 'Cowboy Bebop night shift.',
          available: true,
        },
        {
          id: 'after-school',
          boundary: roomB,
          displayName: 'After School',
          description: 'Revolutionary Girl Utena club.',
          available: true,
        },
      ])
      config.reservedBoundary = reserved
    })

    function stateFor(roomId: 'nebula' | 'after-school') {
      const boundary = roomId === 'nebula' ? roomA : roomB
      return encodeRoomOAuthState({
        roomId,
        boundary,
        redirectTo: 'https://clubhouse.example/after-oauth',
      })
    }

    it('enrolls exactly the selected room and reserved boundary', async () => {
      mockOauthClient.callback.mockResolvedValue({
        session: sessionFor('did:plc:spike'),
        state: stateFor('nebula'),
      })
      mockEnrollmentStore.isEnrolled.mockResolvedValue(false)

      const response = makeRes()
      await callHandler(
        handleCallback(config),
        makeReq(
          'http://localhost:3100/oauth/callback?code=foo&state=bar&room=after-school',
        ),
        response,
      )

      expect(mockEnrollmentStore.enroll).toHaveBeenCalledWith(
        expect.objectContaining({ boundaries: [roomA, reserved] }),
      )
      expect(config.createAttestation).toHaveBeenCalledWith(
        'did:plc:spike',
        [roomA, reserved],
        'did:key:zQ3sh...',
      )
      expect(mockProfileRecordWriter.putEnrollmentRecord).toHaveBeenCalledWith(
        'did:plc:spike',
        expect.any(String),
        expect.objectContaining({
          boundaries: [{ value: roomA }, { value: reserved }],
        }),
      )
      expect(response.redirect).toHaveBeenCalledWith(
        'https://clubhouse.example/after-oauth?stratos_enrolled=true&stratos_enrollment=pending',
      )
    })

    it('uses server state, unions a second room, and preserves stored custody', async () => {
      mockOauthClient.callback.mockResolvedValue({
        session: sessionFor('did:plc:faye'),
        state: stateFor('after-school'),
      })
      mockEnrollmentValidator.validate.mockResolvedValue({
        allowed: true,
        pdsEndpoint: 'https://pds.example.com',
      })
      mockEnrollmentStore.isEnrolled.mockResolvedValue(true)
      mockEnrollmentStore.getEnrollment.mockResolvedValue({
        did: 'did:plc:faye',
        active: true,
        enrollmentRkey: 'did:web:localhost:3100',
        signingKeyDid: 'did:key:faye',
        pdsEndpoint: 'https://pds.example.com',
        custody: 'pds',
        repoHost: 'https://pds.example.com',
      })
      mockEnrollmentStore.getBoundaries = vi
        .fn()
        .mockResolvedValueOnce([roomA, reserved])
        .mockResolvedValue([roomA, reserved, roomB])

      await callHandler(
        handleCallback(config),
        makeReq(
          'http://localhost:3100/oauth/callback?code=foo&state=bar&room=nebula',
        ),
        makeRes(),
      )

      const expectedBoundaries = [roomA, reserved, roomB]
      expect(mockEnrollmentStore.addBoundary).toHaveBeenCalledWith(
        'did:plc:faye',
        roomB,
      )
      expect(config.createAttestation).toHaveBeenCalledWith(
        'did:plc:faye',
        expectedBoundaries,
        'did:key:faye',
      )
      expect(mockProfileRecordWriter.putEnrollmentRecord).toHaveBeenCalledWith(
        'did:plc:faye',
        'did:web:localhost:3100',
        expect.objectContaining({
          boundaries: expectedBoundaries.map((value) => ({ value })),
          custody: 'pds',
          repoHost: 'https://pds.example.com',
        }),
      )
    })

    it('does not add a boundary during a generic reauthorization', async () => {
      mockOauthClient.callback.mockResolvedValue({
        session: sessionFor('did:plc:jet'),
        state: null,
      })
      mockEnrollmentValidator.validate.mockResolvedValue({
        allowed: true,
        pdsEndpoint: 'https://pds.example.com',
      })
      mockEnrollmentStore.isEnrolled.mockResolvedValue(true)
      mockEnrollmentStore.getEnrollment.mockResolvedValue({
        did: 'did:plc:jet',
        active: true,
        enrollmentRkey: 'did:web:localhost:3100',
        signingKeyDid: 'did:key:jet',
        custody: 'stratos',
      })
      mockEnrollmentStore.getBoundaries.mockResolvedValue([roomA, reserved])

      const response = makeRes()
      await callHandler(handleCallback(config), makeReq(), response)

      expect(mockEnrollmentStore.addBoundary).not.toHaveBeenCalled()
      expect(response.status).not.toHaveBeenCalled()
    })

    it('does not add an already-held selected room boundary', async () => {
      mockOauthClient.callback.mockResolvedValue({
        session: sessionFor('did:plc:jet'),
        state: stateFor('nebula'),
      })
      mockEnrollmentValidator.validate.mockResolvedValue({
        allowed: true,
        pdsEndpoint: 'https://pds.example.com',
      })
      mockEnrollmentStore.isEnrolled.mockResolvedValue(true)
      mockEnrollmentStore.getEnrollment.mockResolvedValue({
        did: 'did:plc:jet',
        active: true,
        enrollmentRkey: 'did:web:localhost:3100',
        signingKeyDid: 'did:key:jet',
        custody: 'stratos',
      })
      mockEnrollmentStore.getBoundaries.mockResolvedValue([roomA, reserved])

      const response = makeRes()
      await callHandler(handleCallback(config), makeReq(), response)

      expect(mockEnrollmentStore.addBoundary).not.toHaveBeenCalled()
      expect(response.status).not.toHaveBeenCalled()
    })

    it('serializes concurrent room joins and publishes their union', async () => {
      const locks = new RepoWriteLocks()
      config.repoWriteLocks = locks
      const did = 'did:plc:ed'
      const membership = new Set([reserved])
      mockOauthClient.callback
        .mockResolvedValueOnce({
          session: sessionFor(did),
          state: stateFor('nebula'),
        })
        .mockResolvedValueOnce({
          session: sessionFor(did),
          state: stateFor('after-school'),
        })
      mockEnrollmentValidator.validate.mockResolvedValue({
        allowed: true,
        pdsEndpoint: 'https://pds.example.com',
      })
      mockEnrollmentStore.isEnrolled.mockResolvedValue(true)
      mockEnrollmentStore.getEnrollment.mockResolvedValue({
        did,
        active: true,
        enrollmentRkey: 'did:web:localhost:3100',
        signingKeyDid: 'did:key:ed',
        pdsEndpoint: 'https://pds.example.com',
        custody: 'stratos',
      })
      mockEnrollmentStore.getBoundaries.mockImplementation(async () => [
        ...membership,
      ])
      mockEnrollmentStore.addBoundary.mockImplementation(
        async (_did: string, boundary: string) => {
          membership.add(boundary)
        },
      )

      try {
        const callback = handleCallback(config)
        await Promise.all([
          callHandler(callback, makeReq(), makeRes()),
          callHandler(callback, makeReq(), makeRes()),
        ])

        expect([...membership]).toEqual(
          expect.arrayContaining([reserved, roomA, roomB]),
        )
        expect(
          mockProfileRecordWriter.putEnrollmentRecord,
        ).toHaveBeenLastCalledWith(
          did,
          'did:web:localhost:3100',
          expect.objectContaining({
            boundaries: expect.arrayContaining([
              { value: reserved },
              { value: roomA },
              { value: roomB },
            ]),
          }),
        )
      } finally {
        locks.destroy()
      }
    })

    it('serializes concurrent first enrollments and preserves both rooms plus reserved', async () => {
      const locks = new RepoWriteLocks()
      config.repoWriteLocks = locks
      const did = 'did:plc:first-enrollment-race'
      const membership = new Set<string>()
      let enrolled = false

      mockOauthClient.callback
        .mockResolvedValueOnce({
          session: sessionFor(did),
          state: stateFor('nebula'),
        })
        .mockResolvedValueOnce({
          session: sessionFor(did),
          state: stateFor('after-school'),
        })
      mockEnrollmentValidator.validate.mockResolvedValue({
        allowed: true,
        pdsEndpoint: 'https://pds.example.com',
      })
      mockEnrollmentStore.isEnrolled.mockImplementation(async () => enrolled)
      mockEnrollmentStore.getEnrollment.mockImplementation(async () =>
        enrolled
          ? {
              did,
              active: true,
              enrollmentRkey: 'did:web:localhost:3100',
              signingKeyDid: 'did:key:first-enrollment-race',
              pdsEndpoint: 'https://pds.example.com',
              custody: 'stratos',
            }
          : undefined,
      )
      mockEnrollmentStore.getBoundaries.mockImplementation(async () => [
        ...membership,
      ])
      mockEnrollmentStore.addBoundary.mockImplementation(
        async (_did: string, boundary: string) => {
          membership.add(boundary)
        },
      )
      mockEnrollmentStore.enroll.mockImplementation(
        async (input: { boundaries: string[] }) => {
          enrolled = true
          for (const boundary of input.boundaries) membership.add(boundary)
        },
      )

      try {
        const callback = handleCallback(config)
        await Promise.all([
          callHandler(callback, makeReq(), makeRes()),
          callHandler(callback, makeReq(), makeRes()),
        ])

        expect(mockEnrollmentStore.enroll).toHaveBeenCalledTimes(1)
        expect(mockEnrollmentStore.setBoundaries).not.toHaveBeenCalled()
        expect(mockEnrollmentStore.addBoundary).toHaveBeenCalledWith(did, roomB)
        expect([...membership]).toEqual(
          expect.arrayContaining([roomA, roomB, reserved]),
        )
        expect(
          mockProfileRecordWriter.putEnrollmentRecord,
        ).toHaveBeenLastCalledWith(
          did,
          'did:web:localhost:3100',
          expect.objectContaining({
            boundaries: expect.arrayContaining([
              { value: roomA },
              { value: roomB },
              { value: reserved },
            ]),
          }),
        )
      } finally {
        locks.destroy()
      }
    })

    it('fails closed if a consumed state no longer resolves to a configured room', async () => {
      mockOauthClient.callback.mockResolvedValue({
        session: sessionFor('did:plc:jet'),
        state: encodeRoomOAuthState({
          roomId: 'removed',
          boundary: 'did:web:localhost%3A3100/removed',
          redirectTo: 'https://clubhouse.example/',
        }),
      })
      const res = makeRes()

      await callHandler(handleCallback(config), makeReq(), res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(mockEnrollmentStore.enroll).not.toHaveBeenCalled()
    })

    it('keeps generic redirect state and default boundaries with a room catalogue', async () => {
      config.defaultBoundaries = [reserved]
      mockOauthClient.callback.mockResolvedValue({
        session: sessionFor('did:plc:generic'),
        state: 'https://clubhouse.example/generic-return',
      })
      mockEnrollmentStore.isEnrolled.mockResolvedValue(false)

      const response = makeRes()
      await callHandler(handleCallback(config), makeReq(), response)

      expect(mockEnrollmentStore.enroll).toHaveBeenCalledWith(
        expect.objectContaining({ boundaries: [reserved] }),
      )
      expect(response.redirect).toHaveBeenCalledWith(
        'https://clubhouse.example/generic-return?stratos_enrolled=true',
      )
    })

    it('keeps null state on the normal enrollment path with a room catalogue', async () => {
      config.defaultBoundaries = [reserved]
      mockOauthClient.callback.mockResolvedValue({
        session: sessionFor('did:plc:default'),
        state: null,
      })
      mockEnrollmentStore.isEnrolled.mockResolvedValue(false)

      await callHandler(handleCallback(config), makeReq(), makeRes())

      expect(mockEnrollmentStore.enroll).toHaveBeenCalledWith(
        expect.objectContaining({ boundaries: [reserved] }),
      )
    })

    it('fails closed for a malformed room state payload', async () => {
      mockOauthClient.callback.mockResolvedValue({
        session: sessionFor('did:plc:malformed'),
        state: '{"kind":"stratos-room-enrollment-v1","roomId":"nebula",',
      })
      const response = makeRes()

      await callHandler(handleCallback(config), makeReq(), response)

      expect(response.status).toHaveBeenCalledWith(400)
      expect(mockEnrollmentStore.enroll).not.toHaveBeenCalled()
    })
  })

  it('records the spaces capability verdict for a new enrollment', async () => {
    const session = sessionFor(
      'did:plc:alice',
      `atproto ${buildSpaceScope(config.serviceDid)}`,
    )
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    mockOauthClient.callback.mockResolvedValue({ session })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)
    mockEnrollmentValidator.validate.mockResolvedValue({
      allowed: true,
      pdsEndpoint: 'https://spaces.example.com',
    })
    mockIdResolver.did.resolve.mockResolvedValue(
      atprotoDidDoc('did:plc:alice', keypair),
    )

    const handler = handleCallback(config)
    const req: any = {
      url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
    }
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
    }

    await handler(req, res)

    // The verdict has to reach the stored enrollment, not just the log line.
    expect(mockEnrollmentStore.enroll).toHaveBeenCalledWith(
      expect.objectContaining({ capabilityVerdict: 'capable' }),
    )
    expect(mockLogger.info).toHaveBeenCalledWith(
      {
        did: 'did:plc:alice',
        spacesCapability: 'capable',
        custody: 'pds',
      },
      'determined enrollment custody',
    )
  })

  it('keeps stratos custody end-to-end when the capability verdict is not-capable', async () => {
    const session = sessionFor('did:plc:kenshin')
    mockOauthClient.callback.mockResolvedValue({ session })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)
    mockEnrollmentValidator.validate.mockResolvedValue({
      allowed: true,
      pdsEndpoint: 'https://pds.example.com',
    })

    const handler = handleCallback(config)
    const req = makeReq(
      'http://localhost:3100/oauth/callback?code=foo&state=bar',
    )
    const res = makeRes()

    await callHandler(handler, req, res)

    expect(config.initRepo).toHaveBeenCalledWith('did:plc:kenshin')
    expect(config.createSigningKey).toHaveBeenCalledWith('did:plc:kenshin')
    expect(mockIdResolver.did.resolve).not.toHaveBeenCalled()
    expect(mockEnrollmentStore.enroll).toHaveBeenCalledWith(
      expect.objectContaining({
        did: 'did:plc:kenshin',
        signingKeyDid: 'did:key:zQ3sh...',
        custody: 'stratos',
        repoHost: undefined,
      }),
    )
    expect(mockProfileRecordWriter.putEnrollmentRecord).toHaveBeenCalledWith(
      'did:plc:kenshin',
      expect.any(String),
      expect.objectContaining({ custody: 'stratos', repoHost: undefined }),
    )
  })

  it('falls back to stratos custody when the capability verdict is unknown', async () => {
    const session = {
      sub: 'did:plc:rei',
      getTokenInfo: vi.fn().mockRejectedValue(new Error('token info refused')),
    }
    mockOauthClient.callback.mockResolvedValue({ session })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)
    mockEnrollmentValidator.validate.mockResolvedValue({
      allowed: true,
      pdsEndpoint: 'https://pds.example.com',
    })

    const handler = handleCallback(config)
    const req: any = {
      url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
    }
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
    }

    await handler(req, res)

    expect(config.initRepo).toHaveBeenCalledWith('did:plc:rei')
    expect(mockEnrollmentStore.enroll).toHaveBeenCalledWith(
      expect.objectContaining({ custody: 'stratos' }),
    )
  })

  it('grants pds custody, resolves the user own #atproto key, and creates no Stratos repo', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const did = 'did:plc:asuka'
    mockOauthClient.callback.mockResolvedValue({
      session: sessionFor(did, `atproto ${buildSpaceScope(config.serviceDid)}`),
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)
    mockEnrollmentValidator.validate.mockResolvedValue({
      allowed: true,
      pdsEndpoint: 'https://pds.example.com',
    })
    mockIdResolver.did.resolve.mockResolvedValue(atprotoDidDoc(did, keypair))

    const handler = handleCallback(config)
    const req: any = {
      url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
    }
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
    }

    await handler(req, res)

    expect(config.initRepo).not.toHaveBeenCalled()
    expect(config.createSigningKey).not.toHaveBeenCalled()
    expect(mockIdResolver.did.resolve).toHaveBeenCalledWith(did)
    expect(mockEnrollmentStore.enroll).toHaveBeenCalledWith(
      expect.objectContaining({
        did,
        signingKeyDid: keypair.did(),
        custody: 'pds',
        repoHost: 'https://pds.example.com',
      }),
    )
    expect(mockProfileRecordWriter.putEnrollmentRecord).toHaveBeenCalledWith(
      did,
      expect.any(String),
      expect.objectContaining({
        signingKey: keypair.did(),
        custody: 'pds',
        repoHost: 'https://pds.example.com',
      }),
    )
  })

  it('fails closed when the DID document has no usable #atproto key', async () => {
    const did = 'did:plc:shinji'
    mockOauthClient.callback.mockResolvedValue({
      session: sessionFor(did, `atproto ${buildSpaceScope(config.serviceDid)}`),
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)
    mockEnrollmentValidator.validate.mockResolvedValue({
      allowed: true,
      pdsEndpoint: 'https://pds.example.com',
    })
    mockIdResolver.did.resolve.mockResolvedValue({
      id: did,
      verificationMethod: [],
    })

    const handler = handleCallback(config)
    const req: any = {
      url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
    }
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
    }

    await handler(req, res)

    expect(mockEnrollmentStore.enroll).not.toHaveBeenCalled()
    expect(mockProfileRecordWriter.putEnrollmentRecord).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(500)
  })

  it('sends the same attestation payload shape for both custody classes', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })

    // stratos custody
    mockOauthClient.callback.mockResolvedValue({
      session: sessionFor('did:plc:misato'),
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)
    mockEnrollmentValidator.validate.mockResolvedValue({
      allowed: true,
      pdsEndpoint: 'https://pds.example.com',
    })
    const stratosHandler = handleCallback(config)
    await stratosHandler(
      {
        url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
      } as any,
      {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        redirect: vi.fn(),
      } as any,
    )
    expect(config.createAttestation).toHaveBeenCalledWith(
      'did:plc:misato',
      expect.any(Array),
      'did:key:zQ3sh...',
    )

    // pds custody
    config.createAttestation.mockClear()
    mockOauthClient.callback.mockResolvedValue({
      session: sessionFor(
        'did:plc:asuka2',
        `atproto ${buildSpaceScope(config.serviceDid)}`,
      ),
    })
    mockEnrollmentValidator.validate.mockResolvedValue({
      allowed: true,
      pdsEndpoint: 'https://pds.example.com',
    })
    mockIdResolver.did.resolve.mockResolvedValue(
      atprotoDidDoc('did:plc:asuka2', keypair),
    )
    const pdsHandler = handleCallback(config)
    await pdsHandler(
      {
        url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
      } as any,
      {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        redirect: vi.fn(),
      } as any,
    )
    expect(config.createAttestation).toHaveBeenCalledWith(
      'did:plc:asuka2',
      expect.any(Array),
      keypair.did(),
    )
  })

  it('handles successful existing enrollment', async () => {
    const session = sessionFor('did:plc:alice')
    mockOauthClient.callback.mockResolvedValue({ session })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(true)
    mockEnrollmentStore.getEnrollment.mockResolvedValue({
      did: 'did:plc:alice',
      enrollmentRkey: 'did:web:localhost:3100',
    })

    const handler = handleCallback(config)
    const req = makeReq(
      'http://localhost:3100/oauth/callback?code=foo&state=bar',
    )
    const res = makeRes()

    await callHandler(handler, req, res)

    expect(mockOauthClient.callback).toHaveBeenCalled()
    expect(mockEnrollmentStore.enroll).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        enrolled: false,
        did: 'did:plc:alice',
        message: 'Already enrolled in Stratos',
      }),
    )
  })

  it('emits a boundary change after a selected-room reauthorization', async () => {
    const boundary = 'did:web:localhost%3A3100/swordsmith'
    config.roomCatalog = buildRoomCatalog([
      {
        id: 'swordsmith',
        boundary,
        displayName: 'Swordsmith',
        description: 'Berserk night shift.',
        available: true,
      },
    ])
    const session = sessionFor('did:plc:alice')
    mockOauthClient.callback.mockResolvedValue({
      session,
      state: encodeRoomOAuthState({
        roomId: 'swordsmith',
        boundary,
        redirectTo: 'https://clubhouse.example/after-oauth',
      }),
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(true)
    mockEnrollmentStore.getEnrollment.mockResolvedValue({
      did: 'did:plc:alice',
      active: true,
      enrollmentRkey: 'did:web:previous-service.test',
      signingKeyDid: 'did:key:zQ3sh...',
      pdsEndpoint: 'https://pds.example.com',
    })
    mockEnrollmentStore.getBoundaries = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([boundary])
    mockEnrollmentValidator.validate.mockResolvedValue({
      allowed: true,
      pdsEndpoint: 'https://pds.example.com',
    })
    await callHandler(handleCallback(config), makeReq(), makeRes())

    expect(config.enrollmentEvents.emit).toHaveBeenCalledWith('enrollment', {
      did: 'did:plc:alice',
      action: 'boundaries',
      boundaries: [boundary],
      priorBoundaries: [],
      time: expect.any(String),
    })
  })

  it('denies enrollment if not allowed', async () => {
    const session = sessionFor('did:plc:malice')
    mockOauthClient.callback.mockResolvedValue({ session })
    mockEnrollmentValidator.validate.mockResolvedValue({
      allowed: false,
      reason: 'NotInAllowlist',
    })

    const handler = handleCallback(config)
    const req = makeReq(
      'http://localhost:3100/oauth/callback?code=foo&state=bar',
    )
    const res: MockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await callHandler(handler, req, res)

    expect(mockOauthClient.revoke).toHaveBeenCalledWith('did:plc:malice')
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'EnrollmentDenied',
        message: 'Your account is not eligible for this Stratos service',
      }),
    )
  })

  it('handles OAuth callback failure', async () => {
    mockOauthClient.callback.mockRejectedValue(new Error('OAuth failed'))

    const handler = handleCallback(config)
    const req = makeReq(
      'http://localhost:3100/oauth/callback?code=foo&state=bar',
    )
    const res: MockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await callHandler(handler, req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'CallbackError',
        message: 'Failed to complete authorization',
      }),
    )
  })

  it('handles DID resolution failure when checking PDS allowlist', async () => {
    const session = sessionFor('did:plc:alice')
    mockOauthClient.callback.mockResolvedValue({ session })
    mockEnrollmentValidator.validate.mockResolvedValue({
      allowed: false,
      reason: 'DidNotResolved',
    })

    const handler = handleCallback(config)
    const req = makeReq(
      'http://localhost:3100/oauth/callback?code=foo&state=bar',
    )
    const res: MockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await callHandler(handler, req, res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'EnrollmentDenied',
        message: 'Could not verify your identity',
      }),
    )
  })

  it('redirects to the target that authorize verified into the OAuth state', async () => {
    mockOauthClient.callback.mockResolvedValue({
      session: sessionFor('did:plc:alice'),
      state: 'https://app.example/',
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)

    const handler = handleCallback(config)
    const req = makeReq(
      'http://localhost:3100/oauth/callback?code=foo&state=bar',
    )
    const res = makeRes()

    await callHandler(handler, req, res)

    expect(res.redirect!).toHaveBeenCalledWith(
      'https://app.example/?stratos_enrolled=true',
    )
  })

  it('ignores a stratos_redirect cookie, which a host neighbour could forge', async () => {
    mockOauthClient.callback.mockResolvedValue({
      session: sessionFor('did:plc:alice'),
      state: null,
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)

    const handler = handleCallback(config)
    const req: MockRequest = {
      url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
      cookies: { stratos_redirect: 'https://evil.example/' },
    }
    const res: MockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
      clearCookie: vi.fn(),
    }

    await callHandler(handler, req, res)

    expect(res.redirect).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, did: 'did:plc:alice' }),
    )
    // With no stored target there is nothing to report. A guard that entered
    // the redirect branch anyway would warn here.
    expect(mockLogger.warn).not.toHaveBeenCalled()
  })

  it('declines a stored redirect that uses a disallowed scheme', async () => {
    config.baseUrl = 'https://stratos.example'
    mockOauthClient.callback.mockResolvedValue({
      session: sessionFor('did:plc:alice'),
      state: 'http://evil.example/',
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)

    const handler = handleCallback(config)
    const req = makeReq(
      'https://stratos.example/oauth/callback?code=foo&state=bar',
    )
    const res: MockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
      clearCookie: vi.fn(),
    }

    await callHandler(handler, req, res)

    expect(res.redirect).not.toHaveBeenCalled()
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { origin: 'http://evil.example' },
      expect.stringContaining('disallowed scheme'),
    )
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, did: 'did:plc:alice' }),
    )
  })

  it('declines a stored redirect that is not a valid URL', async () => {
    mockOauthClient.callback.mockResolvedValue({
      session: sessionFor('did:plc:alice'),
      state: 'not-a-url',
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)

    const handler = handleCallback(config)
    const req = makeReq(
      'http://localhost:3100/oauth/callback?code=foo&state=bar',
    )
    const res: MockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
      clearCookie: vi.fn(),
    }

    await callHandler(handler, req, res)

    expect(res.redirect).not.toHaveBeenCalled()
    expect(mockLogger.warn).toHaveBeenCalledWith(
      {},
      expect.stringContaining('not a valid URL'),
    )
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    )
  })

  it('puts no credential on the redirect', async () => {
    const did = 'did:plc:alice'
    mockOauthClient.callback.mockResolvedValue({
      session: sessionFor(did),
      state: 'https://app.example/',
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)

    const handler = handleCallback(config)
    const req = makeReq(
      'http://localhost:3100/oauth/callback?code=secret-code&state=bar',
    )
    const res: MockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
      clearCookie: vi.fn(),
    }

    await callHandler(handler, req, res)

    const target = new URL(res.redirect!.mock.calls[0][0])
    expect([...target.searchParams.keys()]).toEqual(['stratos_enrolled'])
    expect(target.href).not.toContain(did)
    expect(target.href).not.toContain('secret-code')
    expect(target.hash).toBe('')
  })

  it('handles re-enrollment logic correctly', async () => {
    // Test that handleExistingEnrollment is called and it updates/migrates as needed
    const session = sessionFor('did:plc:alice')
    mockOauthClient.callback.mockResolvedValue({ session })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(true)
    mockEnrollmentStore.getEnrollment.mockResolvedValue({
      did: 'did:plc:alice',
      enrollmentRkey: 'old-rkey', // Trigger migration
    })

    const handler = handleCallback(config)
    const req = makeReq(
      'http://localhost:3100/oauth/callback?code=foo&state=bar',
    )
    const res = makeRes()

    await callHandler(handler, req, res)

    // Should still return success
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        enrolled: false,
      }),
    )
  })

  describe('custody reconciliation on re-auth', () => {
    function existingEnrollment(overrides: Record<string, unknown>) {
      return {
        did: 'did:plc:kaoru',
        enrollmentRkey: 'did:web:localhost:3100',
        active: true,
        signingKeyDid: 'did:key:zQ3sh...',
        pdsEndpoint: 'https://pds.example.com',
        custody: 'stratos',
        ...overrides,
      }
    }

    beforeEach(() => {
      mockEnrollmentStore.getBoundaries = vi.fn().mockResolvedValue([])
      mockEnrollmentStore.setBoundaries = vi.fn()
      // Matches existingEnrollment()'s stored pdsEndpoint, so these tests
      // isolate custody reconciliation from the separate pdsEndpoint-refresh
      // behaviour covered below.
      mockEnrollmentValidator.validate.mockResolvedValue({
        allowed: true,
        pdsEndpoint: 'https://pds.example.com',
      })
    })

    async function runExisting() {
      mockEnrollmentStore.isEnrolled.mockResolvedValue(true)
      const handler = handleCallback(config)
      const req: any = {
        url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
      }
      const res: any = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        redirect: vi.fn(),
      }
      await handler(req, res)
      return res
    }

    it('records the new verdict but keeps stratos custody when the grant becomes capable', async () => {
      mockOauthClient.callback.mockResolvedValue({
        session: sessionFor(
          'did:plc:kaoru',
          `atproto ${buildSpaceScope(config.serviceDid)}`,
        ),
      })
      mockEnrollmentStore.getEnrollment.mockResolvedValue(
        existingEnrollment({ custody: 'stratos', repoHost: undefined }),
      )

      await runExisting()

      // Moving custody means moving the repo and changing the signing key.
      // Neither happens here, so the label must not move on its own.
      expect(mockEnrollmentStore.updateEnrollment).toHaveBeenCalledWith(
        'did:plc:kaoru',
        { capabilityVerdict: 'capable' },
      )
      expect(mockProfileRecordWriter.putEnrollmentRecord).toHaveBeenCalledWith(
        'did:plc:kaoru',
        expect.any(String),
        expect.objectContaining({ custody: 'stratos', repoHost: undefined }),
      )
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          did: 'did:plc:kaoru',
          storedCustody: 'stratos',
          wantedCustody: 'pds',
        }),
        'custody diverged from the granted scope, migration required',
      )
    })

    it('records the new verdict but keeps pds custody when the grant is revoked', async () => {
      mockOauthClient.callback.mockResolvedValue({
        session: sessionFor('did:plc:kaoru'), // base scope only: not-capable
      })
      mockEnrollmentStore.getEnrollment.mockResolvedValue(
        existingEnrollment({
          custody: 'pds',
          repoHost: 'https://pds.example.com',
        }),
      )

      await runExisting()

      // Flipping to 'stratos' here would reopen the write gate and mint a
      // second signing key, while the user's records stay on their PDS.
      expect(mockEnrollmentStore.updateEnrollment).toHaveBeenCalledWith(
        'did:plc:kaoru',
        { capabilityVerdict: 'not-capable' },
      )
      expect(mockProfileRecordWriter.putEnrollmentRecord).toHaveBeenCalledWith(
        'did:plc:kaoru',
        expect.any(String),
        expect.objectContaining({
          custody: 'pds',
          repoHost: 'https://pds.example.com',
        }),
      )
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          storedCustody: 'pds',
          wantedCustody: 'stratos',
        }),
        'custody diverged from the granted scope, migration required',
      )
    })

    it('never flips pds custody to stratos when the re-auth verdict is unknown', async () => {
      mockOauthClient.callback.mockResolvedValue({
        session: {
          sub: 'did:plc:kaoru',
          getTokenInfo: vi
            .fn()
            .mockRejectedValue(new Error('introspection down')),
        },
      })
      mockEnrollmentStore.getEnrollment.mockResolvedValue(
        existingEnrollment({
          custody: 'pds',
          repoHost: 'https://pds.example.com',
        }),
      )

      await runExisting()

      expect(mockProfileRecordWriter.putEnrollmentRecord).toHaveBeenCalledWith(
        'did:plc:kaoru',
        expect.any(String),
        expect.objectContaining({
          custody: 'pds',
          repoHost: 'https://pds.example.com',
        }),
      )
      // The verdict is persisted so a later migration pass can find this
      // user. Custody itself must not move: losing the answer is not the
      // same as learning the answer is no.
      expect(mockEnrollmentStore.updateEnrollment).toHaveBeenCalledWith(
        'did:plc:kaoru',
        expect.objectContaining({ capabilityVerdict: 'unknown' }),
      )
      expect(mockEnrollmentStore.updateEnrollment).not.toHaveBeenCalledWith(
        'did:plc:kaoru',
        expect.objectContaining({ custody: 'stratos' }),
      )
    })

    it('refreshes repoHost and the stored pdsEndpoint when the resolved PDS endpoint changes', async () => {
      mockOauthClient.callback.mockResolvedValue({
        session: sessionFor(
          'did:plc:kaoru',
          `atproto ${buildSpaceScope(config.serviceDid)}`,
        ),
      })
      mockEnrollmentValidator.validate.mockResolvedValue({
        allowed: true,
        pdsEndpoint: 'https://new-pds.example.com',
      })
      mockEnrollmentStore.getEnrollment.mockResolvedValue(
        existingEnrollment({
          custody: 'pds',
          repoHost: 'https://pds.example.com',
          pdsEndpoint: 'https://pds.example.com',
          capabilityVerdict: 'capable',
        }),
      )

      await runExisting()

      // A user who moved PDS must get their new host published, not a stale one.
      expect(mockProfileRecordWriter.putEnrollmentRecord).toHaveBeenCalledWith(
        'did:plc:kaoru',
        expect.any(String),
        expect.objectContaining({
          custody: 'pds',
          repoHost: 'https://new-pds.example.com',
        }),
      )
      expect(mockEnrollmentStore.updateEnrollment).toHaveBeenCalledWith(
        'did:plc:kaoru',
        {
          pdsEndpoint: 'https://new-pds.example.com',
          repoHost: 'https://new-pds.example.com',
        },
      )
    })

    it('refreshes the stored pdsEndpoint on stratos custody without setting a repoHost', async () => {
      mockOauthClient.callback.mockResolvedValue({
        session: sessionFor('did:plc:kaoru'), // base scope only: not-capable
      })
      mockEnrollmentValidator.validate.mockResolvedValue({
        allowed: true,
        pdsEndpoint: 'https://new-pds.example.com',
      })
      mockEnrollmentStore.getEnrollment.mockResolvedValue(
        existingEnrollment({
          custody: 'stratos',
          repoHost: undefined,
          pdsEndpoint: 'https://pds.example.com',
          capabilityVerdict: 'not-capable',
        }),
      )

      await runExisting()

      expect(mockProfileRecordWriter.putEnrollmentRecord).toHaveBeenCalledWith(
        'did:plc:kaoru',
        expect.any(String),
        expect.objectContaining({ custody: 'stratos', repoHost: undefined }),
      )
      expect(mockEnrollmentStore.updateEnrollment).toHaveBeenCalledWith(
        'did:plc:kaoru',
        { pdsEndpoint: 'https://new-pds.example.com' },
      )
      // The store treats a present `repoHost` key as an explicit clear, so
      // equality alone is not enough: the key must be absent.
      const updateArg = mockEnrollmentStore.updateEnrollment.mock.calls[0][1]
      expect('repoHost' in updateArg).toBe(false)
    })

    it('resolves the PDS endpoint from the DID document when open-mode eligibility returns none', async () => {
      // Open mode answers eligibility before it resolves the DID document,
      // so the validation result carries no endpoint. A pds-custody re-auth
      // must publish a resolved host, never `repoHost: undefined`.
      const keypair = await Secp256k1Keypair.create({ exportable: true })
      mockOauthClient.callback.mockResolvedValue({
        session: sessionFor(
          'did:plc:kaoru',
          `atproto ${buildSpaceScope(config.serviceDid)}`,
        ),
      })
      mockEnrollmentValidator.validate.mockResolvedValue({ allowed: true })
      const doc = atprotoDidDoc('did:plc:kaoru', keypair)
      doc.service[0].serviceEndpoint = 'https://pds.tokyo3.example.com'
      mockIdResolver.did.resolve.mockResolvedValue(doc)
      mockEnrollmentStore.getEnrollment.mockResolvedValue(
        existingEnrollment({
          custody: 'pds',
          repoHost: 'https://pds.example.com',
          pdsEndpoint: 'https://pds.example.com',
          capabilityVerdict: 'capable',
        }),
      )

      await runExisting()

      expect(mockProfileRecordWriter.putEnrollmentRecord).toHaveBeenCalledWith(
        'did:plc:kaoru',
        expect.any(String),
        expect.objectContaining({
          custody: 'pds',
          repoHost: 'https://pds.tokyo3.example.com',
        }),
      )
      expect(mockEnrollmentStore.updateEnrollment).toHaveBeenCalledWith(
        'did:plc:kaoru',
        {
          pdsEndpoint: 'https://pds.tokyo3.example.com',
          repoHost: 'https://pds.tokyo3.example.com',
        },
      )
    })
  })

  describe('spaces capability detection', () => {
    // Keep the shared fixture. A `did:web` service DID carries `%3A` for its
    // port, and interpolating that raw into the scope used to break the match
    // silently, so the encoded form is the case worth defending.
    const SERVICE_DID = 'did:web:localhost%3A3100'

    beforeEach(() => {
      config.serviceDid = SERVICE_DID
      mockEnrollmentStore.isEnrolled.mockResolvedValue(false)
      // A 'capable' verdict routes into pds provisioning, which resolves the
      // user's own #atproto key. Without this the request 500s and a
      // log-only assertion still passes, hiding the failure.
      mockIdResolver.did.resolve.mockResolvedValue({
        service: [
          {
            id: '#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: 'https://pds.example.com',
          },
        ],
        id: 'did:plc:kenshin',
        verificationMethod: [
          {
            id: 'did:plc:kenshin#atproto',
            type: 'Multikey',
            controller: 'did:plc:kenshin',
            publicKeyMultibase:
              'zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme',
          },
        ],
      })
    })

    it.each([
      ['did:web:localhost%3A3100', 'a did:web with an encoded port'],
      ['did:web:127.0.0.1%3A3100', 'the e2e service DID'],
      ['did:web:stratos.example.com', 'a did:web with no port'],
      ['did:plc:kaoru', 'a did:plc'],
    ])('reports capable for %s (%s)', async (serviceDid) => {
      config.serviceDid = serviceDid
      const session = sessionFor(
        'did:plc:kenshin',
        `atproto ${buildSpaceScope(serviceDid)}`,
      )
      const res = await runCallback(session)

      expect(mockLogger.info).toHaveBeenCalledWith(
        { did: 'did:plc:kenshin', spacesCapability: 'capable' },
        'detected PDS spaces capability',
      )
      // The verdict has to reach the stored enrollment. Asserting only the
      // log lets a later failure pass unnoticed.
      expect(res.status).not.toHaveBeenCalledWith(500)
      expect(mockEnrollmentStore.enroll).toHaveBeenCalledWith(
        expect.objectContaining({ custody: 'pds' }),
      )
    })

    async function runCallback(session: unknown) {
      mockOauthClient.callback.mockResolvedValue({ session })
      const handler = handleCallback(config)
      const req = makeReq(
        'http://localhost:3100/oauth/callback?code=foo&state=bar',
      )
      const res = makeRes()
      await callHandler(handler, req, res)
      return res
    }

    it('reports capable when the PDS granted the requested space scope', async () => {
      const scope = `atproto ${buildSpaceScope(SERVICE_DID)}`
      const session = sessionFor('did:plc:kenshin', scope)
      await runCallback(session)

      expect(mockLogger.info).toHaveBeenCalledWith(
        { did: 'did:plc:kenshin', spacesCapability: 'capable' },
        'detected PDS spaces capability',
      )
      // getTokenInfo(true) would force a network refresh; the check only
      // needs the scope already on the session.
      expect(session.getTokenInfo).toHaveBeenCalledWith(false)
    })

    it('reports not-capable when the PDS silently dropped the space scope', async () => {
      // sessionFor defaults to the base-only grant, i.e. the scope a
      // non-spaces PDS returns after ignoring the space scope request.
      await runCallback(sessionFor('did:plc:kaoru'))

      expect(mockLogger.info).toHaveBeenCalledWith(
        { did: 'did:plc:kaoru', spacesCapability: 'not-capable' },
        'detected PDS spaces capability',
      )
    })

    it('reports not-capable when the granted scope names a different authority', async () => {
      const scope = `atproto ${buildSpaceScope('did:web:other.example.com')}`
      await runCallback(sessionFor('did:plc:sanosuke', scope))

      expect(mockLogger.info).toHaveBeenCalledWith(
        { did: 'did:plc:sanosuke', spacesCapability: 'not-capable' },
        'detected PDS spaces capability',
      )
    })

    it('reports unknown, never not-capable, when the token-info read fails', async () => {
      const session = {
        sub: 'did:plc:megumi',
        getTokenInfo: vi
          .fn()
          .mockRejectedValue(new Error('introspection down')),
      }
      await runCallback(session)

      expect(mockLogger.info).toHaveBeenCalledWith(
        { did: 'did:plc:megumi', spacesCapability: 'unknown' },
        'detected PDS spaces capability',
      )
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ did: 'did:plc:megumi' }),
        expect.stringContaining('failed to read granted OAuth scope'),
      )
    })

    it('reports unknown when the token response carried no scope', async () => {
      const session = {
        sub: 'did:plc:kenshin',
        getTokenInfo: vi.fn().mockResolvedValue({}),
      }
      await runCallback(session)

      expect(mockLogger.info).toHaveBeenCalledWith(
        { did: 'did:plc:kenshin', spacesCapability: 'unknown' },
        'detected PDS spaces capability',
      )
      expect(mockEnrollmentStore.enroll).toHaveBeenCalledWith(
        expect.objectContaining({ custody: 'stratos' }),
      )
    })

    it('reports not-capable when the grant can read but cannot create', async () => {
      // Custody decides where this user's records are written, so a read-only
      // grant is not capable of the flow we would put them in.
      const readOnly =
        `atproto space:zone.stratos.space.feed?authority=${SERVICE_DID}` +
        `&collection=zone.stratos.feed.post&action=read`
      const session = sessionFor('did:plc:kenshin', readOnly)
      await runCallback(session)

      expect(mockLogger.info).toHaveBeenCalledWith(
        { did: 'did:plc:kenshin', spacesCapability: 'not-capable' },
        'detected PDS spaces capability',
      )
      expect(mockEnrollmentStore.enroll).toHaveBeenCalledWith(
        expect.objectContaining({ custody: 'stratos' }),
      )
    })

    it('does not require a logger: a token-info failure still resolves the request', async () => {
      config.logger = undefined
      const session = {
        sub: 'did:plc:yahiko',
        getTokenInfo: vi
          .fn()
          .mockRejectedValue(new Error('introspection down')),
      }
      const res = await runCallback(session)

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, did: 'did:plc:yahiko' }),
      )
    })
  })

  it('refuses pds custody when the DID document names no PDS', async () => {
    // Open mode returns eligibility without resolving the document, so the
    // enrolment result carries no endpoint. A pds custody row without a host
    // has nowhere to sync from and must not be stored.
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const did = 'did:plc:misato'
    mockOauthClient.callback.mockResolvedValue({
      session: sessionFor(did, `atproto ${buildSpaceScope(config.serviceDid)}`),
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)
    // No pdsEndpoint, exactly as open mode returns it.
    mockEnrollmentValidator.validate.mockResolvedValue({ allowed: true })
    const doc = atprotoDidDoc(did, keypair)
    mockIdResolver.did.resolve.mockResolvedValue({ ...doc, service: [] })

    const handler = handleCallback(config)
    const res = makeRes()
    await callHandler(handler, makeReq(), res)

    expect(mockEnrollmentStore.enroll).not.toHaveBeenCalled()
    expect(mockProfileRecordWriter.putEnrollmentRecord).not.toHaveBeenCalled()
  })
})
