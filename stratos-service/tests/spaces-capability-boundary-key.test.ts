import { describe, expect, it } from 'vitest'
import type { OAuthSession } from '@atproto/oauth-client-node'
import { SPACE_TYPE } from '../src/oauth/client.js'
import {
  detectSpacesCapability,
  grantAllowsCreate,
  holdsSpaceGrant,
} from '../src/oauth/spaces-capability.js'
import { HOSTED_SPACE_COLLECTIONS } from '../src/shared/space-type-registry.js'

const SERVICE_DID = 'did:web:nerv.tokyo.jp'
const AUTHORITY = encodeURIComponent(SERVICE_DID)
const SPACE = `space:${SPACE_TYPE}?authority=${AUTHORITY}`
const LIKE = 'app.bsky.feed.like'
const ALL_COLLECTIONS = HOSTED_SPACE_COLLECTIONS.map(
  (collection) => `collection=${collection}`,
).join('&')

const grantFor = (keyParam: string, action: 'read' | 'create') =>
  `atproto ${SPACE}${keyParam}&${ALL_COLLECTIONS}&action=${action}`

const BOUNDARY_KEYS: Array<[string, string]> = [
  ['one boundary key', '&skey=engineering'],
  ['every boundary key', '&skey=*'],
  ['no boundary key', ''],
]

const coversEveryBoundary = (keyParam: string) =>
  keyParam !== '&skey=engineering'

const verdictOf = (scope: string) =>
  detectSpacesCapability(
    {
      sub: 'did:plc:misato-katsuragi',
      getTokenInfo: () => Promise.resolve({ scope }),
    } as unknown as OAuthSession,
    SERVICE_DID,
  )

describe('a space grant limited to one boundary key', () => {
  it.each(BOUNDARY_KEYS)(
    'allows creating a like in any boundary only when it covers every key: %s',
    (_name, keyParam) => {
      expect(
        grantAllowsCreate(grantFor(keyParam, 'create'), LIKE, SERVICE_DID),
      ).toBe(coversEveryBoundary(keyParam))
    },
  )

  it.each(BOUNDARY_KEYS)(
    'is held as a space grant by its read only when it covers every key: %s',
    (_name, keyParam) => {
      expect(holdsSpaceGrant(grantFor(keyParam, 'read'), SERVICE_DID)).toBe(
        coversEveryBoundary(keyParam),
      )
    },
  )

  it.each(BOUNDARY_KEYS)(
    'is capable only when its read and create cover every key: %s',
    async (_name, keyParam) => {
      const scope = `${grantFor(keyParam, 'read')} ${grantFor('&skey=*', 'create').replace('atproto ', '')}`

      expect(await verdictOf(scope)).toBe(
        coversEveryBoundary(keyParam) ? 'capable' : 'unknown',
      )
    },
  )
})
