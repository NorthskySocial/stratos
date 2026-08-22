/**
 * Unit tests for the space-credential verifier.
 *
 * A space credential is a JWT this service mints and later re-accepts on its
 * read/sync surface. Verification happens against OUR OWN signing key (no DID
 * resolution). These tests mint real credentials with a local Secp256k1 keypair
 * and assert the verifier accepts a good one and rejects each distinct failure
 * mode with a distinct typed error — including that it is deliberately
 * MULTI-USE (no credential-`jti` consumption). The presentation suite covers
 * the RFC 9449 sender constraint with fake proof-checker/replay-store seams:
 * `cnf.jkt` required, thumbprint equality, and the single-use PROOF `jti`
 * consumed LAST (a failed presentation never burns its nonce).
 */
import { describe, expect, it, vi } from 'vitest'
import { P256Keypair, Secp256k1Keypair } from '@atproto/crypto'
import { mintSpaceCredential } from '../src/features/space-credential/minter.js'
import {
  ForeignSpaceCredentialError,
  InvalidSpaceCredentialAlgError,
  InvalidSpaceCredentialKidError,
  InvalidSpaceCredentialProofError,
  InvalidSpaceCredentialSignatureError,
  InvalidSpaceCredentialSubError,
  InvalidSpaceCredentialTypError,
  MalformedSpaceCredentialError,
  MissingSpaceCredentialCnfError,
  SPACE_DPOP_REPLAY_KIND,
  SPACE_DPOP_REPLAY_TTL,
  SpaceCredentialExpiredError,
  SpaceCredentialKeyBindingError,
  SpaceCredentialProofReplayError,
  verifyPresentedSpaceCredential,
  verifySpaceCredential,
} from '../src/infra/auth/space-credential-verifier.js'
import { makeSpaceUri } from './helpers/space-uri.js'

const SERVICE_DID = 'did:web:stratos.test'
const SPACE_URI = makeSpaceUri(
  SERVICE_DID,
  'app.bsky.feed.generator',
  'myspace',
)

const b64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

/** Re-sign a hand-built header/payload with a keypair (compact JWT). */
async function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: Secp256k1Keypair | P256Keypair,
): Promise<string> {
  const signingInput = `${b64url(header)}.${b64url(payload)}`
  const sig = await key.sign(new TextEncoder().encode(signingInput))
  return `${signingInput}.${Buffer.from(sig).toString('base64url')}`
}

