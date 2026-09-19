import { describe, expect, it, vi } from 'vitest'
import type { OAuthSession } from '@atproto/oauth-client-node'
import { buildSpaceScope } from '../src/oauth/client.js'
import { detectSpacesCapability } from '../src/oauth/spaces-capability.js'

const SERVICE_DID = 'did:web:tokyo-3.example%3A3100'
const AUTHORITY = encodeURIComponent(SERVICE_DID)
const SPACE = `space:zone.stratos.space.feed?authority=${AUTHORITY}`
const COLLECTION = 'collection=zone.stratos.feed.post'

function makeSession(scope: unknown) {
  const getTokenInfo = vi.fn().mockResolvedValue({ scope })
  const session = {
    sub: 'did:plc:rei',
    getTokenInfo,
  } as unknown as OAuthSession
  return { session, getTokenInfo }
}

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

describe('detectSpacesCapability', () => {
  it.each([
    buildSpaceScope(SERVICE_DID),
    `${SPACE}&${COLLECTION}&action=read ${SPACE}&${COLLECTION}&action=create`,
    `${SPACE}&${COLLECTION}`,
  ])('accepts effective read and create permission from %s', async (scope) => {
    const { session, getTokenInfo } = makeSession(`atproto ${scope}`)
    const logger = makeLogger()

    await expect(
      detectSpacesCapability(session, SERVICE_DID, logger),
    ).resolves.toBe('capable')
    expect(getTokenInfo).toHaveBeenCalledExactlyOnceWith(false)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it.each([
    ['base grant only', 'atproto repo:zone.stratos.actor.enrollment'],
    ['read only', `${SPACE}&${COLLECTION}&action=read`],
    ['create only', `${SPACE}&${COLLECTION}&action=create`],
    ['wrong authority', buildSpaceScope('did:web:seele.example')],
    [
      'wrong space type',
      `space:zone.stratos.space.other?authority=${AUTHORITY}&${COLLECTION}`,
    ],
    ['wrong collection', `${SPACE}&collection=app.bsky.feed.post`],
    ['one boundary only', `${SPACE}&${COLLECTION}&skey=nerv`],
  ])('keeps capability unknown for %s', async (_name, scope) => {
    const { session } = makeSession(scope)
    const logger = makeLogger()

    await expect(
      detectSpacesCapability(session, SERVICE_DID, logger),
    ).resolves.toBe('unknown')
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      { did: 'did:plc:rei' },
      'requested space scope was not granted, cannot decide spaces capability',
    )
  })

  it.each([undefined, null, '', 42])(
    'keeps capability unknown when scope is %s',
    async (scope) => {
      const { session } = makeSession(scope)
      const logger = makeLogger()

      await expect(
        detectSpacesCapability(session, SERVICE_DID, logger),
      ).resolves.toBe('unknown')
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        { did: 'did:plc:rei' },
        'token response carried no scope, cannot decide spaces capability',
      )
    },
  )

  it.each([new Error('session unavailable'), 'session unavailable'])(
    'keeps capability unknown when token information fails with %s',
    async (error) => {
      const { session, getTokenInfo } = makeSession('atproto')
      getTokenInfo.mockRejectedValue(error)
      const logger = makeLogger()

      await expect(
        detectSpacesCapability(session, SERVICE_DID, logger),
      ).resolves.toBe('unknown')
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        { did: 'did:plc:rei', err: 'session unavailable' },
        'failed to read granted OAuth scope for spaces capability check',
      )
    },
  )

  it.each(['atproto', undefined])(
    'does not require logging for an incomplete grant: %s',
    async (scope) => {
      const { session } = makeSession(scope)
      await expect(detectSpacesCapability(session, SERVICE_DID)).resolves.toBe(
        'unknown',
      )
    },
  )
})
