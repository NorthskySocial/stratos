import { describe, expect, it } from 'vitest'
import {
  SpacePermission,
  type SpacePermissionMatch,
} from '@atproto/oauth-scopes'
import { buildSpaceScope } from '../src/oauth/index.js'

// Every `expected` value below is what the upstream scope parser
// (@atproto/oauth-scopes 0.0.0-spaces-alpha-20261124235736, the copy this
// service depends on) answered for the string beside it. `null` means the
// parser refused the string. The strings the apps request are written out
// here and pinned again in the browser package's tests.

const SPACE_TYPE = 'zone.stratos.space.feed'
const AUTHORITY = 'did:plc:bebop'
const ENCODED_AUTHORITY = 'did%3Aplc%3Abebop'
const POST = 'zone.stratos.feed.post'
const HEAD = `space:${SPACE_TYPE}?authority=${ENCODED_AUTHORITY}&collection=${POST}`

interface Parsed {
  authority: string
  collection: string[]
  action: string[]
}

const WEBAPP_SCOPE = `${HEAD}&action=read&action=create&action=delete`
const CLUBHOUSE_SCOPE = `${HEAD}&action=read&action=create&action=update&action=delete`

const TABLE: ReadonlyArray<{
  label: string
  scope: string
  expected: Parsed | null
}> = [
  {
    label: 'browser default',
    scope: `${HEAD}&action=read&action=create`,
    expected: {
      authority: AUTHORITY,
      collection: [POST],
      action: ['read', 'create'],
    },
  },
  {
    label: 'webapp',
    scope: WEBAPP_SCOPE,
    expected: {
      authority: AUTHORITY,
      collection: [POST],
      action: ['read', 'create', 'delete'],
    },
  },
  {
    label: 'Clubhouse',
    scope: CLUBHOUSE_SCOPE,
    expected: {
      authority: AUTHORITY,
      collection: [POST],
      action: ['read', 'create', 'update', 'delete'],
    },
  },
  {
    label: 'webapp with a did:web port authority, encoded once by the builder',
    scope: `space:${SPACE_TYPE}?authority=did%3Aweb%3A127.0.0.1%253A3100&collection=${POST}&action=read&action=create&action=delete`,
    expected: {
      authority: 'did:web:127.0.0.1%3A3100',
      collection: [POST],
      action: ['read', 'create', 'delete'],
    },
  },
  {
    label: 'a %3A in the authority that was not encoded again',
    scope: `space:${SPACE_TYPE}?authority=did:web:127.0.0.1%3A3100&collection=${POST}&action=read`,
    expected: {
      authority: 'did:web:127.0.0.1:3100',
      collection: [POST],
      action: ['read'],
    },
  },
  {
    label: 'no service DID configured (empty authority)',
    scope: `space:${SPACE_TYPE}?authority=&collection=${POST}&action=read&action=create&action=delete`,
    expected: null,
  },
  {
    label: 'actions in another order',
    scope: `space:${SPACE_TYPE}?authority=${AUTHORITY}&collection=${POST}&action=delete&action=create&action=read`,
    expected: {
      authority: AUTHORITY,
      collection: [POST],
      action: ['delete', 'create', 'read'],
    },
  },
  {
    label: 'a duplicate collection',
    scope: `space:${SPACE_TYPE}?authority=${AUTHORITY}&collection=${POST}&collection=${POST}&action=read`,
    expected: {
      authority: AUTHORITY,
      collection: [POST, POST],
      action: ['read'],
    },
  },
  {
    label: 'the named form with spaceType',
    scope: `space?spaceType=${SPACE_TYPE}&authority=${AUTHORITY}&collection=${POST}&action=read`,
    expected: { authority: AUTHORITY, collection: [POST], action: ['read'] },
  },
  {
    label: 'the retired named form with type',
    scope: `space?type=${SPACE_TYPE}&authority=${AUTHORITY}&collection=${POST}&action=read`,
    expected: null,
  },
  {
    label: 'a wildcard collection (no app requests this)',
    scope: `space:${SPACE_TYPE}?authority=${AUTHORITY}&collection=*&action=read`,
    expected: { authority: AUTHORITY, collection: ['*'], action: ['read'] },
  },
]

function parse(scope: string): Parsed | null {
  const permission = SpacePermission.fromString(scope)
  if (!permission) return null
  return {
    authority: permission.authority,
    collection: [...(permission.collection ?? [])],
    action: [...permission.action],
  }
}

describe('space scopes against the pinned upstream parser', () => {
  it.each(TABLE)('$label', ({ scope, expected }) => {
    expect(parse(scope)).toEqual(expected)
  })

  it('parses the enrollment scope the service builds into the three hosted collections', () => {
    expect(parse(buildSpaceScope(AUTHORITY))).toEqual({
      authority: AUTHORITY,
      collection: [POST, 'app.bsky.feed.like', 'app.bsky.feed.repost'],
      action: ['create', 'read'],
    })
  })

  it.each([
    { app: 'webapp', scope: WEBAPP_SCOPE },
    { app: 'Clubhouse', scope: CLUBHOUSE_SCOPE },
  ])(
    'covers a post delete in a boundary space for $app and nothing broader',
    ({ scope }) => {
      const permission = SpacePermission.fromString(scope)
      // The package types identifiers as validated strings; these literals are valid.
      const matches = (
        overrides: Record<string, unknown> & { action?: string },
      ) =>
        permission?.matches({
          spaceType: SPACE_TYPE,
          authority: AUTHORITY,
          skey: 'tokyo3',
          collection: POST,
          ...overrides,
        } as unknown as SpacePermissionMatch)
      expect(matches({ action: 'delete' })).toBe(true)
      expect(matches({ action: 'create' })).toBe(true)
      expect(
        matches({ collection: 'app.bsky.feed.like', action: 'delete' }),
      ).toBe(false)
      expect(matches({ authority: 'did:plc:other', action: 'delete' })).toBe(
        false,
      )
      expect(
        matches({ action: undefined, collection: undefined, manage: 'create' }),
      ).toBe(false)
    },
  )
})