describe('verifySpaceCredential', () => {
  it('accepts a valid credential and returns its space URI', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const { credential } = await mintSpaceCredential({
      signingKey,
      issuerDid: SERVICE_DID,
      spaceUri: SPACE_URI,
      ttlSeconds: 7_200,
    })

    const result = await verifySpaceCredential(credential, {
      serviceKey: signingKey,
      serviceDid: SERVICE_DID,
    })
    expect(result).toEqual({ spaceUri: SPACE_URI })
  })

  it('is MULTI-USE: the same credential verifies repeatedly (no jti burn)', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const { credential } = await mintSpaceCredential({
      signingKey,
      issuerDid: SERVICE_DID,
      spaceUri: SPACE_URI,
      ttlSeconds: 7_200,
    })
    const deps = { serviceKey: signingKey, serviceDid: SERVICE_DID }
    await expect(verifySpaceCredential(credential, deps)).resolves.toEqual({
      spaceUri: SPACE_URI,
    })
    await expect(verifySpaceCredential(credential, deps)).resolves.toEqual({
      spaceUri: SPACE_URI,
    })
    await expect(verifySpaceCredential(credential, deps)).resolves.toEqual({
      spaceUri: SPACE_URI,
    })
  })

  it('rejects an expired credential', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const iat = Math.floor(Date.now() / 1000) - 10_000
    const { credential } = await mintSpaceCredential({
      signingKey,
      issuerDid: SERVICE_DID,
      spaceUri: SPACE_URI,
      ttlSeconds: 60, // exp = iat + 60, well in the past
      iat,
    })
    await expect(
      verifySpaceCredential(credential, {
        serviceKey: signingKey,
        serviceDid: SERVICE_DID,
      }),
    ).rejects.toBeInstanceOf(SpaceCredentialExpiredError)
  })

  it('rejects a credential signed by a DIFFERENT (foreign) key', async () => {
    const authorityKey = await Secp256k1Keypair.create()
    const attackerKey = await Secp256k1Keypair.create()
    const { credential } = await mintSpaceCredential({
      signingKey: attackerKey, // signed by the wrong key
      issuerDid: SERVICE_DID,
      spaceUri: SPACE_URI,
      ttlSeconds: 7_200,
    })
    await expect(
      verifySpaceCredential(credential, {
        serviceKey: authorityKey, // verified against OUR key
        serviceDid: SERVICE_DID,
      }),
    ).rejects.toBeInstanceOf(InvalidSpaceCredentialSignatureError)
  })

  it('rejects a foreign-space credential (sub.spaceDid ≠ serviceDid)', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const foreignSpace = makeSpaceUri(
      'did:web:other.example',
      'app.bsky.feed.generator',
      'x',
    )
    const { credential } = await mintSpaceCredential({
      signingKey,
      issuerDid: SERVICE_DID,
      spaceUri: foreignSpace,
      ttlSeconds: 7_200,
    })
    await expect(
      verifySpaceCredential(credential, {
        serviceKey: signingKey,
        serviceDid: SERVICE_DID,
      }),
    ).rejects.toBeInstanceOf(ForeignSpaceCredentialError)
  })

  it('rejects a wrong typ header', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const jwt = await signJwt(
      { typ: 'JWT', alg: 'ES256K', kid: '#atproto' },
      {
        iss: SERVICE_DID,
        sub: SPACE_URI,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      signingKey,
    )
    await expect(
      verifySpaceCredential(jwt, {
        serviceKey: signingKey,
        serviceDid: SERVICE_DID,
      }),
    ).rejects.toBeInstanceOf(InvalidSpaceCredentialTypError)
  })

  it('rejects a wrong alg header', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const jwt = await signJwt(
      { typ: 'atproto-space-credential+jwt', alg: 'HS256', kid: '#atproto' },
      {
        iss: SERVICE_DID,
        sub: SPACE_URI,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      signingKey,
    )
    await expect(
      verifySpaceCredential(jwt, {
        serviceKey: signingKey,
        serviceDid: SERVICE_DID,
      }),
    ).rejects.toBeInstanceOf(InvalidSpaceCredentialAlgError)
  })

  it('rejects a wrong kid header', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const jwt = await signJwt(
      {
        typ: 'atproto-space-credential+jwt',
        alg: 'ES256K',
        kid: '#atproto_wrong',
      },
      {
        iss: SERVICE_DID,
        sub: SPACE_URI,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      signingKey,
    )
    await expect(
      verifySpaceCredential(jwt, {
        serviceKey: signingKey,
        serviceDid: SERVICE_DID,
      }),
    ).rejects.toBeInstanceOf(InvalidSpaceCredentialKidError)
  })

  it('rejects a malformed (non-JWT) token', async () => {
    const signingKey = await Secp256k1Keypair.create()
    await expect(
      verifySpaceCredential('not.a', {
        serviceKey: signingKey,
        serviceDid: SERVICE_DID,
      }),
    ).rejects.toBeInstanceOf(MalformedSpaceCredentialError)
  })

  it('rejects a credential with a non-space-URI sub', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const jwt = await signJwt(
      { typ: 'atproto-space-credential+jwt', alg: 'ES256K', kid: '#atproto' },
      {
        iss: SERVICE_DID,
        sub: 'not-a-space-uri',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      signingKey,
    )
    await expect(
      verifySpaceCredential(jwt, {
        serviceKey: signingKey,
        serviceDid: SERVICE_DID,
      }),
    ).rejects.toBeInstanceOf(InvalidSpaceCredentialSubError)
  })

  it('surfaces the cnf.jkt binding of a bound credential', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const { credential } = await mintSpaceCredential({
      signingKey,
      issuerDid: SERVICE_DID,
      spaceUri: SPACE_URI,
      ttlSeconds: 7_200,
      jkt: 'thumb-asuka',
    })
    await expect(
      verifySpaceCredential(credential, {
        serviceKey: signingKey,
        serviceDid: SERVICE_DID,
      }),
    ).resolves.toEqual({ spaceUri: SPACE_URI, cnfJkt: 'thumb-asuka' })
  })

  it('omits cnfJkt entirely for an unbound credential', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const { credential } = await mintSpaceCredential({
      signingKey,
      issuerDid: SERVICE_DID,
      spaceUri: SPACE_URI,
      ttlSeconds: 7_200,
    })
    const result = await verifySpaceCredential(credential, {
      serviceKey: signingKey,
      serviceDid: SERVICE_DID,
    })
    expect('cnfJkt' in result).toBe(false)
  })

  it('ignores a non-string or empty cnf.jkt (no binding surfaced)', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const iat = Math.floor(Date.now() / 1000)
    for (const jkt of [42, '']) {
      const jwt = await signJwt(
        { typ: 'atproto-space-credential+jwt', alg: 'ES256K', kid: '#atproto' },
        {
          iss: SERVICE_DID,
          sub: SPACE_URI,
          iat,
          exp: iat + 3600,
          cnf: { jkt },
        },
        signingKey,
      )
      const result = await verifySpaceCredential(jwt, {
        serviceKey: signingKey,
        serviceDid: SERVICE_DID,
      })
      expect('cnfJkt' in result).toBe(false)
    }
  })
})

