import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

describe('a loopback http service that is more than an origin', () => {
  it('is an origin the write client accepts when it is bare', () => {
    const session = responder.session(MEMBER, responder.origin)
    const client = stratosWriteClient(
      session as unknown as OAuthSession,
      enrollment(responder.origin),
    )

    expect(client.resolveTarget()).toEqual({
      kind: 'stratos',
      url: responder.origin,
    })
  })

  it.each([
    ['a user name', (origin: string) => origin.replace('://', '://pen-pen@')],
    [
      'a user name and password',
      (origin: string) => origin.replace('://', '://pen-pen:warm@'),
    ],
    [
      'a password alone',
      (origin: string) => origin.replace('://', '://:warm@'),
    ],
    ['a path', (origin: string) => `${origin}/xrpc`],
    ['a query', (origin: string) => `${origin}/?unit=01`],
    ['a hash', (origin: string) => `${origin}/#geofront`],
  ])('is refused with %s, and nothing is sent', async (_name, decorate) => {
    const service = decorate(responder.origin)
    const session = responder.session(MEMBER, service)
    const client = stratosWriteClient(
      session as unknown as OAuthSession,
      enrollment(service),
    )

    expect(client.resolveTarget()).toMatchObject({ kind: 'unresolved' })
    await expect(
      createBoundaryRecord(client, {
        boundary: BOUNDARY,
        repo: MEMBER,
        collection: 'zone.stratos.feed.post',
        record: { $type: 'zone.stratos.feed.post', text: 'Unit 01 launches.' },
      }),
    ).resolves.toMatchObject({ ok: false })
    expect(session.fetchHandler).not.toHaveBeenCalled()
    expect(responder.requests).toEqual([])
  })
})
