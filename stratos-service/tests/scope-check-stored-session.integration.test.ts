import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NodeSavedSession } from '@atproto/oauth-client-node'
import { assertCollectionGranted } from '../src/api/records/scope-check.js'
import { SPACE_TYPE } from '../src/oauth/client.js'
import { grantAllowsCreate } from '../src/oauth/spaces-capability.js'
import {
  asMember,
  HARNESS_ENGINEERING,
  HARNESS_SERVICE_DID,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'

const SHINJI = 'did:plc:shinji-ikari'
const MISATO = 'did:plc:misato-katsuragi'
const POST = 'zone.stratos.feed.post'
const LIKE = 'app.bsky.feed.like'
const CREATE = 'zone.stratos.repo.createRecord'
const AUTHORITY = encodeURIComponent(HARNESS_SERVICE_DID)
// Granted only for posts, so a scope the check could read would refuse the like.
const POST_ONLY_GRANT = `atproto space:${SPACE_TYPE}?authority=${AUTHORITY}&collection=${POST}&action=read space:${SPACE_TYPE}?authority=${AUTHORITY}&collection=${POST}&action=create`
// The scope parser percent-decodes a space positional, and a lone `%` is not
// a valid escape.
const SCOPE_THE_PARSER_THROWS_ON = `${POST_ONLY_GRANT} space:%`

const tokenSetWith = (scope: unknown) => ({
  iss: 'https://pds.nerv.tokyo.jp',
  sub: MISATO,
  aud: 'https://pds.nerv.tokyo.jp',
  scope,
  access_token: 'access',
  token_type: 'DPoP',
  expires_at: '2099-01-01T00:00:00.000Z',
  refresh_token: 'refresh',
})

const sessionWith = (fields: Record<string, unknown>) =>
  ({
    dpopJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
    authMethod: 'none',
    ...fields,
  }) as unknown as NodeSavedSession

describe('a stored session the grant check cannot read', () => {
  let harness: WriteHarness
  let subject: { uri: string; cid: string }

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
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
    await harness.close()
  })

  const store = (session: NodeSavedSession) =>
    harness.ctx.oauthStores.sessionStore.set(MISATO, session)

  const sendLike = () =>
    harness.call(CREATE, asMember(MISATO), {
      boundary: HARNESS_ENGINEERING,
      repo: MISATO,
      collection: LIKE,
      rkey: 'eva-like',
      record: { $type: LIKE, subject, createdAt: '1996-10-04T00:00:00.000Z' },
    })

  it('refuses a like from the readable post-only grant these cases start from', async () => {
    await store(sessionWith({ tokenSet: tokenSetWith(POST_ONLY_GRANT) }))

    expect((await sendLike()).status).toBe(400)
  })

  it.each([
    ['a number', 3],
    ['a list of scopes', POST_ONLY_GRANT.split(' ')],
    ['null', null],
  ])('does not check a scope that is %s', async (_name, scope) => {
    await store(sessionWith({ tokenSet: tokenSetWith(scope) }))

    await expect(
      assertCollectionGranted(harness.ctx, MISATO, LIKE),
    ).resolves.toBeUndefined()
    expect((await sendLike()).status).toBe(200)
  })

  it('does not check a scope the parser throws on', async () => {
    expect(() =>
      grantAllowsCreate(SCOPE_THE_PARSER_THROWS_ON, LIKE, HARNESS_SERVICE_DID),
    ).toThrow(URIError)
    await store(
      sessionWith({ tokenSet: tokenSetWith(SCOPE_THE_PARSER_THROWS_ON) }),
    )

    await expect(
      assertCollectionGranted(harness.ctx, MISATO, LIKE),
    ).resolves.toBeUndefined()
    expect((await sendLike()).status).toBe(200)
  })

  it('does not check a stored session that has no token set', async () => {
    await store(sessionWith({}))

    await expect(
      assertCollectionGranted(harness.ctx, MISATO, LIKE),
    ).resolves.toBeUndefined()
    expect((await sendLike()).status).toBe(200)
  })
})
