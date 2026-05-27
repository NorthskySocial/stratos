import { describe, expect, it } from 'vitest'
import { type Keypair, P256Keypair, Secp256k1Keypair } from '@atproto/crypto'
import { createServiceJwt, AuthRequiredError } from '@atproto/xrpc-server'

import {
  createFeedRequestVerifier,
  type IncomingFeedRequest,
} from '../src/auth/verifier.js'

const FEEDGEN_DID = 'did:web:feedgen.test'
const USER_DID = 'did:plc:user'
const ALLOWED_LXM = 'zone.stratos.feedgen.getFeed'

interface StubResolver {
  did: {
    resolveAtprotoKey: (iss: string, forceRefresh: boolean) => Promise<string>
  }
  calls: Array<{ iss: string; forceRefresh: boolean }>
}

function stubResolver(
  resolver: (iss: string, forceRefresh: boolean) => Promise<string>,
): StubResolver {
  const calls: StubResolver['calls'] = []
  return {
    calls,
    did: {
      resolveAtprotoKey: async (iss, forceRefresh) => {
        calls.push({ iss, forceRefresh })
        return resolver(iss, forceRefresh)
      },
    },
  }
}

function buildVerifier(resolver: StubResolver) {
  return createFeedRequestVerifier({
    feedgenDid: FEEDGEN_DID,
    allowedLxms: [ALLOWED_LXM],
    // Stub matches the subset of IdResolver we use.
    idResolver: resolver as unknown as Parameters<
      typeof createFeedRequestVerifier
    >[0]['idResolver'],
  })
}

function withBearer(token: string): IncomingFeedRequest {
  return { headers: { authorization: `Bearer ${token}` } }
}

async function mintJwt(
  keypair: Keypair,
  overrides: {
    iss?: string
    aud?: string
    lxm?: string | null
    exp?: number
  } = {},
): Promise<string> {
  return createServiceJwt({
    iss: overrides.iss ?? USER_DID,
    aud: overrides.aud ?? FEEDGEN_DID,
    lxm: overrides.lxm === undefined ? ALLOWED_LXM : overrides.lxm,
    exp: overrides.exp,
    keypair,
  })
}

/**
 * Mint a JWT with a custom `typ` header. `createServiceJwt` always sets
 * `typ: 'JWT'`, so we sign manually to exercise the typ block-list.
 */
async function mintJwtWithTyp(keypair: Keypair, typ: string): Promise<string> {
  const header = { typ, alg: keypair.jwtAlg }
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    iss: USER_DID,
    aud: FEEDGEN_DID,
    exp: Math.floor(Date.now() / 1000) + 60,
    lxm: ALLOWED_LXM,
    jti: 'test',
  }
  const b64 = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url')
  const toSign = `${b64(header)}.${b64(payload)}`
  const sig = Buffer.from(await keypair.sign(Buffer.from(toSign, 'utf8')))
  return `${toSign}.${sig.toString('base64url')}`
}

async function expectAuthError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AuthRequiredError)
  await promise.catch((err: unknown) => {
    expect((err as { customErrorName?: string }).customErrorName).toBe(code)
  })
}

describe('createFeedRequestVerifier', () => {
  it('returns viewer DID and lxm on a valid JWT (secp256k1)', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const resolver = stubResolver(async () => keypair.did())
    const verify = buildVerifier(resolver)
    const token = await mintJwt(keypair)

    const result = await verify(withBearer(token))

    expect(result).toEqual({ viewerDid: USER_DID, lxm: ALLOWED_LXM })
    expect(resolver.calls[0]).toEqual({ iss: USER_DID, forceRefresh: false })
  })

  it('returns viewer DID on a valid JWT (P-256)', async () => {
    const keypair = await P256Keypair.create({ exportable: true })
    const resolver = stubResolver(async () => keypair.did())
    const verify = buildVerifier(resolver)
    const token = await mintJwt(keypair)

    const result = await verify(withBearer(token))

    expect(result.viewerDid).toBe(USER_DID)
  })

  it('rejects when the Authorization header is missing', async () => {
    const resolver = stubResolver(async () => 'unused')
    const verify = buildVerifier(resolver)

    await expectAuthError(verify({ headers: {} }), 'AuthMissing')
    expect(resolver.calls).toHaveLength(0)
  })

  it('rejects a non-Bearer scheme', async () => {
    const resolver = stubResolver(async () => 'unused')
    const verify = buildVerifier(resolver)

    await expectAuthError(
      verify({ headers: { authorization: 'Basic abc' } }),
      'InvalidToken',
    )
  })

  it('rejects an expired JWT with ExpiredToken', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const resolver = stubResolver(async () => keypair.did())
    const verify = buildVerifier(resolver)
    const token = await mintJwt(keypair, {
      exp: Math.floor(Date.now() / 1000) - 10,
    })

    await expectAuthError(verify(withBearer(token)), 'ExpiredToken')
  })

  it('rejects a JWT with the wrong audience', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const resolver = stubResolver(async () => keypair.did())
    const verify = buildVerifier(resolver)
    const token = await mintJwt(keypair, { aud: 'did:web:somewhere.else' })

    await expectAuthError(verify(withBearer(token)), 'BadJwtAudience')
  })

  it('rejects a JWT whose lxm is not in the allow-list', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const resolver = stubResolver(async () => keypair.did())
    const verify = buildVerifier(resolver)
    const token = await mintJwt(keypair, { lxm: 'zone.stratos.something.else' })

    await expectAuthError(verify(withBearer(token)), 'BadJwtLexiconMethod')
  })

  it('rejects a JWT with no lxm claim', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const resolver = stubResolver(async () => keypair.did())
    const verify = buildVerifier(resolver)
    const token = await mintJwt(keypair, { lxm: null })

    await expectAuthError(verify(withBearer(token)), 'BadJwtLexiconMethod')
  })

  it('rejects a JWT signed by a different key (BadJwtSignature)', async () => {
    const signingKey = await Secp256k1Keypair.create({ exportable: true })
    const otherKey = await Secp256k1Keypair.create({ exportable: true })
    // Resolver always reports the *other* key, so signature verification fails
    // on both the initial and force-refresh attempts.
    const resolver = stubResolver(async () => otherKey.did())
    const verify = buildVerifier(resolver)
    const token = await mintJwt(signingKey)

    await expectAuthError(verify(withBearer(token)), 'BadJwtSignature')
    // verifyJwt retries once with forceRefresh=true on signature failure.
    expect(resolver.calls.map((c) => c.forceRefresh)).toEqual([false, true])
  })

  it.each(['at+jwt', 'dpop+jwt', 'refresh+jwt'])(
    'rejects a JWT with forbidden typ %s',
    async (typ) => {
      const keypair = await Secp256k1Keypair.create({ exportable: true })
      const resolver = stubResolver(async () => keypair.did())
      const verify = buildVerifier(resolver)
      const token = await mintJwtWithTyp(keypair, typ)

      await expectAuthError(verify(withBearer(token)), 'BadJwtType')
    },
  )

  it('surfaces DID-resolution failures as CouldNotResolveIssuer', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const resolver = stubResolver(async () => {
      throw new Error('plc directory unreachable')
    })
    const verify = buildVerifier(resolver)
    const token = await mintJwt(keypair)

    await expectAuthError(verify(withBearer(token)), 'CouldNotResolveIssuer')
  })
})
