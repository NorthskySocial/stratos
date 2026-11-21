import { describe, expect, it, vi } from 'vitest'
import type { OAuthSession } from '@atproto/oauth-client-node'
import { buildSpaceScope } from '../src/oauth/client.js'
import { detectSpacesCapability } from '../src/oauth/spaces-capability.js'

vi.mock('../src/shared/space-type-registry.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../src/shared/space-type-registry.js')
  >()),
  HOSTED_SPACE_COLLECTIONS: [
    'zone.stratos.feed.post',
    'zone.stratos.feed.like',
  ],
}))

const SERVICE_DID = 'did:web:tokyo-3.example%3A3100'
const AUTHORITY = encodeURIComponent(SERVICE_DID)
const SPACE = `space:zone.stratos.space.feed?authority=${AUTHORITY}`

function makeSession(scope: unknown) {
  const getTokenInfo = vi.fn().mockResolvedValue({ scope })
  return {
    sub: 'did:plc:rei',
    getTokenInfo,
  } as unknown as OAuthSession
}

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function grantFor(collection: string): string {
  return `${SPACE}&collection=${collection}&action=read ${SPACE}&collection=${collection}&action=create`
}

describe('detectSpacesCapability with several hosted collections', () => {
  it('requests every hosted collection and treats that grant as capable', async () => {
    const scope = buildSpaceScope(SERVICE_DID)
    expect(scope).toContain('collection=zone.stratos.feed.post')
    expect(scope).toContain('collection=zone.stratos.feed.like')

    await expect(
      detectSpacesCapability(makeSession(`atproto ${scope}`), SERVICE_DID),
    ).resolves.toBe('capable')
  })

  it.each([
    ['first', 'zone.stratos.feed.post'],
    ['second', 'zone.stratos.feed.like'],
  ])(
    'keeps capability unknown when only the %s collection is granted',
    async (_name, collection) => {
      const logger = makeLogger()

      await expect(
        detectSpacesCapability(
          makeSession(`atproto ${grantFor(collection)}`),
          SERVICE_DID,
          logger,
        ),
      ).resolves.toBe('unknown')
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        { did: 'did:plc:rei' },
        'requested space scope was not granted, cannot decide spaces capability',
      )
    },
  )
})
