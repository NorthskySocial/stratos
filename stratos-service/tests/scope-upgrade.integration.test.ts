import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import * as fc from 'fast-check'
import type { NodeSavedSession, OAuthSession } from '@atproto/oauth-client-node'
import { HOSTED_SPACE_COLLECTIONS } from '../src/shared/space-type-registry.js'
import { assertCollectionGranted } from '../src/api/records/scope-check.js'
import { buildSpaceScope, SPACE_TYPE } from '../src/oauth/client.js'
import {
  detectSpacesCapability,
  grantAllowsCreate,
} from '../src/oauth/spaces-capability.js'
import {
  asMember,
  HARNESS_ENGINEERING,
  HARNESS_SERVICE_DID,
  startPostgresWriteHarness,
  startSqliteWriteHarness,
  type CallResult,
  type WriteHarness,
} from './helpers/write-harness.js'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'

const LIKE = 'app.bsky.feed.like'
const REPOST = 'app.bsky.feed.repost'
const POST = 'zone.stratos.feed.post'
const CREATE = 'zone.stratos.repo.createRecord'
const PUT = 'zone.stratos.repo.putRecord'
const DELETE = 'zone.stratos.repo.deleteRecord'
const APPLY_WRITES = 'zone.stratos.repo.applyWrites'
const WRITE_TYPE = `${APPLY_WRITES}#`
const UPGRADE_BODY = {
  error: 'ScopeUpgradeRequired',
  message: "The member's grant predates this collection. Authorize again.",
}
const SHINJI = 'did:plc:shinji-ikari'
const MISATO = 'did:plc:misato-katsuragi'
const AUTHORITY = encodeURIComponent(HARNESS_SERVICE_DID)
const SPACE = `space:${SPACE_TYPE}?authority=${AUTHORITY}`
const POST_ONLY_GRANT = `atproto ${SPACE}&collection=${POST}&action=read ${SPACE}&collection=${POST}&action=create`
const ELSEWHERE = encodeURIComponent('did:web:seele.example')
const OTHER_AUTHORITY_GRANT = `atproto space:${SPACE_TYPE}?authority=${ELSEWHERE}&collection=${POST}&action=create`
const ENROLLMENT_ONLY_SCOPES = [
  'atproto repo:zone.stratos.actor.enrollment',
  'atproto',
]
const FULL_GRANT = `atproto ${buildSpaceScope(HARNESS_SERVICE_DID)}`

function savedSessionWith(did: string, scope: string): NodeSavedSession {
  return {
    dpopJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
    authMethod: 'none',
    tokenSet: {
      iss: 'https://pds.nerv.tokyo.jp',
      sub: did,
      aud: 'https://pds.nerv.tokyo.jp',
      scope,
      access_token: 'access',
      token_type: 'DPoP',
      expires_at: '2099-01-01T00:00:00.000Z',
      refresh_token: 'refresh',
    },
  } as unknown as NodeSavedSession
}

const interaction = (collection: string, subject: unknown) => ({
  $type: collection,
  subject,
  createdAt: '1996-10-04T00:00:00.000Z',
})