describe('verifyPresentedSpaceCredential', () => {
  const REQ = { method: 'GET', url: '/x', headers: {} }

  /** Mint a credential and build presentation deps with fake proof/replay. */
  async function setup(opts?: {
    credJkt?: string
    proofJkt?: string
    proofError?: Error
    replayFresh?: boolean
  }) {
    const signingKey = await Secp256k1Keypair.create()
    const { credential } = await mintSpaceCredential({
      signingKey,
      issuerDid: SERVICE_DID,
      spaceUri: SPACE_URI,
      ttlSeconds: 7_200,
      ...(opts?.credJkt === undefined ? {} : { jkt: opts.credJkt }),
    })
    const check = opts?.proofError
      ? vi.fn().mockRejectedValue(opts.proofError)
      : vi.fn().mockResolvedValue({
          jti: 'proof-jti-1',
          jkt: opts?.proofJkt ?? opts?.credJkt ?? 'thumb-rei',
          htm: 'GET',
          htu: 'https://stratos.test/x',
        })
    const consumeOnce = vi.fn().mockResolvedValue(opts?.replayFresh ?? true)
    const deps = {
      serviceKey: signingKey,
      serviceDid: SERVICE_DID,
      proofChecker: { check },
      replayStore: { consumeOnce },
    }
    return { credential, deps, check, consumeOnce }
  }

  it('accepts a bound credential with a matching proof and consumes the proof jti', async () => {
    const { credential, deps, check, consumeOnce } = await setup({
      credJkt: 'thumb-rei',
    })
    await expect(
      verifyPresentedSpaceCredential(credential, REQ, deps),
    ).resolves.toEqual({ spaceUri: SPACE_URI, cnfJkt: 'thumb-rei' })
    // The proof is checked against THIS request and hash-bound to the token.
    expect(check).toHaveBeenCalledWith(REQ, credential)
    expect(consumeOnce).toHaveBeenCalledWith(
      SPACE_DPOP_REPLAY_KIND,
      'proof-jti-1',
      SPACE_DPOP_REPLAY_TTL,
    )
  })

  it('rejects an UNBOUND credential (no cnf.jkt) without touching the proof', async () => {
    const { credential, deps, check, consumeOnce } = await setup()
    await expect(
      verifyPresentedSpaceCredential(credential, REQ, deps),
    ).rejects.toBeInstanceOf(MissingSpaceCredentialCnfError)
    expect(check).not.toHaveBeenCalled()
    expect(consumeOnce).not.toHaveBeenCalled()
  })

  it('rejects when the proof check fails — and does NOT burn the jti', async () => {
    const { credential, deps, consumeOnce } = await setup({
      credJkt: 'thumb-rei',
      proofError: new Error('bad proof'),
    })
    await expect(
      verifyPresentedSpaceCredential(credential, REQ, deps),
    ).rejects.toBeInstanceOf(InvalidSpaceCredentialProofError)
    expect(consumeOnce).not.toHaveBeenCalled()
  })

  it('rejects a proof from a DIFFERENT key — and does NOT burn the jti', async () => {
    const { credential, deps, consumeOnce } = await setup({
      credJkt: 'thumb-rei',
      proofJkt: 'thumb-attacker',
    })
    await expect(
      verifyPresentedSpaceCredential(credential, REQ, deps),
    ).rejects.toBeInstanceOf(SpaceCredentialKeyBindingError)
    expect(consumeOnce).not.toHaveBeenCalled()
  })

  it('rejects a replayed proof jti (consumeOnce false, fail-closed)', async () => {
    const { credential, deps } = await setup({
      credJkt: 'thumb-rei',
      replayFresh: false,
    })
    await expect(
      verifyPresentedSpaceCredential(credential, REQ, deps),
    ).rejects.toBeInstanceOf(SpaceCredentialProofReplayError)
  })

  it('runs credential verification FIRST: an expired bound credential never reaches the proof', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const iat = Math.floor(Date.now() / 1000) - 10_000
    const { credential } = await mintSpaceCredential({
      signingKey,
      issuerDid: SERVICE_DID,
      spaceUri: SPACE_URI,
      ttlSeconds: 60,
      iat,
      jkt: 'thumb-rei',
    })
    const check = vi.fn()
    const consumeOnce = vi.fn()
    await expect(
      verifyPresentedSpaceCredential(credential, REQ, {
        serviceKey: signingKey,
        serviceDid: SERVICE_DID,
        proofChecker: { check },
        replayStore: { consumeOnce },
      }),
    ).rejects.toBeInstanceOf(SpaceCredentialExpiredError)
    expect(check).not.toHaveBeenCalled()
    expect(consumeOnce).not.toHaveBeenCalled()
  })
})
