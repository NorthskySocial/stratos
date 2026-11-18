import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createBoundaryRecord } from '@northskysocial/stratos-client'
import type { OAuthSession } from '@atproto/oauth-client-browser'
import type { StratosEnrollment } from '../src/lib/stratos'
import { stratosWriteClient } from '../src/lib/boundary-writes'
import {
  startStratosResponder,
  type StratosResponder,
} from './helpers/stratos-responder'

const BOUNDARY = 'did:web:stratos.example/nerve'
const MEMBER = 'did:plc:shinji'

let responder: StratosResponder

beforeAll(async () => {
  responder = await startStratosResponder()
})

afterAll(async () => {
  await responder.stop()
})

afterEach(() => {
  responder.requests.length = 0
  responder.respondWith(200, {})
})

function enrollment(service: string): StratosEnrollment {
  return {
    service,
    custody: 'stratos',
    boundaries: [{ value: BOUNDARY }],
    signingKey: 'did:key:zQ3shjRei',
    attestation: null,
    createdAt: '1995-10-04T00:00:00.000Z',
    rkey: 'nerve',
  }
}

function write(service: string, sessionOrigin = service) {
  const session = responder.session(MEMBER, sessionOrigin)
  const result = createBoundaryRecord(
    stratosWriteClient(session as unknown as OAuthSession, enrollment(service)),
    {
      boundary: BOUNDARY,
      repo: MEMBER,
      collection: 'zone.stratos.feed.post',
      record: { $type: 'zone.stratos.feed.post', text: 'Unit 01 launches.' },
    },
  )
  return { session, result }
}

describe('stratosWriteClient', () => {
  it('writes to a service on a loopback http origin', async () => {
    responder.respondWith(200, { uri: 'at://x/y/z', cid: 'bafyreiloop' })

    const { result } = write(responder.origin)

    await expect(result).resolves.toMatchObject({ ok: true })
    expect(responder.requests.map((r) => r.path)).toEqual([
      '/xrpc/zone.stratos.repo.createRecord',
    ])
  })

  it.each(['http://stratos.example', 'http://127.0.0.1.example'])(
    'sends nothing to the http origin %s that is not loopback',
    async (service) => {
      const { session, result } = write(service)

      await expect(result).resolves.toEqual({
        ok: false,
        reason: 'invalid-trusted-host',
      })
      expect(session.fetchHandler).not.toHaveBeenCalled()
      expect(responder.requests).toEqual([])
    },
  )

  it('writes to an https service as before', async () => {
    responder.respondWith(200, { uri: 'at://x/y/z', cid: 'bafyreisecure' })

    const { session, result } = write(
      'https://stratos.example',
      'https://stratos.example',
    )

    await expect(result).resolves.toMatchObject({ ok: true })
    expect(session.fetchHandler.mock.calls[0][0]).toBe(
      'https://stratos.example/xrpc/zone.stratos.repo.createRecord',
    )
    expect(responder.requests).toHaveLength(1)
  })

  it('retries once when the service asks for a DPoP nonce', async () => {
    responder.respondOnceWith(
      401,
      { error: 'use_dpop_nonce', message: 'DPoP nonce required' },
      { 'dpop-nonce': 'nonce-kaworu' },
    )
    responder.respondWith(200, { uri: 'at://x/y/z', cid: 'bafyreinonce' })

    const { session, result } = write(responder.origin)

    await expect(result).resolves.toMatchObject({ ok: true })
    expect(session.fetchHandler).toHaveBeenCalledTimes(2)
    expect(responder.requests).toHaveLength(2)
  })

  it('does not retry a second nonce challenge', async () => {
    const challenge = {
      error: 'use_dpop_nonce',
      message: 'DPoP nonce required',
    }
    responder.respondOnceWith(401, challenge, { 'dpop-nonce': 'nonce-asuka' })
    responder.respondOnceWith(401, challenge, { 'dpop-nonce': 'nonce-rei' })

    const { session, result } = write(responder.origin)

    await expect(result).rejects.toMatchObject({ status: 401 })
    expect(session.fetchHandler).toHaveBeenCalledTimes(2)
  })
})