function defineScopeUpgradeCases(getHarness: () => WriteHarness) {
  let harness: WriteHarness
  let subject: { uri: string; cid: string }

  beforeEach(async () => {
    harness = getHarness()
    await harness.enrollMember(SHINJI, [HARNESS_ENGINEERING])
    await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
    const created = await harness.call(CREATE, asMember(SHINJI), {
      boundary: HARNESS_ENGINEERING,
      repo: SHINJI,
      collection: POST,
      rkey: 'eva01',
      record: {
        $type: POST,
        text: 'sortie',
        createdAt: '1996-10-04T00:00:00.000Z',
      },
    })
    expect(created.status).toBe(200)
    subject = {
      uri: `at://${SHINJI}/${POST}/eva01`,
      cid: (created.body as { cid: string }).cid,
    }
  })

  afterEach(async () => {
    await harness.ctx.oauthStores.sessionStore.del(MISATO)
  })

  const grant = (scope: string) =>
    harness.ctx.oauthStores.sessionStore.set(
      MISATO,
      savedSessionWith(MISATO, scope),
    )

  const sendLike = (
    procedure: 'create' | 'put' | 'batch',
    collection = LIKE,
    rkey = 'eva-like',
  ): Promise<CallResult> => {
    const record = interaction(collection, subject)
    const base = { boundary: HARNESS_ENGINEERING, repo: MISATO }
    if (procedure === 'create') {
      return harness.call(CREATE, asMember(MISATO), {
        ...base,
        collection,
        rkey,
        record,
      })
    }
    if (procedure === 'put') {
      return harness.call(PUT, asMember(MISATO), {
        ...base,
        collection,
        rkey,
        record,
      })
    }
    return harness.call(APPLY_WRITES, asMember(MISATO), {
      ...base,
      writes: [
        { $type: `${WRITE_TYPE}create`, collection, rkey, value: record },
      ],
    })
  }

  describe('a member whose grant covers only posts', () => {
    beforeEach(() => grant(POST_ONLY_GRANT))

    it.each(['create', 'put', 'batch'] as const)(
      'is told to authorize again through %s, for a like and a repost',
      async (procedure) => {
        for (const collection of [LIKE, REPOST]) {
          const response = await sendLike(procedure, collection)

          expect(response).toMatchObject({ status: 400, body: UPGRADE_BODY })
          expect(
            (await harness.recordRows(`at://${MISATO}/${collection}/eva-like`))
              .record,
          ).toBeNull()
        }
      },
    )

    it('is refused for a whole batch that holds a like among posts', async () => {
      const post = {
        $type: POST,
        text: 'sortie',
        createdAt: '1996-10-04T00:00:00.000Z',
      }
      const rootBefore = await harness.repoRoot(MISATO)

      const response = await harness.call(APPLY_WRITES, asMember(MISATO), {
        boundary: HARNESS_ENGINEERING,
        repo: MISATO,
        writes: [
          {
            $type: `${WRITE_TYPE}create`,
            collection: POST,
            rkey: 'eva02',
            value: post,
          },
          {
            $type: `${WRITE_TYPE}create`,
            collection: LIKE,
            rkey: 'eva-like',
            value: interaction(LIKE, subject),
          },
        ],
      })

      expect(response).toMatchObject({ status: 400, body: UPGRADE_BODY })
      expect(await harness.repoRoot(MISATO)).toEqual(rootBefore)
    })

    it('can still write a post', async () => {
      const response = await harness.call(CREATE, asMember(MISATO), {
        boundary: HARNESS_ENGINEERING,
        repo: MISATO,
        collection: POST,
        rkey: 'eva02',
        record: {
          $type: POST,
          text: 'sortie',
          createdAt: '1996-10-04T00:00:00.000Z',
        },
      })

      expect(response.status).toBe(200)
    })

    it('can still delete a like it holds', async () => {
      await harness.ctx.oauthStores.sessionStore.del(MISATO)
      expect((await sendLike('create')).status).toBe(200)
      await grant(POST_ONLY_GRANT)

      const removed = await harness.call(DELETE, asMember(MISATO), {
        boundary: HARNESS_ENGINEERING,
        repo: MISATO,
        collection: LIKE,
        rkey: 'eva-like',
      })

      expect(removed.status).toBe(200)
    })
  })

  it('does not check posts, whatever the grant says of them', async () => {
    await grant(`atproto ${SPACE}&collection=${POST}&action=read`)

    const response = await harness.call(CREATE, asMember(MISATO), {
      boundary: HARNESS_ENGINEERING,
      repo: MISATO,
      collection: POST,
      rkey: 'eva02',
      record: {
        $type: POST,
        text: 'sortie',
        createdAt: '1996-10-04T00:00:00.000Z',
      },
    })

    expect(response.status).toBe(200)
  })

  it('accepts a like and a repost from a grant covering all three collections', async () => {
    await grant(FULL_GRANT)

    expect((await sendLike('create', LIKE)).status).toBe(200)
    expect((await sendLike('create', REPOST)).status).toBe(200)
  })

  describe.each([...ENROLLMENT_ONLY_SCOPES, OTHER_AUTHORITY_GRANT])(
    'a member whose grant is %s',
    (scope) => {
      it.each(['create', 'put', 'batch'] as const)(
        'is not checked through %s, for a like and a repost',
        async (procedure) => {
          await grant(scope)

          for (const collection of [LIKE, REPOST]) {
            const response = await sendLike(procedure, collection)

            expect(response.status).toBe(200)
          }
        },
      )
    },
  )

  it('refuses a like from a grant that reads a collection of this authority and cannot create the like', async () => {
    await grant(`atproto ${SPACE}&collection=${POST}&action=read`)

    expect(await sendLike('create')).toMatchObject({
      status: 400,
      body: UPGRADE_BODY,
    })
  })

  it('does not check a stored scope that names no space of this authority, however malformed', async () => {
    const malformed = fc.oneof(
      fc.string(),
      fc.string().map((tail) => `atproto space:${tail}`),
    )

    await fc.assert(
      fc.asyncProperty(malformed, async (scope) => {
        await grant(scope)

        await expect(
          assertCollectionGranted(harness.ctx, MISATO, LIKE),
        ).resolves.toBeUndefined()
        expect((await sendLike('create')).status).toBeLessThan(500)
      }),
      { numRuns: 60 },
    )
  })

  it('answers a malformed scope that does name this authority with a refusal or nothing', async () => {
    const malformed = fc
      .string()
      .map((tail) => `atproto ${SPACE}&collection=${tail}`)

    await fc.assert(
      fc.asyncProperty(malformed, async (scope) => {
        await grant(scope)

        await assertCollectionGranted(harness.ctx, MISATO, LIKE).catch(
          (err: unknown) => {
            expect(err).toMatchObject({
              customErrorName: 'ScopeUpgradeRequired',
            })
          },
        )
        expect((await sendLike('create')).status).toBeLessThan(500)
      }),
      { numRuns: 60 },
    )
  })

  it('accepts a like from a member with no stored session', async () => {
    expect(await harness.ctx.oauthStores.sessionStore.get(MISATO)).toBe(
      undefined,
    )

    expect((await sendLike('create')).status).toBe(200)
  })

  it('accepts a like again once the member authorizes again', async () => {
    await grant(POST_ONLY_GRANT)
    expect((await sendLike('create')).status).toBe(400)

    await grant(FULL_GRANT)

    expect((await sendLike('create')).status).toBe(200)
  })
}

describe('scope upgrade on sqlite', () => {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  defineScopeUpgradeCases(() => harness)
})

describe('scope upgrade on postgres', () => {
  let connectionString: string
  let harness: WriteHarness

  beforeAll(async () => {
    connectionString = await startPostgresContainer()
  }, 120_000)

  afterAll(async () => {
    await stopPostgresContainer()
  }, 60_000)

  beforeEach(async () => {
    harness = await startPostgresWriteHarness(connectionString)
  }, 60_000)

  afterEach(async () => {
    await harness.close()
  })

  defineScopeUpgradeCases(() => harness)
})

describe('grantAllowsCreate', () => {
  const ACTIONS = ['read', 'create'] as const
  const termsArbitrary = fc.uniqueArray(
    fc.tuple(
      fc.constantFrom(...HOSTED_SPACE_COLLECTIONS),
      fc.constantFrom(...ACTIONS),
    ),
    { selector: ([collection, action]) => `${collection}/${action}` },
  )

  const scopeOf = (terms: Array<[string, string]>) =>
    [
      'atproto',
      ...terms.map(
        ([collection, action]) =>
          `${SPACE}&collection=${collection}&action=${action}`,
      ),
    ].join(' ')

  const verdictOf = (scope: string) =>
    detectSpacesCapability(
      {
        sub: MISATO,
        getTokenInfo: () => Promise.resolve({ scope }),
      } as unknown as OAuthSession,
      HARNESS_SERVICE_DID,
    )

  it('agrees with the capability verdict, which needs create for every collection', async () => {
    await fc.assert(
      fc.asyncProperty(termsArbitrary, async (terms) => {
        const withRead = [
          ...terms,
          ...HOSTED_SPACE_COLLECTIONS.map((collection): [string, string] => [
            collection,
            'read',
          ]),
        ]
        const scope = scopeOf(withRead)

        const everyCollectionGranted = HOSTED_SPACE_COLLECTIONS.every(
          (collection) =>
            grantAllowsCreate(scope, collection, HARNESS_SERVICE_DID),
        )

        expect(await verdictOf(scope)).toBe(
          everyCollectionGranted ? 'capable' : 'unknown',
        )
      }),
    )
  })

  it('grants a collection exactly when the scope names it with create', () => {
    fc.assert(
      fc.property(termsArbitrary, (terms) => {
        const scope = scopeOf(terms)

        for (const collection of HOSTED_SPACE_COLLECTIONS) {
          expect(
            grantAllowsCreate(scope, collection, HARNESS_SERVICE_DID),
          ).toBe(terms.some(([c, a]) => c === collection && a === 'create'))
        }
      }),
    )
  })

  it('refuses a grant from another authority and never throws on any string', () => {
    const elsewhere = `${SPACE.replace(AUTHORITY, encodeURIComponent('did:web:seele.example'))}&collection=${POST}&action=create`
    expect(grantAllowsCreate(elsewhere, POST, HARNESS_SERVICE_DID)).toBe(false)

    fc.assert(
      fc.property(fc.string(), fc.string(), (scope, collection) => {
        expect(
          typeof grantAllowsCreate(scope, collection, HARNESS_SERVICE_DID),
        ).toBe('boolean')
      }),
    )
  })
})
